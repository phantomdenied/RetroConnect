'use strict';
// Getting a game file ready for RetroArch.
//
// RetroArch opens a .zip/.7z by unpacking ONE file from it. That's fine for
// cartridge games, but a CD game is a .cue plus one or more .bin tracks: it
// takes the first track and the game loses its music (or doesn't boot).
// So a disc archive is unpacked whole, once, into a cache, and the .cue (or
// .m3u) is launched. Both players unpack the same archive, so netplay still
// sees the same game.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const raInstaller = require('./retroarch-installer');

const DISC_INDEX = /\.(m3u|cue|ccd|gdi)$/i;
const KEEP = 3; // unpacked discs kept in the cache

/** 'zip', '7z' or null, from the file's first bytes. */
async function archiveKind(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(6);
    await fh.read(b, 0, 6, 0);
    if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
    if (b.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    return null;
  } finally {
    await fh.close();
  }
}

/** Names of the files in an archive (7-Zip lists zips too). */
function listArchive(file, exe = raInstaller.sevenZipPath()) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['l', '-ba', '-slt', file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Couldn't read ${path.basename(file)}: ${err.message}`));
      const names = [];
      let cur = null;
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^Path = (.*)$/.exec(line);
        if (m) cur = { name: m[1], dir: false };
        else if (cur && /^Folder = \+/.test(line)) cur.dir = true;
        else if (cur && line === '') { if (!cur.dir) names.push(cur.name); cur = null; }
      }
      if (cur && !cur.dir) names.push(cur.name);
      resolve(names);
    });
  });
}

/** The file to launch from a list: .m3u first (multi-disc), then .cue/.ccd/.gdi. */
function pickDiscIndex(names) {
  const order = ['.m3u', '.cue', '.ccd', '.gdi'];
  const sorted = names.filter((n) => DISC_INDEX.test(n))
    .sort((a, b) => order.indexOf(path.extname(a).toLowerCase()) - order.indexOf(path.extname(b).toLowerCase()) || a.localeCompare(b));
  return sorted[0] || null;
}

async function prune(cacheDir, keepName) {
  let entries = [];
  try { entries = await fsp.readdir(cacheDir, { withFileTypes: true }); } catch { return; }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === keepName) continue;
    const st = await fsp.stat(path.join(cacheDir, e.name)).catch(() => null);
    if (st) dirs.push({ name: e.name, at: st.mtimeMs });
  }
  dirs.sort((a, b) => b.at - a.at);
  for (const d of dirs.slice(KEEP - 1)) await fsp.rm(path.join(cacheDir, d.name), { recursive: true, force: true }).catch(() => {});
}

/**
 * The path RetroArch should open for a game. Plain files and single-file
 * archives come back unchanged; a disc archive (or an archive whose name lost
 * its .zip/.7z) is unpacked into cacheDir/<sha> and its .cue/.m3u returned.
 */
async function prepare(romFile, sha256, cacheDir, { onProgress = null, log = () => {}, list = listArchive, unpack = raInstaller.extract } = {}) {
  const ext = path.extname(romFile).toLowerCase();
  const known = ext === '.zip' || ext === '.7z';
  const looksLikeExt = /^\.[a-z0-9]{1,4}$/.test(ext);
  if (!known && looksLikeExt) return romFile; // .bin, .cue, .sfc ...: open as is
  const kind = await archiveKind(romFile).catch(() => null);
  if (!kind) return romFile;
  const names = await list(romFile);
  const index = pickDiscIndex(names);
  if (!index && known) return romFile; // one cartridge ROM in a zip: RetroArch handles it
  const dest = path.join(cacheDir, sha256);
  const target = index || names[0];
  if (!target) throw new Error(`${path.basename(romFile)} is an empty archive`);
  const out = path.join(dest, ...target.split(/[\\/]/));
  if (fs.existsSync(path.join(dest, '.done')) && fs.existsSync(out)) {
    const now = new Date();
    await fsp.utimes(dest, now, now).catch(() => {});
    return out;
  }
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  log(`Unpacking ${path.basename(romFile)} so every track loads`);
  await unpack(romFile, dest, (pct) => onProgress && onProgress({ label: `Unpacking ${path.basename(romFile)}`, done: pct, total: 100, percent: true }));
  if (!fs.existsSync(out)) throw new Error(`Unpacked ${path.basename(romFile)} but ${target} isn't in it`);
  await fsp.writeFile(path.join(dest, '.done'), '');
  await prune(cacheDir, sha256);
  return out;
}

// ----- unpacking for good (in the ROM folder) ----------------------------------------

const CD_SYSTEMS = new Set(['psx', 'segacd', 'pce', 'sgx', 'gcm']);

/** Is this library file one RetroArch can't open well as it is? Worth checking at all? */
function worthChecking(relPath, systemKey) {
  const ext = path.extname(relPath).toLowerCase();
  if (!/^\.[a-z0-9]{1,4}$/.test(ext)) return true; // no real extension: maybe an archive that lost it
  return (ext === '.zip' || ext === '.7z') && CD_SYSTEMS.has(systemKey);
}

/**
 * Why a file should be unpacked, or null:
 *   'disc'  - an archive holding a .cue/.m3u (RetroArch would only load one track)
 *   'noext' - an archive whose name lost its .zip/.7z
 */
async function unpackReason(file, { list = listArchive } = {}) {
  const ext = path.extname(file).toLowerCase();
  const kind = await archiveKind(file).catch(() => null);
  if (!kind) return null;
  const names = await list(file).catch(() => []);
  if (pickDiscIndex(names)) return 'disc';
  if (!/^\.[a-z0-9]{1,4}$/.test(ext)) return 'noext';
  return null;
}

/**
 * Unpack an archive next to itself, then hand the archive to `remove`
 * (the Recycle Bin in the app). Refuses to overwrite files already there.
 * Returns the unpacked file names.
 */
async function unpackInPlace(file, { remove, list = listArchive, unpack = raInstaller.extract, onProgress = null } = {}) {
  const dir = path.dirname(file);
  const names = await list(file);
  if (!names.length) throw new Error(`${path.basename(file)} is empty`);
  const clash = names.filter((n) => fs.existsSync(path.join(dir, ...n.split(/[\\/]/))));
  if (clash.length) throw new Error(`Can't unpack: ${clash[0]} is already in that folder`);
  const staging = path.join(dir, `.rc-unpack-${process.pid}-${Date.now()}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    await unpack(file, staging, (pct) => onProgress && onProgress({ label: `Unpacking ${path.basename(file)}`, done: pct, total: 100, percent: true }));
    for (const n of names) {
      const from = path.join(staging, ...n.split(/[\\/]/));
      const to = path.join(dir, ...n.split(/[\\/]/));
      if (!fs.existsSync(from)) throw new Error(`Unpacking ${path.basename(file)} didn't produce ${n}`);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
    }
  } catch (err) {
    // Put things back the way they were: nothing half-moved stays behind.
    for (const n of names) {
      const to = path.join(dir, ...n.split(/[\\/]/));
      if (fs.existsSync(to) && !fs.existsSync(path.join(staging, ...n.split(/[\\/]/)))) {
        await fsp.mkdir(path.dirname(path.join(staging, ...n.split(/[\\/]/))), { recursive: true }).catch(() => {});
        await fsp.rename(to, path.join(staging, ...n.split(/[\\/]/))).catch(() => {});
      }
    }
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }
  await fsp.rm(staging, { recursive: true, force: true });
  if (remove) await remove(file);
  return names;
}

module.exports = { prepare, archiveKind, listArchive, pickDiscIndex, DISC_INDEX, worthChecking, unpackReason, unpackInPlace };
