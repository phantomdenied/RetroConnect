'use strict';
// Build and run the RetroArch netplay command line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

function cfgLine(key, value) {
  return `${key} = "${String(value).replace(/"/g, '')}"\n`;
}

/** Settings passed via --appendconfig (they take priority over retroarch.cfg). */
function netplayOverrides(cfg, role) {
  const useRelay = cfg.connectionMode === 'relay' && role === 'host';
  let out = cfgLine('netplay_nickname', cfg.nickname);
  out += cfgLine('netplay_use_mitm_server', useRelay ? 'true' : 'false');
  if (useRelay) out += cfgLine('netplay_mitm_server', cfg.relayServer);
  return out;
}

/**
 * role is "host" or "guest". Guests in relay mode load the game and join from
 * RetroArch's lobby, since a relay session only gets its ID at runtime.
 */
function buildCommand(cfg, role, corePath, romPath, { connectTo = null, port = null, overridesPath = null } = {}) {
  const ra = config.retroarchCmd(cfg);
  if (!ra.length) throw new Error("Couldn't find RetroArch. Set its location in Settings.");
  const args = [...ra.slice(1), '-L', corePath, romPath];
  const p = String(port || cfg.netplayPort);
  if (role === 'host') {
    args.push('--host', '--port', p);
  } else if (cfg.connectionMode !== 'relay') {
    if (!connectTo) throw new Error('No host address to connect to');
    args.push('--connect', connectTo, '--port', p);
  }
  args.push('--nick', cfg.nickname);
  if (overridesPath) args.push('--appendconfig', overridesPath);
  return [ra[0], args];
}

/** Start RetroArch; resolves with its exit code once it closes. */
function run(cfg, role, corePath, romPath, opts = {}, { onSpawn } = {}) {
  const tmp = path.join(os.tmpdir(), `retroconnect-${process.pid}-${Date.now()}.cfg`);
  fs.writeFileSync(tmp, netplayOverrides(cfg, role));
  const cleanup = () => fs.rm(tmp, { force: true }, () => {});
  let exe, args;
  try {
    [exe, args] = buildCommand(cfg, role, corePath, romPath, { ...opts, overridesPath: tmp });
  } catch (err) {
    cleanup();
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
    if (onSpawn) onSpawn(child);
    child.on('error', (err) => { cleanup(); reject(new Error(`Couldn't start RetroArch: ${err.message}`)); });
    child.on('exit', (code) => { cleanup(); resolve(code); });
  });
}

module.exports = { buildCommand, netplayOverrides, run };
