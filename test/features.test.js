'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const updater = require('../src/main/updater');
const raSetup = require('../src/main/retroarch-setup');
const config = require('../src/main/config');
const platforms = require('../src/main/platforms');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-feat-'));
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return f; };
const jsonFetch = (obj, status = 200) => async () => ({ ok: status < 400, status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });

// ----- updates ----------------------------------------------------------------

test('update check: newer, same, older, and bad files', async () => {
  const feedUrl = 'https://gist.githubusercontent.com/me/abc/raw/retroconnect.json';
  const feed = { version: '0.5.0', url: 'https://drive.example.com/RetroConnect-0.5.0-win-setup.exe', notes: 'Suggest a game!' };
  const newer = await updater.checkForUpdate({ feedUrl, currentVersion: '0.4.0', fetchImpl: jsonFetch(feed) });
  assert.equal(newer.available, true);
  assert.equal(newer.latest, '0.5.0');
  assert.equal(newer.notes, 'Suggest a game!');
  assert.equal((await updater.checkForUpdate({ feedUrl, currentVersion: '0.5.0', fetchImpl: jsonFetch(feed) })).available, false);
  assert.equal((await updater.checkForUpdate({ feedUrl, currentVersion: '0.10.0', fetchImpl: jsonFetch(feed) })).available, false);
  assert.equal((await updater.checkForUpdate({ feedUrl, currentVersion: '0.4.0', fetchImpl: jsonFetch({ ...feed, version: 'v0.6.1' }) })).latest, '0.6.1');
  assert.deepEqual(await updater.checkForUpdate({ feedUrl: '', currentVersion: '0.4.0' }), { configured: false });
  await assert.rejects(updater.checkForUpdate({ feedUrl, currentVersion: '0.4.0', fetchImpl: jsonFetch({ version: '0.5.0', url: 'http://insecure' }) }), /https/);
  await assert.rejects(updater.checkForUpdate({ feedUrl, currentVersion: '0.4.0', fetchImpl: jsonFetch('<html>') }), /Couldn't check/);
  await assert.rejects(updater.checkForUpdate({ feedUrl, currentVersion: '0.4.0', fetchImpl: jsonFetch({}, 404) }), /HTTP 404/);
  await assert.rejects(updater.checkForUpdate({ feedUrl: 'http://x', currentVersion: '1.0.0' }), /https/);
});

test('controller: update banner state, built-in feed overridden by settings', async (t) => {
  const dir = tmpdir();
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ version: '9.9.9', url: 'https://example.com/x.exe' }) }; };
  const c = new Controller({ dataDir: dir, version: '0.5.0', updateFeedDefault: 'https://built.in/feed.json', fetchImpl, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.checkForUpdates();
  assert.match(seen[0], /^https:\/\/built\.in\/feed\.json\?t=\d+$/);
  assert.equal(c.state().update.available, true);
  await c.saveSettings({ updateFeedUrl: 'https://mine.example/feed.json' });
  await c.checkForUpdates();
  assert.match(seen[1], /^https:\/\/mine\.example\/feed\.json/);
  await assert.rejects(c.saveSettings({ updateFeedUrl: 'http://nope' }), /https/);
});

test('update check: GitHub Releases', async () => {
  const seen = [];
  const rel = (tag, assets) => async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, text: async () => JSON.stringify({ tag_name: tag, html_url: 'https://github.com/o/r/releases/tag/' + tag, body: 'Notes here', assets }) }; };
  const assets = [
    { name: 'RetroConnect-0.8.0-win-portable.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.8.0/RetroConnect-0.8.0-win-portable.exe' },
    { name: 'RetroConnect-0.8.0-win-setup.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.8.0/RetroConnect-0.8.0-win-setup.exe' },
  ];
  const r = await updater.checkForUpdate({ githubRepo: 'o/r', currentVersion: '0.7.1', fetchImpl: rel('v0.8.0', assets) });
  assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/releases/latest');
  assert.equal(seen[0].opts.headers['User-Agent'], 'RetroConnect');
  assert.equal(r.available, true);
  assert.equal(r.latest, '0.8.0');
  assert.match(r.url, /win-setup\.exe$/);
  assert.equal(r.notes, 'Notes here');
  // No installer attached: fall back to the release page.
  assert.equal((await updater.checkForUpdate({ githubRepo: 'o/r', currentVersion: '0.7.1', fetchImpl: rel('v0.8.0', []) })).url, 'https://github.com/o/r/releases/tag/v0.8.0');
  assert.equal((await updater.checkForUpdate({ githubRepo: 'o/r', currentVersion: '0.8.0', fetchImpl: rel('v0.8.0', assets) })).available, false);
  // A custom link wins over the repo.
  seen.length = 0;
  await updater.checkForUpdate({ feedUrl: 'https://x.example/f.json', githubRepo: 'o/r', currentVersion: '0.7.1', fetchImpl: rel('v0.8.0', assets) });
  assert.match(seen[0].url, /^https:\/\/x\.example\/f\.json\?t=/);
  await assert.rejects(updater.checkForUpdate({ githubRepo: 'o/r', currentVersion: '0.7.1', fetchImpl: jsonFetch({}, 404) }), /no releases published yet/);
  assert.deepEqual(await updater.checkForUpdate({ githubRepo: 'not a repo', currentVersion: '0.7.1' }), { configured: false });
});

// ----- controllers ------------------------------------------------------------

test('controller classification from Gamepad ids', () => {
  const cases = [
    ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'xbox', 'xinput', 'Xbox 360 Controller'],
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox', 'xinput'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation', 'sdl2', 'DualSense Wireless Controller'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'playstation', 'sdl2'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'nintendo', 'sdl2'],
    ['054c-0ce6-DualSense Wireless Controller', 'playstation', 'sdl2'],
    ['USB Gamepad (Vendor: 0079 Product: 0011)', 'generic', 'xinput', 'USB Gamepad'],
    ['', 'generic', 'xinput', 'Controller'],
  ];
  for (const [id, kind, driver, name] of cases) {
    const c = raSetup.classifyController(id);
    assert.equal(c.kind, kind, id);
    assert.equal(c.driver, driver, id);
    if (name) assert.equal(c.name, name);
  }
});

// ----- RetroArch settings -----------------------------------------------------

test('recommended settings use RetroArch\'s real values', () => {
  const s = raSetup.recommendedSettings({ controllerKind: 'playstation' });
  assert.equal(s.input_joypad_driver, 'sdl2');
  assert.equal(s.pause_nonactive, 'false');
  assert.equal(s.input_menu_toggle_gamepad_combo, '4'); // INPUT_COMBO_START_SELECT
  assert.equal(s.input_player1_analog_dpad_mode, '1'); // ANALOG_DPAD_LSTICK
  assert.equal(s.input_player4_analog_dpad_mode, '1');
  assert.equal(s.video_fullscreen, 'true');
  const minimal = raSetup.recommendedSettings({ fullscreen: false, stickAsDpad: false, startSelectMenu: false });
  assert.equal(minimal.video_fullscreen, 'false');
  assert.equal(minimal.input_joypad_driver, undefined); // no controller seen: leave the driver alone
  assert.equal(minimal.input_menu_toggle_gamepad_combo, undefined);
  assert.equal(minimal.pause_nonactive, 'false'); // always, for netplay
});

test('applying settings merges into retroarch.cfg and backs it up once', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'retroarch.cfg');
  const original = 'video_fullscreen = "false"\r\nmenu_driver = "ozone"\r\npause_nonactive = "true"\r\n';
  fs.writeFileSync(file, original);
  const r = await raSetup.applySettings(file, { video_fullscreen: 'true', pause_nonactive: 'false', input_joypad_driver: 'xinput' });
  assert.equal(r.backup, `${file}.before-retroconnect`);
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, 'video_fullscreen = "true"\r\nmenu_driver = "ozone"\r\npause_nonactive = "false"\r\ninput_joypad_driver = "xinput"\r\n');
  assert.deepEqual(raSetup.parseCfg(text), { video_fullscreen: 'true', menu_driver: 'ozone', pause_nonactive: 'false', input_joypad_driver: 'xinput' });
  // Second apply doesn't overwrite the original backup.
  await raSetup.applySettings(file, { video_fullscreen: 'false' });
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
  // A brand-new RetroArch has no cfg yet: we create one.
  const fresh = path.join(dir, 'new', 'retroarch.cfg');
  const r2 = await raSetup.applySettings(fresh, { pause_nonactive: 'false' });
  assert.equal(r2.backup, null);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'pause_nonactive = "false"\n');
});

test('config file is found next to a portable Windows RetroArch', () => {
  if (platforms.osName() !== 'windows') {
    assert.match(raSetup.configPath(['/usr/bin/retroarch']), /retroarch[\\/]retroarch\.cfg$/);
    assert.match(raSetup.configPath(['flatpak', 'run', 'org.libretro.RetroArch']), /org\.libretro\.RetroArch[\\/]config[\\/]retroarch[\\/]retroarch\.cfg$/);
    return;
  }
  const dir = tmpdir();
  write(path.join(dir, 'retroarch.cfg'), '');
  assert.equal(raSetup.configPath([path.join(dir, 'retroarch.exe')]), path.join(dir, 'retroarch.cfg'));
});

test('controller: set up everything installs missing cores and writes settings', async (t) => {
  const dir = tmpdir();
  const raDir = path.join(dir, 'RA');
  write(path.join(raDir, 'cores', platforms.coreFilename('snes9x_libretro')), 'already here');
  const fetched = [];
  const fetchCore = async (name, coresDir) => {
    fetched.push(name);
    if (name === 'stella_libretro') throw new Error('HTTP 503');
    return write(path.join(coresDir, platforms.coreFilename(name)), 'core');
  };
  const c = new Controller({ dataDir: path.join(dir, 'data'), fetchCore, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ retroarchCommand: [path.join(raDir, 'retroarch')], coresDir: path.join(raDir, 'cores') });
  const progress = [];
  c.on('progress', (p) => progress.push(p.label));

  await c.installCores(['snes9x_libretro', 'fceumm_libretro', 'fceumm_libretro']);
  assert.deepEqual(fetched, ['fceumm_libretro']); // snes9x was installed, duplicates ignored
  assert.ok(progress.includes('Installing cores (1 of 1)'));

  await assert.rejects(c.installCores(['stella_libretro']), /Couldn't install: stella_libretro/);
  assert.equal(c.state().busy, null);

  const cfgFile = raSetup.configPath(config.retroarchCmd(c.cfg));
  // Linux puts retroarch.cfg in ~/.config; point the test at a temp HOME-free path.
  if (!cfgFile.startsWith(raDir)) t.diagnostic(`config path on this OS: ${cfgFile}`);
  const info = await c.retroarchSetupInfo();
  assert.ok(info.systems.find((s) => s.core === 'fceumm_libretro').installed);
  assert.ok(!info.systems.find((s) => s.core === 'mgba_libretro').installed);

  c.playing = { rom: {}, core: {} };
  await assert.rejects(c.applyRetroArchSettings({}), /Close RetroArch/);
  await assert.rejects(c.setUpEverything({}), /Close RetroArch/);
});

// ----- Discord ----------------------------------------------------------------

test('Discord links: only real https Discord URLs', () => {
  for (const ok of ['https://discord.gg/abc123', 'https://discord.com/channels/123/456', 'https://ptb.discord.com/invite/x']) {
    assert.ok(config.isDiscordUrl(ok), ok);
  }
  for (const bad of ['http://discord.gg/abc', 'https://discord.gg.evil.com/x', 'https://evil.com/discord.gg', 'javascript:alert(1)', 'file:///c:/x', '']) {
    assert.ok(!config.isDiscordUrl(bad), bad);
  }
  assert.equal(config.normalize({ discordUrl: 'discord.gg/abc123' }).discordUrl, 'https://discord.gg/abc123');
  assert.throws(() => config.normalize({ discordUrl: 'https://example.com' }), /Discord link/);
});

// ----- two players: suggestion + shared Discord link -------------------------

test('suggest a game and share the Discord link between two apps', async (t) => {
  const root = tmpdir();
  const port = 58000 + Math.floor(Math.random() * 1500);
  const mk = async (name, extra) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, launch: () => new Promise(() => {}) });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: 's3cret', peerAddress: '127.0.0.1', syncPort: port, ...extra,
    });
    return c;
  };
  write(path.join(root, 'alex', 'roms', 'Bomb Party.sfc'), 'bomb');
  const alex = await mk('alex', { discordUrl: 'https://discord.gg/retro-night' });
  const sam = await mk('sam', { shareLibrary: false });
  t.after(async () => { await alex.dispose(); await sam.dispose(); });

  const waitFor = async (pred, what) => {
    for (let i = 0; i < 150; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor(() => sam.buddy.status === 'online', 'sam sees alex');
  // Sam has no Discord link of their own, so Alex's is used.
  await waitFor(() => sam.state().discord, 'discord link');
  assert.deepEqual(sam.state().discord, { url: 'https://discord.gg/retro-night', from: 'alex' });
  assert.deepEqual(alex.state().discord, { url: 'https://discord.gg/retro-night', from: 'you' });

  const got = new Promise((resolve) => sam.once('suggestion', resolve));
  const lib = await alex.getLibrary();
  const sug = await alex.suggest(lib.rows[0].mine.sha256);
  assert.equal(alex.state().mySuggestion.id, sug.id);
  const received = await got;
  assert.equal(received.from, 'alex');
  assert.equal(received.rom.path, 'Bomb Party.sfc');
  assert.equal(sam.state().buddy.suggestion.id, sug.id);

  // Hosting clears the suggestion for both.
  await alex.saveSettings({}); // keep server; nothing changes
  alex.clearSuggestion();
  await waitFor(() => !sam.buddy.suggestion, 'suggestion cleared');
  await assert.rejects(alex.suggest('0'.repeat(64)), /isn't in either library/);

  // Sam doesn't share a library, but can still suggest: the server starts for it.
  write(path.join(root, 'sam', 'roms', 'Kart.sfc'), 'kart');
  assert.equal(sam.state().server.running, false);
  await alex.dispose(); // free the port so Sam can serve on it
  const samLib = await sam.getLibrary();
  await sam.suggest(samLib.rows.find((r) => r.path === 'Kart.sfc').mine.sha256);
  assert.equal(sam.state().server.running, true);
  sam.clearSuggestion();
  await waitFor(() => !sam.state().server.running, 'sam server stops again');
});

test('a buddy sending junk can\'t inject a bad Discord link or suggestion', async (t) => {
  const { SyncServer } = require('../src/main/server');
  const { Library } = require('../src/main/library');
  const root = tmpdir();
  const lib = new Library({ romsDir: path.join(root, 'roms'), coresDir: path.join(root, 'cores'), nickname: 'evil' });
  const server = await new SyncServer({ library: lib, secret: 'x', host: '127.0.0.1', port: 0 }).start();
  server.discordUrl = 'https://evil.example/phish';
  server.suggestion = { id: '1', rom: 'not-an-object', from: 'evil' };
  const c = new Controller({ dataDir: path.join(root, 'me'), pollMs: 60000 });
  await c.init();
  t.after(async () => { await c.dispose(); await server.stop(); });
  await c.saveSettings({ sharedSecret: 'x', peerAddress: '127.0.0.1', syncPort: server.port, shareLibrary: false });
  await c.pollBuddy();
  assert.equal(c.buddy.status, 'online');
  assert.equal(c.buddy.discordUrl, null);
  assert.equal(c.buddy.suggestion, null);
  assert.equal(c.state().discord, null);
});

test('controller: update cores re-downloads every installed core and reports which changed', async (t) => {
  const dir = tmpdir();
  const coresDir = path.join(dir, 'RA', 'cores');
  write(path.join(coresDir, platforms.coreFilename('snes9x_libretro')), 'old snes');
  write(path.join(coresDir, platforms.coreFilename('fceumm_libretro')), 'nes latest');
  const calls = [];
  const fetchCore = async (name, dest, _log, opts) => {
    calls.push([name, opts && opts.onlyIfChanged]);
    if (name === 'snes9x_libretro') write(path.join(dest, platforms.coreFilename(name)), 'new snes');
    return path.join(dest, platforms.coreFilename(name));
  };
  const c = new Controller({ dataDir: path.join(dir, 'data'), fetchCore, pollMs: 60000 });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ coresDir });

  const r = await c.updateCores();
  assert.deepEqual(calls.map((x) => x[0]).sort(), ['fceumm_libretro', 'snes9x_libretro']);
  assert.ok(calls.every((x) => x[1] === true));
  assert.deepEqual(r, { checked: 2, updated: ['snes9x_libretro'] });
  assert.equal(c.state().busy, null);

  c.playing = true;
  await assert.rejects(c.updateCores(), /Close RetroArch/);
});
