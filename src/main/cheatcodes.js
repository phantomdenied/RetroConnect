'use strict';
// Turn cheat codes into ROM edits, so a cheat can be baked into a copy of the
// game. RetroArch switches cheats off during netplay; a patched ROM works
// online because both players run the same (patched) game.
//
// Only codes that change the game's ROM can be baked in: Game Genie codes and
// ROM-address Action Replay codes. Codes that poke RAM (most Action Replay /
// GameShark codes) need the emulator's cheat engine, so they're solo only.

const NES_LETTERS = 'APZLGITYEOXUKSVN';
const SNES_GENIE = 'DF4709156BC8A23E';
const GEN_CHARS = 'ABCDEFGHJKLMNPRSTVWXYZ0123456789';

// ----- decoding: code text -> { cpu address, value, compare?, width } -----------

/** SNES Game Genie "XXXX-XXXX" -> 24-bit SNES address + byte. */
function snesGenie(code) {
  const m = /^([0-9A-F]{4})-?([0-9A-F]{4})$/i.exec(code);
  if (!m) return null;
  let n = 0;
  for (const ch of (m[1] + m[2]).toUpperCase()) n = n * 16 + SNES_GENIE.indexOf(ch);
  const value = Math.floor(n / 0x1000000) & 0xff;
  const a = n & 0xffffff;
  const address = ((a & 0x003c00) << 10) + ((a & 0x00003c) << 14) + ((a & 0xf00000) >> 8)
    + ((a & 0x000003) << 10) + ((a & 0x00c000) >> 6) + ((a & 0x0f0000) >> 12) + ((a & 0x0003c0) >> 6);
  return { address, value, width: 1 };
}

/** SNES Pro Action Replay "AAAAAAVV". */
function snesPar(code) {
  const m = /^([0-9A-F]{6}):?([0-9A-F]{2})$/i.exec(code);
  return m ? { address: parseInt(m[1], 16), value: parseInt(m[2], 16), width: 1 } : null;
}

/** NES Game Genie, 6 or 8 letters -> CPU address ($8000-$FFFF) + byte (+ compare). */
function nesGenie(code) {
  if (!/^[APZLGITYEOXUKSVN]{6}([APZLGITYEOXUKSVN]{2})?$/i.test(code)) return null;
  const n = [...code.toUpperCase()].map((c) => NES_LETTERS.indexOf(c));
  const address = 0x8000 + (((n[3] & 7) << 12) | ((n[5] & 7) << 8) | ((n[4] & 8) << 8)
    | ((n[2] & 7) << 4) | ((n[1] & 8) << 4) | (n[4] & 7) | (n[3] & 8));
  if (n.length === 6) {
    return { address, value: ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[5] & 8), width: 1 };
  }
  return {
    address,
    value: ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[7] & 8),
    compare: ((n[7] & 7) << 4) | ((n[6] & 8) << 4) | (n[6] & 7) | (n[5] & 8),
    width: 1,
  };
}

/** Genesis Game Genie "ABCD-EFGH": 8 characters of 5 bits (as Genesis Plus GX decodes them). */
function genesisGenie(code) {
  const m = /^([A-Z0-9]{4})-?([A-Z0-9]{4})$/i.exec(code);
  if (!m) return null;
  const n = [...(m[1] + m[2]).toUpperCase()].map((ch) => GEN_CHARS.indexOf(ch));
  if (n.some((v) => v < 0)) return null;
  let value = 0;
  let address = 0;
  value |= n[0] << 3;
  value |= n[1] >> 2; address |= (n[1] & 3) << 14;
  address |= n[2] << 9;
  address |= ((n[3] & 0xf) << 20) | ((n[3] >> 4) << 8);
  value |= (n[4] & 1) << 12; address |= (n[4] >> 1) << 16;
  value |= ((n[5] & 1) << 15) | ((n[5] >> 1) << 8);
  value |= (n[6] >> 3) << 13; address |= (n[6] & 7) << 5;
  address |= n[7];
  return { address, value: value & 0xffff, width: 2 };
}

/** Genesis raw "AAAAAA:VVVV" (or :VV). */
function genesisRaw(code) {
  const m = /^([0-9A-F]{6}):([0-9A-F]{2}|[0-9A-F]{4})$/i.exec(code);
  return m ? { address: parseInt(m[1], 16), value: parseInt(m[2], 16), width: m[2].length / 2 } : null;
}

/** Game Boy Game Genie "ABC-DEF[-GHI]". */
function gbGenie(code) {
  const m = /^([0-9A-F]{3})-?([0-9A-F]{3})(?:-?([0-9A-F]{3}))?$/i.exec(code);
  if (!m) return null;
  const s = (m[1] + m[2]).toUpperCase();
  const value = parseInt(s.slice(0, 2), 16);
  const address = (((parseInt(s[5], 16) ^ 0xf) << 12) | parseInt(s.slice(2, 5), 16)) & 0xffff;
  const out = { address, value, width: 1 };
  if (m[3]) {
    const g = m[3].toUpperCase();
    const c = parseInt(g[0] + g[2], 16);
    out.compare = ((((c >> 2) | (c << 6)) & 0xff) ^ 0xba);
  }
  return out;
}

// ----- systems -------------------------------------------------------------------

const SNES = 'Nintendo - Super Nintendo Entertainment System';
const NES = 'Nintendo - Nintendo Entertainment System';
const GEN = 'Sega - Mega Drive - Genesis';
const GB = 'Nintendo - Game Boy';
const GBC = 'Nintendo - Game Boy Color';

/** Each code part of a cheat ("A+B" or lines) as trimmed strings. */
function codeParts(code) {
  return String(code || '').split(/[+\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Decode one code for a system: { kind, address, value, compare?, width } or null (not a ROM code). */
function decode(system, code) {
  const c = String(code).trim();
  if (system === SNES) {
    const g = /^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(c) ? snesGenie(c) : null;
    if (g) return { kind: 'Game Genie', ...g };
    const p = snesPar(c);
    if (p && !(p.address >> 16 === 0x7e || p.address >> 16 === 0x7f)) return { kind: 'Action Replay', ...p };
    return null;
  }
  if (system === NES) { const g = nesGenie(c); return g ? { kind: 'Game Genie', ...g } : null; }
  if (system === GEN) {
    const r = genesisRaw(c);
    if (r) return r.address < 0x400000 ? { kind: 'ROM', ...r } : null;
    const g = genesisGenie(c);
    return g ? { kind: 'Game Genie', ...g } : null;
  }
  if (system === GB || system === GBC) {
    const g = gbGenie(c);
    return g && g.address < 0x8000 ? { kind: 'Game Genie', ...g } : null;
  }
  return null;
}

/** Systems whose ROM codes we can bake in. */
const BAKEABLE = new Set([SNES, NES, GEN, GB, GBC]);

/** True when every part of a cheat is a ROM code we can bake in. */
function canBake(system, code) {
  if (!BAKEABLE.has(system)) return false;
  const parts = codeParts(code);
  return parts.length > 0 && parts.every((p) => decode(system, p));
}

// ----- mapping CPU addresses to file offsets ------------------------------------------

/** SNES: LoROM or HiROM, by which internal header looks valid. */
function snesLayout(rom) {
  const score = (base, hi) => {
    if (rom.length < base + 0x30) return -1;
    let s = 0;
    const comp = rom.readUInt16LE(base + 0x2c);
    const sum = rom.readUInt16LE(base + 0x2e);
    if ((comp ^ sum) === 0xffff) s += 4;
    const mode = rom[base + 0x25] & 0xef;
    if ((hi && (mode === 0x21 || mode === 0x25)) || (!hi && mode === 0x20)) s += 2;
    const reset = rom.readUInt16LE(base + 0x3c);
    if (reset >= 0x8000) s += 1;
    // Title: printable ASCII.
    if ([...rom.subarray(base + 0x10, base + 0x25)].every((b) => b >= 0x20 && b < 0x7f)) s += 1;
    return s;
  };
  return score(0xffb0, true) > score(0x7fb0, false) ? 'hirom' : 'lorom';
}

function snesOffsets(rom, address) {
  const bank = address >> 16;
  const lo = address & 0xffff;
  if (bank === 0x7e || bank === 0x7f) return [];
  let off;
  if (snesLayout(rom) === 'hirom') {
    if ((bank & 0x7f) >= 0x40) off = ((bank & 0x3f) << 16) | lo;
    else if (lo >= 0x8000) off = ((bank & 0x3f) << 16) | lo;
    else return [];
  } else {
    if (lo < 0x8000) return [];
    off = ((bank & 0x7f) << 15) | (lo & 0x7fff);
  }
  // Smaller ROMs mirror.
  if (off >= rom.length && rom.length) off %= rom.length;
  return [off];
}

/** NES (iNES): PRG offsets visible at a CPU address, honoring the mapper's bank size. */
function nesOffsets(rom, address, compare) {
  if (rom.length < 16 || rom.toString('latin1', 0, 4) !== 'NES\x1a') return [];
  const prgStart = 16 + (rom[6] & 4 ? 512 : 0);
  const prgSize = rom[4] * 0x4000;
  if (!prgSize || prgStart + prgSize > rom.length) return [];
  const mapper = (rom[7] & 0xf0) | (rom[6] >> 4);
  const a = address - 0x8000;
  let cands = [];
  if (prgSize <= 0x8000) {
    cands = [a % prgSize];
  } else {
    let bankSize = 0x2000;
    let fixedLast = null; // the window at the top that always holds the last bank
    if (mapper === 1 || mapper === 2) { bankSize = 0x4000; fixedLast = 0x4000; }
    else if (mapper === 4) { bankSize = 0x2000; fixedLast = 0x2000; }
    else if (mapper === 7) bankSize = 0x8000;
    if (fixedLast && a >= 0x8000 - fixedLast) {
      cands = [prgSize - (0x8000 - a)];
    } else {
      for (let o = a % bankSize; o < prgSize; o += bankSize) cands.push(o);
    }
  }
  return cands.map((o) => prgStart + o).filter((o) => compare === undefined || rom[o] === compare);
}

/** Game Boy: bank 0 at $0000-$3FFF, switchable 16K banks at $4000-$7FFF. */
function gbOffsets(rom, address, compare) {
  let cands;
  if (address < 0x4000) cands = [address];
  else {
    cands = [];
    for (let o = 0x4000 + (address - 0x4000); o < rom.length; o += 0x4000) cands.push(o);
  }
  return cands.filter((o) => o < rom.length && (compare === undefined || rom[o] === compare));
}

/**
 * Bake cheats into a copy of a ROM. `cheats`: [{ desc, code }].
 * Returns { data, applied: [desc], skipped: [{ desc, why }] }.
 */
/** Where a cheat writes in this ROM: { writes: [[offset, value, width]] } or { why }. */
function plan(system, rom, code) {
  const writes = [];
  for (const part of codeParts(code)) {
    const d = decode(system, part);
    if (!d) return { why: 'needs the emulator (changes memory, not the game)' };
    if (system === NES && (rom.length < 16 || rom.toString('latin1', 0, 4) !== 'NES')) {
      return { why: "this copy of the game has no NES header, so cheats can't be built in (a No-Intro headered dump works)" };
    }
    let offs;
    if (system === SNES) offs = snesOffsets(rom, d.address);
    else if (system === NES) offs = nesOffsets(rom, d.address, d.compare);
    else if (system === GB || system === GBC) offs = gbOffsets(rom, d.address, d.compare);
    else offs = d.address + d.width <= rom.length ? [d.address] : [];
    if (!offs.length) return { why: d.compare !== undefined ? "doesn't match this version of the game" : 'points outside the game' };
    for (const o of offs) writes.push([o, d.value, d.width]);
  }
  return writes.length ? { writes } : { why: 'no code' };
}

/** The ROM as cheats see it (SNES copier header dropped). */
function cheatView(system, romData) {
  const rom = Buffer.isBuffer(romData) ? romData : Buffer.from(romData);
  return system === SNES && rom.length % 1024 === 512 ? rom.subarray(512) : rom;
}

/** null if the cheat can be built into this ROM, otherwise why not. */
function whyNot(system, romData, code) {
  if (!BAKEABLE.has(system)) return 'needs the emulator';
  return plan(system, cheatView(system, romData), code).why || null;
}

function bake(system, romData, cheats) {
  const rom = Buffer.from(cheatView(system, romData));
  const applied = [];
  const skipped = [];
  for (const cheat of cheats) {
    const p = plan(system, rom, cheat.code);
    if (p.why) { skipped.push({ desc: cheat.desc, why: p.why }); continue; }
    for (const [o, v, w] of p.writes) {
      if (w === 2) rom.writeUInt16BE(v, o);
      else rom[o] = v;
    }
    applied.push(cheat.desc);
  }
  // Genesis ROMs carry a checksum some games check at boot; keep it right.
  if (system === GEN && applied.length && rom.length >= 0x200 && rom.toString('latin1', 0x100, 0x104).includes('SEGA')) {
    let sum = 0;
    for (let i = 0x200; i + 1 < rom.length; i += 2) sum = (sum + rom.readUInt16BE(i)) & 0xffff;
    rom.writeUInt16BE(sum, 0x18e);
  }
  return { data: rom, applied, skipped };
}

module.exports = {
  snesGenie, snesPar, nesGenie, genesisGenie, genesisRaw, gbGenie,
  decode, canBake, bake, whyNot, plan, codeParts, snesLayout, snesOffsets, nesOffsets, gbOffsets,
  SYSTEMS: { SNES, NES, GEN, GB, GBC }, BAKEABLE,
};
