'use strict';
// ROM patches (IPS, BPS, UPS) with checks that the ROM is the right one.
//
// * BPS and UPS carry CRC32s of the exact source ROM, the result and the patch
//   itself, so a wrong ROM is always caught.
// * IPS carries nothing. We look for the expected hash (CRC32 / MD5 / SHA-1)
//   in the readme that ships with the patch, or one the user types in; with
//   none, the caller must ask the user to confirm.
// * SNES dumps sometimes carry a 512-byte copier header. If the expected hash
//   matches the ROM without it, the header is dropped before patching.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { unzipSync } = require('fflate');
const { crc32Update } = require('./library');

const crc32 = (buf) => crc32Update(0, buf) >>> 0;
const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const PATCH_EXT = /\.(ips|bps|ups)$/i;
const README_EXT = /\.(txt|nfo|htm|html|diz|1st|me)$/i; // not .md: that's a Genesis ROM

class PatchError extends Error {}

// ----- formats ---------------------------------------------------------------

function formatOf(buf) {
  const head = Buffer.from(buf.subarray(0, 5)).toString('latin1');
  if (head === 'PATCH') return 'ips';
  if (head.startsWith('BPS1')) return 'bps';
  if (head.startsWith('UPS1')) return 'ups';
  return null;
}

/** IPS: [offset:3][size:2][data] records, size 0 = RLE; "EOF", then an optional 3-byte truncate length. */
function applyIps(rom, patch) {
  let p = 5;
  const writes = [];
  let end = rom.length;
  let truncate = null;
  for (;;) {
    if (p + 3 > patch.length) throw new PatchError('This IPS patch is cut off (no EOF marker)');
    if (patch[p] === 0x45 && patch[p + 1] === 0x4f && patch[p + 2] === 0x46 && (p + 3 === patch.length || p + 6 === patch.length)) {
      if (p + 6 === patch.length) truncate = (patch[p + 3] << 16) | (patch[p + 4] << 8) | patch[p + 5];
      break;
    }
    if (p + 5 > patch.length) throw new PatchError('This IPS patch is cut off');
    const off = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
    const size = (patch[p + 3] << 8) | patch[p + 4];
    p += 5;
    if (size) {
      if (p + size > patch.length) throw new PatchError('This IPS patch is cut off');
      writes.push([off, patch.subarray(p, p + size)]);
      p += size;
      end = Math.max(end, off + size);
    } else {
      if (p + 3 > patch.length) throw new PatchError('This IPS patch is cut off');
      const run = (patch[p] << 8) | patch[p + 1];
      writes.push([off, Buffer.alloc(run, patch[p + 2])]);
      p += 3;
      end = Math.max(end, off + run);
    }
  }
  const out = Buffer.alloc(end);
  Buffer.from(rom).copy(out);
  for (const [off, data] of writes) Buffer.from(data).copy(out, off);
  return truncate !== null ? out.subarray(0, truncate) : out;
}

function varint(buf, pos) {
  let data = 0;
  let shift = 1;
  for (;;) {
    if (pos.i >= buf.length) throw new PatchError('This patch is cut off');
    const x = buf[pos.i++];
    data += (x & 0x7f) * shift;
    if (x & 0x80) break;
    shift *= 128;
    data += shift;
  }
  return data;
}

const u32le = (buf, at) => (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;

/** BPS/UPS footer: source, target and patch CRC32s. */
function footer(patch) {
  if (patch.length < 16) throw new PatchError('This patch is too short');
  const n = patch.length;
  return { source: u32le(patch, n - 12), target: u32le(patch, n - 8), patch: u32le(patch, n - 4) };
}

function checkPatchCrc(patch) {
  const f = footer(patch);
  if (crc32(patch.subarray(0, patch.length - 4)) !== f.patch) throw new PatchError('This patch file is damaged (its own checksum is wrong). Download it again.');
  return f;
}

function applyBps(rom, patch) {
  const f = checkPatchCrc(patch);
  const pos = { i: 4 };
  const sourceSize = varint(patch, pos);
  const targetSize = varint(patch, pos);
  const metaSize = varint(patch, pos);
  pos.i += metaSize;
  if (rom.length !== sourceSize) throw new PatchError(`Wrong ROM: the patch expects ${sourceSize} bytes, this one is ${rom.length}`);
  if (crc32(rom) !== f.source) throw new PatchError(`Wrong ROM: the patch expects CRC32 ${hex8(f.source)}, this one is ${hex8(crc32(rom))}`);
  const out = Buffer.alloc(targetSize);
  let o = 0;
  let srcRel = 0;
  let dstRel = 0;
  const end = patch.length - 12;
  while (pos.i < end) {
    const data = varint(patch, pos);
    const cmd = data & 3;
    const len = Math.floor(data / 4) + 1;
    if (o + len > targetSize) throw new PatchError('This BPS patch is damaged (writes past the end)');
    if (cmd === 0) { // SourceRead
      Buffer.from(rom).copy(out, o, o, o + len);
      o += len;
    } else if (cmd === 1) { // TargetRead
      Buffer.from(patch).copy(out, o, pos.i, pos.i + len);
      pos.i += len;
      o += len;
    } else {
      const d = varint(patch, pos);
      const delta = (d & 1 ? -1 : 1) * Math.floor(d / 2);
      if (cmd === 2) { // SourceCopy
        srcRel += delta;
        Buffer.from(rom).copy(out, o, srcRel, srcRel + len);
        srcRel += len;
        o += len;
      } else { // TargetCopy (may overlap, so byte by byte)
        dstRel += delta;
        for (let k = 0; k < len; k++) out[o++] = out[dstRel++];
      }
    }
  }
  if (crc32(out) !== f.target) throw new PatchError("The patched ROM didn't come out right (checksum mismatch). Nothing was saved.");
  return out;
}

function applyUps(rom, patch) {
  const f = checkPatchCrc(patch);
  const pos = { i: 4 };
  const sizeA = varint(patch, pos);
  const sizeB = varint(patch, pos);
  const crc = crc32(rom);
  if (rom.length !== sizeA || crc !== f.source) {
    throw new PatchError(`Wrong ROM: the patch expects CRC32 ${hex8(f.source)} (${sizeA} bytes), this one is ${hex8(crc)} (${rom.length} bytes)`);
  }
  const out = Buffer.alloc(sizeB);
  Buffer.from(rom).copy(out, 0, 0, Math.min(rom.length, sizeB));
  let o = 0;
  const end = patch.length - 12;
  while (pos.i < end) {
    o += varint(patch, pos);
    for (;;) {
      const x = patch[pos.i++];
      if (o < sizeB) out[o] = (o < rom.length ? rom[o] : 0) ^ x;
      o++;
      if (!x) break;
    }
  }
  if (crc32(out) !== f.target) throw new PatchError("The patched ROM didn't come out right (checksum mismatch). Nothing was saved.");
  return out;
}

function applyPatch(rom, patch) {
  const fmt = formatOf(patch);
  if (fmt === 'ips') return applyIps(rom, patch);
  if (fmt === 'bps') return applyBps(rom, patch);
  if (fmt === 'ups') return applyUps(rom, patch);
  throw new PatchError("That isn't an IPS, BPS or UPS patch");
}

// ----- what ROM does a patch want? ---------------------------------------------

/** Hashes named in a readme: { crc32: [], md5: [], sha1: [] } (lowercase, unique). */
function hashesFromText(text) {
  const out = { crc32: new Set(), md5: new Set(), sha1: new Set() };
  const s = String(text || '');
  for (const m of s.matchAll(/SHA-?1[^0-9a-f\n]{0,40}([0-9a-f]{40})\b/gi)) out.sha1.add(m[1].toLowerCase());
  for (const m of s.matchAll(/MD-?5[^0-9a-f\n]{0,40}([0-9a-f]{32})\b/gi)) out.md5.add(m[1].toLowerCase());
  for (const m of s.matchAll(/CRC-?(?:32)?[^0-9a-f\n]{0,40}(?:0x)?([0-9a-f]{8})\b/gi)) out.crc32.add(m[1].toLowerCase());
  return { crc32: [...out.crc32], md5: [...out.md5], sha1: [...out.sha1] };
}

/** One hash string the user typed (CRC32, MD5 or SHA-1, by length). */
function hashesFromUser(s) {
  const h = String(s || '').trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{8}$/.test(h)) return { crc32: [h], md5: [], sha1: [] };
  if (/^[0-9a-f]{32}$/.test(h)) return { crc32: [], md5: [h], sha1: [] };
  if (/^[0-9a-f]{40}$/.test(h)) return { crc32: [], md5: [], sha1: [h] };
  return null;
}

function hashesOf(buf) {
  return {
    crc32: hex8(crc32(buf)),
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    sha1: crypto.createHash('sha1').update(buf).digest('hex'),
  };
}

function matchesAny(h, want) {
  if (!want) return null;
  if (want.sha1.includes(h.sha1)) return `SHA-1 ${h.sha1}`;
  if (want.md5.includes(h.md5)) return `MD5 ${h.md5}`;
  if (want.crc32.includes(h.crc32)) return `CRC32 ${h.crc32}`;
  return null;
}

const hasAny = (want) => Boolean(want && (want.crc32.length || want.md5.length || want.sha1.length));

/**
 * Read a patch file, or a .zip holding patches and readmes.
 * Resolves to { patches: [{ name, format, data, source?, target? }], readmeHashes, readmeName }.
 */
async function readPatchInput(file) {
  const raw = new Uint8Array(await fsp.readFile(file));
  const patches = [];
  const readmes = [];
  if (raw[0] === 0x50 && raw[1] === 0x4b) {
    let entries;
    try { entries = unzipSync(raw, { filter: (f) => PATCH_EXT.test(f.name) || README_EXT.test(f.name) }); } catch { throw new PatchError("That zip couldn't be opened"); }
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      if (PATCH_EXT.test(name)) patches.push({ name, data: Buffer.from(data) });
      else readmes.push({ name, text: Buffer.from(data).toString('latin1') });
    }
  } else {
    patches.push({ name: path.basename(file), data: Buffer.from(raw) });
    // A readme next to a loose patch often has the hashes too.
    const dir = path.dirname(file);
    for (const n of await fsp.readdir(dir).catch(() => [])) {
      if (README_EXT.test(n)) {
        const st = await fsp.stat(path.join(dir, n)).catch(() => null);
        if (st && st.size < 512 * 1024) readmes.push({ name: n, text: await fsp.readFile(path.join(dir, n), 'latin1') });
      }
    }
  }
  const out = [];
  for (const p of patches) {
    const format = formatOf(p.data);
    if (!format) continue;
    const info = { name: p.name, format, size: p.data.length, data: p.data };
    if (format !== 'ips') {
      const f = footer(p.data);
      info.source = hex8(f.source);
      info.target = hex8(f.target);
    }
    out.push(info);
  }
  if (!out.length) throw new PatchError('No IPS, BPS or UPS patch found in that file');
  const merged = { crc32: [], md5: [], sha1: [] };
  for (const r of readmes) {
    const h = hashesFromText(r.text);
    for (const k of Object.keys(merged)) merged[k].push(...h[k].filter((x) => !merged[k].includes(x)));
  }
  return { patches: out, readmeHashes: merged, readmeNames: readmes.map((r) => r.name) };
}

// ----- ROM files ---------------------------------------------------------------

/** The game data inside a ROM file: a bare ROM, or the one content file in a .zip. */
async function readRomData(file) {
  const raw = new Uint8Array(await fsp.readFile(file));
  if (!(raw[0] === 0x50 && raw[1] === 0x4b && /\.zip$/i.test(file))) return { data: Buffer.from(raw), inner: path.basename(file) };
  const files = unzipSync(raw, { filter: (f) => !f.name.endsWith('/') && !README_EXT.test(f.name) });
  const names = Object.keys(files);
  if (names.length !== 1) throw new PatchError(`That zip holds ${names.length} files; unzip it and patch the game file itself`);
  return { data: Buffer.from(files[names[0]]), inner: path.basename(names[0]) };
}

/** CRC32s of the files in a zip, read from its central directory (no unpacking). */
async function zipCrcs(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return [];
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdSize > 4 * 1024 * 1024) return [];
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const out = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extra = cd.readUInt16LE(p + 30);
      const comment = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString('latin1', p + 46, p + 46 + nameLen), crc32: hex8(cd.readUInt32LE(p + 16)), size: cd.readUInt32LE(p + 24) });
      p += 46 + nameLen + extra + comment;
    }
    return out;
  } finally {
    await fh.close();
  }
}

const SNES_EXT = /\.(sfc|smc|swc|fig)$/i;

/** The ROM data as the patch wants it: as is, or without a 512-byte copier header. */
function variants(data, inner) {
  const v = [{ data, header: false }];
  if (SNES_EXT.test(inner) && data.length % 1024 === 512) v.push({ data: data.subarray(512), header: true });
  return v;
}

/**
 * Check a ROM against a patch. Returns
 *   { ok, how, data, droppedHeader, needsConfirm, problem }
 * ok: verified; needsConfirm: no way to verify (IPS with no hash given).
 */
function verify(patch, romData, inner, want) {
  const vs = variants(romData, inner);
  if (patch.format !== 'ips') {
    for (const v of vs) {
      if (hex8(crc32(v.data)) === patch.source) {
        return { ok: true, how: `CRC32 ${patch.source} (from the patch itself)`, data: v.data, droppedHeader: v.header };
      }
    }
    return { ok: false, problem: `This isn't the ROM the patch was made for. It needs CRC32 ${patch.source}; yours is ${hex8(crc32(romData))}.` };
  }
  if (hasAny(want)) {
    for (const v of vs) {
      const how = matchesAny(hashesOf(v.data), want);
      if (how) return { ok: true, how, data: v.data, droppedHeader: v.header };
    }
    const mine = hashesOf(romData);
    return { ok: false, problem: `This isn't the ROM the patch expects. Expected ${[...want.crc32.map((c) => `CRC32 ${c}`), ...want.md5.map((m) => `MD5 ${m}`), ...want.sha1.map((s) => `SHA-1 ${s}`)].slice(0, 3).join(' or ')}; yours is CRC32 ${mine.crc32}.` };
  }
  return { ok: false, needsConfirm: true, data: romData, droppedHeader: false, problem: "This IPS patch doesn't say which ROM it needs, and no checksum was given." };
}

/** "Game (USA) [Patch Name].sfc" next to the original. */
function outputName(romRel, inner, patchName) {
  const ext = path.extname(inner) || path.extname(romRel);
  const base = path.basename(romRel).replace(/\.[^.]+$/, '');
  const label = path.basename(patchName).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Patched';
  return `${base} [${label}]${ext}`;
}

module.exports = {
  PatchError, formatOf, applyIps, applyBps, applyUps, applyPatch, hashesFromText, hashesFromUser, hashesOf,
  readPatchInput, readRomData, zipCrcs, verify, outputName, crc32, hex8, variants, matchesAny,
};
