'use strict';
// Lag smoothing + shared saves.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const saves = require('../src/main/saves');
const platforms = require('../src/main/platforms');
const config = require('../src/main/config');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-b-'));
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return f; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const setAge = (file, ageMs) => { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); };

test('lag smoothing: frames from ping, fixed and off', async (t) => {
  assert.deepEqual([null, 10, 45, 90, 150, 300].map((p) => Controller.recommendFrames(p)), [null, 0, 1, 2, 3, 4]);
  const c = new Controller({ dataDir: tmpdir(), pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  assert.deepEqual(c.lagInfo(), { auto: true, frames: null, range: null, ping: null });
  c.rtt = [80, 95, 90];
  assert.deepEqual(c.lagInfo(), { auto: true, frames: 2, range: 2, ping: 90 });
  let o = await c.launchOverrides(1);
  assert.equal(o.netplay_input_latency_frames_min, '2');
  assert.equal(o.netplay_input_latency_frames_range, '2');
  await c.saveSettings({ lagFrames: 0 });
  o = await c.launchOverrides(1);
  assert.equal(o.netplay_input_latency_frames_min, '0');
  assert.equal(o.netplay_input_latency_frames_range, '0');
  await c.saveSettings({ lagFrames: 5 });
  assert.equal(c.lagInfo().frames, 5);
  assert.throws(() => config.normalize({ lagFrames: 12 }), /0-8/);
  c.rtt = [];
  await c.saveSettings({ lagFrames: -1 });
  o = await c.launchOverrides(1);
  assert.equal(o.netplay_input_latency_frames_min, undefined); // unknown ping: leave RetroArch's own setting
});

test('save folder: RetroArch settings and defaults', () => {
  const exe = path.join(os.tmpdir(), 'RA', 'retroarch.exe');
  assert.equal(saves.savesRoot([exe], { savefile_directory: ':\\saves' }), path.join(os.tmpdir(), 'RA', 'saves'));
  assert.equal(saves.savesRoot([exe], { savefile_directory: '/data/saves' }), '/data/saves');
  assert.equal(saves.savesRoot([exe], { savefiles_in_content_dir: 'true' }), null);
  if (platforms.osName() === 'windows') assert.equal(saves.savesRoot([exe], {}), path.join(os.tmpdir(), 'RA', 'saves'));
});

test('finding the newest save, and where to put a new one', async () => {
  const root = tmpdir();
  const rom = write(path.join(root, 'roms', 'Secret of Mana (USA).sfc'), 'rom');
  const savesDir = path.join(root, 'saves');
  assert.equal(await saves.findSave(rom, savesDir), null);
  const sorted = write(path.join(savesDir, 'Snes9x', 'Secret of Mana (USA).srm'), 'sorted');
  const flat = write(path.join(savesDir, 'Secret of Mana (USA).srm'), 'flat');
  setAge(flat, 3600e3);
  setAge(sorted, 60e3);
  const found = await saves.findSave(rom, savesDir);
  assert.equal(found.path, sorted);
  assert.equal(found.rel, 'Snes9x/Secret of Mana (USA).srm');
  const d = await saves.describe(found);
  assert.equal(d.size, 6);
  assert.ok(d.age_ms >= 59e3 && d.age_ms < 120e3);
  // Next to the ROM when saves live in the content folder.
  const beside = write(path.join(root, 'roms', 'Secret of Mana (USA).srm'), 'beside');
  assert.equal((await saves.findSave(rom, null)).path, beside);
  // A save we don't have: mirror their core subfolder, named after OUR rom file.
  const myRom = path.join(root, 'roms', 'mana.sfc');
  assert.equal(saves.targetPath(myRom, savesDir, 'Snes9x/Secret of Mana (USA).srm'), path.join(savesDir, 'Snes9x', 'mana.srm'));
  assert.equal(saves.targetPath(myRom, savesDir, '../../evil/x.srm'), path.join(savesDir, 'mana.srm'));
  assert.equal(saves.targetPath(myRom, null, 'Snes9x/x.srm'), path.join(root, 'roms', 'mana.srm'));
});

test('newer is decided by age on each machine, so wrong clocks don\'t matter', () => {
  const mine = { sha256: 'a', age_ms: 3600e3 };
  assert.equal(saves.theirsIsNewer(mine, { sha256: 'b', age_ms: 60e3 }), true);
  assert.equal(saves.theirsIsNewer(mine, { sha256: 'b', age_ms: 7200e3 }), false);
  assert.equal(saves.theirsIsNewer(mine, { sha256: 'a', age_ms: 1 }), false); // identical
  assert.equal(saves.theirsIsNewer(null, { sha256: 'b', age_ms: 9e9 }), true); // we have none
  assert.equal(saves.theirsIsNewer(mine, null), false);
});

test('before hosting, the buddy\'s newer save is pulled and ours backed up', async (t) => {
  const root = tmpdir();
  const sync = await freePort();
  const mk = async (name, extra = {}) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, launch: () => new Promise(() => {}) });
    await c.init();
    await c.saveSettings({ nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: 's', peerAddress: '127.0.0.1', syncPort: sync, ...extra });
    c.saveRoot = async () => path.join(dir, 'saves'); // keep each player's saves apart in this test
    return c;
  };
  write(path.join(root, 'alex', 'roms', 'Mana.sfc'), 'same rom');
  write(path.join(root, 'sam', 'roms', 'my mana copy.sfc'), 'same rom');
  const alex = await mk('alex');
  const sam = await mk('sam', { shareLibrary: false });
  t.after(async () => { await alex.dispose(); await sam.dispose(); });
  for (let i = 0; i < 150 && sam.buddy.status !== 'online'; i++) await new Promise((r) => setTimeout(r, 20));
  const rom = (await sam.library.scanRoms())[0];

  // Alex has no save yet: nothing happens.
  assert.equal(await sam.pullNewerSave(rom), null);

  // Alex played last night; Sam's save is a week old.
  const alexSave = write(path.join(root, 'alex', 'saves', 'Snes9x', 'Mana.srm'), 'ALEX PROGRESS');
  setAge(alexSave, 8 * 3600e3);
  const samSave = write(path.join(root, 'sam', 'saves', 'Snes9x', 'my mana copy.srm'), 'old sam progress');
  setAge(samSave, 7 * 24 * 3600e3);
  const r = await sam.pullNewerSave(rom);
  assert.equal(r.dest, samSave);
  assert.equal(fs.readFileSync(samSave, 'utf8'), 'ALEX PROGRESS');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), 'old sam progress');

  // Now Sam's copy is identical: nothing to do.
  assert.equal(await sam.pullNewerSave(rom), null);
  // Sam plays more (newer): Alex's older one is not taken.
  fs.writeFileSync(samSave, 'SAM EVEN FURTHER');
  assert.equal(await sam.pullNewerSave(rom), null);
  assert.equal(fs.readFileSync(samSave, 'utf8'), 'SAM EVEN FURTHER');

  // A player who turned save sharing off doesn't hand theirs out.
  fs.writeFileSync(alexSave, 'ALEX NEWEST');
  await alex.saveSettings({ shareSaves: false });
  alex.saveRoot = async () => path.join(root, 'alex', 'saves');
  assert.equal(await sam.pullNewerSave(rom), null);

  // Sam had no save at all: theirs lands in the same core subfolder, named after Sam's ROM.
  await alex.saveSettings({ shareSaves: true });
  alex.saveRoot = async () => path.join(root, 'alex', 'saves');
  fs.rmSync(path.join(root, 'sam', 'saves'), { recursive: true });
  const r2 = await sam.pullNewerSave(rom);
  assert.equal(r2.dest, path.join(root, 'sam', 'saves', 'Snes9x', 'my mana copy.srm'));
  assert.equal(r2.backup, null);
});
