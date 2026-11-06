'use strict';
// Guest side: make the local core + ROM identical to the host's.
//
// * ROMs are matched by SHA-256. If you already have the exact file anywhere
//   in your ROM folder it's used as-is (the name doesn't matter). Otherwise it
//   is downloaded from the host to the same relative path the host uses.
// * Cores on the same OS/CPU are matched by SHA-256 and downloaded from the
//   host when missing or different, so both sides run the identical build.
// * Cores across different OSes can't be copied (they're native binaries).
//   The same core is fetched from the libretro buildbot instead, with a
//   warning, since its version may not match the host's exactly.
// * Anything replaced is kept as `<name>.<timestamp>.old`, never deleted.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { unzipSync } = require('fflate');
const platforms = require('./platforms');
const { safeRelParts, retroarchVersion } = require('./library');

class SyncError extends Error {}

class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

function hostForUrl(address) {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}

class HostClient {
  constructor(address, port, secret, { timeoutMs = 15000 } = {}) {
    if (!address) throw new SyncError("Your buddy's address isn't set (Settings → Buddy's address)");
    this.address = address;
    this.base = `http://${hostForUrl(address)}:${port}`;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }

  /** Resolves to an http.IncomingMessage with status < 400. */
  open(urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(this.base + urlPath, {
        headers: { ...headers, Authorization: `Bearer ${this.secret}` },
        timeout: this.timeoutMs,
      }, (res) => {
        if (res.statusCode === 401) {
          res.resume();
          reject(new SyncError("Your buddy's app rejected the shared secret. Make sure you both have the same one."));
        } else if (res.statusCode >= 400) {
          res.resume();
          reject(new HttpError(res.statusCode));
        } else {
          res.setTimeout(0);
          resolve(res);
        }
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => {
        if (err instanceof SyncError || err instanceof HttpError) return reject(err);
        reject(new SyncError(
          `Can't reach your buddy at ${this.address} (${err.code || err.message}). ` +
          'Is RetroConnect open on their side, and is the sync port reachable?'));
      });
    });
  }

  async getJson(urlPath) {
    const res = await this.open(urlPath);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  manifest() {
    return this.getJson('/api/manifest');
  }

  /** Session + suggestion + Discord link; falls back for older buddies without /api/status. */
  async status() {
    try {
      return await this.getJson('/api/status');
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      return { session: await this.session(), suggestion: null, discord_url: null };
    }
  }

  async session() {
    try {
      return await this.getJson('/api/session');
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

async function backupExisting(file) {
  if (!(await exists(file))) return null;
  const base = `${file}.${stamp()}`;
  let backup = `${base}.old`;
  for (let n = 1; await exists(backup); n++) backup = `${base}-${n}.old`;
  await fsp.rename(file, backup);
  return backup;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Download into `dest` (resuming a `.part` file); resolves to any backup made. */
async function downloadFromHost(client, kind, sha256, size, dest, label, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let offset = 0;
  try { offset = (await fsp.stat(part)).size; } catch { /* no partial */ }
  if (offset > size) { await fsp.unlink(part); offset = 0; }

  if (offset < size || size === 0) {
    let res = null;
    try {
      res = await client.open(`/files/${kind}/${sha256}`, offset ? { Range: `bytes=${offset}-` } : {});
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 404) throw new SyncError(`Your buddy no longer has ${label}`);
      if (err.status !== 416) throw new SyncError(`Download of ${label} failed (HTTP ${err.status})`);
      // 416: we already have every byte
    }
    if (res) {
      if (offset && res.statusCode !== 206) offset = 0; // range ignored: start over
      const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
      let done = offset;
      try {
        await new Promise((resolve, reject) => {
          res.on('data', (chunk) => {
            done += chunk.length;
            if (onProgress) onProgress({ label, done, total: size });
          });
          res.on('error', reject);
          res.on('aborted', () => reject(new SyncError(`Connection dropped while downloading ${label}; try again to resume`)));
          out.on('error', reject);
          out.on('finish', resolve);
          res.pipe(out);
        });
      } catch (err) {
        out.destroy();
        throw err instanceof SyncError ? err : new SyncError(`Download of ${label} failed: ${err.message}`);
      }
    }
  }

  if ((await sha256File(part)) !== sha256) {
    await fsp.unlink(part);
    throw new SyncError(`${label} arrived corrupted (hash mismatch). Try again.`);
  }
  const backup = await backupExisting(dest);
  await fsp.rename(part, dest);
  return backup;
}

async function fetchCoreFromBuildbot(coreName, coresDir, log, { fetchImpl = globalThis.fetch, tag } = {}) {
  const url = platforms.buildbotCoreUrl(coreName, tag);
  if (!url) {
    throw new SyncError(`No libretro download for ${platforms.platformTag()}; install ${coreName} with RetroArch's Online Updater`);
  }
  const fname = platforms.coreFilename(coreName, (tag || platforms.platformTag()).split('-')[0]);
  log(`Downloading ${coreName} from the libretro buildbot`);
  let data;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new SyncError(`Buildbot download of ${coreName} failed: ${err.message}`);
  }
  let files;
  try {
    files = unzipSync(data, { filter: (f) => f.name.split('/').pop() === fname });
  } catch {
    throw new SyncError('The buildbot returned a corrupt archive');
  }
  const payload = Object.values(files)[0];
  if (!payload) throw new SyncError(`The buildbot archive didn't contain ${fname}`);
  await fsp.mkdir(coresDir, { recursive: true });
  const dest = path.join(coresDir, fname);
  await fsp.writeFile(`${dest}.part`, payload);
  await backupExisting(dest);
  await fsp.rename(`${dest}.part`, dest);
  return dest;
}

class Syncer {
  constructor(library, client, { buildbotFallback = true, onProgress = null, log = () => {}, fetchCore = fetchCoreFromBuildbot } = {}) {
    this.library = library;
    this.client = client;
    this.buildbotFallback = buildbotFallback;
    this.onProgress = onProgress;
    this.log = log;
    this.fetchCore = fetchCore;
  }

  async ensureRom(remote, result, localBySha = null) {
    if (!localBySha) localBySha = new Map((await this.library.scanRoms()).map((r) => [r.sha256, r]));
    const local = localBySha.get(remote.sha256);
    if (local) {
      // Same .cue, but its tracks may be missing or different here.
      if (remote.parts && remote.parts.length) await this.ensureParts(remote, result, path.posix.dirname(local.path), path.posix.dirname(remote.path));
      return this.library.romPath(local);
    }
    const dest = path.join(this.library.romsDir, ...safeRelParts(remote.path));
    const why = (await exists(dest)) ? 'is a different version' : 'is missing';
    this.log(`${remote.path} ${why}, downloading from your buddy`);
    const backup = await downloadFromHost(this.client, 'rom', remote.sha256, remote.size, dest, remote.path, this.onProgress);
    if (backup) result.warnings.push(`Your old copy was kept as ${path.basename(backup)}`);
    result.downloaded.push(remote.path);
    localBySha.set(remote.sha256, { ...remote });
    if (remote.parts && remote.parts.length) await this.ensureParts(remote, result);
    return dest;
  }

  /**
   * The tracks / discs a .cue or .m3u names. They keep their place relative to
   * it (localDir/remoteDir let a .cue we already have elsewhere get its tracks
   * next to it).
   */
  async ensureParts(remote, result, localDir = null, remoteDir = null) {
    for (const part of remote.parts) {
      let rel = part.path;
      if (localDir !== null && remoteDir !== null && localDir !== remoteDir) {
        const inside = path.posix.relative(remoteDir, part.path);
        if (!inside.startsWith('..')) rel = localDir === '.' ? inside : `${localDir}/${inside}`;
      }
      if ((await this.library.fileSha(rel)) === part.sha256) continue;
      const dest = path.join(this.library.romsDir, ...safeRelParts(rel));
      this.log(`${rel} (part of ${path.posix.basename(remote.path)}) downloading from your buddy`);
      const backup = await downloadFromHost(this.client, 'rom', part.sha256, part.size, dest, rel, this.onProgress);
      if (backup) result.warnings.push(`Your old copy was kept as ${path.basename(backup)}`);
      result.downloaded.push(rel);
    }
  }

  async ensureCore(remote, remotePlatform, result) {
    const name = remote.name;
    const local = await this.library.findCore(name);
    if (remotePlatform === this.library.platformTag) {
      if (local && local.sha256 === remote.sha256) return this.library.corePath(local);
      this.log(`Core ${name} ${local ? 'is a different build' : 'is missing'}, downloading your buddy's copy`);
      const dest = path.join(this.library.coresDir, path.basename(remote.file));
      const backup = await downloadFromHost(this.client, 'core', remote.sha256, remote.size, dest, remote.file, this.onProgress);
      if (backup) result.warnings.push(`Your previous ${remote.file} was kept as ${path.basename(backup)}`);
      result.downloaded.push(remote.file);
      return dest;
    }

    // Different OS/CPU: the host's binary is useless to us.
    if (local) {
      result.warnings.push(
        `Your buddy is on ${remotePlatform} and you're on ${this.library.platformTag}, so you're using your own ` +
        `${local.file}. Keep both on the same ${name} version (RetroArch → Online Updater → Update Cores) or you may desync.`);
      return this.library.corePath(local);
    }
    if (!this.buildbotFallback) {
      throw new SyncError(
        `You don't have ${name}, and your buddy's copy is for ${remotePlatform}. ` +
        'Install it with RetroArch\'s Online Updater, or turn on "Download cores from libretro" in Settings.');
    }
    const dest = await this.fetchCore(name, this.library.coresDir, this.log);
    result.downloaded.push(path.basename(dest));
    result.warnings.push(
      `${name} came from the libretro buildbot because your buddy is on ${remotePlatform}. ` +
      'If you desync, both update cores to the latest.');
    return dest;
  }

  async versionWarning(remote, result) {
    const theirs = remote.retroarch_version;
    const ours = await retroarchVersion(this.library.retroarchCmd);
    if (theirs && ours && theirs !== ours) {
      result.warnings.push(`RetroArch versions differ (buddy ${theirs}, you ${ours}). Netplay works best on the same version.`);
    }
  }

  async syncSession(session) {
    const result = { romPath: null, corePath: null, downloaded: [], warnings: [] };
    await this.versionWarning(session, result);
    result.corePath = await this.ensureCore(session.core, session.platform, result);
    result.romPath = await this.ensureRom(session.rom, result);
    return result;
  }

  /** Pull ROMs (optionally only those whose sha256 is in `onlySha`) + same-platform cores. */
  async syncLibrary(manifest, { onlySha = null, includeCores = true } = {}) {
    const result = { downloaded: [], warnings: [] };
    const localBySha = new Map((await this.library.scanRoms()).map((r) => [r.sha256, r]));
    for (const rom of manifest.roms) {
      if (onlySha && !onlySha.includes(rom.sha256)) continue;
      try { await this.ensureRom(rom, result, localBySha); } catch (err) { result.warnings.push(err.message); }
    }
    if (includeCores && manifest.platform === this.library.platformTag) {
      for (const core of manifest.cores) {
        try { await this.ensureCore(core, manifest.platform, result); } catch (err) { result.warnings.push(err.message); }
      }
    }
    return result;
  }
}

/**
 * Merge two libraries into one list, one row per game:
 *   status: "both" | "different" | "mine" | "theirs"
 */
function compare(local, remote) {
  const mine = new Map(local.roms.map((r) => [r.sha256, r]));
  const theirs = new Map((remote ? remote.roms : []).map((r) => [r.sha256, r]));
  const minePaths = new Map(local.roms.map((r) => [r.path, r]));
  const rows = [];
  const seenPaths = new Set();
  for (const [sha, r] of theirs) {
    if (mine.has(sha)) {
      rows.push({ path: mine.get(sha).path, status: 'both', mine: mine.get(sha), theirs: r });
      seenPaths.add(mine.get(sha).path);
    } else if (minePaths.has(r.path)) {
      rows.push({ path: r.path, status: 'different', mine: minePaths.get(r.path), theirs: r });
      seenPaths.add(r.path);
    } else {
      rows.push({ path: r.path, status: 'theirs', mine: null, theirs: r });
    }
  }
  for (const [sha, r] of mine) {
    if (!theirs.has(sha) && !seenPaths.has(r.path)) {
      rows.push({ path: r.path, status: remote ? 'mine' : 'unknown', mine: r, theirs: null });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

module.exports = { HostClient, Syncer, SyncError, HttpError, downloadFromHost, fetchCoreFromBuildbot, backupExisting, compare };
