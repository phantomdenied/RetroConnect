'use strict';
// Install or update RetroArch from the official libretro stable builds.
//
// Uses the portable Windows build (RetroArch.7z) and unpacks it into a folder
// RetroConnect manages, so it needs no admin rights and we always know where
// retroarch.exe and its cores folder are. Updating unpacks over the same
// folder: your retroarch.cfg, saves, states and downloaded cores are kept,
// because the archive doesn't contain them.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const STABLE_INDEX = 'https://buildbot.libretro.com/stable/';
const MARKER = '.retroconnect-install.json';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function archiveUrl(version) {
  return `${STABLE_INDEX}${version}/windows/x86_64/RetroArch.7z`;
}

/** Newest stable version that actually has a Windows x64 build. */
async function latestStable({ fetchImpl = globalThis.fetch } = {}) {
  let html;
  try {
    const res = await fetchImpl(STABLE_INDEX);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Couldn't check for the latest RetroArch: ${err.message}`);
  }
  const versions = [...new Set([...html.matchAll(/\/stable\/(\d+\.\d+\.\d+)\//g)].map((m) => m[1]))]
    .sort(compareVersions)
    .reverse();
  if (!versions.length) throw new Error("Couldn't find any RetroArch releases on the libretro server");
  // A brand-new release can show up before its Windows build is uploaded.
  for (const version of versions.slice(0, 3)) {
    const url = archiveUrl(version);
    try {
      const res = await fetchImpl(url, { method: 'HEAD' });
      if (res.ok) return { version, url, size: Number(res.headers.get('content-length')) || 0 };
    } catch { /* try the next one */ }
  }
  throw new Error('No recent RetroArch release has a Windows download yet');
}

/** Version installed by RetroConnect in `dir`, or null. */
function installedVersion(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return fs.existsSync(path.join(dir, 'retroarch.exe')) ? marker.version : null;
  } catch {
    return null;
  }
}

async function download(url, dest, onProgress, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (onProgress) onProgress({ done, total });
  });
  await pipeline(body, fs.createWriteStream(dest));
  if (total && done !== total) throw new Error('Download was cut off; try again');
}

function sevenZipPath() {
  // Inside a packaged app the binary lives in app.asar.unpacked.
  return require('7zip-bin').path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function extract(archive, destDir, onProgress, exe = sevenZipPath()) {
  return new Promise((resolve, reject) => {
    // x = keep folder structure, -aoa = overwrite existing, -bsp1 = progress on stdout
    const child = spawn(exe, ['x', archive, `-o${destDir}`, '-aoa', '-y', '-bsp1', '-bb0'], { windowsHide: true });
    let stderr = '';
    child.stdout.on('data', (buf) => {
      const pcts = String(buf).match(/(\d+)%/g);
      if (pcts && onProgress) onProgress(Number(pcts[pcts.length - 1].slice(0, -1)));
    });
    child.stderr.on('data', (buf) => { stderr += buf; });
    child.on('error', (err) => reject(new Error(`Couldn't run 7-Zip: ${err.message}`)));
    child.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error(`Unpacking RetroArch failed: ${stderr.trim().split('\n').pop() || `7-Zip exit code ${code}`}`))));
  });
}

/** Find the folder holding retroarch.exe (the archive may nest it one level). */
async function findExeDir(dir, depth = 2) {
  if (fs.existsSync(path.join(dir, 'retroarch.exe'))) return dir;
  if (!depth) return null;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const found = await findExeDir(path.join(dir, e.name), depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Download and unpack the latest stable RetroArch into `installDir`.
 * Resolves to { version, exe, coresDir }.
 */
async function install({ installDir, release = null, onProgress = null, log = () => {}, fetchImpl = globalThis.fetch, sevenZip } = {}) {
  const rel = release || (await latestStable({ fetchImpl }));
  const label = `RetroArch ${rel.version}`;
  await fsp.mkdir(installDir, { recursive: true });
  const work = await fsp.mkdtemp(path.join(path.dirname(installDir), '.retroarch-download-'));
  try {
    log(`Downloading ${label} from libretro`);
    const archive = path.join(work, 'RetroArch.7z');
    await download(rel.url, archive, (p) => onProgress && onProgress({ label: `Downloading ${label}`, ...p }), fetchImpl);

    log(`Unpacking ${label}`);
    const staging = path.join(work, 'unpacked');
    await extract(archive, staging, (pct) => onProgress && onProgress({ label: `Unpacking ${label}`, done: pct, total: 100, percent: true }), sevenZip);
    if (onProgress) onProgress({ label: `Unpacking ${label}`, done: 100, total: 100, percent: true });
    const root = await findExeDir(staging);
    if (!root) throw new Error("The download didn't contain retroarch.exe");

    // Copy over the install folder; user files not in the archive stay put.
    await fsp.cp(root, installDir, { recursive: true, force: true });
    await fsp.mkdir(path.join(installDir, 'cores'), { recursive: true });
    await fsp.writeFile(path.join(installDir, MARKER), JSON.stringify({ version: rel.version, installedAt: new Date().toISOString() }));
    log(`${label} is installed`);
    return { version: rel.version, exe: path.join(installDir, 'retroarch.exe'), coresDir: path.join(installDir, 'cores') };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

module.exports = { latestStable, install, installedVersion, compareVersions, extract, archiveUrl, STABLE_INDEX };
