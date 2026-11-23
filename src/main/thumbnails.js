'use strict';
// Box art from libretro's free thumbnail server (the same one RetroArch uses):
//   https://thumbnails.libretro.com/<System>/Named_Boxarts/<No-Intro name>.png
// Names must match exactly ("Tetris (World) (Rev 1)"), so we try the ROM's
// own name first, then match its cleaned-up title against the system's file
// list. No confident match = no art (better than the wrong cover).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const systems = require('./systems');

const BASE = 'https://thumbnails.libretro.com';

// File extension -> libretro system folder.
const SYSTEMS = {
  nes: 'Nintendo - Nintendo Entertainment System', unf: 'Nintendo - Nintendo Entertainment System',
  fds: 'Nintendo - Family Computer Disk System',
  sfc: 'Nintendo - Super Nintendo Entertainment System', smc: 'Nintendo - Super Nintendo Entertainment System',
  gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color', gba: 'Nintendo - Game Boy Advance',
  n64: 'Nintendo - Nintendo 64', z64: 'Nintendo - Nintendo 64', v64: 'Nintendo - Nintendo 64',
  md: 'Sega - Mega Drive - Genesis', gen: 'Sega - Mega Drive - Genesis', smd: 'Sega - Mega Drive - Genesis',
  sms: 'Sega - Master System - Mark III', gg: 'Sega - Game Gear',
  pce: 'NEC - PC Engine - TurboGrafx 16', a26: 'Atari - 2600',
};

/**
 * libretro system folder for a ROM: from the system its folders name (zipped
 * sets are the norm), else from its extension.
 */
function systemFor(romPath) {
  if (systems.systemFromFolders(romPath)) return systems.thumbSystemForRom(romPath);
  return SYSTEMS[path.extname(String(romPath)).slice(1).toLowerCase()] || null;
}

const REGION_ORDER = ['USA', 'World', 'USA, Europe', 'Europe', 'Japan'];
const NEGATIVE_TTL_MS = 7 * 24 * 3600e3;
const INDEX_TTL_MS = 14 * 24 * 3600e3;

/** libretro replaces these characters with "_" in thumbnail file names. */
function sanitize(name) {
  return name.replace(/[&*/:`<>?\\|"]/g, '_');
}

/** "Legend of Zelda, The - A Link to the Past (USA) [!]" -> "The Legend of Zelda - A Link to the Past" */
function cleanTitle(base) {
  let t = String(base).replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // No-Intro puts articles last: "Legend of Zelda, The - ..." / "Addams Family, The"
  t = t.replace(/^(.+?), (The|A|An)(?=$| - |: )/, '$2 $1');
  return t || String(base);
}

function regionOf(base) {
  const m = /\(([^)]*(USA|Europe|Japan|World|Korea|Brazil|Australia|Germany|France|Spain|Italy|China|Asia)[^)]*)\)/i.exec(base);
  return m ? m[1] : null;
}

function key(title) {
  return cleanTitle(title).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function words(title) {
  return cleanTitle(title).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Pick the best entry in a system's thumbnail list for a ROM name.
 * 1) same title ignoring punctuation/tags; 2) otherwise every word of your
 * title appears in exactly one game's title with at most 2 extra words
 * ("pokemon emerald" -> "Pokemon - Emerald Version"). Ambiguous = no match.
 */
function bestMatch(names, romBase) {
  const want = key(romBase);
  if (!want) return null;
  let pool = names.filter((n) => key(n) === want);
  if (!pool.length) {
    const mine = words(romBase);
    if (mine.length >= 2) {
      const loose = names.filter((n) => {
        const theirs = words(n);
        return mine.every((w) => theirs.includes(w)) && theirs.length - mine.length <= 2;
      });
      if (new Set(loose.map(key)).size === 1) pool = loose;
    }
  }
  const wantRegion = regionOf(romBase);
  const scored = pool.map((n) => {
    const region = regionOf(n) || '';
    let score = 0;
    if (wantRegion && region === wantRegion) score += 100;
    const r = REGION_ORDER.indexOf(region);
    score += r === -1 ? 0 : 50 - r * 5;
    score -= (n.match(/\(/g) || []).length; // fewer extra tags (Rev, Beta, ...) is better
    if (/\((Beta|Proto|Demo|Sample|Pirate|Unl)/i.test(n)) score -= 40;
    return { n, score };
  });
  scored.sort((a, b) => b.score - a.score || a.n.length - b.n.length);
  return scored.length ? scored[0].n : null;
}

function thumbUrl(system, name) {
  return `${BASE}/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(sanitize(name))}.png`;
}

// The same covers live on GitHub (one repo per system, spaces -> "_"), which
// keeps working when thumbnails.libretro.com is down or empty.
const GITHUB_RAW = 'https://raw.githubusercontent.com/libretro-thumbnails';
const GITHUB_API = 'https://api.github.com/repos/libretro-thumbnails';
const repoOf = (system) => encodeURIComponent(system.replace(/ /g, '_'));

function githubUrl(system, name) {
  return `${GITHUB_RAW}/${repoOf(system)}/master/Named_Boxarts/${encodeURIComponent(sanitize(name))}.png`;
}

/** "Game (USA).7z" -> "Game (USA)"; "I.Q - Intelligent Qube (USA)" (no extension) stays whole. */
function romBase(romPath) {
  return path.basename(String(romPath)).replace(/\.[a-z0-9]{1,4}$/i, '');
}

// "Not found" markers. Renamed from .none so misses recorded while the
// server was down are forgotten.
const MISS = '.miss';

class ThumbCache {
  /**
   * dir: cache folder; resize(buffer) -> smaller PNG buffer (optional).
   */
  constructor(dir, { fetchImpl = globalThis.fetch, resize = null, concurrency = 2 } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.resize = resize;
    this.concurrency = concurrency;
    this.queue = [];
    this.active = 0;
    this.pending = new Set();
    this.indexes = new Map(); // system -> Promise<string[]>
  }

  file(sha) { return path.join(this.dir, `${sha}.png`); }

  has(sha) { return fs.existsSync(this.file(sha)); }

  isNegative(sha) {
    try { return Date.now() - fs.statSync(path.join(this.dir, `${sha}${MISS}`)).mtimeMs < NEGATIVE_TTL_MS; } catch { return false; }
  }

  /** Forget every "no art found" and empty game list, so they are looked up again. Returns how many games. */
  async forgetMisses() {
    let n = 0;
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { return 0; }
    for (const f of names) {
      const full = path.join(this.dir, f);
      if (f.endsWith(MISS) || f.endsWith('.none')) {
        await fsp.rm(full, { force: true });
        if (f.endsWith(MISS)) n++;
      } else if (/^index-.*\.json$/.test(f)) {
        try { if (!JSON.parse(await fsp.readFile(full, 'utf8')).length) await fsp.rm(full, { force: true }); } catch { await fsp.rm(full, { force: true }); }
      }
    }
    this.indexes.clear();
    return n;
  }

  /** Queue a lookup; resolves true if art is now cached. */
  ensure(sha, romPath) {
    if (!systemFor(romPath) || this.has(sha) || this.isNegative(sha) || this.pending.has(sha)) return Promise.resolve(this.has(sha));
    this.pending.add(sha);
    return new Promise((resolve) => {
      this.queue.push({ sha, romPath, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.fetchOne(job.sha, job.romPath)
        .catch(() => false)
        .then((ok) => { this.active--; this.pending.delete(job.sha); job.resolve(ok); this.pump(); });
    }
  }

  async get(url, hops = 0) {
    let res;
    try { res = await this.fetchImpl(url); } catch { return null; }
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
    // On GitHub, a cover shared by several names is a symlink: its "file" is the target's name.
    if (url.startsWith(GITHUB_RAW) && type.startsWith('text/plain') && hops < 2 && res.text) {
      const target = (await res.text()).trim();
      if (/^[^\n]{1,250}\.png$/i.test(target)) return this.get(new URL(target.split('/').map(encodeURIComponent).join('/'), url).href, hops + 1);
    }
    return null;
  }

  /** Try libretro's server, then GitHub (first, once GitHub has had a cover the server didn't). */
  async getCover(system, name) {
    const urls = [thumbUrl(system, name), githubUrl(system, name)];
    if (this.preferGithub) urls.reverse();
    for (const u of urls) {
      const png = await this.get(u);
      if (png) {
        if (u.startsWith(GITHUB_RAW)) this.preferGithub = true;
        return png;
      }
    }
    return null;
  }

  async listFromServer(system) {
    try {
      const res = await this.fetchImpl(`${BASE}/${encodeURIComponent(system)}/Named_Boxarts/`);
      if (!res.ok) return [];
      const html = await res.text();
      return [...new Set([...html.matchAll(/href="([^"/]+)\.png"/g)].map((m) => {
        try { return decodeURIComponent(m[1]); } catch { return null; }
      }).filter(Boolean))];
    } catch { return []; }
  }

  async listFromGithub(system) {
    try {
      const res = await this.fetchImpl(`${GITHUB_API}/${repoOf(system)}/git/trees/master:Named_Boxarts`,
        { headers: { 'User-Agent': 'RetroConnect (https://github.com/phantomdenied/RetroConnect)', Accept: 'application/vnd.github+json' } });
      if (!res.ok) return [];
      const j = await res.json();
      return (j.tree || []).filter((t) => /\.png$/i.test(t.path)).map((t) => t.path.replace(/\.png$/i, ''));
    } catch { return []; }
  }

  async index(system) {
    if (!this.indexes.has(system)) {
      this.indexes.set(system, (async () => {
        const file = path.join(this.dir, `index-${system.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
        try {
          const st = await fsp.stat(file);
          if (Date.now() - st.mtimeMs < INDEX_TTL_MS) {
            const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
            if (cached.length) return cached;
          }
        } catch { /* not cached yet */ }
        let names = await this.listFromServer(system);
        if (!names.length) names = await this.listFromGithub(system);
        if (!names.length) {
          this.indexes.delete(system); // couldn't reach either: try again next time
          return [];
        }
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(file, JSON.stringify(names));
        return names;
      })().catch(() => { this.indexes.delete(system); return []; }));
    }
    return this.indexes.get(system);
  }

  async fetchOne(sha, romPath) {
    const system = systemFor(romPath);
    const base = romBase(romPath);
    const tries = [base, base.replace(/\s*\[[^\]]*\]/g, '').trim()];
    if (!/\(/.test(base)) for (const r of ['USA', 'World', 'Europe', 'Japan']) tries.push(`${base} (${r})`);
    let png = null;
    for (const name of [...new Set(tries)]) {
      png = await this.getCover(system, name);
      if (png) break;
    }
    let list = null;
    if (!png) {
      list = await this.index(system);
      const match = bestMatch(list, base);
      if (match) png = await this.getCover(system, match);
    }
    await fsp.mkdir(this.dir, { recursive: true });
    if (!png) {
      // Only remember "no art" when we could actually see the system's list;
      // a server that's down shouldn't hide covers for a week.
      if (list && list.length) await fsp.writeFile(path.join(this.dir, `${sha}${MISS}`), '');
      return false;
    }
    if (this.resize) {
      try { png = await this.resize(png); } catch { /* keep original */ }
    }
    await fsp.writeFile(`${this.file(sha)}.part`, png);
    await fsp.rename(`${this.file(sha)}.part`, this.file(sha));
    return true;
  }
}

module.exports = { ThumbCache, SYSTEMS, sanitize, cleanTitle, regionOf, bestMatch, thumbUrl, githubUrl, romBase, key };
