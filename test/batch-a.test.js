'use strict';
// Connection check + version-match warnings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const netcheck = require('../src/main/netcheck');
const { Controller } = require('../src/main/controller');
const raInstaller = require('../src/main/retroarch-installer');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-a-'));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('tcpReachable and test listeners', async () => {
  const port = await freePort();
  assert.equal((await netcheck.tcpReachable('127.0.0.1', port, 2000)).reachable, false);
  const l = await netcheck.openTestListener(port, 5000);
  assert.equal(l.listening, true);
  assert.deepEqual(await netcheck.tcpReachable('127.0.0.1', port, 2000), { reachable: true });
  // ...and it closes itself after that one test connection, freeing the port for RetroArch.
  await new Promise((r) => setTimeout(r, 50));
  const again = await netcheck.openTestListener(port, 5000);
  assert.equal(again.listening, true);
  const clash = await netcheck.openTestListener(port);
  assert.equal(clash.listening, false);
  assert.match(clash.error, /already in use/);
  again.close();
});

async function pair(t, { aliceExtra = {}, bobExtra = {} } = {}) {
  const root = tmpdir();
  const sync = await freePort();
  const mk = async (name, extra) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, version: extra.version || '0.7.0', launch: () => new Promise(() => {}) });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: 's', peerAddress: '127.0.0.1', syncPort: sync,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'version')),
    });
    return c;
  };
  const alex = await mk('alex', { netplayPort: await freePort(), ...aliceExtra });
  const sam = await mk('sam', { netplayPort: await freePort(), shareLibrary: false, ...bobExtra });
  t.after(async () => { await alex.dispose(); await sam.dispose(); });
  for (let i = 0; i < 150 && sam.buddy.status !== 'online'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sam.buddy.status, 'online');
  return { alex, sam, root };
}

test('connection check: ping and both directions of the netplay port', async (t) => {
  const { alex, sam } = await pair(t);
  const r = await sam.checkConnection();
  assert.ok(r.ping.median >= 0 && r.ping.median < 1000);
  assert.ok(['great', 'good', 'ok', 'poor'].includes(r.ping.quality));
  assert.deepEqual([r.toBuddy.reachable, r.fromBuddy.reachable], [true, true]);
  assert.equal(r.toBuddy.port, alex.cfg.netplayPort);
  assert.equal(r.fromBuddy.port, sam.cfg.netplayPort);
  assert.equal(sam.state().connCheck.running, false);

  // Something else squats on Sam's netplay port: "they join you" can't be tested.
  const squat = net.createServer().listen(sam.cfg.netplayPort);
  await new Promise((res) => squat.once('listening', res));
  // ... and on Alex's: their side can't listen either.
  const squat2 = net.createServer().listen(alex.cfg.netplayPort);
  await new Promise((res) => squat2.once('listening', res));
  t.after(() => { squat.close(); squat2.close(); });
  const r2 = await sam.checkConnection();
  assert.equal(r2.fromBuddy.reachable, false);
  assert.match(r2.fromBuddy.error, /couldn't listen here/);
  assert.equal(r2.toBuddy.reachable, false);
  assert.match(r2.toBuddy.error, /their side couldn't listen/);
});

test('connection check: relay mode skips ports; old buddy app gets a clear message', async (t) => {
  const { alex, sam } = await pair(t);
  await sam.saveSettings({ connectionMode: 'relay' });
  const relay = await sam.checkConnection();
  assert.equal(relay.relay, true);
  assert.equal(relay.toBuddy, undefined);
  await sam.saveSettings({ connectionMode: 'direct' });
  alex.server.onNetplayProbe = null; // like a RetroConnect version without the endpoint
  alex.server.onProbeBack = null;
  const r = await sam.checkConnection();
  assert.match(r.toBuddy.error, /update RetroConnect/);
  assert.match(r.fromBuddy.error, /update RetroConnect/);
});

test('version warnings before joining, and installing a specific RetroArch version', async (t) => {
  const { alex, sam } = await pair(t, { aliceExtra: { version: '0.8.0' } });
  sam.raVersion = '1.21.0';
  const compat = await sam.joinCompat({ started_at: 1, host_nickname: 'alex', retroarch_version: '1.22.2', platform: 'other-os', core: { name: 'snes9x_libretro' } });
  const kinds = compat.warnings.map((w) => w.kind);
  assert.deepEqual(kinds, ['retroarch', 'app']);
  assert.match(compat.warnings[0].text, /alex has 1\.22\.2, you have 1\.21\.0/);
  assert.match(compat.warnings[1].text, /RetroConnect 0\.8\.0, you're on 0\.7\.0/);
  // Same versions: nothing to say.
  sam.raVersion = '1.22.2';
  sam.buddy.appVersion = '0.7.0';
  const ok = await sam.joinCompat({ started_at: 2, host_nickname: 'alex', retroarch_version: '1.22.2' });
  assert.deepEqual(ok.warnings, []);

  // "Match their RetroArch" installs exactly that version from libretro's stable builds.
  let asked = null;
  sam.installer = { ...raInstaller, install: async ({ release }) => { asked = release; throw new Error('stop here'); } };
  await assert.rejects(sam.installRetroArch('1.21.0'), /stop here/);
  assert.deepEqual(asked, { version: '1.21.0', url: 'https://buildbot.libretro.com/stable/1.21.0/windows/x86_64/RetroArch.7z' });
  await assert.rejects(sam.installRetroArch('../../evil'), /version number/);

  // The live poll fills in compat when the buddy hosts.
  sam.raVersion = '1.0.0';
  alex.server.session = { started_at: 99, host_nickname: 'alex', retroarch_version: '1.22.2', platform: 'x', rom: { path: 'G.sfc', size: 1, sha256: 'a'.repeat(64) }, core: { name: 'snes9x_libretro' } };
  for (let i = 0; i < 150 && !(sam.compat && sam.compat.startedAt === 99); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sam.state().compat.retroarch.match, false);
  assert.equal(sam.state().buddy.appVersion, '0.8.0');
  alex.server.session = null;
  for (let i = 0; i < 150 && sam.compat; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sam.state().compat, null);
});
