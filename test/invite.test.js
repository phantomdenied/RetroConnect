'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const invite = require('../src/main/invite');
const updater = require('../src/main/updater');
const { Controller } = require('../src/main/controller');
const { HostClient } = require('../src/main/sync');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-inv-'));

// ----- invite codes ---------------------------------------------------------------

test('invite: round trip, plain secret, broken codes', () => {
  const code = invite.makeInvite({ secret: 'abc123', tsKey: 'tskey-auth-xyz', address: '100.64.1.2', nickname: 'Phantom' });
  assert.match(code, /^RC1-[\w-]+$/);
  assert.deepEqual(invite.parseInvite(code), { secret: 'abc123', tsKey: 'tskey-auth-xyz', address: '100.64.1.2', nickname: 'Phantom' });
  // Line breaks and spaces from chat apps are ignored.
  assert.equal(invite.parseInvite(`  ${code.slice(0, 10)}\n${code.slice(10)} `).secret, 'abc123');
  assert.deepEqual(invite.parseInvite(invite.makeInvite({ secret: 's' })), { secret: 's', tsKey: null, address: null, nickname: '' });
  assert.equal(invite.isInvite('rc1-abc'), true);
  assert.equal(invite.isInvite('just-a-secret'), false);
  assert.throws(() => invite.parseInvite('RC1-%%%'), /cut off/);
  assert.throws(() => invite.parseInvite(code.slice(0, 12)), /cut off/);
  assert.throws(() => invite.makeInvite({ secret: '' }), /secret/);
  assert.throws(() => invite.makeInvite({ secret: 's', tsKey: 'nope' }), /tskey-/);
});

// A Tailscale stand-in: not installed until install(), connected after login().
function fakeTailscale(hostIp) {
  const calls = [];
  const st = { installed: false, state: 'NeedsLogin' };
  return {
    calls,
    KEYS_PAGE: 'https://login.tailscale.com/admin/settings/keys',
    MACHINES_PAGE: 'https://login.tailscale.com/admin/machines',
    status: async () => (!st.installed
      ? { installed: false, state: 'Unknown', peers: [] }
      : {
        installed: true, state: st.state,
        self: st.state === 'Running' ? { name: 'BUDDY-PC', ip: '100.64.9.9' } : null,
        peers: st.state === 'Running' ? [{ name: 'HOST-PC', ip: hostIp, online: true }] : [],
      }),
    latestInstaller: async () => ({ version: '1.90.0', url: 'https://pkgs.tailscale.com/x.msi' }),
    install: async () => { calls.push('install'); st.installed = true; return { version: '1.90.0' }; },
    login: async (_cmd, { authKey }) => { calls.push(`login:${authKey}`); st.state = 'Running'; },
    startApp: () => {},
  };
}

test('controller: redeeming an invite installs Tailscale, joins with the key, sets the address', async (t) => {
  process.env.RETROCONNECT_ALLOW_TS_INSTALL = '1';
  t.after(() => { delete process.env.RETROCONNECT_ALLOW_TS_INSTALL; });
  const dir = tmpdir();
  const ts = fakeTailscale('100.64.1.2');
  const c = new Controller({ dataDir: dir, tailscale: ts, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());

  const code = invite.makeInvite({ secret: 's3cret', tsKey: 'tskey-auth-once', address: '100.64.1.2', nickname: 'Phantom' });
  await c.redeemInvite(code, { nickname: 'Buddy', romsDir: path.join(dir, 'roms') });
  const cfg = c.state().config;
  assert.equal(cfg.sharedSecret, 's3cret');
  assert.equal(cfg.peerAddress, '100.64.1.2');
  assert.equal(cfg.connectionMode, 'tailscale');
  assert.equal(cfg.nickname, 'Buddy');
  assert.equal(c.state().configured, true);
  assert.deepEqual(ts.calls, ['install', 'login:tskey-auth-once']);

  // Pasting it again doesn't burn the (one-time) key: already on that network.
  await c.redeemInvite(code);
  assert.deepEqual(ts.calls, ['install', 'login:tskey-auth-once']);
  await assert.rejects(c.redeemInvite('RC1-garbage!!'), /cut off/);
});

test('controller: makeInvite includes my Tailscale address only when connected', async (t) => {
  process.env.RETROCONNECT_ALLOW_TS_INSTALL = '1';
  t.after(() => { delete process.env.RETROCONNECT_ALLOW_TS_INSTALL; });
  const ts = fakeTailscale('100.64.1.2');
  const c = new Controller({ dataDir: tmpdir(), tailscale: ts, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ sharedSecret: 'host-secret', nickname: 'Phantom' });
  assert.deepEqual(invite.parseInvite(c.makeInvite()), { secret: 'host-secret', tsKey: null, address: null, nickname: 'Phantom' });
  assert.throws(() => c.makeInvite({ tsKey: 'tskey-auth-1' }), /Tailscale first/);
  await ts.install();
  await c.loginTailscale({ authKey: 'tskey-auth-host' });
  const inv = invite.parseInvite(c.makeInvite({ tsKey: 'tskey-auth-1' }));
  assert.equal(inv.address, '100.64.9.9');
  assert.equal(inv.tsKey, 'tskey-auth-1');
});

test('controller: the buddy\'s first request fills in their address on the inviter\'s side', async (t) => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'roms'));
  const port = 56000 + Math.floor(Math.random() * 2000);
  const c = new Controller({ dataDir: dir, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ sharedSecret: 'pair', romsDir: path.join(dir, 'roms'), syncPort: port, peerAddress: '' });
  assert.ok(c.server, 'sharing server should run');

  // Wrong secret: ignored.
  await new HostClient('127.0.0.1', port, 'wrong', { timeoutMs: 3000 }).status().catch(() => {});
  // Loopback is never taken as the buddy, so dial the LAN address instead when there is one.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  await new HostClient('127.0.0.1', port, 'pair', { timeoutMs: 3000 }).status();
  assert.equal(c.cfg.peerAddress, '');
  if (!lan) return t.diagnostic('no LAN address; skipped the non-loopback half');
  await new HostClient(lan.address, port, 'pair', { timeoutMs: 3000 }).status();
  for (let i = 0; i < 20 && !c.cfg.peerAddress; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.cfg.peerAddress, lan.address);
  // Once set, it's never overwritten by a request.
  c.noteBuddyAddress('10.9.9.9');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.cfg.peerAddress, lan.address);
});

// ----- self-update ----------------------------------------------------------------

const bodyOf = (buf) => new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array(buf)); ctl.close(); } });
const fileFetch = (buf) => async () => ({ ok: true, status: 200, body: bodyOf(buf), headers: new Headers({ 'content-length': String(buf.length) }) });

test('update download: checks size and SHA-256, never leaves a half file', async () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(5000);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const dest = path.join(dir, 'setup.exe');
  const asset = { name: 'setup.exe', url: 'https://x/setup.exe', size: data.length, sha256 };
  await updater.downloadAsset(asset, dest, { fetchImpl: fileFetch(data) });
  assert.deepEqual(fs.readFileSync(dest), data);
  fs.rmSync(dest);
  await assert.rejects(updater.downloadAsset({ ...asset, sha256: 'a'.repeat(64) }, dest, { fetchImpl: fileFetch(data) }), /damaged/);
  await assert.rejects(updater.downloadAsset({ ...asset, size: data.length + 1 }, dest, { fetchImpl: fileFetch(data) }), /cut off/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('release asset: setup exe with GitHub digest; portable-only releases can\'t self-update', () => {
  const feed = updater.feedFromRelease({
    tag_name: 'v0.8.0', html_url: 'https://github.com/o/r/releases/tag/v0.8.0',
    assets: [{ name: 'RetroConnect-0.8.0-win-setup.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.8.0/RetroConnect-0.8.0-win-setup.exe', size: 123, digest: `sha256:${'b'.repeat(64)}` }],
  });
  assert.deepEqual(feed.asset, { name: 'RetroConnect-0.8.0-win-setup.exe', url: 'https://github.com/o/r/releases/download/v0.8.0/RetroConnect-0.8.0-win-setup.exe', size: 123, sha256: 'b'.repeat(64) });
  assert.equal(feed.pageUrl, 'https://github.com/o/r/releases/tag/v0.8.0');
  const portable = updater.feedFromRelease({ tag_name: 'v0.8.0', html_url: 'https://github.com/o/r/releases/tag/v0.8.0', assets: [{ name: 'RetroConnect-0.8.0-win-portable.exe', browser_download_url: 'https://github.com/o/r/x.exe' }] });
  assert.equal(portable.asset, undefined);
});

test('controller: download the update, then run the installer silently', async (t) => {
  const dir = tmpdir();
  const data = crypto.randomBytes(3000);
  const release = {
    tag_name: 'v9.0.0', html_url: 'https://github.com/o/r/releases/tag/v9.0.0', body: '',
    assets: [{ name: 'RetroConnect-9.0.0-win-setup.exe', browser_download_url: 'https://github.com/o/r/releases/download/v9.0.0/RetroConnect-9.0.0-win-setup.exe', size: data.length }],
  };
  const fetchImpl = async (url) => (/api\.github\.com/.test(url)
    ? { ok: true, status: 200, text: async () => JSON.stringify(release) }
    : fileFetch(data)());
  const opened = [];
  const c = new Controller({ dataDir: dir, version: '0.7.1', githubRepo: 'o/r', selfUpdate: true, fetchImpl, pollMs: 60000 });
  c.on('openUrl', (u) => opened.push(u));
  await c.init();
  t.after(() => c.dispose());

  assert.throws(() => c.installUpdate(), /Download the update first/);
  await c.checkForUpdates();
  assert.equal(c.state().update.available, true);
  assert.equal(c.state().selfUpdate, true);
  await c.downloadUpdate();
  const file = c.state().update.downloaded;
  assert.deepEqual(fs.readFileSync(file), data);
  // A later check for the same version keeps the downloaded file.
  await c.checkForUpdates();
  assert.equal(c.state().update.downloaded, file);

  const spawned = [];
  c.installUpdate({ spawnImpl: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; } });
  assert.equal(spawned[0].cmd, file);
  assert.deepEqual(spawned[0].args, ['/S', '--force-run']);
  assert.equal(spawned[0].opts.detached, true);
  assert.deepEqual(opened, []);

  // Portable / dev copies just open the release page.
  c.selfUpdate = false;
  await c.downloadUpdate();
  assert.deepEqual(opened, ['https://github.com/o/r/releases/tag/v9.0.0']);
});
