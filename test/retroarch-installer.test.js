'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const inst = require('../src/main/retroarch-installer');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ra-'));

function fakeResponse(body, { status = 200, headers = {} } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status < 400,
    status,
    headers: { get: (k) => ({ 'content-length': String(buf.length), ...headers })[k.toLowerCase()] ?? null },
    text: async () => buf.toString(),
    body: new Blob([buf]).stream(),
  };
}

const INDEX = `<a href="/stable/1.9.9/">1.9.9</a><a href="/stable/1.21.0/">1.21.0</a>
<a href="/stable/1.22.2/">1.22.2</a><a href="/stable/1.23.0/">1.23.0</a><a href="/stable/altstore.json">x</a>`;

test('versions compare numerically', () => {
  assert.ok(inst.compareVersions('1.22.2', '1.9.9') > 0);
  assert.ok(inst.compareVersions('1.22.2', '1.22.10') < 0);
  assert.equal(inst.compareVersions('1.22.2', '1.22.2'), 0);
});

test('latest stable skips a release whose Windows build is not up yet', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url}`);
    if (url === inst.STABLE_INDEX) return fakeResponse(INDEX);
    if (url.includes('/1.23.0/')) return fakeResponse('', { status: 404 });
    return fakeResponse('', { headers: { 'content-length': '202509078' } });
  };
  const rel = await inst.latestStable({ fetchImpl });
  assert.equal(rel.version, '1.22.2');
  assert.equal(rel.url, 'https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch.7z');
  assert.equal(rel.size, 202509078);
  assert.ok(seen.includes(`HEAD ${inst.archiveUrl('1.23.0')}`));
});

test('latest stable reports a clear error when offline', async () => {
  await assert.rejects(inst.latestStable({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
    /Couldn't check for the latest RetroArch: ENOTFOUND/);
});

test('install downloads, unpacks a nested archive, and keeps user files on update', async () => {
  const root = tmpdir();
  // Build a small archive shaped like the real one: RetroArch-Win64/retroarch.exe ...
  const src = path.join(root, 'src', 'RetroArch-Win64');
  fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(src, 'retroarch.exe'), 'MZ fake exe v1');
  fs.writeFileSync(path.join(src, 'assets', 'logo.png'), 'png');
  const archive = path.join(root, 'RetroArch.7z');
  execFileSync(require('7zip-bin').path7za, ['a', archive, src], { stdio: 'ignore' });
  const bytes = fs.readFileSync(archive);
  const fetchImpl = async () => fakeResponse(bytes);

  const installDir = path.join(root, 'RetroConnect', 'RetroArch');
  const progress = [];
  const r = await inst.install({
    installDir, release: { version: '1.22.2', url: 'x' }, fetchImpl, onProgress: (p) => progress.push(p),
  });
  assert.equal(r.exe, path.join(installDir, 'retroarch.exe'));
  assert.equal(fs.readFileSync(r.exe, 'utf8'), 'MZ fake exe v1');
  assert.ok(fs.existsSync(path.join(installDir, 'assets', 'logo.png')));
  assert.ok(fs.statSync(r.coresDir).isDirectory());
  assert.equal(inst.installedVersion(installDir), '1.22.2');
  assert.ok(progress.some((p) => p.label.startsWith('Downloading') && p.done === bytes.length));
  assert.ok(progress.some((p) => p.label.startsWith('Unpacking') && p.percent));
  // no temp folders left behind
  assert.deepEqual(fs.readdirSync(path.dirname(installDir)).filter((f) => f.startsWith('.retroarch')), []);

  // Update: user config and cores survive.
  fs.writeFileSync(path.join(installDir, 'retroarch.cfg'), 'video_fullscreen = "true"');
  fs.writeFileSync(path.join(r.coresDir, 'snes9x_libretro.dll'), 'core');
  await inst.install({ installDir, release: { version: '1.23.0', url: 'x' }, fetchImpl });
  assert.equal(inst.installedVersion(installDir), '1.23.0');
  assert.equal(fs.readFileSync(path.join(installDir, 'retroarch.cfg'), 'utf8'), 'video_fullscreen = "true"');
  assert.ok(fs.existsSync(path.join(r.coresDir, 'snes9x_libretro.dll')));
});

test('a truncated download fails instead of installing', async () => {
  const root = tmpdir();
  const fetchImpl = async () => {
    const res = fakeResponse(Buffer.alloc(100));
    res.headers = { get: (k) => (k === 'content-length' ? '5000' : null) };
    return res;
  };
  await assert.rejects(inst.install({ installDir: path.join(root, 'RA'), release: { version: '1', url: 'x' }, fetchImpl }), /cut off/);
  assert.equal(inst.installedVersion(path.join(root, 'RA')), null);
});

test('installing from the app points RetroConnect at the new RetroArch', async (t) => {
  const root = tmpdir();
  const raDir = path.join(root, 'RA');
  const installer = {
    ...inst,
    latestStable: async () => ({ version: '1.22.2', url: 'x', size: 1 }),
    install: async ({ installDir, onProgress }) => {
      onProgress({ label: 'Downloading RetroArch 1.22.2', done: 1, total: 1 });
      fs.mkdirSync(path.join(installDir, 'cores'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'retroarch.exe'), 'MZ');
      fs.writeFileSync(path.join(installDir, '.retroconnect-install.json'), JSON.stringify({ version: '1.22.2' }));
      return { version: '1.22.2', exe: path.join(installDir, 'retroarch.exe'), coresDir: path.join(installDir, 'cores') };
    },
  };
  const c = new Controller({ dataDir: path.join(root, 'data'), retroarchDir: raDir, installer, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ sharedSecret: 's', retroarchCommand: ['/old/retroarch'], coresDir: '/my/cores', syncPort: 56000 + Math.floor(Math.random() * 2000) });

  await c.checkRetroArchLatest();
  assert.equal(c.state().retroarch.updateAvailable, true); // /old/retroarch has no version

  const result = await c.installRetroArch();
  assert.equal(result.version, '1.22.2');
  const st = c.state();
  assert.deepEqual(st.config.retroarchCommand, [path.join(raDir, 'retroarch.exe')]);
  assert.equal(st.config.coresDir, '/my/cores'); // a hand-picked cores folder is kept
  assert.equal(st.retroarch.version, '1.22.2');
  assert.equal(st.retroarch.managed.version, '1.22.2');
  assert.equal(st.retroarch.updateAvailable, false);
  assert.equal(st.busy, null);

  // Can't install mid-game
  c.playing = { rom: {}, core: {}, host: 'x' };
  await assert.rejects(c.installRetroArch(), /Close RetroArch/);
});
