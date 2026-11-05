'use strict';
// Scan local ROMs and cores and fingerprint them (SHA-256 + CRC32).
//
// RetroArch netplay refuses to connect unless both sides run the same
// content, and desyncs if the cores differ, so everything is identified by
// content hash rather than by file name.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const platforms = require('./platforms');

const MANIFEST_VERSION = 1;

// Things that commonly live next to ROMs but aren't content.
const IGNORED_EXTENSIONS = new Set([
  '.srm', '.sav', '.state', '.png', '.jpg', '.jpeg', '.txt', '.nfo', '.cfg', '.opt',
  '.rmp', '.lpl', '.part', '.old', '.tmp', '.auto', '.ds_store', '.ini', '.db',
]);
const STATE_SLOT = /\.state\d+$/i;

let CRC_TABLE = null;
function crc32Update(crc, buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256');
    let crc = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (chunk) => { sha.update(chunk); crc = crc32Update(crc, chunk); })
      .on('error', reject)
      .on('end', () => resolve({
        sha256: sha.digest('hex'),
        crc32: (crc >>> 0).toString(16).padStart(8, '0'),
      }));
  });
}

function isContentFile(name) {
  if (name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  return !(IGNORED_EXTENSIONS.has(ext) || STATE_SLOT.test(name));
}

/** Validate a relative path that came over the network; returns its parts. */
function safeRelParts(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error(`unsafe path from host: ${JSON.stringify(rel)}`);
  const norm = rel.replace(/\\/g, '/');
  const parts = norm.split('/');
  if (
    norm.startsWith('/') ||
    parts.some((p) => p === '' || p === '.' || p === '..') ||
    parts[0].includes(':')
  ) {
    throw new Error(`unsafe path from host: ${JSON.stringify(rel)}`);
  }
  return parts;
}

/** Remembers hashes keyed by (path, size, mtime) so rescans are cheap. */
class HashCache {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.dirty = false;
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    }
  }

  async get(file, st) {
    const key = path.resolve(file);
    const mtime = Math.floor(st.mtimeMs);
    const hit = this.data[key];
    if (hit && hit.size === st.size && hit.mtime === mtime) {
      return { sha256: hit.sha256, crc32: hit.crc32 };
    }
    const digests = await hashFile(file);
    this.data[key] = { size: st.size, mtime, ...digests };
    this.dirty = true;
    return digests;
  }

  async save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data));
    await fsp.rename(tmp, this.file);
  }
}

const versionCache = new Map();
function retroarchVersion(cmd) {
  if (!cmd || !cmd.length) return Promise.resolve(null);
  const key = cmd.join('\0');
  if (!versionCache.has(key)) {
    versionCache.set(key, new Promise((resolve) => {
      execFile(cmd[0], [...cmd.slice(1), '--version'], { timeout: 15000, windowsHide: true },
        (err, stdout, stderr) => {
          const m = /v?(\d+\.\d+\.\d+)/.exec(`${stdout || ''}${stderr || ''}`);
          resolve(m ? m[1] : null);
        });
    }));
  }
  return versionCache.get(key);
}

async function walk(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) out.push(...(await walk(dir, childRel)));
    } else if (e.isFile() && isContentFile(e.name)) {
      out.push(childRel);
    }
  }
  return out;
}

class Library {
  constructor({ romsDir, coresDir, cacheFile = null, nickname = '', retroarchCmd = [], platformTag = null }) {
    this.romsDir = romsDir;
    this.coresDir = coresDir;
    this.cache = new HashCache(cacheFile);
    this.nickname = nickname;
    this.retroarchCmd = retroarchCmd;
    this.platformTag = platformTag || platforms.platformTag();
    this._scanning = null;
  }

  async scanRoms() {
    const roms = [];
    for (const rel of await walk(this.romsDir)) {
      const full = path.join(this.romsDir, ...rel.split('/'));
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      roms.push({ path: rel, size: st.size, ...(await this.cache.get(full, st)) });
    }
    await this.cache.save();
    return roms;
  }

  async scanCores() {
    let names;
    try { names = (await fsp.readdir(this.coresDir)).sort(); } catch { return []; }
    const cores = [];
    for (const file of names) {
      const name = platforms.coreNameFromFile(file);
      if (!name) continue;
      const full = path.join(this.coresDir, file);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (!st.isFile()) continue;
      const { sha256 } = await this.cache.get(full, st);
      cores.push({ name, file, size: st.size, sha256 });
    }
    await this.cache.save();
    return cores;
  }

  /** Full manifest; concurrent callers share one scan. */
  manifest() {
    if (!this._scanning) {
      this._scanning = (async () => ({
        version: MANIFEST_VERSION,
        nickname: this.nickname,
        platform: this.platformTag,
        retroarch_version: await retroarchVersion(this.retroarchCmd),
        roms: await this.scanRoms(),
        cores: await this.scanCores(),
      }))().finally(() => { this._scanning = null; });
    }
    return this._scanning;
  }

  romPath(entry) {
    return path.join(this.romsDir, ...safeRelParts(entry.path));
  }

  corePath(entry) {
    return path.join(this.coresDir, path.basename(entry.file));
  }

  async findRomBySha(sha256) {
    return (await this.scanRoms()).find((r) => r.sha256 === sha256) || null;
  }

  async findCore(name) {
    return (await this.scanCores()).find((c) => c.name === name) || null;
  }
}

module.exports = { Library, HashCache, hashFile, isContentFile, safeRelParts, retroarchVersion, MANIFEST_VERSION };
