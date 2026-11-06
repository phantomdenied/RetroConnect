'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platforms = require('../src/main/platforms');
const config = require('../src/main/config');
const { Library, hashFile, safeRelParts } = require('../src/main/library');
const { SyncServer } = require('../src/main/server');
const { HostClient, Syncer, SyncError, HttpError, downloadFromHost, compare } = require('../src/main/sync');
const { buildCommand, netplayOverrides } = require('../src/main/launcher');
const { Controller } = require('../src/main/controller');

const SECRET = 'test-secret';
const TAG = platforms.platformTag();
const CORE_FILE = platforms.coreFilename('snes9x_libretro');
const quiet = () => {};

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
}

async function setup() {
  const root = tmpdir();
  const hostRoms = path.join(root, 'host_roms');
  const hostCores = path.join(root, 'host_cores');
  write(path.join(hostRoms, 'SNES', 'Game.sfc'), Buffer.from('snes rom '.repeat(50000)));
  write(path.join(hostRoms, 'NES', 'Other.nes'), 'nes rom');
  write(path.join(hostRoms, 'SNES', 'Game.srm'), 'save file, not content');
  write(path.join(hostCores, CORE_FILE), 'host core binary v2');
  const hostLib = new Library({ romsDir: hostRoms, coresDir: hostCores, nickname: 'hosty', platformTag: TAG });
  const server = await new SyncServer({ library: hostLib, secret: SECRET, host: '127.0.0.1', port: 0 }).start();
  const guestLib = new Library({ romsDir: path.join(root, 'guest_roms'), coresDir: path.join(root, 'guest_cores'), platformTag: TAG });
  fs.mkdirSync(guestLib.romsDir);
  fs.mkdirSync(guestLib.coresDir);
  const client = new HostClient('127.0.0.1', server.port, SECRET);
  return { root, hostLib, server, guestLib, client };
}

async function startSession(env) {
  const rom = (await env.hostLib.scanRoms()).find((r) => r.path.endsWith('.sfc'));
  const core = await env.hostLib.findCore('snes9x_libretro');
  env.server.session = {
    host_nickname: 'hosty', platform: TAG, retroarch_version: null, netplay_port: 55435,
    connection_mode: 'direct', relay_server: 'nyc', rom, core, started_at: 1,
  };
  return { rom, core };
}

test('scan ignores saves and hashes content', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const roms = await env.hostLib.scanRoms();
  assert.deepEqual(roms.map((r) => r.path), ['NES/Other.nes', 'SNES/Game.sfc']);
  assert.equal(roms[0].crc32.length, 8);
  assert.equal((await env.hostLib.scanCores())[0].name, 'snes9x_libretro');
});

test('join downloads missing core and ROM', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const { rom, core } = await startSession(env);
  const result = await new Syncer(env.guestLib, env.client, { log: quiet }).syncSession(await env.client.session());
  assert.equal(result.romPath, path.join(env.guestLib.romsDir, 'SNES', 'Game.sfc'));
  assert.equal((await hashFile(result.romPath)).sha256, rom.sha256);
  assert.equal((await hashFile(result.corePath)).sha256, core.sha256);
  assert.deepEqual(result.downloaded.sort(), [CORE_FILE, 'SNES/Game.sfc'].sort());
});

test('mismatched files are replaced and backed up', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const { rom, core } = await startSession(env);
  write(path.join(env.guestLib.romsDir, 'SNES', 'Game.sfc'), 'a bad dump');
  write(path.join(env.guestLib.coresDir, CORE_FILE), 'old core v1');
  const result = await new Syncer(env.guestLib, env.client, { log: quiet }).syncSession(await env.client.session());
  assert.equal((await hashFile(result.romPath)).sha256, rom.sha256);
  assert.equal((await hashFile(result.corePath)).sha256, core.sha256);
  const romBackups = fs.readdirSync(path.join(env.guestLib.romsDir, 'SNES')).filter((f) => f.endsWith('.old'));
  assert.equal(romBackups.length, 1);
  assert.ok(romBackups[0].startsWith('Game.sfc.'));
  assert.equal(fs.readdirSync(env.guestLib.coresDir).filter((f) => f.endsWith('.old')).length, 1);
  // backups aren't treated as content or cores
  assert.deepEqual((await env.guestLib.scanRoms()).map((r) => r.path), ['SNES/Game.sfc']);
  assert.equal((await env.guestLib.scanCores()).length, 1);
});

test('identical ROM under another name is reused', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  await startSession(env);
  fs.copyFileSync(path.join(env.hostLib.romsDir, 'SNES', 'Game.sfc'), path.join(env.guestLib.romsDir, 'my-copy.sfc'));
  const result = await new Syncer(env.guestLib, env.client, { log: quiet }).syncSession(await env.client.session());
  assert.equal(result.romPath, path.join(env.guestLib.romsDir, 'my-copy.sfc'));
  assert.ok(!result.downloaded.includes('SNES/Game.sfc'));
});

test('partial downloads resume', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const { rom } = await startSession(env);
  const data = fs.readFileSync(path.join(env.hostLib.romsDir, 'SNES', 'Game.sfc'));
  const dest = path.join(env.guestLib.romsDir, 'SNES', 'Game.sfc');
  write(`${dest}.part`, data.subarray(0, 1000));
  const seen = [];
  await downloadFromHost(env.client, 'rom', rom.sha256, rom.size, dest, 'Game', (p) => seen.push(p));
  assert.ok(fs.readFileSync(dest).equals(data));
  assert.equal(seen[0].done > 1000, true);
  assert.equal(seen.at(-1).done, data.length);
  assert.ok(seen.every((p) => p.done > 1000)); // didn't restart from zero
});

test('corrupt partial download is rejected and removed', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const { rom } = await startSession(env);
  const dest = path.join(env.guestLib.romsDir, 'SNES', 'Game.sfc');
  write(`${dest}.part`, Buffer.alloc(1000, 'X'));
  await assert.rejects(downloadFromHost(env.client, 'rom', rom.sha256, rom.size, dest, 'Game'), /corrupted/);
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test('wrong secret is rejected', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  const bad = new HostClient('127.0.0.1', env.server.port, 'nope');
  await assert.rejects(bad.manifest(), (err) => err instanceof SyncError && /shared secret/.test(err.message));
});

test('only hashed files are served', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  for (const p of ['/files/rom/' + '0'.repeat(64), '/files/rom/../../etc/passwd', '/files/rom/%2e%2e%2fsecret']) {
    await assert.rejects(env.client.open(p), (err) => err instanceof HttpError && err.status === 404);
  }
});

test('unreachable host gives a friendly error', async () => {
  const c = new HostClient('127.0.0.1', 1, SECRET, { timeoutMs: 2000 });
  await assert.rejects(c.manifest(), (err) => err instanceof SyncError && /Can't reach/.test(err.message));
});

test('no session returns null', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  assert.equal(await env.client.session(), null);
});

test('cross-platform cores come from the buildbot', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  await startSession(env);
  const session = await env.client.session();
  session.platform = TAG.startsWith('windows') ? 'linux-x86_64' : 'windows-x86_64';
  let called = null;
  const fetchCore = async (name, coresDir) => {
    called = name;
    return write(path.join(coresDir, platforms.coreFilename(name)), 'buildbot core');
  };
  const result = await new Syncer(env.guestLib, env.client, { log: quiet, fetchCore }).syncSession(session);
  assert.equal(called, 'snes9x_libretro');
  assert.ok(result.warnings.some((w) => /buildbot/.test(w)));

  // second time: uses the local core but warns about versions
  const again = await new Syncer(env.guestLib, env.client, { log: quiet, fetchCore }).syncSession(session);
  assert.ok(again.warnings.some((w) => /same snes9x_libretro version/.test(w)));

  fs.unlinkSync(path.join(env.guestLib.coresDir, CORE_FILE));
  await assert.rejects(
    new Syncer(env.guestLib, env.client, { log: quiet, buildbotFallback: false }).syncSession(session),
    /Online Updater/);
});

test('buildbot zip is unpacked', async () => {
  const { zipSync } = require('fflate');
  const { fetchCoreFromBuildbot } = require('../src/main/sync');
  const dir = tmpdir();
  const fname = platforms.coreFilename('snes9x_libretro', 'linux');
  const zip = zipSync({ [fname]: new Uint8Array(Buffer.from('real core bytes')) });
  let url = null;
  const fetchImpl = async (u) => { url = u; return { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }; };
  const dest = await fetchCoreFromBuildbot('snes9x_libretro', dir, quiet, { fetchImpl, tag: 'linux-x86_64' });
  assert.equal(url, 'https://buildbot.libretro.com/nightly/linux/x86_64/latest/snes9x_libretro.so.zip');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'real core bytes');
});

test('library sync and compare', async (t) => {
  const env = await setup();
  t.after(() => env.server.stop());
  write(path.join(env.guestLib.romsDir, 'Mine.gba'), 'guest only');
  write(path.join(env.guestLib.romsDir, 'NES', 'Other.nes'), 'different dump');
  const remote = await env.client.manifest();
  const rows = compare(await env.guestLib.manifest(), remote);
  assert.deepEqual(rows.map((r) => [r.path, r.status]), [
    ['Mine.gba', 'mine'], ['NES/Other.nes', 'different'], ['SNES/Game.sfc', 'theirs'],
  ]);
  const result = await new Syncer(env.guestLib, env.client, { log: quiet }).syncLibrary(remote);
  assert.deepEqual(new Set(result.downloaded), new Set(['SNES/Game.sfc', 'NES/Other.nes', CORE_FILE]));
  const after = compare(await env.guestLib.manifest(), await env.client.manifest());
  assert.deepEqual(after.filter((r) => r.status === 'both').map((r) => r.path), ['NES/Other.nes', 'SNES/Game.sfc']);
  // without a buddy, everything is just "unknown"
  assert.ok(compare(await env.guestLib.manifest(), null).every((r) => r.status === 'unknown'));
});

test('unsafe relative paths are rejected', () => {
  for (const bad of ['../evil', '/etc/passwd', 'a/../../b', 'C:/x', '', 'a//b']) {
    assert.throws(() => safeRelParts(bad), /unsafe/);
  }
  assert.deepEqual(safeRelParts('SNES\\Game.sfc'), ['SNES', 'Game.sfc']);
});

test('launch commands', () => {
  const cfg = config.normalize({ nickname: 'me', retroarchCommand: ['retroarch'] });
  const [exe, args] = buildCommand(cfg, 'host', 'c.so', 'g.sfc', { overridesPath: 'o.cfg' });
  assert.equal(exe, 'retroarch');
  assert.deepEqual(args, ['-L', 'c.so', 'g.sfc', '--host', '--port', '55435', '--nick', 'me', '--appendconfig', 'o.cfg']);
  const [, guest] = buildCommand(cfg, 'guest', 'c.so', 'g.sfc', { connectTo: '100.1.2.3', port: 6000 });
  assert.deepEqual(guest.slice(3, 7), ['--connect', '100.1.2.3', '--port', '6000']);
  const flatpak = config.normalize({ nickname: 'me', retroarchCommand: ['flatpak', 'run', 'org.libretro.RetroArch'] });
  assert.deepEqual(buildCommand(flatpak, 'host', 'c', 'g')[1].slice(0, 3), ['run', 'org.libretro.RetroArch', '-L']);
  const relay = { ...cfg, connectionMode: 'relay' };
  assert.ok(!buildCommand(relay, 'guest', 'c.so', 'g.sfc')[1].includes('--connect'));
  assert.match(netplayOverrides(relay, 'host'), /netplay_use_mitm_server = "true"/);
  assert.match(netplayOverrides(relay, 'host'), /netplay_mitm_server = "nyc"/);
  assert.match(netplayOverrides(relay, 'guest'), /netplay_use_mitm_server = "false"/);
});

test('config round trip and validation', () => {
  const file = path.join(tmpdir(), 'config.json');
  config.save(file, { ...config.defaults(), peerAddress: ' 100.64.0.2 ', syncPort: '6000', coreMap: { sfc: 'bsnes_libretro' } });
  const loaded = config.load(file);
  assert.equal(loaded.peerAddress, '100.64.0.2');
  assert.equal(loaded.syncPort, 6000);
  assert.equal(config.coreForExtension(loaded, '.SFC'), 'bsnes_libretro');
  assert.equal(config.coreForExtension(loaded, 'nes'), 'fceumm_libretro');
  assert.throws(() => config.normalize({ connectionMode: 'carrier-pigeon' }), /Connection mode/);
  assert.throws(() => config.normalize({ syncPort: 55435 }), /must differ/);
  assert.equal(config.load(path.join(tmpdir(), 'missing.json')).connectionMode, 'direct');
});

test('two controllers: buddy sees the invite, joins, and gets matching files', async (t) => {
  const root = tmpdir();
  const port = 56000 + Math.floor(Math.random() * 2000);
  const launches = [];
  const releases = [];
  // Fake RetroArch: records the launch and stays "open" until released.
  const launch = (cfg, role, core, rom, opts = {}, hooks = {}) => new Promise((resolve) => {
    const child = { kill: () => resolve(0) };
    launches.push({ role, core, rom, opts, nick: cfg.nickname });
    releases.push(() => resolve(0));
    if (hooks.onSpawn) hooks.onSpawn(child);
  });
  const mk = async (name) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 50, launch });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: SECRET, peerAddress: '127.0.0.1', syncPort: port,
    });
    return c;
  };
  write(path.join(root, 'alice', 'roms', 'SNES', 'Co-op Game.sfc'), Buffer.from('co-op '.repeat(10000)));
  write(path.join(root, 'alice', 'cores', CORE_FILE), 'alice core');
  // Alice's server runs; Bob only polls (both can't bind the same port on one machine).
  const alice = await mk('alice');
  const bob = new Controller({ dataDir: path.join(root, 'bob'), pollMs: 50, launch });
  await bob.init();
  await bob.saveSettings({
    nickname: 'bob', romsDir: path.join(root, 'bob', 'roms'), coresDir: path.join(root, 'bob', 'cores'),
    retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: SECRET, peerAddress: '127.0.0.1',
    syncPort: port, shareLibrary: false,
  });
  t.after(async () => { await alice.dispose(); await bob.dispose(); });

  const waitFor = async (pred, what) => {
    for (let i = 0; i < 100; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 30)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor(() => bob.buddy.status === 'online', 'bob to see alice');
  assert.equal(bob.buddy.nickname, 'alice');

  const lib = await bob.getLibrary();
  assert.deepEqual(lib.rows.map((r) => [r.path, r.status]), [['SNES/Co-op Game.sfc', 'theirs']]);

  const invited = new Promise((resolve) => bob.once('invite', resolve));
  const aliceLib = await alice.getLibrary();
  await alice.host(aliceLib.rows[0].mine.sha256);
  assert.equal(launches[0].role, 'host');
  const invite = await invited;
  assert.equal(invite.rom.path, 'SNES/Co-op Game.sfc');

  const joined = await bob.join();
  assert.deepEqual(joined.downloaded.sort(), [CORE_FILE, 'SNES/Co-op Game.sfc'].sort());
  const guestLaunch = launches.find((l) => l.role === 'guest');
  assert.equal(guestLaunch.opts.connectTo, '127.0.0.1');
  assert.ok(fs.readFileSync(guestLaunch.rom).equals(fs.readFileSync(path.join(root, 'alice', 'roms', 'SNES', 'Co-op Game.sfc'))));

  // Alice closes RetroArch: the session ends and Bob's banner goes away.
  alice.stopHosting();
  await waitFor(() => alice.hosting === null, 'alice to stop hosting');
  await waitFor(() => bob.buddy.status === 'online' && !bob.buddy.session, 'bob to see session end');
  releases.forEach((r) => r());
});

test('buildbot: onlyIfChanged leaves an identical core alone, replaces a different one', async () => {
  const { zipSync } = require('fflate');
  const { fetchCoreFromBuildbot } = require('../src/main/sync');
  const dir = tmpdir();
  const fname = platforms.coreFilename('snes9x_libretro', 'linux');
  let bytes = 'v2 core';
  const fetchImpl = async () => {
    const zip = zipSync({ [fname]: new Uint8Array(Buffer.from(bytes)) });
    return { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
  };
  const opts = { fetchImpl, tag: 'linux-x86_64', onlyIfChanged: true };
  write(path.join(dir, fname), 'v2 core');
  await fetchCoreFromBuildbot('snes9x_libretro', dir, quiet, opts);
  assert.deepEqual(fs.readdirSync(dir), [fname]); // same bytes: no backup made

  bytes = 'v3 core';
  await fetchCoreFromBuildbot('snes9x_libretro', dir, quiet, opts);
  assert.equal(fs.readFileSync(path.join(dir, fname), 'utf8'), 'v3 core');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.old')).length, 1);
});
