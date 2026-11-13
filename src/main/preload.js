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
  publicIp: (opts) => call('net:publicIp', opts),
  newSecret: () => call('settings:newSecret'),
  library: (opts) => call('library', opts),
  host: (sha, core) => call('host', sha, core),
  stopHosting: () => call('host:stop'),
  swapPlayers: () => call('players:swap'),
  join: () => call('join'),
  sync: (shas) => call('sync', shas),
  retroarchLatest: () => call('retroarch:latest'),
  installRetroArch: (version) => call('retroarch:install', version),
  checkConnection: () => call('conn:check'),
  checkPorts: () => call('conn:checkPorts'),
  suggest: (sha) => call('suggest', sha),
  toggleFavorite: (sha) => call('favorite', sha),
  onThumbs: on('thumbs'),
  clearSuggestion: () => call('suggest:clear'),
  checkForUpdates: () => call('update:check'),
  downloadUpdate: () => call('update:download'),
  installUpdate: () => call('update:install'),
  makeInvite: (opts) => call('invite:make', opts),
  redeemInvite: (code, extra) => call('invite:redeem', code, extra),
  raSetupInfo: () => call('ra-setup:info'),
  raSetupApply: (opts) => call('ra-setup:apply', opts),
  raSetupCores: (names) => call('ra-setup:cores', names),
  updateCores: () => call('cores:update'),
  sendFilesAdd: (paths) => call('files:add', paths),
  sendFilesRemove: (ids) => call('files:remove', ids),
  receiveFiles: (ids) => call('files:receive', ids),
  dismissFiles: (ids) => call('files:dismiss', ids),
  openReceiveFolder: () => call('files:openFolder'),
  showReceived: (id) => call('files:show', id),
  pickSendFiles: (folders) => call('dialog:sendFiles', Boolean(folders)),
  onFiles: on('files'),
  describeGame: (romPath) => call('game:describe', romPath),
  cheats: (sha) => call('cheats:get', sha),
  setCheats: (sha, indices) => call('cheats:set', sha, indices),
  downloadCheats: () => call('cheats:download'),
  makeCheatRom: (sha) => call('cheats:make', sha),
  hostWithCheats: (sha) => call('cheats:host', sha),
  playSolo: (sha) => call('cheats:solo', sha),
  openCheatFolder: (sha) => call('cheats:openFolder', sha),
  patchInspect: (file, userHash) => call('patch:inspect', file, userHash),
  patchApply: (opts) => call('patch:apply', opts),
  showPatched: (full) => call('patch:show', full),
  pickPatch: () => call('dialog:patch'),
  raSetupAll: (opts) => call('ra-setup:all', opts),
  raOpen: () => call('ra-setup:open'),
  reportPads: (list) => call('pads:report', list),
  assignPad: (key, player) => call('pads:assign', key, player),
  classifyPads: (ids) => call('ra-setup:classify', ids),
  onSuggestion: on('suggestion'),
  tsRefresh: () => call('tailscale:refresh'),
  tsLatest: () => call('tailscale:latest'),
  tsInstall: () => call('tailscale:install'),
  tsLogin: (authKey) => call('tailscale:login', authKey),
  tsCancel: () => call('tailscale:cancel'),
  tsStart: () => call('tailscale:start'),
  tsUsePeer: (ip) => call('tailscale:usePeer', ip),
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
