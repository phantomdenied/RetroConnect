'use strict';
// A short description of a game, from Wikipedia's page summary. Looked up
// once per title and cached (misses too, for a while).

const path = require('path');
const systems = require('./systems');
const transfer = require('./transfer');

const UA = 'RetroConnect (https://github.com/phantomdenied/RetroConnect)';
const MISS_TTL_MS = 7 * 24 * 3600e3;

/** "Super Mario World (USA) (Rev 1)" -> "Super Mario World". */
function cleanTitle(romPath) {
  let t = path.basename(String(romPath)).replace(/\.[^.]+$/, '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  // No-Intro puts a leading article last: "Legend of Zelda, The - ..." -> "The Legend of Zelda - ..."
  t = t.replace(/^(.*?), (The|A|An)\b(.*)$/, '$2 $1$3');
  return t.replace(/ ~ .*$/, '').trim();
}

const norm = (s) => String(s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** Does a Wikipedia page title plausibly name this game? */
function titleFits(pageTitle, game) {
  const a = norm(pageTitle);
  const b = norm(game);
  if (!a || !b) return false;
  if (a === b) return true;
  // Sequel numbers must agree: "Sonic the Hedgehog 2" isn't "Sonic the Hedgehog".
  const nums = (s) => (String(s).replace(/\([^)]*\)/g, '').match(/\b(\d+|I{2,3}|IV|VI{0,3}|IX)\b/g) || []).join(',');
  if (nums(pageTitle) !== nums(game)) return false;
  // A subtitle dropped by one side: "Super Mario All-Stars + Super Mario World" vs
  // "Super Mario All-Stars", "1943 - The Battle of Midway" vs "1943: The Battle of Midway".
  // Never a plain prefix: "Donkey Kong" isn't "Donkey Kong Country".
  const head = (s) => norm(String(s).replace(/\([^)]*\)/g, '').split(/\s[-+~]\s|:\s/)[0]);
  const ha = head(pageTitle);
  const hb = head(game);
  return (ha.length >= 4 && ha === b) || (hb.length >= 4 && hb === a);
}

class DescriptionCache {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.pending = new Map();
  }

  load() {
    if (!this.data) this.data = transfer.readJson(this.file, {});
    return this.data;
  }

  get(key) {
    const hit = this.load()[key];
    if (!hit) return undefined;
    if (!hit.text && Date.now() - (hit.at || 0) > MISS_TTL_MS) return undefined;
    return hit;
  }

  set(key, value) {
    this.load()[key] = { ...value, at: Date.now() };
    try { transfer.writeJson(this.file, this.data); } catch { /* cache only */ }
  }
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function lookup(title, system, fetchImpl) {
  const queries = [`${title} ${system || ''} video game`, `${title} video game`];
  for (const q of queries) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&srsearch=${encodeURIComponent(q)}`;
    const found = await getJson(fetchImpl, url);
    const hits = ((found.query || {}).search || []).map((s) => s.title);
    // Best first: "Title (video game)" pages, then the exact title, then close ones.
    const isGamePage = (t) => /\((\d{4} )?video game\)$/i.test(t) && titleFits(t, title);
    const pages = [...new Set([
      ...hits.filter(isGamePage),
      ...hits.filter((t) => norm(t) === norm(title)),
      ...hits.filter((t) => titleFits(t, title)),
    ])].slice(0, 3);
    for (const page of pages) {
      const sum = await getJson(fetchImpl, `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.replace(/ /g, '_'))}`);
      if (sum.type === 'disambiguation' || !sum.extract) continue;
      if (/franchise|series|media|character/i.test(sum.description || '') && !/video game$/i.test(sum.description || '')) continue;
      return {
        title: sum.title,
        text: sum.extract,
        url: ((sum.content_urls || {}).desktop || {}).page || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`,
      };
    }
  }
  return null;
}

/** { title, text, url, source } or null. Network failures aren't cached. */
async function describe(cache, romPath, { fetchImpl = globalThis.fetch } = {}) {
  const title = cleanTitle(romPath);
  const sysLong = systems.thumbSystemForRom(romPath);
  const system = sysLong ? sysLong.replace(/^[^-]+ - /, '').replace(/ - .*$/, '') : '';
  const key = `${norm(title)}|${norm(system)}`;
  const hit = cache.get(key);
  if (hit) return hit.text ? { title: hit.title, text: hit.text, url: hit.url, source: 'Wikipedia' } : null;
  if (!cache.pending.has(key)) {
    cache.pending.set(key, lookup(title, system, fetchImpl)
      .then((r) => { cache.set(key, r || { text: null }); return r; })
      .finally(() => cache.pending.delete(key)));
  }
  const r = await cache.pending.get(key);
  return r ? { ...r, source: 'Wikipedia' } : null;
}

module.exports = { describe, cleanTitle, titleFits, DescriptionCache };
