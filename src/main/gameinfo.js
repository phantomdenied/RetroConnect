'use strict';
// Facts for the Games page filters:
//   - system, language and hack/homebrew come from the ROM's folders and its
//     No-Intro / GoodTools name tags ("(USA)", "(En,Fr,De)", "[T+Eng]", "Hacks/");
//   - player count and genre come from libretro-database (the data RetroArch
//     itself uses), fetched once per system and cached, matched by the game's
//     No-Intro name or the ROM's CRC32.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const systems = require('./systems');

const DB_BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat';
const DB_TTL_MS = 30 * 24 * 3600e3;
const DB_RETRY_MS = 6 * 3600e3; // after a failed download

// Region -> the language a game from there is most likely in (when the name
// carries no explicit language tag).
const REGION_LANG = {
  USA: 'en', World: 'en', Europe: 'en', UK: 'en', Australia: 'en', Canada: 'en',
  Japan: 'ja', Germany: 'de', France: 'fr', Spain: 'es', Italy: 'it', Netherlands: 'nl',
  Sweden: 'sv', Brazil: 'pt', Portugal: 'pt', Korea: 'ko', China: 'zh', Taiwan: 'zh',
  Hong: 'zh', Russia: 'ru', Asia: 'en',
};
const LANG_CODES = new Set(['en', 'ja', 'fr', 'de', 'es', 'it', 'nl', 'pt', 'sv', 'no', 'da', 'fi', 'zh', 'ko', 'pl', 'ru', 'ca', 'el', 'cs', 'hu', 'tr', 'ar']);
// GoodTools translation tags: [T+Eng], [T-Fre], [T+Spa1.1] ...
const GOOD_LANG = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', bra: 'pt', dut: 'nl', swe: 'sv', rus: 'ru', chi: 'zh', kor: 'ko', jap: 'ja', pol: 'pl' };

const LANG_NAMES = {
  en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', nl: 'Dutch',
  pt: 'Portuguese', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', zh: 'Chinese', ko: 'Korean',
  pl: 'Polish', ru: 'Russian', ca: 'Catalan', el: 'Greek', cs: 'Czech', hu: 'Hungarian', tr: 'Turkish', ar: 'Arabic',
};

/** File name without folders or extension. */
function baseName(romPath) {
  return String(romPath).split(/[\\/]+/).pop().replace(/\.[^.]+$/, '');
}

/** Languages a ROM is (most likely) in, as ISO codes. */
function languagesOf(romPath) {
  const base = baseName(romPath);
  // A fan translation wins: it's what the game now shows.
  const tr = /\[T[+-]([A-Za-z]{3})/.exec(base);
  if (tr && GOOD_LANG[tr[1].toLowerCase()]) return [GOOD_LANG[tr[1].toLowerCase()]];
  const groups = [...base.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  // Explicit No-Intro language list: "(En,Fr,De)" or "(En+Ja)".
  for (const g of groups) {
    const parts = g.split(/[,+]/).map((p) => p.trim().toLowerCase());
    if (parts.length && parts.every((p) => LANG_CODES.has(p))) return [...new Set(parts)];
  }
  // Otherwise infer from the region tag: "(USA, Europe)", "(Japan)".
  const langs = new Set();
  for (const g of groups) {
    for (const region of g.split(',').map((p) => p.trim())) {
      const lang = REGION_LANG[region] || REGION_LANG[region.split(' ')[0]];
      if (lang) langs.add(lang);
    }
  }
  // GoodTools single-letter regions: "(U)", "(J)", "(E)", "(UE)", "(JU)".
  if (!langs.size) {
    for (const g of groups) {
      if (/^[UEJWGFSKB]{1,4}$/.test(g)) {
        for (const c of g) langs.add({ U: 'en', E: 'en', W: 'en', J: 'ja', G: 'de', F: 'fr', S: 'es', K: 'ko', B: 'pt' }[c]);
      }
    }
  }
  return [...langs];
}

/** 'hack', 'homebrew' or 'official'. */
function kindOf(romPath) {
  const p = String(romPath);
  const dirs = p.split(/[\\/]+/).slice(0, -1).join('/');
  const base = baseName(p);
  if (/\bhacks?\b|translations?\b/i.test(dirs) || /\((hack|[^)]*\bhack)\)|\[(h\d*[^\]]*|T[+-][^\]]*)\]/i.test(base)) return 'hack';
  if (/homebrew|\bhomebrews?\b/i.test(dirs) || /\((homebrew|pd|aftermarket)\)/i.test(base)) return 'homebrew';
  return 'official';
}

/** Parse a libretro-database clrmamepro .dat into { byName, byCrc } of one field. */
function parseDat(text, field) {
  const byName = new Map();
  const byCrc = new Map();
  const re = new RegExp(`game \\(([\\s\\S]*?)\\n\\)`, 'g');
  const fieldRe = new RegExp(`^\\s*${field}\\s+(?:"([^"]*)"|(\\S+))`, 'm');
  for (const m of text.matchAll(re)) {
    const body = m[1];
    const f = fieldRe.exec(body);
    if (!f) continue;
    const value = f[1] !== undefined ? f[1] : f[2];
    const name = (/^\s*(?:comment|name)\s+"([^"]*)"/m.exec(body) || [])[1];
    if (name) byName.set(name.toLowerCase(), value);
    for (const c of body.matchAll(/crc\s+([0-9A-Fa-f]{8})/g)) byCrc.set(c[1].toLowerCase(), value);
  }
  return { byName, byCrc };
}

class GameInfoDb {
  /** dir: cache folder. */
  constructor(dir, { fetchImpl = globalThis.fetch } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.dbs = new Map(); // system -> { users, genre } (parsed), or a Promise while loading
    this.failedAt = new Map();
  }

  file(system, kind) {
    return path.join(this.dir, `${kind}-${system.replace(/[^A-Za-z0-9]+/g, '_')}.dat`);
  }

  async loadOne(system, kind) {
    const file = this.file(system, kind);
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs < DB_TTL_MS) return await fsp.readFile(file, 'utf8');
    } catch { /* not cached yet */ }
    try {
      const res = await this.fetchImpl(`${DB_BASE}/${kind}/${encodeURIComponent(system)}.dat`);
      if (res.status === 404) { await fsp.mkdir(this.dir, { recursive: true }); await fsp.writeFile(file, ''); return ''; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(file, text);
      return text;
    } catch (err) {
      // Offline: use a stale copy if there is one.
      try { return await fsp.readFile(file, 'utf8'); } catch { throw err; }
    }
  }

  /** Make sure a system's data is loaded. Resolves true if it became available now. */
  ensure(system) {
    if (!system || this.dbs.has(system)) return Promise.resolve(false);
    const failed = this.failedAt.get(system);
    if (failed && Date.now() - failed < DB_RETRY_MS) return Promise.resolve(false);
    const p = (async () => {
      const [users, genre] = await Promise.all([this.loadOne(system, 'maxusers'), this.loadOne(system, 'genre')]);
      this.dbs.set(system, { users: parseDat(users, 'users'), genre: parseDat(genre, 'genre') });
      return true;
    })().catch(() => { this.dbs.delete(system); this.failedAt.set(system, Date.now()); return false; });
    this.dbs.set(system, p);
    return p;
  }

  /** { players, genre } for a ROM if its system's data is loaded; nulls otherwise. */
  lookup(romPath, crc32) {
    const system = systems.thumbSystemForRom(romPath);
    const db = system && this.dbs.get(system);
    if (!db || typeof db.then === 'function') return { players: null, genre: null, system };
    const name = baseName(romPath).toLowerCase();
    // A .zip's own CRC isn't the game's; only trust the CRC for bare ROMs.
    const crc = !/\.zip$/i.test(romPath) && crc32 ? String(crc32).toLowerCase() : null;
    const pick = (d) => d.byName.get(name) || (crc && d.byCrc.get(crc)) || null;
    const users = pick(db.users);
    return { players: users ? Number(users) || null : null, genre: pick(db.genre), system };
  }
}

/** Display name of a system for a ROM ("Super Nintendo Entertainment System"). */
function systemLabel(romPath) {
  const t = systems.thumbSystemForRom(romPath);
  if (t) return t.replace(/^[^-]+ - /, '').replace(/^Arcade Games$/, 'Arcade');
  const ext = path.extname(String(romPath)).slice(1).toLowerCase();
  return ext ? ext.toUpperCase() : 'Other';
}

module.exports = { languagesOf, kindOf, parseDat, GameInfoDb, systemLabel, baseName, LANG_NAMES };
