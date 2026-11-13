'use strict';
// Patcher and cheats through the controller: real files in a temp ROM folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync } = require('fflate');
const { Controller } = require('../src/main/controller');
const platforms = require('../src/main/platforms');
const P = require('../src/main/patcher');

const NES = 'Nintendo - Nintendo Entertainment System';
const SNES = 'Nintendo - Super Nintendo Entertainment System';

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
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
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function bps(src, dst) {
  const body = Buffer.concat([Buffer.from('BPS1'), enc(src.length), enc(dst.length), enc(0), enc(((dst.length - 1) << 2) | 1), dst]);
  const head = Buffer.concat([body, u32(P.crc32(src)), u32(P.crc32(dst))]);
  return Buffer.concat([head, u32(P.crc32(head))]);
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-flow-'));
  const roms = path.join(root, 'roms');
  const ra = path.join(root, 'RetroArch');
  write(path.join(ra, 'retroarch.exe'), '');
  write(path.join(ra, 'retroarch.cfg'), 'cheat_database_path = ":\\cheats"\nlibretro_info_path = ":\\info"\n');
  write(path.join(ra, 'info', 'fceumm_libretro.info'), 'corename = "FCEUmm"\n');
  write(path.join(root, 'cores', platforms.coreFilename('fceumm_libretro')), 'core');
  const launches = [];
  const launch = (cfg, role, core, rom, opts) => { launches.push({ role, rom, opts }); return Promise.resolve(0); };
  const c = new Controller({ dataDir: path.join(root, 'data'), pollMs: 60000, launch, fetchImpl: async () => { throw new Error('offline'); } });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ romsDir: roms, coresDir: path.join(root, 'cores'), sharedSecret: 's', retroarchCommand: [path.join(ra, 'retroarch.exe')], syncPort: 57000 + Math.floor(Math.random() * 900) });
  return { c, root, roms, ra, launches };
}

test('patcher: finds the right ROM inside a zip, patches it next to the original, refuses the wrong one', async (t) => {
  const { c, root, roms } = await setup(t);
  const good = Buffer.alloc(1024, 1);
  const other = Buffer.alloc(1024, 2);
  write(path.join(roms, SNES, 'Game (USA).zip'), zipSync({ 'Game (USA).sfc': good }));
  write(path.join(roms, SNES, 'Other (USA).sfc'), other);
  const target = Buffer.from('translated game!');
  const patchFile = path.join(root, 'dl', 'Game English.bps');
  write(patchFile, bps(good, target));

  const info = await c.patchInspect(patchFile);
  assert.equal(info.patches[0].format, 'bps');
  assert.equal(info.matches.length, 1);
  assert.equal(info.matches[0].path, `${SNES}/Game (USA).zip`);

  const done = await c.patchApply({ patchPath: patchFile, patchName: 'Game English.bps', romSha: info.matches[0].sha });
  assert.equal(done.path, `${SNES}/Game (USA) [Game English].sfc`);
  assert.deepEqual(fs.readFileSync(path.join(roms, SNES, 'Game (USA) [Game English].sfc')), target);
  assert.ok(fs.existsSync(path.join(roms, SNES, 'Game (USA).zip')), 'original kept');
  assert.match(done.verified, /CRC32/);

  const otherSha = (await c.library.scanRoms()).find((r) => r.path.endsWith('Other (USA).sfc')).sha256;
  await assert.rejects(c.patchApply({ patchPath: patchFile, patchName: 'Game English.bps', romSha: otherSha }), /isn't the ROM/);

  // IPS without any checksum: asks first; force patches; a typed checksum checks it.
  const ips = path.join(root, 'dl2', 'fix.ips');
  write(ips, Buffer.concat([Buffer.from('PATCH'), Buffer.from([0, 0, 0, 0, 1, 0x42]), Buffer.from('EOF')]));
  const ask = await c.patchApply({ patchPath: ips, patchName: 'fix.ips', romSha: otherSha });
  assert.equal(ask.needsConfirm, true);
  const forced = await c.patchApply({ patchPath: ips, patchName: 'fix.ips', romSha: otherSha, force: true });
  assert.equal(forced.verified, null);
  await assert.rejects(c.patchApply({ patchPath: ips, patchName: 'fix.ips', romSha: otherSha, userHash: '00000000' }), /isn't the ROM/);
  const ok = await c.patchApply({ patchPath: ips, patchName: 'fix.ips', romSha: otherSha, userHash: P.hex8(P.crc32(other)) });
  assert.match(ok.path, /Other \(USA\) \[fix\] \(2\)\.sfc$/);
});

test('cheats: database lookup, multiplayer copy, solo launch writes the game file', async (t) => {
  const { c, roms, ra, launches } = await setup(t);
  const rom = Buffer.alloc(16 + 0x8000, 0xea);
  rom.write('NES\x1a', 0, 'latin1');
  rom[4] = 2; // 32K NROM
  write(path.join(roms, NES, 'Contra.nes'), rom);
  write(path.join(ra, 'cheats', NES, 'Contra (USA).cht'),
    'cheats = 2\ncheat0_desc = "Lives"\ncheat0_code = "SXIOPO"\ncheat0_enable = false\ncheat1_desc = "RAM thing"\ncheat1_code = "0032:09"\ncheat1_enable = false\n');
  const sha = (await c.library.scanRoms())[0].sha256;

  let info = await c.gameCheats(sha);
  assert.equal(info.fileName, 'Contra (USA).cht');
  assert.deepEqual(info.cheats.map((x) => [x.desc, x.multiplayer, x.on]), [['Lives', true, false], ['RAM thing', false, false]]);
  await assert.rejects(c.makeCheatRom(sha), /Switch on/);

  c.setCheats(sha, [0, 1]);
  info = await c.gameCheats(sha);
  assert.ok(info.cheats.every((x) => x.on));

  const made = await c.makeCheatRom(sha);
  assert.equal(made.path, `${NES}/Contra [Cheats].nes`);
  assert.deepEqual(made.applied, ['Lives']);
  assert.deepEqual(made.soloOnly, ['RAM thing']);
  const baked = fs.readFileSync(path.join(roms, NES, 'Contra [Cheats].nes'));
  assert.equal(baked[16 + 0x11d9], 0xad);
  assert.ok(made.sha && made.sha !== sha);

  await c.playSolo(sha);
  for (let i = 0; i < 50 && c.playing; i++) await new Promise((r) => setTimeout(r, 10));
  const l = launches.find((x) => x.role === 'solo');
  assert.ok(l);
  assert.equal(l.opts.overrides.apply_cheats_after_load, 'true');
  const cht = fs.readFileSync(path.join(ra, 'cheats', 'FCEUmm', 'Contra.cht'), 'utf8');
  assert.match(cht, /cheat0_enable = true/);
  assert.match(cht, /cheat1_enable = true/);
});
