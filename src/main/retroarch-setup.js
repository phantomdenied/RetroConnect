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

/** Vendor/product IDs (lowercase hex) from a Gamepad.id, when the browser reports them. */
function parseIds(id) {
  const s = String(id || '');
  const m = /vendor:\s*([0-9a-f]{4})\s*product:\s*([0-9a-f]{4})/i.exec(s) || /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(s);
  return m ? { vid: m[1].toLowerCase(), pid: m[2].toLowerCase() } : { vid: null, pid: null };
}

/** Classify a browser Gamepad.id like "Xbox 360 Controller (XInput STANDARD GAMEPAD)". */
function classifyController(id, mapping = '') {
  const s = String(id || '');
  const { vid, pid } = parseIds(s);
  const vendor = vid;
  let kind = (vendor && VENDORS[vendor.toLowerCase()]) || null;
  if (!kind) {
    if (/xinput|xbox/i.test(s)) kind = 'xbox';
    else if (/dualsense|dualshock|playstation|wireless controller/i.test(s)) kind = 'playstation';
    else if (/pro controller|joy-con|nintendo|switch/i.test(s)) kind = 'nintendo';
    else kind = 'generic';
  }
  const name = s.replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').replace(/\s*\(.*$/, '').trim() || 'Controller';
  // XInput pads are reported without IDs (RetroArch also sees them only as
  // "XInput Controller"); everything else carries vendor/product IDs.
  const xinput = /xinput/i.test(s) || (kind === 'xbox' && !vid);
  return {
    kind, name, ...KINDS[kind], vid, pid, xinput,
    standard: mapping === 'standard' || /STANDARD GAMEPAD/i.test(s),
    key: vid ? `${vid}:${pid}` : `xinput:${name}`,
  };
}

/**
 * One joypad driver serves every controller, so pick the one that suits the
 * whole set: sdl2 knows PlayStation/Nintendo pads by their IDs, but XInput
 * pads have no IDs, so if one is connected stay on xinput (which also handles
 * other pads through DirectInput).
 */
function chooseDriver(pads) {
  if (!pads.length) return null;
  if (pads.some((p) => p.xinput)) return 'xinput';
  if (pads.some((p) => p.kind === 'playstation' || p.kind === 'nintendo')) return 'sdl2';
  return 'xinput';
}

// ----- controller profiles (RetroArch "autoconfig") ---------------------------

// RetroArch matches a profile by vendor+product ID or by exact device name
// (task_autodetect.c). XInput pads are always named "XInput Controller".
const XINPUT_DEVICE_NAME = 'XInput Controller';

// Layout RetroArch's own sdl2 profiles use (e.g. sdl2/PS5 Controller.cfg),
// i.e. SDL's standard GameController numbering, positional: bottom face
// button = RetroPad B, right = A, left = Y, top = X.
const SDL2_STANDARD_BINDS = {
  input_b_btn: '0', input_a_btn: '1', input_y_btn: '2', input_x_btn: '3',
  input_select_btn: '4', input_menu_toggle_btn: '5', input_start_btn: '6',
  input_l3_btn: '7', input_r3_btn: '8', input_l_btn: '9', input_r_btn: '10',
  input_up_btn: '11', input_down_btn: '12', input_left_btn: '13', input_right_btn: '14',
  input_l2_axis: '+4', input_r2_axis: '+5',
  input_l_x_plus_axis: '+0', input_l_x_minus_axis: '-0', input_l_y_plus_axis: '+1', input_l_y_minus_axis: '-1',
  input_r_x_plus_axis: '+2', input_r_x_minus_axis: '-2', input_r_y_plus_axis: '+3', input_r_y_minus_axis: '-3',
};

/** RetroArch's autoconfig folder ("joypad_autoconfig_dir"; ":" means next to retroarch.exe). */
function autoconfigDir(retroarchCmd, cfgValues = {}) {
  const exeDir = retroarchCmd && retroarchCmd.length && retroarchCmd[0] !== 'flatpak' ? path.dirname(retroarchCmd[0]) : null;
  const set = cfgValues.joypad_autoconfig_dir;
  if (set && set !== 'default') {
    if (set.startsWith(':') && exeDir) return path.join(exeDir, set.slice(1).replace(/^[\\/]+/, ''));
    return set;
  }
  if (platforms.osName() === 'windows' && exeDir) return path.join(exeDir, 'autoconfig');
  const cfgDir = path.dirname(configPath(retroarchCmd));
  return path.join(cfgDir, 'autoconfig');
}

async function listProfiles(dir, driver) {
  const folder = path.join(dir, driver);
  let names = [];
  try { names = (await fsp.readdir(folder)).filter((n) => n.toLowerCase().endsWith('.cfg')); } catch { return []; }
  const out = [];
  for (const file of names) {
    try {
      const c = parseCfg(await fsp.readFile(path.join(folder, file), 'utf8'));
      const ids = [];
      for (const suffix of ['', '_alt1', '_alt2', '_alt3', '_alt4', '_alt5']) {
        const v = Number(c[`input_vendor_id${suffix}`]);
        const p = Number(c[`input_product_id${suffix}`]);
        if (v && p) ids.push(`${v.toString(16).padStart(4, '0')}:${p.toString(16).padStart(4, '0')}`);
      }
      const names2 = ['', '_alt1', '_alt2', '_alt3'].map((x) => c[`input_device${x}`]).filter(Boolean);
      out.push({ file, ids, names: names2 });
    } catch { /* unreadable profile: skip */ }
  }
  return out;
}

const GENERATED_PREFIX = 'RetroConnect - ';

/**
 * For each connected controller: does RetroArch have a profile for it under
 * this driver? Writes one for standard controllers it doesn't know (sdl2).
 * Returns [{ ...pad, profile: { status, file, help } }].
 */
async function ensureProfiles(pads, driver, dir, { write = true } = {}) {
  const profiles = driver ? await listProfiles(dir, driver) : [];
  const results = [];
  for (const pad of pads) {
    // Under the xinput driver, non-XInput pads are read through DirectInput.
    const effective = driver === 'xinput' && !pad.xinput ? 'dinput' : driver;
    const pool = effective === driver ? profiles : await listProfiles(dir, effective);
    const match = pad.xinput && effective === 'xinput'
      ? pool.find((p) => p.names.includes(XINPUT_DEVICE_NAME))
      : pool.find((p) => pad.vid && p.ids.includes(`${pad.vid}:${pad.pid}`));
    let profile;
    if (match && !match.file.startsWith(GENERATED_PREFIX)) {
      profile = { status: 'builtin', file: match.file };
    } else if (match) {
      profile = { status: 'created', file: match.file };
    } else if (effective === 'sdl2' && pad.vid && pad.standard) {
      const file = `${GENERATED_PREFIX}${pad.name.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60) || 'Controller'} (${pad.vid}-${pad.pid}).cfg`;
      if (write) {
        const lines = {
          input_driver: 'sdl2',
          input_device: pad.name,
          input_vendor_id: String(parseInt(pad.vid, 16)),
          input_product_id: String(parseInt(pad.pid, 16)),
          ...SDL2_STANDARD_BINDS,
        };
        await fsp.mkdir(path.join(dir, 'sdl2'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'sdl2', file),
          `# Written by RetroConnect: standard layout for ${pad.name}\n${Object.entries(lines).map(([k, v]) => `${k} = "${v}"`).join('\n')}\n`);
      }
      profile = { status: 'created', file };
    } else if (pad.xinput) {
      profile = { status: 'missing', help: 'RetroArch\'s controller profiles look out of date. In RetroArch: Main Menu → Online Updater → Update Controller Profiles.' };
    } else {
      profile = {
        status: 'missing',
        help: 'RetroArch doesn\'t know this controller yet. Map it once in RetroArch: Settings → Input → RetroPad Binds → Port 1 Controls → Set All Controls, then press each button it asks for.',
      };
    }
    results.push({ ...pad, driver: effective, profile });
  }
  return results;
}

/**
 * Settings that put chosen controllers on chosen player numbers.
 * assign: { "<vid>:<pid>": 1..4 }. Uses RetroArch's "preferred" device
 * reservation (input_playerN_reserved_device = "vvvv:pppp Name").
 */
function reservationSettings(pads, assign = {}) {
  const s = {};
  for (let p = 1; p <= 4; p++) {
    s[`input_player${p}_device_reservation_type`] = '0';
    s[`input_player${p}_reserved_device`] = '';
  }
  for (const pad of pads) {
    const player = assign[pad.key];
    if (!pad.vid || !player || player < 1 || player > 4) continue;
    s[`input_player${player}_device_reservation_type`] = '1'; // INPUT_DEVICE_RESERVATION_PREFERRED
    s[`input_player${player}_reserved_device`] = `${pad.vid}:${pad.pid} ${pad.name.replace(/"/g, '')}`;
  }
  return s;
}

/**
 * Netplay player slot. Each side asks for a port (netplay_request_device_pN);
 * without a request RetroArch hands out the first free one, so by default the
 * host is Player 1. slot = 1..4 or null for "no preference".
 */
function netplaySlotSettings(slot) {
  const s = {};
  for (let p = 1; p <= 4; p++) s[`netplay_request_device_p${p}`] = slot === p ? 'true' : 'false';
  return s;
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

/** RetroArch's system (BIOS) folder, from its config ("default" / ":\system" = next to retroarch.cfg). */
function systemDir(cfgFile, settings = {}) {
  const base = path.dirname(cfgFile);
  const sd = String(settings.system_directory || '').trim();
  if (!sd || sd === 'default') return path.join(base, 'system');
  if (sd.startsWith(':')) return path.join(base, sd.slice(1));
  return sd;
}

/** Which of a system's BIOS files are present (case-insensitive, like Windows). */
async function biosStatus(dir, bios) {
  let names = [];
  try { names = (await fsp.readdir(dir)).map((n) => n.toLowerCase()); } catch { /* no folder yet */ }
  const found = bios.files.filter((f) => names.includes(f.toLowerCase()));
  return { ...bios, dir, found, ok: found.length > 0 };
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
  {
    id: 'genesis', label: 'Sega Genesis / Sega CD / Master System / Game Gear', core: 'genesis_plus_gx_libretro', netplay: 'great',
    // Sega CD games need one of these in RetroArch's system folder (any region works for most games).
    bios: { system: 'Sega CD', required: true, files: ['bios_CD_U.bin', 'bios_CD_E.bin', 'bios_CD_J.bin'] },
  },
  { id: 'arcade', label: 'Arcade (FinalBurn Neo)', core: 'fbneo_libretro', netplay: 'great' },
  { id: 'pce', label: 'PC Engine / TurboGrafx-16', core: 'mednafen_pce_fast_libretro', netplay: 'great' },
  { id: 'gb', label: 'Game Boy / Color', core: 'gambatte_libretro', netplay: 'ok' },
  { id: 'gba', label: 'Game Boy Advance', core: 'mgba_libretro', netplay: 'ok' },
  {
    id: 'psx', label: 'PlayStation', core: 'pcsx_rearmed_libretro', netplay: 'ok',
    // Optional: without one the core uses its built-in BIOS, which runs most games.
    bios: { system: 'PS1', required: false, files: ['scph5501.bin', 'scph5500.bin', 'scph5502.bin', 'scph1001.bin', 'scph7001.bin', 'PSXONPSP660.bin'] },
  },
  { id: 'atari', label: 'Atari 2600', core: 'stella_libretro', netplay: 'great' },
  { id: 'n64', label: 'Nintendo 64', core: 'mupen64plus_next_libretro', netplay: 'poor' },
];

module.exports = {
  classifyController, parseIds, chooseDriver, autoconfigDir, listProfiles, ensureProfiles,
  reservationSettings, netplaySlotSettings, SDL2_STANDARD_BINDS, XINPUT_DEVICE_NAME, GENERATED_PREFIX,
  recommendedSettings, configPath, applySettings, readSettings, parseCfg, systemDir, biosStatus,
  SYSTEMS, KINDS, MENU_COMBO_START_SELECT, ANALOG_DPAD_LSTICK,
};
