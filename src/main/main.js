'use strict';
// Electron entry point: window, IPC wiring, notifications.

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, protocol, nativeImage } = require('electron');
const fs = require('fs');

// rcthumb://cover/<rom sha> serves cached box art to the window.
protocol.registerSchemesAsPrivileged([{ scheme: 'rcthumb', privileges: { standard: true, secure: true } }]);
const path = require('path');
const { Controller } = require('./controller');
const config = require('./config');

let win = null;
let controller = null;
let logFile = null;

/** Append to <data>/logs/main.log (kept under ~1 MB) so problems can be looked into afterwards. */
function fileLog(message) {
  if (!logFile) return;
  try {
    const st = fs.statSync(logFile, { throwIfNoEntry: false });
    if (st && st.size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch { /* logging must never break the app */ }
}

/** Short, non-reversible tag for a secret, so logs can tell two keys apart without containing them. */
function fingerprint(secret) {
  return secret ? require('crypto').createHash('sha256').update(String(secret)).digest('hex').slice(0, 8) : '(none)';
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#12101c',
    title: 'RetroConnect',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

/** Wrap handlers so errors reach the UI as clean messages. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function wireIpc() {
  handle('state', () => controller.state());
  handle('settings:save', (partial) => controller.saveSettings(partial));
  handle('settings:newSecret', () => config.generateSecret());
  handle('net:publicIp', (opts) => controller.publicAddress(opts || {}));
  handle('library', (opts) => controller.getLibrary(opts || {}));
  handle('host', (sha, core) => controller.host(sha, core));
  handle('host:stop', () => controller.stopHosting());
  handle('players:swap', () => controller.swapPlayers());
  handle('join', () => controller.join());
  handle('sync', (shas) => controller.syncGames(shas || null));
  handle('retroarch:latest', () => controller.checkRetroArchLatest());
  handle('retroarch:install', (version) => controller.installRetroArch(version || null));
  handle('conn:check', () => controller.checkConnection());
  handle('conn:checkPorts', () => controller.checkMyPorts());
  handle('suggest', (sha) => controller.suggest(sha));
  handle('favorite', (sha) => controller.toggleFavorite(String(sha)));
  handle('suggest:clear', () => controller.clearSuggestion());
  handle('update:check', () => controller.checkForUpdates());
  handle('update:download', () => controller.downloadUpdate());
  handle('update:install', () => {
    controller.installUpdate();
    // Get out of the installer's way; it reopens the new version.
    setTimeout(() => app.quit(), 400);
    return true;
  });
  handle('invite:make', (opts) => controller.makeInvite(opts || {}));
  handle('invite:redeem', (code, extra) => controller.redeemInvite(String(code || ''), extra || {}));
  handle('ra-setup:info', () => controller.retroarchSetupInfo());
  handle('ra-setup:apply', (opts) => controller.applyRetroArchSettings(opts || {}));
  handle('cores:update', () => controller.updateCores());
  handle('files:add', (paths) => controller.addToOutbox(Array.isArray(paths) ? paths.map(String) : []));
  handle('files:remove', (ids) => controller.removeFromOutbox(Array.isArray(ids) ? ids : []));
  handle('files:receive', (ids) => controller.receiveFiles(Array.isArray(ids) ? ids.map(String) : []));
  handle('files:dismiss', (ids) => controller.dismissIncoming(Array.isArray(ids) ? ids.map(String) : []));
  handle('files:openFolder', async () => {
    const dir = controller.receiveDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('files:show', (id) => {
    const p = controller.received.saved[String(id)];
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    else throw new Error("That file isn't there any more");
    return true;
  });
  handle('dialog:sendFiles', async (folders) => {
    const r = await dialog.showOpenDialog(win, {
      title: folders ? 'Pick a folder to send' : 'Pick files to send',
      properties: folders ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('ra-setup:cores', (names) => controller.installCores(Array.isArray(names) ? names : []));
  handle('ra-setup:all', (opts) => controller.setUpEverything(opts || {}));
  handle('ra-setup:open', () => controller.openRetroArch());
  handle('pads:report', (list) => controller.reportPads(list));
  handle('pads:assign', (key, player) => controller.assignPad(String(key), player ? Number(player) : null));
  handle('ra-setup:classify', (ids) => (Array.isArray(ids) ? ids : []).map((id) => require('./retroarch-setup').classifyController(id)));
  handle('tailscale:refresh', () => controller.refreshTailscale());
  handle('tailscale:latest', () => controller.checkTailscaleLatest());
  handle('tailscale:install', () => controller.installTailscale());
  handle('tailscale:login', (authKey) => controller.loginTailscale({ authKey: authKey || null }));
  handle('tailscale:cancel', () => controller.cancelTailscaleLogin());
  handle('tailscale:start', () => controller.startTailscale());
  handle('tailscale:usePeer', (ip) => controller.useTailscalePeer(ip));
  handle('dialog:folder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title) => {
    const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : undefined;
    const r = await dialog.showOpenDialog(win, { title, filters, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open:path', async (p) => {
    if (!p || !fs.existsSync(p)) throw new Error(`That folder doesn't exist: ${p || '(not set)'}. Check Settings.`);
    const err = await shell.openPath(p);
    if (err) throw new Error(`Couldn't open ${p}: ${err}`);
    return true;
  });
  handle('open:url', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  });
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));
}

function wireController() {
  controller.on('state', (s) => send('state', s));
  controller.on('log', (entry) => send('log', entry));
  controller.on('openUrl', (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  let lastProgress = 0;
  controller.on('progress', (p) => {
    const now = Date.now();
    if (p.done >= p.total || now - lastProgress > 100) {
      lastProgress = now;
      send('progress', p);
    }
  });
  let thumbTimer = null;
  const refreshList = () => {
    clearTimeout(thumbTimer); // covers and game info arrive in bursts: refresh the list once
    thumbTimer = setTimeout(() => send('thumbs'), 400);
  };
  controller.on('thumb', refreshList);
  controller.on('gameinfo', refreshList); // player counts / genres for a system arrived
  controller.on('suggestion', (sug) => {
    send('suggestion', sug);
    if (Notification.isSupported() && !(win && win.isFocused())) {
      const n = new Notification({ title: `${sug.from} suggests a game`, body: path.basename(sug.rom.path) });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  });
  controller.on('files', (info) => {
    send('files', info);
    if (Notification.isSupported() && !(win && win.isFocused())) {
      const n = new Notification({
        title: `${info.from} wants to send you ${info.count === 1 ? 'a file' : `${info.count} files`}`,
        body: info.names.slice(0, 3).join(', ') + (info.count > 3 ? ', …' : ''),
      });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  });
  controller.on('invite', (session) => {
    send('invite', session);
    if (Notification.isSupported() && !(win && win.isFocused())) {
      const n = new Notification({
        title: `${session.host_nickname} is hosting`,
        body: `${path.basename(session.rom.path)} — open RetroConnect to join`,
      });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return; // another copy is already open; this one is quitting
  const dataDir = process.env.RETROCONNECT_HOME || app.getPath('userData');
  logFile = path.join(dataDir, 'logs', 'main.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fileLog(`start v${app.getVersion()} argv=${JSON.stringify(process.argv.slice(1))} cwd=${process.cwd()} dataDir=${dataDir}` +
    ` home=${process.env.RETROCONNECT_HOME ? 'env' : 'userData'} lock=${gotLock}`);
  controller = new Controller({
    dataDir,
    version: app.getVersion(),
    downloadsDir: app.getPath('downloads'),
    updateFeedDefault: (require('../../package.json').retroconnect || {}).updateFeedUrl || '',
    githubRepo: (require('../../package.json').retroconnect || {}).githubRepo || '',
    // Only an installed copy can update itself; the portable exe and `npm start` can't.
    selfUpdate: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && process.platform === 'win32',
    // Store covers small: 160 px wide is plenty for the game list.
    resizeImage: async (buf) => {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) throw new Error('not an image');
      return img.getSize().width > 160 ? img.resize({ width: 160, quality: 'good' }).toPNG() : buf;
    },
    // Big, machine-specific files belong in Local AppData, not the roaming profile.
    retroarchDir: process.env.LOCALAPPDATA && !process.env.RETROCONNECT_HOME
      ? path.join(process.env.LOCALAPPDATA, 'RetroConnect', 'RetroArch')
      : path.join(dataDir, 'RetroArch'),
  });
  wireIpc();
  wireController();
  controller.on('log', (e) => fileLog(`${e.level || 'info'}: ${e.message}`));
  await controller.init();
  {
    const st = controller.state();
    fileLog(`ready config=${controller.configFile} roms=${st.config.romsDir} key=${fingerprint(st.config.sharedSecret)}` +
      ` server=${st.server.running ? `port ${st.server.port}` : `off (${st.server.error || 'not needed'})`}`);
  }
  protocol.handle('rcthumb', async (req) => {
    const sha = new URL(req.url).pathname.replace(/^\//, '');
    const file = controller.thumbFile(sha);
    if (!file) return new Response('', { status: 404 });
    return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' } });
  });
  createWindow();
  // Quietly look for a new version shortly after start, then every 6 hours.
  const check = () => { if (controller.updateFeed()) controller.checkForUpdates().catch(() => {}); };
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (controller) await controller.dispose();
  app.quit();
});
