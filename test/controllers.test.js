'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raSetup = require('../src/main/retroarch-setup');
const { netplayOverrides } = require('../src/main/launcher');
const config = require('../src/main/config');
const platforms = require('../src/main/platforms');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pads-'));
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return f; };

const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const PRO = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
const CHEAP = 'USB Gamepad (Vendor: 0079 Product: 0011)';
const pad = (id, mapping = 'standard') => raSetup.classifyController(id, /STANDARD/.test(id) ? mapping : '');

// RetroArch's own sdl2/PS5 Controller.cfg (trimmed) from retroarch-joypad-autoconfig.
const PS5_PROFILE = 'input_driver = "sdl2"\ninput_device = "PS5 Controller"\ninput_vendor_id = "1356"\ninput_product_id = "3302"\ninput_b_btn = "0"\n';
const XINPUT_PROFILE = 'input_driver = "xinput"\ninput_device = "XInput Controller"\ninput_b_btn = "0"\n';

test('driver choice covers the whole set of controllers', () => {
  assert.equal(raSetup.chooseDriver([]), null);
  assert.equal(raSetup.chooseDriver([pad(XBOX)]), 'xinput');
  assert.equal(raSetup.chooseDriver([pad(DUALSENSE)]), 'sdl2');
  assert.equal(raSetup.chooseDriver([pad(PRO)]), 'sdl2');
  assert.equal(raSetup.chooseDriver([pad(CHEAP)]), 'xinput');
  // XInput pads have no IDs, so sdl2 couldn't match them: stay on xinput.
  assert.equal(raSetup.chooseDriver([pad(DUALSENSE), pad(XBOX)]), 'xinput');
});

test('profiles: built-in found by IDs or XInput name, standard pads get one created, unknown pads get help', async () => {
  const dir = tmpdir();
  write(path.join(dir, 'sdl2', 'PS5 Controller.cfg'), PS5_PROFILE);
  write(path.join(dir, 'xinput', 'XInput Controller.cfg'), XINPUT_PROFILE);

  const [ds] = await raSetup.ensureProfiles([pad(DUALSENSE)], 'sdl2', dir);
  assert.deepEqual(ds.profile, { status: 'builtin', file: 'PS5 Controller.cfg' });

  const [xb] = await raSetup.ensureProfiles([pad(XBOX)], 'xinput', dir);
  assert.deepEqual(xb.profile, { status: 'builtin', file: 'XInput Controller.cfg' });

  // A Switch Pro controller RetroArch has no profile for: we write one.
  const [pro] = await raSetup.ensureProfiles([pad(PRO)], 'sdl2', dir);
  assert.equal(pro.profile.status, 'created');
  const written = raSetup.parseCfg(fs.readFileSync(path.join(dir, 'sdl2', pro.profile.file), 'utf8'));
  assert.equal(written.input_driver, 'sdl2');
  assert.equal(written.input_vendor_id, String(0x057e));
  assert.equal(written.input_product_id, String(0x2009));
  assert.equal(written.input_b_btn, '0'); // same layout as RetroArch's PS5 profile
  assert.equal(written.input_start_btn, '6');
  assert.equal(written.input_up_btn, '11');
  // ...and next time it's recognised as ours, not rewritten.
  const [again] = await raSetup.ensureProfiles([pad(PRO)], 'sdl2', dir);
  assert.deepEqual(again.profile, { status: 'created', file: pro.profile.file });

  // A non-standard cheap pad under xinput goes through DirectInput: no profile, clear help.
  const [cheap] = await raSetup.ensureProfiles([pad(CHEAP)], 'xinput', dir);
  assert.equal(cheap.driver, 'dinput');
  assert.equal(cheap.profile.status, 'missing');
  assert.match(cheap.profile.help, /Set All Controls/);

  // Missing XInput profile -> point to RetroArch's updater.
  const empty = tmpdir();
  const [xb2] = await raSetup.ensureProfiles([pad(XBOX)], 'xinput', empty);
  assert.match(xb2.profile.help, /Update Controller Profiles/);
  // write: false never touches disk
  await raSetup.ensureProfiles([pad(PRO)], 'sdl2', empty, { write: false });
  assert.ok(!fs.existsSync(path.join(empty, 'sdl2')));
});

test('autoconfig folder: RetroArch ":" paths resolve next to retroarch.exe', () => {
  const exe = path.join(os.tmpdir(), 'RA', 'retroarch.exe');
  assert.equal(raSetup.autoconfigDir([exe], { joypad_autoconfig_dir: ':\\autoconfig' }), path.join(os.tmpdir(), 'RA', 'autoconfig'));
  assert.equal(raSetup.autoconfigDir([exe], { joypad_autoconfig_dir: '/custom/ac' }), '/custom/ac');
  if (platforms.osName() === 'windows') assert.equal(raSetup.autoconfigDir([exe], {}), path.join(path.dirname(exe), 'autoconfig'));
});

test('reservations put a chosen controller on a player; netplay slot requests', () => {
  const pads = [pad(DUALSENSE), pad(PRO), pad(XBOX)];
  const s = raSetup.reservationSettings(pads, { '057e:2009': 1, '054c:0ce6': 2, 'xinput:Xbox 360 Controller': 3 });
  assert.equal(s.input_player1_device_reservation_type, '1');
  assert.equal(s.input_player1_reserved_device, '057e:2009 Pro Controller');
  assert.equal(s.input_player2_reserved_device, '054c:0ce6 DualSense Wireless Controller');
  assert.equal(s.input_player3_device_reservation_type, '0'); // XInput pads have no IDs to reserve by
  assert.deepEqual(raSetup.netplaySlotSettings(2), {
    netplay_request_device_p1: 'false', netplay_request_device_p2: 'true', netplay_request_device_p3: 'false', netplay_request_device_p4: 'false',
  });
  assert.ok(Object.values(raSetup.netplaySlotSettings(null)).every((v) => v === 'false'));
  // They end up in the --appendconfig file
  const cfg = config.normalize({ nickname: 'me' });
  const text = netplayOverrides(cfg, 'host', { input_joypad_driver: 'sdl2', ...raSetup.netplaySlotSettings(1) });
  assert.match(text, /input_joypad_driver = "sdl2"/);
  assert.match(text, /netplay_request_device_p1 = "true"/);
});

test('controller: remembers controllers, picks driver, and Host/Join launch with the right players', async (t) => {
  const root = tmpdir();
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldAppData = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  process.env.APPDATA = path.join(root, 'appdata');
  t.after(() => {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
  });
  const port = 59000 + Math.floor(Math.random() * 900);
  const raDir = path.join(root, 'RA');
  write(path.join(raDir, 'autoconfig', 'sdl2', 'PS5 Controller.cfg'), PS5_PROFILE);
  // Put retroarch.cfg somewhere we control so autoconfigDir resolves to raDir/autoconfig.
  const launches = [];
  const launch = (cfg, role, core, rom, opts = {}) => { launches.push({ role, overrides: opts.overrides }); return new Promise(() => {}); };
  const mk = async (name, extra = {}) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, launch });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: [path.join(raDir, 'retroarch.exe')], sharedSecret: 's', peerAddress: '127.0.0.1', syncPort: port, ...extra,
    });
    return c;
  };
  write(path.join(root, 'alex', 'roms', 'Game.sfc'), 'game');
  write(path.join(root, 'alex', 'cores', platforms.coreFilename('snes9x_libretro')), 'core');
  const alex = await mk('alex', { hostPlayer: 2 });
  const sam = await mk('sam', { shareLibrary: false });
  t.after(async () => { await alex.dispose(); await sam.dispose(); });

  // Point the profile lookup at our fake RetroArch folder (via its retroarch.cfg,
  // kept in a temp config dir so the real one is never touched).
  const cfgFile = raSetup.configPath([path.join(raDir, 'retroarch.exe')]);
  write(cfgFile, `joypad_autoconfig_dir = "${path.join(raDir, 'autoconfig')}"\n`);

  // Alex plugs in a DualSense: reported, classified, remembered.
  const ctrl = await alex.reportPads([{ index: 0, id: DUALSENSE, mapping: 'standard' }]);
  assert.equal(ctrl.driver, 'sdl2');
  assert.equal(ctrl.pads[0].profile.status, 'builtin');
  await alex.assignPad('054c:0ce6', 1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'alex', 'controllers.json'), 'utf8'));
  assert.equal(saved.known[0].name, 'DualSense Wireless Controller');
  assert.deepEqual(saved.assign, { '054c:0ce6': 1 });
  // Window closed and reopened: no live pads, but the remembered one still counts.
  await alex.reportPads([]);
  assert.equal(alex.state().controllers.live, false);
  assert.equal(alex.state().controllers.driver, 'sdl2');

  // Sam has an Xbox pad.
  await sam.reportPads([{ index: 0, id: XBOX, mapping: 'standard' }]);

  const waitFor = async (pred, what) => {
    for (let i = 0; i < 150; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor(() => sam.buddy.status === 'online', 'sam sees alex');

  // Alex hosts with "my buddy is Player 1" (hostPlayer 2).
  const lib = await alex.getLibrary();
  await alex.host(lib.rows[0].mine.sha256);
  const hostLaunch = launches.find((l) => l.role === 'host').overrides;
  assert.equal(hostLaunch.input_joypad_driver, 'sdl2');
  // No fixed ports (they'd undo a swap): the host starts out watching, so Sam
  // takes Player 1 on joining and Alex steps in as Player 2.
  assert.equal(hostLaunch.netplay_request_device_p1, 'false');
  assert.equal(hostLaunch.netplay_request_device_p2, 'false');
  assert.equal(hostLaunch.netplay_start_as_spectator, 'true');
  assert.equal(hostLaunch.network_cmd_enable, 'true');
  assert.equal(hostLaunch.input_player1_reserved_device, '054c:0ce6 DualSense Wireless Controller');
  assert.equal(alex.server.session.host_player, 2);

  await waitFor(() => sam.buddy.session, 'sam sees the session');
  await sam.join();
  const guestLaunch = launches.find((l) => l.role === 'guest').overrides;
  assert.equal(guestLaunch.input_joypad_driver, 'xinput');
  assert.equal(guestLaunch.netplay_request_device_p1, 'false'); // first free port: Player 1
  assert.equal(guestLaunch.netplay_request_device_p2, 'false');
  assert.equal(guestLaunch.netplay_start_as_spectator, 'false');
  assert.equal(guestLaunch.input_player1_reserved_device, undefined); // Sam assigned nothing
});
