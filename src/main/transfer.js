'use strict';
// Sending other files (not games) to your buddy.
//
// The sender keeps an "outbox": files they picked, each hashed. Their app
// serves exactly those files (by sha256) and lists them in /api/status, so the
// buddy's app sees new ones on its next poll. Nothing downloads until the
// buddy clicks Download; then the file lands in their receive folder (default
// Downloads\RetroConnect), resumable and hash-checked like ROMs.
//
// Only files in the outbox can be fetched: the server looks the sha up in it
// and never takes a path from the network.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
/** sha256 of a file, reporting bytes read as it goes. */
function shaFile(file, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => { h.update(c); n += c.length; if (onBytes) onBytes(n); })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

const MAX_FILES_PER_FOLDER = 5000;
const MAX_LISTED = 500; // most items we publish / accept in one status answer

/** Saved list helper: a JSON array in dataDir. */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Every file under `dir` (recursive), as [{ full, rel }] with rel using "/" and starting with the folder's name. */
async function walk(dir) {
  const base = path.basename(dir);
  const out = [];
  async function go(abs, rel) {
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_FOLDER) throw new Error(`That folder has more than ${MAX_FILES_PER_FOLDER} files. Pick a smaller one, or zip it first.`);
      const full = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await go(full, r);
      else if (e.isFile()) out.push({ full, rel: r });
    }
  }
  await go(dir, base);
  return out;
}

class Outbox {
  constructor(file) {
    this.file = file;
    this.items = readJson(file, []).filter((i) => i && i.id && i.path && i.sha256);
  }

  save() { writeJson(this.file, this.items); }

  /**
   * Add files and/or folders. Hashes each file (onProgress gets bytes done/total).
   * Re-adding a file already in the outbox (same path and sha) is a no-op.
   */
  async add(paths, { onProgress } = {}) {
    const todo = [];
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) throw new Error(`Can't find ${p}`);
      if (st.isDirectory()) {
        const group = path.basename(p);
        for (const f of await walk(p)) todo.push({ ...f, group });
      } else if (st.isFile()) {
        todo.push({ full: p, rel: path.basename(p), group: null });
      }
    }
    if (!todo.length) throw new Error('Nothing to send: that folder is empty');
    const sizes = await Promise.all(todo.map((t) => fsp.stat(t.full).then((s) => s.size)));
    const total = sizes.reduce((a, b) => a + b, 0);
    let done = 0;
    const added = [];
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      const label = `Preparing ${t.rel}`;
      const sha256 = await shaFile(t.full, (n) => onProgress && onProgress({ label, done: done + n, total }));
      done += sizes[i];
      if (onProgress) onProgress({ label, done, total });
      if (this.items.some((x) => x.path === t.full && x.sha256 === sha256)) continue;
      const item = {
        id: crypto.randomBytes(6).toString('hex'),
        name: t.rel, // what the buddy sees and where it lands under their receive folder
        group: t.group,
        path: t.full,
        size: sizes[i],
        sha256,
        addedAt: Date.now(),
      };
      this.items.push(item);
      added.push(item);
    }
    this.save();
    return added;
  }

  remove(ids) {
    const drop = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((i) => !drop.has(i.id) && !(i.group && drop.has(`group:${i.group}`)));
    if (this.items.length !== before) this.save();
  }

  clear() {
    this.items = [];
    this.save();
  }

  /** The path to serve for a sha, only if it's in the outbox and unchanged on disk. */
  async lookup(sha) {
    const item = this.items.find((i) => i.sha256 === sha);
    if (!item) return null;
    const st = await fsp.stat(item.path).catch(() => null);
    if (!st || !st.isFile() || st.size !== item.size) return null;
    return item.path;
  }

  /** What goes over the network: no local paths. */
  publicList() {
    return this.items.slice(0, MAX_LISTED).map(({ id, name, group, size, sha256, addedAt }) => ({ id, name, group, size, sha256, addedAt }));
  }
}

/** Trust nothing from the network: keep only well-formed entries with safe relative names. */
function cleanIncoming(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const i of list.slice(0, MAX_LISTED)) {
    if (!i || typeof i.id !== 'string' || !/^[0-9a-f]{1,32}$/.test(i.id)) continue;
    if (typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256)) continue;
    if (!Number.isSafeInteger(i.size) || i.size < 0) continue;
    let parts;
    try { parts = safeNameParts(i.name); } catch { continue; }
    out.push({
      id: i.id,
      name: parts.join('/'),
      group: typeof i.group === 'string' && i.group ? safeNameParts(i.group)[0] : null,
      size: i.size,
      sha256: i.sha256,
      addedAt: Number.isFinite(i.addedAt) ? i.addedAt : 0,
    });
  }
  return out;
}

// Characters Windows won't allow in a file name, plus control characters.
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Split a sender-supplied name into safe path parts (no .., no drive letters, Windows-safe). */
function safeNameParts(name) {
  if (typeof name !== 'string' || !name || name.length > 1000) throw new Error('bad name');
  const parts = name.replace(/\\/g, '/').split('/').map((p) => p.replace(BAD_CHARS, '_').replace(/[. ]+$/, ''));
  if (name.startsWith('/') || parts.some((p) => !p || p === '.' || p === '..')) throw new Error('bad name');
  return parts.map((p) => (RESERVED.test(p) ? `_${p}` : p));
}

/**
 * Where an incoming file should go under `dir`. If a different file already
 * has that name, picks "name (2).ext" and so on. `already` is true when the
 * same file (same sha) is already there.
 */
async function destFor(dir, name, sha256, shaOf = shaFile) {
  const parts = safeNameParts(name);
  const want = path.join(dir, ...parts);
  const ext = path.extname(want);
  const stem = want.slice(0, want.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? want : `${stem} (${n})${ext}`;
    const st = await fsp.stat(candidate).catch(() => null);
    if (!st) return { dest: candidate, already: false };
    if (st.isFile() && (await shaOf(candidate)) === sha256) return { dest: candidate, already: true };
  }
  throw new Error(`Too many files called ${parts[parts.length - 1]} in ${dir}`);
}

module.exports = { shaFile, Outbox, cleanIncoming, safeNameParts, destFor, readJson, writeJson, walk, MAX_FILES_PER_FOLDER };
