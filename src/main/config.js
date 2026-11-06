'use strict';
// User settings, stored as JSON in the app's data folder.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platforms = require('./platforms');

const CONNECTION_MODES = ['direct', 'tailscale', 'relay'];
const RELAY_SERVERS = ['nyc', 'madrid', 'saopaulo', 'singapore'];

// File extension -> default core.
const DEFAULT_CORE_MAP = {
  nes: 'fceumm_libretro', fds: 'fceumm_libretro', unf: 'fceumm_libretro',
  sfc: 'snes9x_libretro', smc: 'snes9x_libretro',
  md: 'genesis_plus_gx_libretro', gen: 'genesis_plus_gx_libretro', smd: 'genesis_plus_gx_libretro',
  sms: 'genesis_plus_gx_libretro', gg: 'genesis_plus_gx_libretro',
  gb: 'gambatte_libretro', gbc: 'gambatte_libretro', gba: 'mgba_libretro',
  pce: 'mednafen_pce_fast_libretro', a26: 'stella_libretro', zip: 'fbneo_libretro',
  n64: 'mupen64plus_next_libretro', z64: 'mupen64plus_next_libretro', v64: 'mupen64plus_next_libretro',
};

function defaults() {
  let nick = 'player';
  try { nick = os.userInfo().username || nick; } catch { /* ignore */ }
  return {
    nickname: nick,
    retroarchCommand: [], // empty = auto-detect
    romsDir: path.join(os.homedir(), 'RetroConnect', 'roms'),
    coresDir: '', // empty = auto-detect
    peerAddress: '', // your buddy's IP / Tailscale name
    connectionMode: 'direct',
    relayServer: 'nyc',
    netplayPort: 55435,
    syncPort: 55440,
    shareLibrary: true, // run the sync server whenever the app is open
    sharedSecret: '',
    coreMap: { ...DEFAULT_CORE_MAP },
    buildbotFallback: true,
    hostPlayer: 1, // when you host: 1 = you're Player 1, 2 = your buddy is
    discordUrl: '', // invite or channel link for the Discord you both hang out in
    updateFeedUrl: '', // public JSON announcing new versions (overrides the built-in one)
  };
}

const DISCORD_HOSTS = new Set(['discord.com', 'www.discord.com', 'discord.gg', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com', 'www.discordapp.com']);

/** True for https links to Discord (invites like discord.gg/abc or channel links). */
function isDiscordUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && DISCORD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function generateSecret() {
  return crypto.randomBytes(18).toString('base64url');
}

function validate(cfg) {
  if (!CONNECTION_MODES.includes(cfg.connectionMode)) {
    throw new Error(`Connection mode must be one of: ${CONNECTION_MODES.join(', ')}`);
  }
  if (!RELAY_SERVERS.includes(cfg.relayServer)) {
    throw new Error(`Relay server must be one of: ${RELAY_SERVERS.join(', ')}`);
  }
  for (const k of ['netplayPort', 'syncPort']) {
    const p = cfg[k];
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${k} must be a port number (1-65535)`);
  }
  if (cfg.netplayPort === cfg.syncPort) throw new Error('Netplay and sync ports must differ');
  if (![1, 2].includes(cfg.hostPlayer)) throw new Error('hostPlayer must be 1 or 2');
  if (typeof cfg.nickname !== 'string' || !cfg.nickname.trim()) throw new Error('Nickname is required');
  if (!Array.isArray(cfg.retroarchCommand)) throw new Error('retroarchCommand must be a list');
  if (cfg.discordUrl && !isDiscordUrl(cfg.discordUrl)) {
    throw new Error('The Discord link should look like https://discord.gg/abc123 or https://discord.com/channels/…');
  }
  if (cfg.updateFeedUrl && !/^https:\/\//.test(cfg.updateFeedUrl)) throw new Error('The update link must start with https://');
  return cfg;
}

/** Merge saved/edited values over defaults, keeping only known keys. */
function normalize(raw = {}) {
  const base = defaults();
  const cfg = { ...base };
  for (const k of Object.keys(base)) if (raw[k] !== undefined) cfg[k] = raw[k];
  cfg.coreMap = { ...base.coreMap, ...(raw.coreMap || {}) };
  if (typeof cfg.retroarchCommand === 'string') {
    cfg.retroarchCommand = cfg.retroarchCommand ? [cfg.retroarchCommand] : [];
  }
  for (const k of ['netplayPort', 'syncPort', 'hostPlayer']) cfg[k] = Number(cfg[k]);
  cfg.nickname = String(cfg.nickname).trim();
  cfg.peerAddress = String(cfg.peerAddress || '').trim();
  cfg.sharedSecret = String(cfg.sharedSecret || '').trim();
  cfg.discordUrl = String(cfg.discordUrl || '').trim();
  if (cfg.discordUrl && !/^[a-z]+:\/\//i.test(cfg.discordUrl)) cfg.discordUrl = `https://${cfg.discordUrl}`;
  cfg.updateFeedUrl = String(cfg.updateFeedUrl || '').trim();
  return validate(cfg);
}

function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return normalize({});
    throw err;
  }
}

function save(file, cfg) {
  const clean = normalize(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

// ----- derived values ------------------------------------------------------

function retroarchCmd(cfg) {
  return cfg.retroarchCommand.length ? [...cfg.retroarchCommand] : platforms.detectRetroarch();
}

function coresPath(cfg) {
  return cfg.coresDir || platforms.detectCoresDir(retroarchCmd(cfg));
}

function coreForExtension(cfg, ext) {
  return cfg.coreMap[String(ext).toLowerCase().replace(/^\./, '')] || null;
}

function isConfigured(cfg) {
  return Boolean(cfg.sharedSecret && cfg.romsDir);
}

module.exports = {
  CONNECTION_MODES, RELAY_SERVERS, DEFAULT_CORE_MAP,
  defaults, normalize, load, save, generateSecret, isDiscordUrl,
  retroarchCmd, coresPath, coreForExtension, isConfigured,
};
