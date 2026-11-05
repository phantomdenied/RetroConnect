'use strict';
// Electron entry point: window, IPC wiring, notifications.

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification } = require('electron');
const path = require('path');
const { Controller } = require('./controller');
const config = require('./config');

let win = null;
let controller = null;

if (!app.requestSingleInstanceLock()) {
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
  handle('library', (opts) => controller.getLibrary(opts || {}));
  handle('host', (sha, core) => controller.host(sha, core));
  handle('host:stop', () => controller.stopHosting());
  handle('join', () => controller.join());
  handle('sync', (shas) => controller.syncGames(shas || null));
  handle('dialog:folder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open:path', (p) => shell.openPath(p));
  handle('open:url', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  });
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));
}

function wireController() {
  controller.on('state', (s) => send('state', s));
  controller.on('log', (entry) => send('log', entry));
  let lastProgress = 0;
  controller.on('progress', (p) => {
    const now = Date.now();
    if (p.done >= p.total || now - lastProgress > 100) {
      lastProgress = now;
      send('progress', p);
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
  controller = new Controller({
    dataDir: process.env.RETROCONNECT_HOME || app.getPath('userData'),
    version: app.getVersion(),
  });
  wireIpc();
  wireController();
  await controller.init();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (controller) await controller.dispose();
  app.quit();
});
