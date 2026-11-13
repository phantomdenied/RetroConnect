'use strict';
// RetroArch cheat files (.cht): find a game's cheats in RetroArch's cheat
// folder, fill that folder from libretro's cheat database, and write the
// per-game file RetroArch loads when you play on your own.
//
// RetroArch keeps the database as <cheats>/<System>/<Game>.cht and the
// cheats you set up for a game as <cheats>/<Core name>/<Game>.cht.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { unzipSync } = require('fflate');
const systems = require('./systems');
const raSetup = require('./retroarch-setup');
const { backupExisting } = require('./sync');

const CHEATS_ZIP_URL = 'https://buildbot.libretro.com/assets/frontend/cheats.zip';
const MARK = '# Written by RetroConnect';

// ----- .cht files ------------------------------------------------------------------

/** Parse a .cht file into [{ index, desc, code, enable, extra: {key: value} }]. */
function parseCht(text) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|(\S+))/.exec(line);
    if (m) kv[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  const count = Number(kv.cheats) || 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const extra = {};
    const prefix = `cheat${i}_`;
    for (const [k, v] of Object.entries(kv)) {
      if (k.startsWith(prefix) && !['desc', 'code', 'enable'].includes(k.slice(prefix.length))) extra[k.slice(prefix.length)] = v;
    }
    out.push({ index: i, desc: kv[`${prefix}desc`] || `Cheat ${i + 1}`, code: kv[`${prefix}code`] || '', enable: kv[`${prefix}enable`] === 'true', extra });
  }
  return out;
}

function q(v) { return `"${String(v).replace(/"/g, "'")}"`; }

/** A .cht file with the given cheats, each switched on or off. */
function serializeCht(list) {
  let out = `${MARK}\ncheats = ${list.length}\n`;
  list.forEach((c, i) => {
    out += `\ncheat${i}_desc = ${q(c.desc)}\ncheat${i}_code = ${q(c.code)}\ncheat${i}_enable = ${c.enable ? 'true' : 'false'}\n`;
    for (const [k, v] of Object.entries(c.extra || {})) out += `cheat${i}_${k} = ${q(v)}\n`;
  });
  return out;
}

// ----- where things are ------------------------------------------------------------

/** RetroArch's folder setting, honoring ":\" (= next to retroarch.cfg) and "default". */
function raDir(cfgFile, settings, key, fallback) {
  const base = path.dirname(cfgFile);
  const v = String(settings[key] || '').trim();
  if (!v || v === 'default') return path.join(base, fallback);
  if (v.startsWith(':')) return path.join(base, v.slice(1));
  return v;
}

async function cheatPaths(retroarchCmd) {
  const cfgFile = raSetup.configPath(retroarchCmd);
  const settings = await raSetup.readSettings(cfgFile);
  return {
    cheatDir: raDir(cfgFile, settings, 'cheat_database_path', 'cheats'),
    infoDir: raDir(cfgFile, settings, 'libretro_info_path', 'info'),
  };
}

/** A core's display name ("Snes9x"), which RetroArch uses as the folder for its own cheat files. */
async function coreDisplayName(infoDir, coreName) {
  const base = coreName.replace(/_libretro$/, '');
  try {
    const text = await fsp.readFile(path.join(infoDir, `${base}_libretro.info`), 'utf8');
    const m = /^\s*corename\s*=\s*"([^"]*)"/m.exec(text);
    if (m) return m[1];
  } catch { /* no info file */ }
  return { snes9x: 'Snes9x', fceumm: 'FCEUmm', nestopia: 'Nestopia', genesis_plus_gx: 'Genesis Plus GX', gambatte: 'Gambatte', mgba: 'mGBA', mupen64plus_next: 'Mupen64Plus-Next', pcsx_rearmed: 'PCSX-ReARMed', mednafen_pce_fast: 'Beetle PCE Fast' }[base] || base;
}

// ----- matching a ROM to its database entry ------------------------------------------

/** Lowercase title without region/version tags, for loose matching. */
function titleKey(name) {
  return String(name).replace(/\.[^.]+$/, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/^the\s+|,\s*the\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function tagsOf(name) {
  return new Set([...String(name).matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().toLowerCase())));
}

const dirIndex = new Map(); // folder -> { at, names }
async function listCht(dir) {
  const hit = dirIndex.get(dir);
  if (hit && Date.now() - hit.at < 60e3) return hit.names;
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => /\.cht$/i.test(n)); } catch { /* none */ }
  dirIndex.set(dir, { at: Date.now(), names });
  return names;
}

/** The database .cht for a ROM: exact name first, then the same title (preferring the same region). */
async function findDbCheat(cheatDir, romPath) {
  const system = systems.thumbSystemForRom(romPath);
  if (!system) return null;
  const dir = path.join(cheatDir, system);
  const names = await listCht(dir);
  if (!names.length) return null;
  const base = path.basename(romPath).replace(/\.[^.]+$/, '');
  const exact = names.find((n) => n.slice(0, -4).toLowerCase() === base.toLowerCase());
  if (exact) return path.join(dir, exact);
  const key = titleKey(base);
  if (!key) return null;
  const mine = tagsOf(base);
  let best = null;
  let bestScore = -1;
  for (const n of names) {
    if (titleKey(n) !== key) continue;
    const t = tagsOf(n);
    let score = 0;
    for (const x of t) if (mine.has(x)) score += 3;
    if (!mine.size && t.has('usa')) score += 2; // "Game.zip": most sets are US dumps
    if (t.has('world')) score += 1;
    score -= t.size * 0.1; // fewer extra tags = closer to a plain release
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best ? path.join(dir, best) : null;
}

function hasDatabase(cheatDir) {
  return fs.existsSync(path.join(cheatDir, 'Nintendo - Super Nintendo Entertainment System'))
    || fs.existsSync(path.join(cheatDir, 'Nintendo - Nintendo Entertainment System'));
}

/** Download libretro's cheat database into RetroArch's cheat folder (what RetroArch's "Update Cheats" does). */
async function downloadDatabase(cheatDir, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  const res = await fetchImpl(CHEATS_ZIP_URL);
  if (!res.ok) throw new Error(`Couldn't download the cheat database (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  const label = 'Downloading cheats';
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      onProgress({ label, done: got, total });
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  const zip = new Uint8Array(Buffer.concat(chunks));
  onProgress({ label: 'Unpacking cheats', done: 0, total: 0 });
  const files = unzipSync(zip);
  let n = 0;
  const names = Object.keys(files).filter((name) => !name.endsWith('/') && /\.cht$/i.test(name));
  for (const name of names) {
    const parts = name.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.' || p.includes(':'))) continue;
    const dest = path.join(cheatDir, ...parts);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, files[name]);
    if (++n % 500 === 0) onProgress({ label: 'Unpacking cheats', done: n, total: names.length });
  }
  dirIndex.clear();
  return n;
}

/**
 * Write the per-game file RetroArch loads at start (<cheats>/<Core>/<Game>.cht).
 * A file there that RetroConnect didn't write is kept as a backup first.
 */
async function writeGameCheats(file, list) {
  try {
    const old = await fsp.readFile(file, 'utf8');
    if (!old.startsWith(MARK)) await backupExisting(file);
  } catch { /* none yet */ }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, serializeCht(list));
}

module.exports = {
  parseCht, serializeCht, cheatPaths, coreDisplayName, titleKey, findDbCheat, hasDatabase,
  downloadDatabase, writeGameCheats, CHEATS_ZIP_URL, MARK,
};
