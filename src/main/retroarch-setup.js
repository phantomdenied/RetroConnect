'use strict';
// One-click RetroArch setup for people who never want to see its menus:
// pick the right controller driver, turn on netplay-friendly settings, and
// install the cores for the systems you play.
//
// Setting names and values come from RetroArch 1.22's configuration.c and
// input_defines.h (e.g. INPUT_COMBO_START_SELECT = 4, ANALOG_DPAD_LSTICK = 1).

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const platforms = require('./platforms');

// ----- controllers ------------------------------------------------------------

const VENDORS = {
  '045e': 'xbox', // Microsoft (also most "XInput mode" third-party pads)
  '054c': 'playstation', // Sony
  '057e': 'nintendo', // Nintendo
};

const KINDS = {
  xbox: { label: 'Xbox-style controller', driver: 'xinput' },
  playstation: { label: 'PlayStation controller', driver: 'sdl2' },
  nintendo: { label: 'Nintendo controller', driver: 'sdl2' },
  // RetroArch's xinput driver falls back to DirectInput for everything else,
  // and its autoconfig profiles cover most cheap USB pads that way.
  generic: { label: 'Controller', driver: 'xinput' },
};

/** Classify a browser Gamepad.id like "Xbox 360 Controller (XInput STANDARD GAMEPAD)". */
function classifyController(id) {
  const s = String(id || '');
  const vendor = (/vendor:\s*([0-9a-f]{4})/i.exec(s) || /^([0-9a-f]{4})-[0-9a-f]{4}-/i.exec(s) || [])[1];
  let kind = (vendor && VENDORS[vendor.toLowerCase()]) || null;
  if (!kind) {
    if (/xinput|xbox/i.test(s)) kind = 'xbox';
    else if (/dualsense|dualshock|playstation|wireless controller/i.test(s)) kind = 'playstation';
    else if (/pro controller|joy-con|nintendo|switch/i.test(s)) kind = 'nintendo';
    else kind = 'generic';
  }
  const name = s.replace(/\s*\(.*$/, '').trim() || 'Controller';
  return { kind, name, ...KINDS[kind] };
}

// ----- settings ---------------------------------------------------------------

const MENU_COMBO_START_SELECT = '4';
const ANALOG_DPAD_LSTICK = '1';

/**
 * The retroarch.cfg changes for a set of choices.
 * opts: { controllerKind, fullscreen, stickAsDpad, startSelectMenu }
 */
function recommendedSettings({ controllerKind = null, fullscreen = true, stickAsDpad = true, startSelectMenu = true } = {}) {
  const s = {
    input_autodetect_enable: 'true', // load the right button layout for known controllers
    notification_show_autoconfig: 'true', // "Xbox controller configured" pop-up
    pause_nonactive: 'false', // netplay must keep running when the window isn't focused
    video_fullscreen: fullscreen ? 'true' : 'false',
  };
  if (controllerKind && KINDS[controllerKind]) s.input_joypad_driver = KINDS[controllerKind].driver;
  if (startSelectMenu) s.input_menu_toggle_gamepad_combo = MENU_COMBO_START_SELECT;
  if (stickAsDpad) {
    for (let p = 1; p <= 4; p++) s[`input_player${p}_analog_dpad_mode`] = ANALOG_DPAD_LSTICK;
  }
  return s;
}

/** Where RetroArch reads its config for a given RetroArch command. */
function configPath(retroarchCmd = []) {
  const home = os.homedir();
  if (platforms.osName() === 'windows') {
    const besideExe = retroarchCmd.length ? path.join(path.dirname(retroarchCmd[0]), 'retroarch.cfg') : null;
    const appdata = path.join(process.env.APPDATA || home, 'RetroArch', 'retroarch.cfg');
    if (besideExe && fs.existsSync(besideExe)) return besideExe;
    if (fs.existsSync(appdata)) return appdata;
    return besideExe || appdata;
  }
  if (platforms.osName() === 'macos') return path.join(home, 'Library/Application Support/RetroArch/config/retroarch.cfg');
  if (retroarchCmd[0] === 'flatpak') return path.join(home, '.var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'retroarch', 'retroarch.cfg');
}

function parseCfg(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Merge `changes` into retroarch.cfg, keeping everything else. Backs up the original once. */
async function applySettings(file, changes) {
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const backup = `${file}.before-retroconnect`;
  if (text && !fs.existsSync(backup)) await fsp.writeFile(backup, text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(changes));
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[i]);
    if (m && pending.has(m[1])) {
      lines[i] = `${m[1]} = "${pending.get(m[1])}"`;
      pending.delete(m[1]);
    }
  }
  for (const [k, v] of pending) lines.push(`${k} = "${v}"`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, lines.join(eol) + eol);
  return { file, backup: fs.existsSync(backup) ? backup : null };
}

async function readSettings(file) {
  try { return parseCfg(await fsp.readFile(file, 'utf8')); } catch { return {}; }
}

// ----- cores ------------------------------------------------------------------

// Systems offered in the setup, in display order. netplay: how well the core
// does online (N64 is heavy and often desyncs).
const SYSTEMS = [
  { id: 'nes', label: 'NES / Famicom', core: 'fceumm_libretro', netplay: 'great' },
  { id: 'snes', label: 'Super Nintendo', core: 'snes9x_libretro', netplay: 'great' },
  { id: 'genesis', label: 'Sega Genesis / Master System / Game Gear', core: 'genesis_plus_gx_libretro', netplay: 'great' },
  { id: 'arcade', label: 'Arcade (FinalBurn Neo)', core: 'fbneo_libretro', netplay: 'great' },
  { id: 'pce', label: 'PC Engine / TurboGrafx-16', core: 'mednafen_pce_fast_libretro', netplay: 'great' },
  { id: 'gb', label: 'Game Boy / Color', core: 'gambatte_libretro', netplay: 'ok' },
  { id: 'gba', label: 'Game Boy Advance', core: 'mgba_libretro', netplay: 'ok' },
  { id: 'atari', label: 'Atari 2600', core: 'stella_libretro', netplay: 'great' },
  { id: 'n64', label: 'Nintendo 64', core: 'mupen64plus_next_libretro', netplay: 'poor' },
];

module.exports = {
  classifyController, recommendedSettings, configPath, applySettings, readSettings, parseCfg,
  SYSTEMS, KINDS, MENU_COMBO_START_SELECT, ANALOG_DPAD_LSTICK,
};
