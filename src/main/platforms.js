'use strict';
// Platform detection: OS/arch tags, core file names, default install paths.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILDBOT_BASE = 'https://buildbot.libretro.com/nightly';

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function archName() {
  return { x64: 'x86_64', arm64: 'arm64', ia32: 'x86' }[process.arch] || process.arch;
}

/** Cores are native binaries, so they're only interchangeable on the same tag. */
function platformTag() {
  return `${osName()}-${archName()}`;
}

function coreExtension(osTag = osName()) {
  return { windows: '.dll', macos: '.dylib' }[osTag] || '.so';
}

/** 'snes9x_libretro' -> 'snes9x_libretro.so' (or .dll / .dylib). */
function coreFilename(coreName, osTag) {
  return coreName + coreExtension(osTag);
}

/** 'snes9x_libretro.dll' -> 'snes9x_libretro'; null if it isn't a core. */
function coreNameFromFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!['.so', '.dll', '.dylib'].includes(ext)) return null;
  const stem = filename.slice(0, -ext.length);
  return stem.endsWith('_libretro') ? stem : null;
}

/** URL of the libretro nightly build of a core for a platform (zipped). */
function buildbotCoreUrl(coreName, tag = platformTag()) {
  const [osTag, arch] = tag.split('-');
  const fname = coreFilename(coreName, osTag);
  if (osTag === 'linux' && arch === 'x86_64') return `${BUILDBOT_BASE}/linux/x86_64/latest/${fname}.zip`;
  if (osTag === 'windows' && (arch === 'x86_64' || arch === 'x86')) {
    return `${BUILDBOT_BASE}/windows/${arch}/latest/${fname}.zip`;
  }
  if (osTag === 'macos' && (arch === 'x86_64' || arch === 'arm64')) {
    return `${BUILDBOT_BASE}/apple/osx/${arch}/latest/${fname}.zip`;
  }
  return null;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function which(cmd) {
  const exts = osName() === 'windows' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** Best guess at the command that starts RetroArch; [] if not found. */
function detectRetroarch() {
  const home = os.homedir();
  const candidates = [];
  if (osName() === 'windows') {
    const appdata = process.env.APPDATA || '';
    candidates.push(
      'C:\\RetroArch-Win64\\retroarch.exe',
      'C:\\RetroArch\\retroarch.exe',
      path.join(appdata, 'RetroArch', 'retroarch.exe'),
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RetroArch\\retroarch.exe',
      'C:\\Program Files\\RetroArch\\retroarch.exe',
    );
  } else if (osName() === 'macos') {
    candidates.push(
      '/Applications/RetroArch.app/Contents/MacOS/RetroArch',
      path.join(home, 'Applications/RetroArch.app/Contents/MacOS/RetroArch'),
    );
  }
  for (const c of candidates) if (isFile(c)) return [c];
  for (const exe of ['retroarch', 'RetroArch']) {
    const found = which(exe);
    if (found) return [found];
  }
  if (osName() === 'linux' && which('flatpak') && isDir(path.join(home, '.var/app/org.libretro.RetroArch'))) {
    return ['flatpak', 'run', 'org.libretro.RetroArch'];
  }
  return [];
}

/** Where RetroArch keeps its cores on this machine (first existing guess). */
function detectCoresDir(retroarchCmd = []) {
  const home = os.homedir();
  const candidates = [];
  if (osName() === 'windows') {
    // Windows installs keep cores next to retroarch.exe.
    if (retroarchCmd.length) candidates.push(path.join(path.dirname(retroarchCmd[0]), 'cores'));
    candidates.push('C:\\RetroArch-Win64\\cores', path.join(process.env.APPDATA || '', 'RetroArch', 'cores'));
  } else if (osName() === 'macos') {
    candidates.push(path.join(home, 'Library/Application Support/RetroArch/cores'));
  } else {
    candidates.push(
      path.join(home, '.config/retroarch/cores'),
      path.join(home, '.var/app/org.libretro.RetroArch/config/retroarch/cores'),
    );
  }
  return candidates.find(isDir) || candidates[0];
}

module.exports = {
  osName, archName, platformTag, coreExtension, coreFilename, coreNameFromFile,
  buildbotCoreUrl, detectRetroarch, detectCoresDir, isFile, isDir,
};
