'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ts = require('../src/main/tailscale');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ts-'));

// Status JSON shaped like `tailscale status --json` (ipnstate.Status).
function statusJson(state, peers = []) {
  return {
    Version: '1.104.5-t1234',
    BackendState: state,
    AuthURL: '',
    TailscaleIPs: state === 'Running' ? ['100.64.0.1', 'fd7a:115c:a1e0::1'] : [],
    Self: { HostName: 'SAM-PC', DNSName: 'sam-pc.tail1234.ts.net.', OS: 'windows', TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], Online: true },
    Peer: Object.fromEntries(peers.map((p, i) => [`nodekey:${i}`, p])),
    User: {},
  };
}

/**
 * A stand-in for tailscale.exe. Behaviour is driven by files in `dir`:
 *   state.json   what `status --json` prints
 *   down         if present, status fails like the service isn't running
 *   approve      created by the test to "finish" browser sign-in
 */
function fakeCli(dir) {
  const script = path.join(dir, 'fake-tailscale.js');
  fs.writeFileSync(script, `
const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const stateFile = path.join(dir, 'state.json');
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const setState = (s) => { const d = read(); d.BackendState = s; fs.writeFileSync(stateFile, JSON.stringify(d)); };
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\\n');
if (args[0] === 'status') {
  if (fs.existsSync(path.join(dir, 'down'))) { console.error('failed to connect to local tailscaled; it doesn\\'t appear to be running'); process.exit(1); }
  process.stdout.write(JSON.stringify(read(), null, 2)); process.exit(0);
}
if (args[0] === 'up') {
  const key = (args.find((a) => a.startsWith('--auth-key=')) || '').slice('--auth-key='.length);
  if (key) {
    if (key !== 'tskey-auth-good') { console.error('backend error: invalid key: unable to validate API key'); process.exit(1); }
    setState('Running'); console.log(JSON.stringify({ BackendState: 'Running' }, null, '\\t')); process.exit(0);
  }
  console.log(JSON.stringify({ AuthURL: 'https://login.tailscale.com/a/0123456789abcdef', QR: 'data:image/png;base64,AAAA', BackendState: 'NeedsLogin' }, null, '\\t'));
  const t = setInterval(() => {
    if (fs.existsSync(path.join(dir, 'approve'))) {
      clearInterval(t); setState('Running');
      console.log(JSON.stringify({ BackendState: 'Running' }, null, '\\t')); process.exit(0);
    }
  }, 20);
}
`);
  return [process.execPath, script];
}

const BUDDY = { HostName: 'ALEX-PC', DNSName: 'alex-pc.tail1234.ts.net.', OS: 'windows', TailscaleIPs: ['100.101.102.103', 'fd7a::2'], Online: true };
const PHONE = { HostName: 'pixel', DNSName: 'pixel.tail1234.ts.net.', OS: 'android', TailscaleIPs: ['100.90.1.1'], Online: false };

test('status parsing: devices sorted online-first, IPv4 preferred', () => {
  const st = ts.parseStatus(statusJson('Running', [PHONE, BUDDY]));
  assert.equal(st.state, 'Running');
  assert.equal(st.version, '1.104.5');
  assert.deepEqual(st.self, { name: 'SAM-PC', dnsName: 'sam-pc.tail1234.ts.net', ip: '100.64.0.1', os: 'windows', online: true });
  assert.deepEqual(st.peers.map((p) => [p.name, p.ip, p.online]), [['ALEX-PC', '100.101.102.103', true], ['pixel', '100.90.1.1', false]]);
});

test('status: not installed, not running, needs login', async () => {
  assert.deepEqual(await ts.status([]), { installed: false, state: 'NotInstalled', peers: [] });
  const dir = tmpdir();
  const cli = fakeCli(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(statusJson('NeedsLogin')));
  assert.equal((await ts.status(cli)).state, 'NeedsLogin');
  fs.writeFileSync(path.join(dir, 'down'), '');
  const down = await ts.status(cli);
  assert.equal(down.state, 'NotRunning');
  assert.equal(down.installed, true);
});

test('browser sign-in: surfaces the URL, then resolves once approved', async () => {
  const dir = tmpdir();
  const cli = fakeCli(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(statusJson('NeedsLogin')));
  let url = null;
  const done = ts.login(cli, { onAuthUrl: (u) => { url = u; fs.writeFileSync(path.join(dir, 'approve'), ''); } });
  const r = await done;
  assert.equal(url, 'https://login.tailscale.com/a/0123456789abcdef');
  assert.equal(r.state, 'Running');
  assert.match(fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'), /^up --json --timeout=600s$/m);
});

test('join with a key; bad keys get a friendly message', async () => {
  const dir = tmpdir();
  const cli = fakeCli(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(statusJson('NeedsLogin')));
  await assert.rejects(ts.login(cli, { authKey: 'tskey-auth-bad' }), /didn't work.*new one/);
  const r = await ts.login(cli, { authKey: ' tskey-auth-good ' });
  assert.equal(r.state, 'Running');
  assert.match(fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'), /--auth-key=tskey-auth-good$/m);
});

test('cancelling sign-in rejects', async () => {
  const dir = tmpdir();
  const cli = fakeCli(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(statusJson('NeedsLogin')));
  let child;
  const p = ts.login(cli, { onStart: (c) => { child = c; }, onAuthUrl: () => child.kill() });
  await assert.rejects(p, /Tailscale couldn't connect/);
});

test('latest installer comes from the redirect target', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi');
    assert.equal(opts.method, 'HEAD');
    return { ok: true, url: 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi', headers: { get: () => '38800896' } };
  };
  assert.deepEqual(await ts.latestInstaller({ fetchImpl, arch: 'amd64' }),
    { url: 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi', version: '1.104.5', size: 38800896 });
});

test('install: downloads the MSI, runs it elevated, cleans up; maps cancel', async () => {
  const work = tmpdir();
  const bytes = Buffer.alloc(5000, 7);
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(bytes.length) : null) }, body: new Blob([bytes]).stream() });
  const release = { url: 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi', version: '1.104.5' };
  let ranWith = null;
  const progress = [];
  const r = await ts.install({
    release, fetchImpl, workDir: work, findCliImpl: () => ['tailscale.exe'],
    onProgress: (p) => progress.push(p),
    runElevated: async (msi) => { ranWith = msi; assert.equal(fs.readFileSync(msi).length, 5000); return 0; },
  });
  assert.equal(path.basename(ranWith), 'tailscale-setup-1.104.5-amd64.msi');
  assert.deepEqual(r, { version: '1.104.5', restartNeeded: false });
  assert.equal(progress.at(-1).done, 5000);
  assert.deepEqual(fs.readdirSync(work), []); // temp folder removed

  await assert.rejects(ts.install({ release, fetchImpl, workDir: work, findCliImpl: () => ['x'], runElevated: async () => 1602 }), /cancelled/);
  await assert.rejects(ts.install({ release, fetchImpl, workDir: work, findCliImpl: () => ['x'], runElevated: async () => 1618 }), /Another installation/);
  const restart = await ts.install({ release, fetchImpl, workDir: work, findCliImpl: () => ['x'], runElevated: async () => 3010 });
  assert.equal(restart.restartNeeded, true);
  assert.deepEqual(fs.readdirSync(work), []);
});

test('controller: join with key, then pick the buddy from the device list', async (t) => {
  const dir = tmpdir();
  const cli = fakeCli(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(statusJson('NeedsLogin', [BUDDY, PHONE])));
  const fake = {
    ...ts,
    status: () => ts.status(cli),
    login: (_cmd, opts) => ts.login(cli, opts),
  };
  const c = new Controller({ dataDir: path.join(dir, 'data'), tailscale: fake, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.refreshTailscale();
  assert.equal(c.state().tailscale.state, 'NeedsLogin');

  await assert.rejects(c.loginTailscale({ authKey: 'not-a-key' }), /tskey-/);
  // A failed attempt must tell the UI it's no longer signing in.
  const states = [];
  c.on('state', (st) => states.push(st.tailscale.signingIn));
  await assert.rejects(c.loginTailscale({ authKey: 'tskey-auth-bad' }), /didn't work/);
  assert.equal(states.at(-1), false);
  await c.loginTailscale({ authKey: 'tskey-auth-good' });
  const st = c.state();
  assert.equal(st.tailscale.state, 'Running');
  assert.equal(st.tailscale.signingIn, false);
  assert.equal(st.config.connectionMode, 'tailscale');
  assert.equal(st.tailscale.peers[0].name, 'ALEX-PC');

  await c.useTailscalePeer('100.101.102.103');
  assert.equal(c.state().config.peerAddress, '100.101.102.103');
  await assert.rejects(c.useTailscalePeer('100.1.1.1'), /no longer/);
});
