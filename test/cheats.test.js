'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cc = require('../src/main/cheatcodes');
const cheats = require('../src/main/cheats');
const describe = require('../src/main/describe');
const launcher = require('../src/main/launcher');

const { SNES, NES, GEN, GB } = cc.SYSTEMS;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cheat-'));

test('NES Game Genie: the classic Super Mario Bros code', () => {
  assert.deepStrictEqual(cc.nesGenie('SXIOPO'), { address: 0x91d9, value: 0xad, width: 1 });
  const eight = cc.nesGenie('AAAAAAAA');
  assert.strictEqual(eight.address, 0x8000);
  assert.strictEqual(eight.compare, 0);
  assert.strictEqual(cc.nesGenie('SXIOP1'), null);
});

test('Genesis Game Genie: Sonic master code skips the checksum check', () => {
  assert.deepStrictEqual(cc.genesisGenie('ATBT-AA32'), { address: 0x338, value: 0x6004, width: 2 });
  assert.deepStrictEqual(cc.genesisRaw('01A2D4:4E71'), { address: 0x01a2d4, value: 0x4e71, width: 2 });
  assert.strictEqual(cc.decode(GEN, 'FF0400:0009'), null); // RAM: needs the emulator
});

test('SNES: Action Replay ROM vs RAM codes; Game Genie decodes', () => {
  assert.strictEqual(cc.decode(SNES, '7E0DBE63'), null);
  assert.deepStrictEqual(cc.decode(SNES, '00FFFFEA'), { kind: 'Action Replay', address: 0x00ffff, value: 0xea, width: 1 });
  const g = cc.decode(SNES, 'DD62-3B1F');
  assert.strictEqual(g.kind, 'Game Genie');
  assert.ok(g.address <= 0xffffff);
});

test('Game Boy Game Genie with a compare byte', () => {
  const g = cc.gbGenie('00A-17B-C49');
  assert.deepStrictEqual(g, { address: 0x4a17, value: 0x00, width: 1, compare: 0xc8 });
});

test('canBake: every part of a cheat has to be a ROM code', () => {
  assert.strictEqual(cc.canBake(NES, 'SXIOPO'), true);
  assert.strictEqual(cc.canBake(NES, 'SXIOPO+AAAAAA'), true);
  assert.strictEqual(cc.canBake(SNES, 'DD62-3B1F+7E0DBE63'), false);
  assert.strictEqual(cc.canBake('Sony - PlayStation', '80012345 0001'), false);
});

function lorom(size = 0x80000) {
  const rom = Buffer.alloc(size, 0xff);
  rom.write('TEST GAME            ', 0x7fc0, 'latin1');
  rom[0x7fd5] = 0x20;
  rom.writeUInt16LE(0x1234 ^ 0xffff, 0x7fdc);
  rom.writeUInt16LE(0x1234, 0x7fde);
  rom.writeUInt16LE(0x8000, 0x7ffc);
  return rom;
}

test('bake: SNES LoROM address -> file offset; copier header dropped; RAM code skipped', () => {
  const rom = lorom();
  assert.strictEqual(cc.snesLayout(rom), 'lorom');
  const withHeader = Buffer.concat([Buffer.alloc(512), rom]);
  const r = cc.bake(SNES, withHeader, [{ desc: 'a', code: '018123AA' }, { desc: 'b', code: '7E0DBE63' }]);
  assert.strictEqual(r.data.length, rom.length);
  assert.strictEqual(r.data[0x8123], 0xaa); // bank 01, $8123 -> 0x8000 + 0x0123
  assert.deepStrictEqual(r.applied, ['a']);
  assert.strictEqual(r.skipped[0].desc, 'b');
  assert.strictEqual(rom[0x8123], 0xff, 'original untouched');
});

test('bake: NES with compare finds the right bank; mismatched compare is skipped', () => {
  const prg = 8; // 8 x 16K = 128K, MMC1
  const rom = Buffer.alloc(16 + prg * 0x4000, 0);
  rom.write('NES\x1a', 0, 'latin1');
  rom[4] = prg;
  rom[6] = 0x10; // mapper 1
  const code = cc.nesGenie('AAAAAAAA'); // $8000 := 0 if it holds 0
  assert.strictEqual(code.compare, 0);
  rom.fill(7, 16); // nothing holds 0 now...
  rom[16 + 3 * 0x4000] = 0; // ...except bank 3's first byte
  const r = cc.bake(NES, rom, [{ desc: 'x', code: 'AAAAAAAA' }]);
  assert.deepStrictEqual(r.applied, ['x']);
  const none = cc.bake(NES, Buffer.from(rom).fill(7, 16), [{ desc: 'y', code: 'AAAAAAAA' }]);
  assert.match(none.skipped[0].why, /version/);
  // Fixed last bank at $C000 for MMC1: only the last bank is patched.
  const small = cc.nesGenie('SXIOPO'); // $91D9
  const r2 = cc.bake(NES, rom, [{ desc: 'smb', code: 'SXIOPO' }]);
  let changed = 0;
  for (let b = 0; b < prg; b++) if (r2.data[16 + b * 0x4000 + (small.address - 0x8000)] === 0xad) changed++;
  assert.strictEqual(changed, prg); // no compare: every switchable bank, like the real Game Genie
});

test('bake: Genesis word write and the header checksum is fixed', () => {
  const rom = Buffer.alloc(0x1000, 0);
  rom.write('SEGA GENESIS    ', 0x100, 'latin1');
  const r = cc.bake(GEN, rom, [{ desc: 'nop', code: '000400:4E71' }]);
  assert.strictEqual(r.data.readUInt16BE(0x400), 0x4e71);
  assert.strictEqual(r.data.readUInt16BE(0x18e), 0x4e71);
});

test('bake: Game Boy bank 0 and switchable banks', () => {
  const rom = Buffer.alloc(0x10000, 0x11);
  rom[0x8000 + 0x0a17] = 0xc8; // bank 2 holds the compare value at $4A17
  const r = cc.bake(GB, rom, [{ desc: 'g', code: '00A-17B-C49' }]);
  assert.deepStrictEqual(r.applied, ['g']);
  assert.strictEqual(r.data[0x8a17], 0x00);
  assert.strictEqual(r.data[0x4a17], 0x11);
});

test('.cht parse and write round trip', () => {
  const text = 'cheats = 2\n\ncheat0_desc = "Infinite lives"\ncheat0_code = "SXIOPO"\ncheat0_enable = false\n\ncheat1_desc = "Big"\ncheat1_code = "AAAAAA+PPPPPP"\ncheat1_enable = true\ncheat1_handler = "0"\n';
  const list = cheats.parseCht(text);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[1].enable, true);
  assert.deepStrictEqual(list[1].extra, { handler: '0' });
  const again = cheats.parseCht(cheats.serializeCht(list));
  assert.deepStrictEqual(again, list);
});

test('findDbCheat: exact name, then same title preferring the same region', async () => {
  const dir = tmp();
  const sys = path.join(dir, NES);
  fs.mkdirSync(sys, { recursive: true });
  for (const n of ['1943 - The Battle of Midway (USA).cht', '1943 - The Battle of Midway (Japan).cht', 'Contra (USA).cht', 'Contra Force (USA).cht']) fs.writeFileSync(path.join(sys, n), 'cheats = 0\n');
  const nes = (n) => `${NES}/${n}`;
  assert.strictEqual(path.basename(await cheats.findDbCheat(dir, nes('Contra (USA).zip'))), 'Contra (USA).cht');
  assert.strictEqual(path.basename(await cheats.findDbCheat(dir, nes('1943 - The Battle of Midway.zip'))), '1943 - The Battle of Midway (USA).cht');
  assert.strictEqual(path.basename(await cheats.findDbCheat(dir, nes('1943 - The Battle of Midway (Japan).nes'))), '1943 - The Battle of Midway (Japan).cht');
  assert.strictEqual(await cheats.findDbCheat(dir, nes('Gradius.zip')), null);
  assert.strictEqual(cheats.hasDatabase(dir), true);
});

test('writeGameCheats keeps a hand-made file as a backup, overwrites its own', async () => {
  const dir = tmp();
  const file = path.join(dir, 'Snes9x', 'Game.cht');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'cheats = 0\n');
  await cheats.writeGameCheats(file, [{ desc: 'a', code: 'X', enable: true }]);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(cheats.MARK));
  assert.strictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.old')).length, 1);
  await cheats.writeGameCheats(file, [{ desc: 'b', code: 'Y', enable: false }]);
  assert.strictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.old')).length, 1);
});

test('descriptions: title cleanup and page matching', () => {
  assert.strictEqual(describe.cleanTitle("SNES/Legend of Zelda, The - A Link to the Past (USA) [!].sfc"), 'The Legend of Zelda - A Link to the Past');
  assert.strictEqual(describe.titleFits('Sonic the Hedgehog 2', 'Sonic The Hedgehog 2'), true);
  assert.strictEqual(describe.titleFits('Sonic the Hedgehog', 'Sonic The Hedgehog 2'), false);
  assert.strictEqual(describe.titleFits('Donkey Kong (1981 video game)', 'Donkey Kong Country'), false);
  assert.strictEqual(describe.titleFits('Super Mario All-Stars', 'Super Mario All-Stars + Super Mario World'), true);
  assert.strictEqual(describe.titleFits('1943: The Battle of Midway', '1943 - The Battle of Midway'), true);
});

test('descriptions: looked up once, misses cached', async () => {
  const cache = new describe.DescriptionCache(path.join(tmp(), 'd.json'));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const body = url.includes('list=search')
      ? { query: { search: [{ title: 'Contra (video game)' }] } }
      : { title: 'Contra (video game)', description: '1987 video game', extract: 'Contra is a run and gun game.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Contra_(video_game)' } } };
    return { ok: true, json: async () => body };
  };
  const a = await describe.describe(cache, `${NES}/Contra.zip`, { fetchImpl });
  assert.strictEqual(a.text, 'Contra is a run and gun game.');
  await describe.describe(cache, `${NES}/Contra (USA).nes`, { fetchImpl });
  assert.strictEqual(calls, 2);
  const none = async (url) => ({ ok: true, json: async () => (url.includes('list=search') ? { query: { search: [] } } : {}) });
  assert.strictEqual(await describe.describe(cache, `${NES}/Zzyzx.zip`, { fetchImpl: none }), null);
});

test('launcher: solo runs without netplay flags', () => {
  const cfg = { retroarchCommand: ['C:/RA/retroarch.exe'], nickname: 'me', netplayPort: 55435, connectionMode: 'direct' };
  const [, args] = launcher.buildCommand(cfg, 'solo', 'core.dll', 'game.sfc', {});
  assert.ok(!args.includes('--host') && !args.includes('--connect') && !args.includes('--nick'));
  const [, g] = launcher.buildCommand(cfg, 'guest', 'core.dll', 'game.sfc', { connectTo: '1.2.3.4' });
  assert.ok(g.includes('--connect'));
});
