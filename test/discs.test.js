'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platforms = require('../src/main/platforms');
const { Library, discRefs } = require('../src/main/library');
const { SyncServer } = require('../src/main/server');
const { HostClient, Syncer } = require('../src/main/sync');
const raSetup = require('../src/main/retroarch-setup');
const config = require('../src/main/config');

const SECRET = 's';
const TAG = platforms.platformTag();
const quiet = () => {};
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-disc-'));
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return f; };

const CUE = (tracks) => tracks.map((t, i) => `FILE "${t}" BINARY\r\n  TRACK ${String(i + 1).padStart(2, '0')} MODE2/2352\r\n    INDEX 01 00:00:00\r\n`).join('');

function hostRoms(root) {
  const dir = path.join(root, 'host');
  // One single-track game, one two-track game, one two-disc set, one CHD.
  write(path.join(dir, 'PSX', 'Solo (USA).cue'), CUE(['Solo (USA).bin']));
  write(path.join(dir, 'PSX', 'Solo (USA).bin'), Buffer.alloc(40000, 1));
  write(path.join(dir, 'Sega CD', 'Sonic CD (USA).cue'), CUE(['Sonic CD (USA) (Track 1).bin', 'Sonic CD (USA) (Track 2).bin']));
  write(path.join(dir, 'Sega CD', 'Sonic CD (USA) (Track 1).bin'), Buffer.alloc(30000, 2));
  write(path.join(dir, 'Sega CD', 'Sonic CD (USA) (Track 2).bin'), Buffer.alloc(20000, 3));
  write(path.join(dir, 'PSX', 'Big (USA)', 'Big (USA) (Disc 1).cue'), CUE(['Big (USA) (Disc 1).bin']));
  write(path.join(dir, 'PSX', 'Big (USA)', 'Big (USA) (Disc 1).bin'), Buffer.alloc(10000, 4));
  write(path.join(dir, 'PSX', 'Big (USA)', 'Big (USA) (Disc 2).cue'), CUE(['Big (USA) (Disc 2).bin']));
  write(path.join(dir, 'PSX', 'Big (USA)', 'Big (USA) (Disc 2).bin'), Buffer.alloc(10000, 5));
  write(path.join(dir, 'PSX', 'Big (USA)', 'Big (USA).m3u'), '# discs\nBig (USA) (Disc 1).cue\r\nBig (USA) (Disc 2).cue\n');
  write(path.join(dir, 'PSX', 'One File (USA).chd'), Buffer.alloc(5000, 6));
  return dir;
}

test('cue/m3u parsing', () => {
  assert.deepEqual(discRefs('FILE "a b.bin" BINARY\n  TRACK 01\nfile c.bin BINARY\n', '.cue'), ['a b.bin', 'c.bin']);
  assert.deepEqual(discRefs('#comment\n\nDisc 1.cue\r\nDisc 2.cue\n', '.m3u'), ['Disc 1.cue', 'Disc 2.cue']);
});

test('library: a .cue / .m3u is one game; its tracks and discs are parts', async () => {
  const lib = new Library({ romsDir: hostRoms(tmpdir()), coresDir: tmpdir(), platformTag: TAG });
  const roms = await lib.scanRoms();
  assert.deepEqual(roms.map((r) => r.path).sort(), [
    'PSX/Big (USA)/Big (USA).m3u',
    'PSX/One File (USA).chd',
    'PSX/Solo (USA).cue',
    'Sega CD/Sonic CD (USA).cue',
  ]);
  const sonic = roms.find((r) => r.path.startsWith('Sega CD'));
  assert.deepEqual(sonic.parts.map((p) => p.path), ['Sega CD/Sonic CD (USA) (Track 1).bin', 'Sega CD/Sonic CD (USA) (Track 2).bin']);
  assert.equal(sonic.totalSize, sonic.size + 50000);
  const big = roms.find((r) => r.path.endsWith('.m3u'));
  assert.deepEqual(big.parts.map((p) => path.posix.basename(p.path)),
    ['Big (USA) (Disc 1).cue', 'Big (USA) (Disc 1).bin', 'Big (USA) (Disc 2).cue', 'Big (USA) (Disc 2).bin']);
  // Core picked by folder, as before.
  assert.equal(config.coreForRom(config.defaults(), sonic.path), 'genesis_plus_gx_libretro');
  assert.equal(config.coreForRom(config.defaults(), big.path), 'pcsx_rearmed_libretro');
});

test('sync: joining a disc game copies every track; a missing track gets fetched later', async (t) => {
  const root = tmpdir();
  const hostLib = new Library({ romsDir: hostRoms(root), coresDir: tmpdir(), platformTag: TAG });
  const server = await new SyncServer({ library: hostLib, secret: SECRET, host: '127.0.0.1', port: 0 }).start();
  t.after(() => server.stop());
  const guestDir = path.join(root, 'guest');
  fs.mkdirSync(guestDir);
  const guestLib = new Library({ romsDir: guestDir, coresDir: tmpdir(), platformTag: TAG });
  const client = new HostClient('127.0.0.1', server.port, SECRET);
  const manifest = await client.manifest();

  const sonic = manifest.roms.find((r) => r.path.startsWith('Sega CD'));
  const result = { downloaded: [], warnings: [] };
  const dest = await new Syncer(guestLib, client, { log: quiet }).ensureRom(sonic, result);
  assert.equal(dest, path.join(guestDir, 'Sega CD', 'Sonic CD (USA).cue'));
  for (const f of ['Sonic CD (USA).cue', 'Sonic CD (USA) (Track 1).bin', 'Sonic CD (USA) (Track 2).bin']) {
    assert.deepEqual(fs.readFileSync(path.join(guestDir, 'Sega CD', f)), fs.readFileSync(path.join(hostLib.romsDir, 'Sega CD', f)));
  }
  assert.equal(result.downloaded.length, 3);

  // The whole multi-disc set comes along with its .m3u.
  const big = manifest.roms.find((r) => r.path.endsWith('.m3u'));
  await new Syncer(guestLib, client, { log: quiet }).ensureRom(big, { downloaded: [], warnings: [] });
  assert.equal(fs.readdirSync(path.join(guestDir, 'PSX', 'Big (USA)')).length, 5);

  // Guest lost a track: same .cue, so the game "exists", but the track is fetched again.
  fs.rmSync(path.join(guestDir, 'Sega CD', 'Sonic CD (USA) (Track 2).bin'));
  const again = { downloaded: [], warnings: [] };
  await new Syncer(guestLib, client, { log: quiet }).ensureRom(sonic, again);
  assert.deepEqual(again.downloaded, ['Sega CD/Sonic CD (USA) (Track 2).bin']);
  // Nothing to do once complete.
  const done = { downloaded: [], warnings: [] };
  await new Syncer(guestLib, client, { log: quiet }).ensureRom(sonic, done);
  assert.deepEqual(done.downloaded, []);
  // The guest's library now lists it as one game too.
  assert.equal((await guestLib.scanRoms()).filter((r) => r.path.startsWith('Sega CD')).length, 1);
});

test('setup: PS1 offered and ticked by default; Sega CD and PS1 BIOS found case-insensitively', async () => {
  const psx = raSetup.SYSTEMS.find((s) => s.id === 'psx');
  assert.equal(psx.core, 'pcsx_rearmed_libretro');
  assert.notEqual(psx.netplay, 'poor');
  const gen = raSetup.SYSTEMS.find((s) => s.id === 'genesis');
  assert.match(gen.label, /Sega CD/);

  const ra = tmpdir();
  const cfg = path.join(ra, 'retroarch.cfg');
  assert.equal(raSetup.systemDir(cfg, { system_directory: ':\\system' }), path.join(ra, 'system'));
  assert.equal(raSetup.systemDir(cfg, { system_directory: 'default' }), path.join(ra, 'system'));
  assert.equal(raSetup.systemDir(cfg, { system_directory: 'D:\\bios' }), 'D:\\bios');
  const sys = path.join(ra, 'system');
  let st = await raSetup.biosStatus(sys, gen.bios);
  assert.equal(st.ok, false);
  write(path.join(sys, 'BIOS_CD_U.BIN'), 'x');
  st = await raSetup.biosStatus(sys, gen.bios);
  assert.equal(st.ok, true);
  assert.deepEqual(st.found, ['bios_CD_U.bin']);
  assert.equal((await raSetup.biosStatus(sys, psx.bios)).ok, false);
});
