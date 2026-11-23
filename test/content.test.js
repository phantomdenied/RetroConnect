'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync } = require('fflate');
const content = require('../src/main/content');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-content-'));

test('disc archives are unpacked whole and the .cue is launched; cartridge zips are left alone', async () => {
  const dir = tmp();
  const cache = path.join(dir, 'cache');
  const disc = path.join(dir, 'Game.7z');
  fs.writeFileSync(disc, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
  let unpacked = 0;
  const files = { 'Game (Track 1).bin': 'data', 'Game (Track 2).bin': 'music', 'Game.cue': 'FILE "Game (Track 1).bin" BINARY' };
  const fake = {
    list: async () => Object.keys(files),
    unpack: async (archive, dest) => { unpacked++; for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(dest, n), v); },
  };
  const p = await content.prepare(disc, 'abc', cache, fake);
  assert.equal(p, path.join(cache, 'abc', 'Game.cue'));
  assert.equal(fs.readFileSync(path.join(cache, 'abc', 'Game (Track 2).bin'), 'utf8'), 'music');
  assert.equal(await content.prepare(disc, 'abc', cache, fake), p);
  assert.equal(unpacked, 1, 'unpacked once, then reused');

  const cart = path.join(dir, 'Mario.zip');
  fs.writeFileSync(cart, zipSync({ 'Mario.sfc': Buffer.alloc(16) }));
  assert.equal(await content.prepare(cart, 'def', cache, { list: async () => ['Mario.sfc'], unpack: fake.unpack }), cart);

  const plain = path.join(dir, 'Game.cue');
  fs.writeFileSync(plain, 'x');
  assert.equal(await content.prepare(plain, 'ghi', cache, fake), plain);
});

test('an archive whose name lost its .7z is unpacked too', async () => {
  const dir = tmp();
  const f = path.join(dir, 'I.Q - Intelligent Qube (USA)');
  fs.writeFileSync(f, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
  const out = await content.prepare(f, 'iq', path.join(dir, 'c'), {
    list: async () => ['IQ.bin', 'IQ.cue'],
    unpack: async (a, dest) => { fs.writeFileSync(path.join(dest, 'IQ.bin'), 'b'); fs.writeFileSync(path.join(dest, 'IQ.cue'), 'c'); },
  });
  assert.equal(path.basename(out), 'IQ.cue');
});

test('only the most recent unpacked discs are kept', async () => {
  const dir = tmp();
  const cache = path.join(dir, 'c');
  const f = path.join(dir, 'g.7z');
  fs.writeFileSync(f, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  const fake = { list: async () => ['g.cue'], unpack: async (a, dest) => fs.writeFileSync(path.join(dest, 'g.cue'), 'c') };
  for (const sha of ['a', 'b', 'c', 'd', 'e']) {
    await content.prepare(f, sha, cache, fake);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(fs.readdirSync(cache).sort(), ['c', 'd', 'e']);
});

test('pickDiscIndex prefers .m3u, then .cue', () => {
  assert.equal(content.pickDiscIndex(['a.bin', 'a.cue', 'set.m3u']), 'set.m3u');
  assert.equal(content.pickDiscIndex(['a.bin', 'a.cue']), 'a.cue');
  assert.equal(content.pickDiscIndex(['a.sfc']), null);
});

test('unpack in place: real 7-Zip, files land next to the archive, archive goes to the bin', async () => {
  const dir = tmp();
  const z = path.join(dir, 'Disc Game.zip');
  fs.writeFileSync(z, zipSync({ 'Disc Game.cue': Buffer.from('FILE "Disc Game (Track 1).bin" BINARY'), 'Disc Game (Track 1).bin': Buffer.alloc(4096, 1), 'Disc Game (Track 2).bin': Buffer.alloc(2048, 2) }));
  assert.equal(await content.unpackReason(z), 'disc');
  const binned = [];
  const names = await content.unpackInPlace(z, { remove: async (p) => { binned.push(p); fs.rmSync(p); } });
  assert.equal(names.length, 3);
  assert.deepEqual(binned, [z]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Disc Game (Track 1).bin', 'Disc Game (Track 2).bin', 'Disc Game.cue']);
  assert.equal(fs.statSync(path.join(dir, 'Disc Game (Track 2).bin')).size, 2048);
});

test('unpack in place refuses to overwrite and leaves everything as it was', async () => {
  const dir = tmp();
  const z = path.join(dir, 'G.zip');
  fs.writeFileSync(z, zipSync({ 'G.cue': Buffer.from('c'), 'G.bin': Buffer.from('new') }));
  fs.writeFileSync(path.join(dir, 'G.bin'), 'mine');
  await assert.rejects(content.unpackInPlace(z, { remove: async () => assert.fail('must not remove') }), /already in that folder/);
  assert.equal(fs.readFileSync(path.join(dir, 'G.bin'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['G.bin', 'G.zip']);
});

test('which files are worth checking, and cartridge zips are fine', async () => {
  assert.equal(content.worthChecking('PSX/Game.7z', 'psx'), true);
  assert.equal(content.worthChecking('SNES/Game.zip', 'sfc'), false);
  assert.equal(content.worthChecking('PlayStation/I.Q - Intelligent Qube (USA)', 'psx'), true);
  const dir = tmp();
  const z = path.join(dir, 'Mario.zip');
  fs.writeFileSync(z, zipSync({ 'Mario.sfc': Buffer.alloc(16) }));
  assert.equal(await content.unpackReason(z), null);
  const lost = path.join(dir, 'Mario (USA)');
  fs.copyFileSync(z, lost);
  assert.equal(await content.unpackReason(lost), 'noext');
});
