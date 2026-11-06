'use strict';
// Shared battery saves (.srm): whoever hosts next continues from the newest
// save either of you has.
//
// RetroArch writes "<content name>.srm" into savefile_directory (default
// "saves" next to retroarch.exe on Windows), in a subfolder named after the
// core when sort_savefiles_enable is on (the default), or next to the ROM
// when savefiles_in_content_dir is on / no save folder is set.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const platforms = require('./platforms');
const raSetup = require('./retroarch-setup');

/** RetroArch's save folder for this install, or null if saves go next to the ROM. */
function savesRoot(retroarchCmd = [], cfgValues = {}) {
  if (String(cfgValues.savefiles_in_content_dir) === 'true') return null;
  const exeDir = retroarchCmd.length && retroarchCmd[0] !== 'flatpak' ? path.dirname(retroarchCmd[0]) : null;
  const set = cfgValues.savefile_directory;
  if (set && set !== 'default') {
    if (set.startsWith(':') && exeDir) return path.join(exeDir, set.slice(1).replace(/^[\\/]+/, ''));
    return set;
  }
  if (platforms.osName() === 'windows' && exeDir) return path.join(exeDir, 'saves');
  return path.join(path.dirname(raSetup.configPath(retroarchCmd)), 'saves');
}

function baseName(romPath) {
  return path.basename(romPath).replace(/\.[^.]+$/, '');
}

async function statFile(p) {
  try { const st = await fsp.stat(p); return st.isFile() ? st : null; } catch { return null; }
}

/** All places RetroArch might keep this ROM's .srm, newest first. */
async function findSave(romFullPath, root) {
  const name = `${baseName(romFullPath)}.srm`;
  const candidates = [path.join(path.dirname(romFullPath), name)];
  if (root) {
    candidates.push(path.join(root, name));
    let subs = [];
    try { subs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no saves yet */ }
    for (const d of subs) candidates.push(path.join(root, d, name));
  }
  const found = [];
  for (const p of candidates) {
    const st = await statFile(p);
    if (st) found.push({ path: p, size: st.size, mtimeMs: Math.floor(st.mtimeMs), rel: root && p.startsWith(root + path.sep) ? path.relative(root, p).split(path.sep).join('/') : name });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] || null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** What we tell the buddy about our save for a ROM. Ages, not clock times, so clock differences don't matter. */
async function describe(save) {
  if (!save) return null;
  return { rel: save.rel, size: save.size, sha256: await sha256(save.path), age_ms: Math.max(0, Date.now() - save.mtimeMs) };
}

/** Where to write a save we don't have yet: mirror the buddy's subfolder (e.g. the core name). */
function targetPath(romFullPath, root, remoteRel) {
  const name = `${baseName(romFullPath)}.srm`;
  if (!root) return path.join(path.dirname(romFullPath), name);
  const parts = String(remoteRel || '').replace(/\\/g, '/').split('/');
  const sub = parts.length === 2 && parts[0] && !['.', '..'].includes(parts[0]) && !parts[0].includes(':') ? parts[0] : null;
  return sub ? path.join(root, sub, name) : path.join(root, name);
}

/** Should we take their save instead of ours? */
function theirsIsNewer(mine, theirs, slackMs = 5000) {
  if (!theirs) return false;
  if (!mine) return true;
  if (mine.sha256 === theirs.sha256) return false;
  return theirs.age_ms + slackMs < mine.age_ms;
}

function ageText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

module.exports = { savesRoot, findSave, describe, targetPath, theirsIsNewer, ageText, baseName };
