'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/main/config');
const systems = require('../src/main/systems');

test('zipped ROMs get their core from the system folder name', () => {
  const cfg = config.defaults();
  const cases = {
    'Nintendo - Nintendo Entertainment System/Contra (USA).zip': 'fceumm_libretro',
    'Nintendo - Nintendo Entertainment System (Headerless)/Contra (USA).zip': 'fceumm_libretro',
    'Nintendo - Nintendo Entertainment System - Hacks/x.zip': 'fceumm_libretro',
    'Nintendo - Super Nintendo Entertainment System/Super Metroid (USA).zip': 'snes9x_libretro',
    'Nintendo - Super Famicom/x.zip': 'snes9x_libretro',
    'Nintendo - Super Nintendo Entertainment System - Hacks/x.zip': 'snes9x_libretro',
    'Nintendo - Game Boy/Tetris (World).zip': 'gambatte_libretro',
    'Nintendo - Game Boy Color/x.zip': 'gambatte_libretro',
    'Nintendo - Game Boy Advance/x.zip': 'mgba_libretro',
    'Sega - Mega Drive - Genesis/Sonic (World).zip': 'genesis_plus_gx_libretro',
    'Sega - Mega Drive - Genesis - Hacks/x.zip': 'genesis_plus_gx_libretro',
    'Sega - 32X/x.zip': 'picodrive_libretro',
    'NEC - PC Engine - TurboGrafx 16/x.zip': 'mednafen_pce_fast_libretro',
    'NEC - PC Engine - SuperGrafx/x.zip': 'mednafen_supergrafx_libretro',
    'Atari - Lynx/x.zip': 'handy_libretro',
    'Atari - Jaguar/x.zip': 'virtualjaguar_libretro',
    'Commodore - Commodore 64/x.zip': 'vice_x64sc_libretro',
    'PSX/Game (USA)/Game.cue': 'pcsx_rearmed_libretro', // deepest folder names no system: parent does
    'GAMECUBE/x.rvz': 'dolphin_libretro',
    'SNES/x.zip': 'snes9x_libretro',
    'Genesis/x.zip': 'genesis_plus_gx_libretro',
    'Arcade/sf2.zip': 'fbneo_libretro',
    'Sega - Mega Drive - Genesis\\Windows separators.zip': 'genesis_plus_gx_libretro',
  };
  for (const [rom, core] of Object.entries(cases)) assert.equal(config.coreForRom(cfg, rom), core, rom);
});

test('without a system folder the extension decides, as before', () => {
  const cfg = config.defaults();
  assert.equal(config.coreForRom(cfg, 'z/zelda3.sfc'), 'snes9x_libretro');
  assert.equal(config.coreForRom(cfg, 'mario.nes'), 'fceumm_libretro');
  assert.equal(config.coreForRom(cfg, 'stuff/sf2.zip'), 'fbneo_libretro');
  assert.equal(config.coreForRom(cfg, 'stuff/readme.txt'), null);
});

test('the user\'s core choices (Settings → Cores) still apply to folder matches', () => {
  const cfg = { ...config.defaults() };
  cfg.coreMap = { ...cfg.coreMap, sfc: 'bsnes_libretro' };
  assert.equal(config.coreForRom(cfg, 'Nintendo - Super Nintendo Entertainment System/x.zip'), 'bsnes_libretro');
});

test('box art system comes from the folder too; loose zips get none', () => {
  assert.equal(systems.thumbSystemForRom('Nintendo - Game Boy Color/x.zip'), 'Nintendo - Game Boy Color');
  assert.equal(systems.thumbSystemForRom('Sega - Mega Drive - Genesis - Hacks/x.zip'), 'Sega - Mega Drive - Genesis');
  assert.equal(systems.thumbSystemForRom('stuff/x.zip'), null);
  assert.equal(systems.thumbSystemForRom('z/zelda3.sfc'), 'Nintendo - Super Nintendo Entertainment System');
});
