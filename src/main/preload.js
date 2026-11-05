'use strict';
// The only bridge between the UI and the main process.

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function on(channel) {
  return (fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('rc', {
  state: () => call('state'),
  saveSettings: (partial) => call('settings:save', partial),
  newSecret: () => call('settings:newSecret'),
  library: (opts) => call('library', opts),
  host: (sha, core) => call('host', sha, core),
  stopHosting: () => call('host:stop'),
  join: () => call('join'),
  sync: (shas) => call('sync', shas),
  retroarchLatest: () => call('retroarch:latest'),
  installRetroArch: () => call('retroarch:install'),
  pickFolder: (title, defaultPath) => call('dialog:folder', title, defaultPath),
  pickFile: (title) => call('dialog:file', title),
  openPath: (p) => call('open:path', p),
  openUrl: (url) => call('open:url', url),
  copy: (text) => call('clipboard:write', text),
  onState: on('state'),
  onLog: on('log'),
  onProgress: on('progress'),
  onInvite: on('invite'),
});
