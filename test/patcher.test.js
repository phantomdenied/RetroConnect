'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync } = require('fflate');
const P = require('../src/main/patcher');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-patch-'));

// ----- tiny patch builders ---------------------------------------------------

function ips(records, truncate) {
  const parts = [Buffer.from('PATCH')];
  for (const r of records) {
    const h = Buffer.alloc(5);
    h.writeUIntBE(r.off, 0, 3);
    if (r.rle) {
      h.writeUInt16BE(0, 3);
      const t = Buffer.alloc(3);
      t.writeUInt16BE(r.rle.len, 0);
      t[2] = r.rle.byte;
      parts.push(h, t);
    } else {
      h.writeUInt16BE(r.data.length, 3);
      parts.push(h, Buffer.from(r.data));
    }
  }
  parts.push(Buffer.from('EOF'));
  if (truncate !== undefined) { const t = Buffer.alloc(3); t.writeUIntBE(truncate, 0, 3); parts.push(t); }
  return Buffer.concat(parts);
}

function enc(n) {
  const out = [];
  for (;;) {
    const x = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) { out.push(0x80 | x); break; }
    out.push(x);
    n--;
  }
  return Buffer.from(out);
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function withFooter(body, src, dst) {
  const head = Buffer.concat([body, u32(P.crc32(src)), u32(P.crc32(dst))]);
  return Buffer.concat([head, u32(P.crc32(head))]);
}

/** BPS that writes the whole target as one TargetRead (enough to test the checks). */
function bps(src, dst) {
  const body = Buffer.concat([Buffer.from('BPS1'), enc(src.length), enc(dst.length), enc(0), enc(((dst.length - 1) << 2) | 1), dst]);
  return withFooter(body, src, dst);
}

/** BPS using SourceRead + SourceCopy + TargetCopy. */
function bpsMixed(src, dst) {
  // dst = src[0..4) + src[8..12) + dst[0..4) again
  const body = Buffer.concat([
    Buffer.from('BPS1'), enc(src.length), enc(dst.length), enc(0),
    enc(((4 - 1) << 2) | 0), // SourceRead 4
    enc(((4 - 1) << 2) | 2), enc(8 << 1), // SourceCopy 4 from +8
    enc(((4 - 1) << 2) | 3), enc(0), // TargetCopy 4 from 0
  ]);
  return withFooter(body, src, dst);
}

function ups(src, dst) {
  const parts = [Buffer.from('UPS1'), enc(src.length), enc(dst.length)];
  let last = 0;
  const len = Math.max(src.length, dst.length);
  for (let i = 0; i < len;) {
    const a = i < src.length ? src[i] : 0;
    const b = i < dst.length ? dst[i] : 0;
    if (a === b) { i++; continue; }
    parts.push(enc(i - last));
    const run = [];
    while (i < len) {
      const x = (i < src.length ? src[i] : 0) ^ (i < dst.length ? dst[i] : 0);
      if (!x) break;
      run.push(x);
      i++;
    }
    parts.push(Buffer.from(run), Buffer.from([0]));
    i++;
    last = i;
  }
  return withFooter(Buffer.concat(parts), src, dst);
}

const rom = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

// ----- tests -------------------------------------------------------------------

test('IPS: plain writes, RLE, growing and truncating', () => {
  const p = ips([{ off: 2, data: [0xaa, 0xbb] }, { off: 10, rle: { len: 4, byte: 0x77 } }, { off: 66, data: [1] }]);
  const out = P.applyPatch(rom, p);
  assert.strictEqual(out.length, 67);
  assert.deepStrictEqual([...out.subarray(0, 4)], [0, 1, 0xaa, 0xbb]);
  assert.deepStrictEqual([...out.subarray(10, 14)], [0x77, 0x77, 0x77, 0x77]);
  assert.strictEqual(out[64], 0);
  assert.strictEqual(out[66], 1);
  const cut = P.applyPatch(rom, ips([{ off: 0, data: [9] }], 16));
  assert.strictEqual(cut.length, 16);
  assert.strictEqual(cut[0], 9);
  // The original is never touched.
  assert.strictEqual(rom[2], 2);
});

test('IPS: a write at offset 0x454f46 is not taken for EOF', () => {
  const p = ips([{ off: 0x454f46, data: [5] }]);
  const out = P.applyPatch(rom, p);
  assert.strictEqual(out.length, 0x454f47);
  assert.strictEqual(out[0x454f46], 5);
});

test('IPS: a cut-off patch is an error', () => {
  assert.throws(() => P.applyPatch(rom, Buffer.from('PATCH\x00\x00\x01\x00')), P.PatchError);
});

test('BPS: applies and checks source, target and patch CRCs', () => {
  const dst = Buffer.from('a whole new game!');
  assert.deepStrictEqual(P.applyPatch(rom, bps(rom, dst)), dst);
  const wrong = Buffer.from(rom); wrong[5] ^= 1;
  assert.throws(() => P.applyPatch(wrong, bps(rom, dst)), /Wrong ROM/);
  const damaged = bps(rom, dst); damaged[20] ^= 1;
  assert.throws(() => P.applyPatch(rom, damaged), /damaged/);
});

test('BPS: SourceRead, SourceCopy and TargetCopy', () => {
  const dst = Buffer.concat([rom.subarray(0, 4), rom.subarray(8, 12), rom.subarray(0, 4)]);
  assert.deepStrictEqual(P.applyPatch(rom, bpsMixed(rom, dst)), dst);
});

test('UPS: applies, grows, and rejects the wrong ROM', () => {
  const dst = Buffer.from(rom); dst[3] = 0xee; dst[4] = 0xdd; dst[40] = 0;
  const grown = Buffer.concat([dst, Buffer.from([1, 2, 3])]);
  assert.deepStrictEqual(P.applyPatch(rom, ups(rom, dst)), dst);
  assert.deepStrictEqual(P.applyPatch(rom, ups(rom, grown)), grown);
  assert.throws(() => P.applyPatch(Buffer.alloc(64), ups(rom, dst)), /Wrong ROM/);
});

test('readme hashes and typed hashes', () => {
  const h = P.hashesFromText('Apply to:\r\nCRC32: 1A2B3C4D\nMD5 - 0123456789abcdef0123456789ABCDEF\nSHA-1: 0123456789012345678901234567890123456789\nROM CRC32 0xdeadbeef');
  assert.deepStrictEqual(h.crc32.sort(), ['1a2b3c4d', 'deadbeef']);
  assert.deepStrictEqual(h.md5, ['0123456789abcdef0123456789abcdef']);
  assert.deepStrictEqual(h.sha1, ['0123456789012345678901234567890123456789']);
  assert.deepStrictEqual(P.hashesFromUser(' 0xDEADBEEF ').crc32, ['deadbeef']);
  assert.strictEqual(P.hashesFromUser('nope'), null);
});

test('verify: IPS needs a hash, matches it, drops a SNES copier header', () => {
  const patch = { format: 'ips' };
  const none = P.verify(patch, rom, 'Game.sfc', { crc32: [], md5: [], sha1: [] });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.needsConfirm, true);

  const want = { crc32: [P.hex8(P.crc32(rom))], md5: [], sha1: [] };
  assert.strictEqual(P.verify(patch, rom, 'Game.sfc', want).ok, true);

  const big = Buffer.alloc(2048, 3);
  const headered = Buffer.concat([Buffer.alloc(512), big]);
  const r = P.verify(patch, headered, 'Game.smc', { crc32: [], md5: [], sha1: [P.hashesOf(big).sha1] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.droppedHeader, true);
  assert.strictEqual(r.data.length, 2048);

  const bad = P.verify(patch, rom, 'Game.sfc', { crc32: ['00000000'], md5: [], sha1: [] });
  assert.strictEqual(bad.ok, false);
  assert.ok(!bad.needsConfirm);
  assert.match(bad.problem, /isn't the ROM/);
});

test('verify: BPS uses its own source CRC', () => {
  const dst = Buffer.from('xyz');
  const info = { format: 'bps', source: P.hex8(P.crc32(rom)) };
  assert.strictEqual(P.verify(info, rom, 'g.nes', null).ok, true);
  assert.strictEqual(P.verify(info, Buffer.alloc(64), 'g.nes', null).ok, false);
  assert.ok(bps(rom, dst));
});

test('readPatchInput: zip with a patch and readme; loose patch with a readme beside it', async () => {
  const dir = tmp();
  const p = ips([{ off: 0, data: [1] }]);
  const zip = path.join(dir, 'hack.zip');
  fs.writeFileSync(zip, zipSync({ 'Hack v1.2/hack.ips': p, 'Hack v1.2/readme.txt': Buffer.from('Use the ROM with CRC32: 89abcdef') }));
  const z = await P.readPatchInput(zip);
  assert.strictEqual(z.patches.length, 1);
  assert.strictEqual(z.patches[0].format, 'ips');
  assert.deepStrictEqual(z.readmeHashes.crc32, ['89abcdef']);

  const loose = path.join(dir, 'loose');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'x.bps'), bps(rom, Buffer.from('q')));
  fs.writeFileSync(path.join(loose, 'info.txt'), 'nothing here');
  const l = await P.readPatchInput(path.join(loose, 'x.bps'));
  assert.strictEqual(l.patches[0].source, P.hex8(P.crc32(rom)));

  fs.writeFileSync(path.join(dir, 'junk.ips'), 'hello');
  await assert.rejects(P.readPatchInput(path.join(dir, 'junk.ips')), P.PatchError);
});

test('readRomData and zipCrcs read inside zipped ROMs', async () => {
  const dir = tmp();
  const z = path.join(dir, 'Game (USA).zip');
  fs.writeFileSync(z, zipSync({ 'Game (USA).sfc': rom }));
  const { data, inner } = await P.readRomData(z);
  assert.deepStrictEqual(data, rom);
  assert.strictEqual(inner, 'Game (USA).sfc');
  const crcs = await P.zipCrcs(z);
  assert.deepStrictEqual(crcs.map((c) => [c.name, c.crc32, c.size]), [['Game (USA).sfc', P.hex8(P.crc32(rom)), 64]]);

  const two = path.join(dir, 'two.zip');
  fs.writeFileSync(two, zipSync({ 'a.sfc': rom, 'b.sfc': rom }));
  await assert.rejects(P.readRomData(two), /2 files/);
});

test('outputName keeps the ROM name and the inner extension', () => {
  assert.strictEqual(P.outputName('SNES/Game (USA).zip', 'Game (USA).sfc', 'Hack v1.2/Super Hack: Redux.ips'), 'Game (USA) [Super Hack Redux].sfc');
  assert.strictEqual(P.outputName('Game.nes', 'Game.nes', '[x].ips'), 'Game [x].nes');
});
