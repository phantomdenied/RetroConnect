'use strict';
// Box art from libretro's free thumbnail server (the same one RetroArch uses):
//   https://thumbnails.libretro.com/<System>/Named_Boxarts/<No-Intro name>.png
// Names must match exactly ("Tetris (World) (Rev 1)"), so we try the ROM's
// own name first, then match its cleaned-up title against the system's file
// list. No confident match = no art (better than the wrong cover).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

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
    try { return Date.now() - fs.statSync(path.join(this.dir, `${sha}.none`)).mtimeMs < NEGATIVE_TTL_MS; } catch { return false; }
  }

  /** Queue a lookup; resolves true if art is now cached. */
  ensure(sha, romPath) {
    const ext = path.extname(romPath).slice(1).toLowerCase();
    if (!SYSTEMS[ext] || this.has(sha) || this.isNegative(sha) || this.pending.has(sha)) return Promise.resolve(this.has(sha));
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

  async get(url) {
    const res = await this.fetchImpl(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  async index(system) {
    if (!this.indexes.has(system)) {
      this.indexes.set(system, (async () => {
        const file = path.join(this.dir, `index-${system.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
        try {
          const st = await fsp.stat(file);
          if (Date.now() - st.mtimeMs < INDEX_TTL_MS) return JSON.parse(await fsp.readFile(file, 'utf8'));
        } catch { /* not cached yet */ }
        const res = await this.fetchImpl(`${BASE}/${encodeURIComponent(system)}/Named_Boxarts/`);
        if (!res.ok) return [];
        const html = await res.text();
        const names = [...new Set([...html.matchAll(/href="([^"/]+)\.png"/g)].map((m) => {
          try { return decodeURIComponent(m[1]); } catch { return null; }
        }).filter(Boolean))];
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(file, JSON.stringify(names));
        return names;
      })().catch(() => []));
    }
    return this.indexes.get(system);
  }

  async fetchOne(sha, romPath) {
    const ext = path.extname(romPath).slice(1).toLowerCase();
    const system = SYSTEMS[ext];
    const base = path.basename(romPath).replace(/\.[^.]+$/, '');
    const tries = [base, base.replace(/\s*\[[^\]]*\]/g, '').trim()];
    if (!/\(/.test(base)) for (const r of ['USA', 'World', 'Europe', 'Japan']) tries.push(`${base} (${r})`);
    let png = null;
    for (const name of [...new Set(tries)]) {
      png = await this.get(thumbUrl(system, name));
      if (png) break;
    }
    if (!png) {
      const match = bestMatch(await this.index(system), base);
      if (match) png = await this.get(thumbUrl(system, match));
    }
    await fsp.mkdir(this.dir, { recursive: true });
    if (!png) {
      await fsp.writeFile(path.join(this.dir, `${sha}.none`), '');
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

module.exports = { ThumbCache, SYSTEMS, sanitize, cleanTitle, regionOf, bestMatch, thumbUrl, key };
