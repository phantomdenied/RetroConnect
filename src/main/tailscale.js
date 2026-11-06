'use strict';
// Tailscale helper: detect, install, sign in, and list the devices on your
// Tailscale network so you can pick your buddy without typing an address.
//
// Everything goes through Tailscale's own CLI (`tailscale.exe`):
//   tailscale status --json         state + devices
//   tailscale up --json             prints {"AuthURL": ...} for browser sign-in,
//                                   then {"BackendState": "Running"}
//   tailscale up --auth-key=KEY     join a network with a key, no account needed

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const platforms = require('./platforms');

const PKGS = 'https://pkgs.tailscale.com/stable/';
const DOWNLOAD_PAGE = 'https://tailscale.com/download/windows';
const KEYS_PAGE = 'https://login.tailscale.com/admin/settings/keys';
const MACHINES_PAGE = 'https://login.tailscale.com/admin/machines';

/** The command that runs the Tailscale CLI, or [] if it isn't installed. */
function findCli() {
  if (process.env.RETROCONNECT_TAILSCALE_CMD) return JSON.parse(process.env.RETROCONNECT_TAILSCALE_CMD);
  const candidates = [];
  if (platforms.osName() === 'windows') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) candidates.push(path.join(base, 'Tailscale', 'tailscale.exe'));
    }
  } else if (platforms.osName() === 'macos') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  }
  for (const c of candidates) if (platforms.isFile(c)) return [c];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['tailscale.exe', 'tailscale']) {
      const full = dir && path.join(dir, name);
      if (full && platforms.isFile(full)) return [full];
    }
  }
  return [];
}

function run(cmd, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd[0], [...cmd.slice(1), ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), err }));
  });
}

function firstIPv4(ips) {
  return (ips || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || (ips || [])[0] || null;
}

function device(p) {
  return {
    name: p.HostName || (p.DNSName || '').split('.')[0] || 'unknown',
    dnsName: (p.DNSName || '').replace(/\.$/, ''),
    ip: firstIPv4(p.TailscaleIPs),
    os: p.OS || '',
    online: Boolean(p.Online),
  };
}

/** Parse `tailscale status --json` into what the app needs. */
function parseStatus(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const peers = Object.values(d.Peer || {})
    .map(device)
    .filter((p) => p.ip)
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  return {
    installed: true,
    state: d.BackendState || 'Unknown', // NoState | NeedsLogin | NeedsMachineAuth | Stopped | Starting | Running
    version: (d.Version || '').split('-')[0] || null,
    self: d.Self ? device(d.Self) : null,
    authUrl: d.AuthURL || null,
    peers,
  };
}

/** Current Tailscale state. Never throws. */
async function status(cmd = findCli()) {
  if (!cmd.length) return { installed: false, state: 'NotInstalled', peers: [] };
  const r = await run(cmd, ['status', '--json']);
  if (r.stdout.trim().startsWith('{')) {
    try { return parseStatus(r.stdout); } catch { /* fall through */ }
  }
  const msg = `${r.stderr} ${r.stdout}`;
  if (/tailscaled|connect|pipe|service/i.test(msg)) {
    return { installed: true, state: 'NotRunning', peers: [], error: 'The Tailscale service isn\'t running' };
  }
  return { installed: true, state: 'Unknown', peers: [], error: msg.trim() || `tailscale exited with ${r.code}` };
}

/**
 * Connect this PC to Tailscale.
 *  - with authKey: joins the network the key belongs to (no account needed)
 *  - without: resolves the browser sign-in URL via onAuthUrl, then waits
 * Resolves when Tailscale reports Running. Returns { child } via onStart for cancelling.
 */
function login(cmd = findCli(), { authKey = null, onAuthUrl = () => {}, onStart = () => {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!cmd.length) return Promise.reject(new Error('Tailscale isn\'t installed'));
  const args = ['up', '--json', `--timeout=${Math.round(timeoutMs / 1000)}s`];
  if (authKey) args.push(`--auth-key=${authKey.trim()}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true });
    onStart(child);
    let out = '';
    let err = '';
    let finalState = null;
    let errorMsg = null;
    const consume = () => {
      // The CLI prints one or more pretty-printed JSON objects.
      let start;
      while ((start = out.indexOf('{')) !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < out.length; i++) {
          if (out[i] === '{') depth++;
          else if (out[i] === '}' && --depth === 0) { end = i; break; }
        }
        if (end === -1) return;
        const chunk = out.slice(start, end + 1);
        out = out.slice(end + 1);
        let obj;
        try { obj = JSON.parse(chunk); } catch { continue; }
        if (obj.AuthURL) onAuthUrl(obj.AuthURL);
        if (obj.Error) errorMsg = obj.Error;
        if (obj.BackendState) finalState = obj.BackendState;
      }
    };
    child.stdout.on('data', (b) => { out += b; consume(); });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => reject(new Error(`Couldn't run Tailscale: ${e.message}`)));
    child.on('exit', (code) => {
      consume();
      if (finalState === 'Running' || (code === 0 && !errorMsg)) return resolve({ state: finalState || 'Running' });
      if (finalState === 'NeedsMachineAuth') {
        return reject(new Error('Signed in, but this PC still needs approval in the Tailscale admin console (Machines page)'));
      }
      const detail = errorMsg || err.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`;
      if (/invalid key|not valid|expired|unable to validate/i.test(detail)) {
        return reject(new Error('That Tailscale key didn\'t work (it may be expired or already used). Ask your buddy for a new one.'));
      }
      if (/timeout|timed out/i.test(detail)) return reject(new Error('Tailscale sign-in timed out. Try again.'));
      reject(new Error(`Tailscale couldn't connect: ${detail}`));
    });
  });
}

/** Start the Tailscale app (tray icon + service) if it's installed but not running. */
function startApp(cmd = findCli()) {
  if (!cmd.length) throw new Error('Tailscale isn\'t installed');
  const gui = path.join(path.dirname(cmd[0]), 'tailscale-ipn.exe');
  if (!platforms.isFile(gui)) throw new Error('Open Tailscale from the Start menu');
  spawn(gui, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// ----- install (Windows) ------------------------------------------------------

function msiArch() {
  return { arm64: 'arm64', ia32: 'x86' }[process.arch] || 'amd64';
}

/** Latest stable Windows MSI: follows pkgs.tailscale.com's "latest" redirect. */
async function latestInstaller({ fetchImpl = globalThis.fetch, arch = msiArch() } = {}) {
  const url = `${PKGS}tailscale-setup-latest-${arch}.msi`;
  let res;
  try {
    res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
  } catch (err) {
    throw new Error(`Couldn't reach Tailscale's download server: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Couldn't find the Tailscale installer (HTTP ${res.status})`);
  const finalUrl = res.url || url;
  const m = /tailscale-setup-(\d+\.\d+\.\d+)-/.exec(finalUrl);
  return { url: finalUrl, version: m ? m[1] : null, size: Number(res.headers.get('content-length')) || 0 };
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Run msiexec through a UAC prompt and wait for it. Resolves to msiexec's exit
 * code; rejects if the person says No to the prompt.
 */
function runMsiElevated(msiPath) {
  const msiArgs = `/i "${msiPath}" /passive /norestart`;
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList ${psQuote(msiArgs)} -Verb RunAs -Wait -PassThru`,
    '  exit $p.ExitCode',
    // Saying No on the UAC prompt throws "The operation was canceled by the user."
    '} catch { $m = $_.Exception.Message; [Console]::Error.WriteLine($m); if ($m -match "cancel") { exit 1223 } else { exit 1 } }',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => reject(new Error(`Couldn't start the installer: ${e.message}`)));
    child.on('exit', (code) => {
      if (code === 1 && err.trim()) return reject(new Error(`Couldn't start the Tailscale installer: ${err.trim()}`));
      resolve(code);
    });
  });
}

const MSI_OK = new Set([0, 3010, 1641]); // 3010/1641 = success, restart needed/started
const MSI_ERRORS = {
  1602: 'Install cancelled.',
  1618: 'Another installation is in progress. Wait for it to finish and try again.',
  1223: 'Install cancelled. Click Yes on the Windows prompt to install Tailscale.',
};

async function install({
  release = null, onProgress = null, log = () => {}, fetchImpl = globalThis.fetch,
  runElevated = runMsiElevated, workDir = os.tmpdir(), findCliImpl = findCli,
} = {}) {
  if (platforms.osName() !== 'windows' && runElevated === runMsiElevated) {
    throw new Error('Automatic Tailscale install is only available on Windows');
  }
  const rel = release || (await latestInstaller({ fetchImpl }));
  const label = `Tailscale${rel.version ? ' ' + rel.version : ''}`;
  const dir = await fsp.mkdtemp(path.join(workDir, 'retroconnect-tailscale-'));
  const msi = path.join(dir, path.basename(new URL(rel.url).pathname) || 'tailscale.msi');
  try {
    log(`Downloading ${label}`);
    const res = await fetchImpl(rel.url);
    if (!res.ok || !res.body) throw new Error(`Tailscale download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || rel.size || 0;
    let done = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => { done += c.length; if (onProgress) onProgress({ label: `Downloading ${label}`, done, total }); });
    await pipeline(body, fs.createWriteStream(msi));
    if (total && done !== total) throw new Error('Tailscale download was cut off; try again');

    log(`Installing ${label}. Click Yes if Windows asks for permission.`);
    const code = await runElevated(msi);
    if (!MSI_OK.has(code)) throw new Error(MSI_ERRORS[code] || `Tailscale installer failed (code ${code})`);
    if (!findCliImpl().length) throw new Error('Tailscale installed, but RetroConnect can\'t find it yet. Restart RetroConnect.');
    log(`${label} installed${code === 0 ? '' : ' (Windows wants a restart at some point)'}`);
    return { version: rel.version, restartNeeded: code !== 0 };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

module.exports = {
  findCli, status, parseStatus, login, startApp, latestInstaller, install, runMsiElevated, msiArch,
  DOWNLOAD_PAGE, KEYS_PAGE, MACHINES_PAGE,
};
