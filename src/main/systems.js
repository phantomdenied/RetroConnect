'use strict';
// Which system a ROM belongs to. ROM sets are usually sorted into folders
// named after the system ("Nintendo - Super Nintendo Entertainment System",
// "SNES", "Genesis", ...) and are often zipped, so the folder is a far better
// guide than the file extension (".zip" says nothing about the console).
//
// Each system has:
//   key    - its entry in cfg.coreMap (Settings → Cores), so the user's core
//            choice still applies. A real extension where one is unique to the
//            system; "psx" / "segacd" for CD systems whose .cue/.chd are shared.
//   thumbs - libretro thumbnail server folder (box art), or null.
//   folder - matches a folder name. Order matters: more specific names first.

const path = require('path');

const SYSTEMS = [
  { key: 'fds', short: 'FDS', thumbs: 'Nintendo - Family Computer Disk System', folder: /famicom disk|\bfds\b/i },
  { key: 'sfc', short: 'SNES', thumbs: 'Nintendo - Super Nintendo Entertainment System', folder: /super nintendo|super famicom|\bsnes\b|\bsfc\b/i },
  { key: 'n64', short: 'N64', thumbs: 'Nintendo - Nintendo 64', folder: /nintendo 64|\bn64\b/i },
  { key: 'nes', short: 'NES', thumbs: 'Nintendo - Nintendo Entertainment System', folder: /nintendo entertainment system|famicom|\bnes\b/i },
  { key: 'gba', short: 'GBA', thumbs: 'Nintendo - Game Boy Advance', folder: /game ?boy advance|\bgba\b/i },
  { key: 'gbc', short: 'GBC', thumbs: 'Nintendo - Game Boy Color', folder: /game ?boy colou?r|\bgbc\b/i },
  { key: 'gb', short: 'GB', thumbs: 'Nintendo - Game Boy', folder: /game ?boy|\bgb\b/i },
  { key: 'gcm', short: 'GC', thumbs: 'Nintendo - GameCube', folder: /game ?cube|\bgcn?\b/i },
  { key: '32x', short: '32X', thumbs: 'Sega - 32X', folder: /\b32x\b/i },
  { key: 'segacd', short: 'SCD', thumbs: 'Sega - Mega-CD - Sega CD', folder: /mega[- ]?cd|sega[- ]?cd/i },
  { key: 'md', short: 'MD', thumbs: 'Sega - Mega Drive - Genesis', folder: /mega ?drive|genesis|\bmd\b/i },
  { key: 'sms', short: 'SMS', thumbs: 'Sega - Master System - Mark III', folder: /master system|mark iii|\bsms\b/i },
  { key: 'gg', short: 'GG', thumbs: 'Sega - Game Gear', folder: /game ?gear|\bgg\b/i },
  { key: 'sgx', short: 'SGX', thumbs: 'NEC - PC Engine SuperGrafx', folder: /supergrafx|\bsgx\b/i },
  { key: 'pce', short: 'PCE', thumbs: 'NEC - PC Engine - TurboGrafx 16', folder: /pc ?engine|turbo ?grafx|\bpce\b|\btg-?16\b/i },
  { key: 'psx', short: 'PS1', thumbs: 'Sony - PlayStation', folder: /^(sony - )?playstation$|\bpsx\b|\bps1\b/i },
  { key: 'lnx', short: 'LYNX', thumbs: 'Atari - Lynx', folder: /\blynx\b/i },
  { key: 'j64', short: 'JAG', thumbs: 'Atari - Jaguar', folder: /\bjaguar\b/i },
  { key: 'a78', short: '7800', thumbs: 'Atari - 7800', folder: /\b7800\b/i },
  { key: 'a26', short: '2600', thumbs: 'Atari - 2600', folder: /\b2600\b/i },
  { key: 'd64', short: 'C64', thumbs: 'Commodore - 64', folder: /commodore 64|\bc64\b/i },
  { key: 'zip', short: 'ARC', thumbs: 'FBNeo - Arcade Games', folder: /arcade|\bfbneo\b|\bfba\b|\bmame\b|neo ?geo/i },
];

// Extension -> system key, for ROMs whose folders don't name a system.
const BY_EXTENSION = {
  nes: 'nes', unf: 'nes', fds: 'fds', sfc: 'sfc', smc: 'sfc',
  n64: 'n64', z64: 'n64', v64: 'n64', gb: 'gb', gbc: 'gbc', gba: 'gba',
  md: 'md', gen: 'md', smd: 'md', '32x': '32x', sms: 'sms', gg: 'gg',
  pce: 'pce', sgx: 'sgx', a26: 'a26', a78: 'a78', lnx: 'lnx', j64: 'j64',
  d64: 'd64', gcm: 'gcm', rvz: 'gcm', zip: 'zip',
};

const BY_KEY = new Map(SYSTEMS.map((s) => [s.key, s]));

/** The system whose name appears in the ROM's folders (deepest folder first), or null. */
function systemFromFolders(romPath) {
  const dirs = String(romPath).split(/[\\/]+/).slice(0, -1).reverse();
  for (const dir of dirs) {
    const hit = SYSTEMS.find((s) => s.folder.test(dir.trim()));
    if (hit) return hit;
  }
  return null;
}

/**
 * The coreMap key for a ROM: from its folder names first, then its extension
 * (as before). romPath may be relative to the ROM folder, with / or \.
 */
function coreKeyForRom(romPath) {
  const sys = systemFromFolders(romPath);
  if (sys) return sys.key;
  const ext = path.extname(String(romPath)).slice(1).toLowerCase();
  return BY_EXTENSION[ext] || ext || null;
}

/** libretro thumbnail folder for a ROM, or null if unknown. */
function thumbSystemForRom(romPath) {
  const key = coreKeyForRom(romPath);
  // A loose .zip outside an arcade folder could be anything: no guessing.
  if (key === 'zip' && !systemFromFolders(romPath)) return null;
  return (BY_KEY.get(key) || {}).thumbs || null;
}

/** Short tag for a ROM's system ("SNES"), or null if unknown. */
function shortSystemForRom(romPath) {
  const key = coreKeyForRom(romPath);
  if (key === 'zip' && !systemFromFolders(romPath)) return null;
  return (BY_KEY.get(key) || {}).short || null;
}

module.exports = { SYSTEMS, systemFromFolders, coreKeyForRom, thumbSystemForRom, shortSystemForRom };
