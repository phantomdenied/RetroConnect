'use strict';
// App state and actions, independent of Electron so it can be tested.
//
// Every RetroConnect app runs a sync server (while "share my library" is on)
// and polls the buddy's server. Either player can host; the other sees the
// invite appear and clicks Join.

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const config = require('./config');
const platforms = require('./platforms');
const launcher = require('./launcher');
const { Library, retroarchVersion, clearVersionCache } = require('./library');
const raInstaller = require('./retroarch-installer');
const { SyncServer } = require('./server');
const { HostClient, Syncer, SyncError, compare } = require('./sync');

const POLL_MS = 4000;
const MANIFEST_REFRESH_MS = 30000;

function isTailscaleIp(ip) {
  const m = /^100\.(\d+)\./.exec(ip);
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function localAddresses() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({
        address: a.address,
        kind: isTailscaleIp(a.address) || /tailscale/i.test(ifname) ? 'tailscale' : 'lan',
      });
    }
  }
  return out;
}

class Controller extends EventEmitter {
  constructor({
    dataDir, version = '0', pollMs = POLL_MS, launch = launcher.run, fetchCore,
    retroarchDir = path.join(dataDir, 'RetroArch'), installer = raInstaller,
  } = {}) {
    super();
    this.dataDir = dataDir;
    this.configFile = path.join(dataDir, 'config.json');
    this.cacheFile = path.join(dataDir, 'hash-cache.json');
    this.version = version;
    this.pollMs = pollMs;
    this.launch = launch;
    this.fetchCore = fetchCore;
    this.cfg = null;
    this.library = null;
    this.server = null;
    this.serverError = null;
    this.buddy = { status: 'unset' };
    this.buddyManifest = null;
    this.buddyManifestAt = 0;
    this.hosting = null; // { rom, core, child }
    this.playing = null; // guest: { rom, core }
    this.busy = null; // description of a running job
    this.pollTimer = null;
    this.raVersion = null;
    this.retroarchDir = retroarchDir; // where "Install RetroArch" puts it
    this.installer = installer;
    this.raLatest = null; // { version, url, size } from libretro, once checked
  }

  // ----- lifecycle -----------------------------------------------------------

  async init() {
    this.cfg = config.load(this.configFile);
    await this.applyConfig();
    this.startPolling();
    return this.state();
  }

  async dispose() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.hosting && this.hosting.child) this.hosting.child.kill();
    if (this.server) await this.server.stop();
    this.server = null;
  }

  async applyConfig() {
    const ra = config.retroarchCmd(this.cfg);
    this.library = new Library({
      romsDir: this.cfg.romsDir,
      coresDir: config.coresPath(this.cfg),
      cacheFile: this.cacheFile,
      nickname: this.cfg.nickname,
      retroarchCmd: ra,
    });
    // A RetroArch we installed knows its version; otherwise ask the binary.
    const managed = this.managedRetroArch();
    this.raVersion = managed && ra[0] === managed.exe ? managed.version : await retroarchVersion(ra);
    this.buddyManifest = null;
    this.buddyManifestAt = 0;
    await this.restartServer();
    this.emitState();
  }

  async restartServer() {
    const session = this.server ? this.server.session : null;
    if (this.server) await this.server.stop();
    this.server = null;
    this.serverError = null;
    const wanted = this.cfg.sharedSecret && (this.cfg.shareLibrary || this.hosting);
    if (!wanted) return;
    try {
      const server = new SyncServer({
        library: this.library, secret: this.cfg.sharedSecret, port: this.cfg.syncPort, version: this.version,
      });
      await server.start();
      server.session = session;
      this.server = server;
    } catch (err) {
      this.serverError = err.code === 'EADDRINUSE'
        ? `Port ${this.cfg.syncPort} is already in use (is RetroConnect open twice?)`
        : err.message;
    }
  }

  // ----- state for the UI ----------------------------------------------------

  state() {
    const cfg = this.cfg;
    return {
      version: this.version,
      configured: config.isConfigured(cfg),
      config: cfg,
      platform: platforms.platformTag(),
      retroarch: {
        command: config.retroarchCmd(cfg),
        version: this.raVersion,
        canInstall: platforms.osName() === 'windows' || process.env.RETROCONNECT_ALLOW_RA_INSTALL === '1',
        managed: this.managedRetroArch(),
        latest: this.raLatest,
        updateAvailable: Boolean(this.raLatest && (!this.raVersion
          || raInstaller.compareVersions(this.raLatest.version, this.raVersion) > 0)),
      },
      coresDir: config.coresPath(cfg),
      server: { running: Boolean(this.server), port: this.server ? this.server.port : null, error: this.serverError },
      addresses: localAddresses(),
      buddy: this.buddy,
      hosting: this.hosting ? { rom: this.hosting.rom, core: this.hosting.core } : null,
      playing: this.playing,
      busy: this.busy,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  log(message, level = 'info') {
    this.emit('log', { message, level, at: Date.now() });
  }

  // ----- settings ------------------------------------------------------------

  async saveSettings(partial) {
    const next = config.normalize({ ...this.cfg, ...partial });
    this.cfg = config.save(this.configFile, next);
    this.buddy = { status: this.cfg.peerAddress ? 'checking' : 'unset' };
    await this.applyConfig();
    this.pollNow();
    return this.state();
  }

  // ----- buddy polling -------------------------------------------------------

  client() {
    if (!this.cfg.sharedSecret) throw new SyncError('Set up a shared secret first (Settings)');
    return new HostClient(this.cfg.peerAddress, this.cfg.syncPort, this.cfg.sharedSecret, { timeoutMs: 5000 });
  }

  startPolling() {
    clearTimeout(this.pollTimer);
    const tick = async () => {
      await this.pollBuddy();
      if (this.pollTimer !== null) this.pollTimer = setTimeout(tick, this.pollMs);
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  pollNow() {
    if (this.pollTimer !== null) this.startPolling();
  }

  async pollBuddy() {
    if (!this.cfg.peerAddress || !this.cfg.sharedSecret) {
      this.setBuddy({ status: 'unset' });
      return;
    }
    const before = this.buddy;
    try {
      const client = this.client();
      if (!this.buddyManifest || Date.now() - this.buddyManifestAt > MANIFEST_REFRESH_MS) {
        this.buddyManifest = await client.manifest();
        this.buddyManifestAt = Date.now();
      }
      const session = await client.session();
      const m = this.buddyManifest;
      this.setBuddy({
        status: 'online',
        nickname: m.nickname || 'Buddy',
        platform: m.platform,
        retroarchVersion: m.retroarch_version,
        romCount: m.roms.length,
        session,
      });
      if (session && !(before.session && before.session.started_at === session.started_at)) {
        this.emit('invite', session);
        this.log(`${session.host_nickname} is hosting ${session.rom.path}`);
      }
    } catch (err) {
      this.buddyManifest = null;
      this.setBuddy({ status: 'offline', error: err.message });
    }
  }

  setBuddy(next) {
    const changed = JSON.stringify(next) !== JSON.stringify(this.buddy);
    this.buddy = next;
    if (changed) this.emitState();
  }

  // ----- library -------------------------------------------------------------

  async getLibrary({ refreshBuddy = false } = {}) {
    const local = await this.library.manifest();
    if (refreshBuddy) {
      this.buddyManifestAt = 0;
      await this.pollBuddy();
    }
    const rows = compare(local, this.buddyManifest).map((row) => {
      const ext = path.extname(row.path);
      const coreName = config.coreForExtension(this.cfg, ext);
      return {
        ...row,
        coreName,
        coreInstalled: Boolean(coreName && local.cores.some((c) => c.name === coreName)),
      };
    });
    return { rows, cores: local.cores, buddyOnline: Boolean(this.buddyManifest), romsDir: this.cfg.romsDir };
  }

  // ----- RetroArch install ---------------------------------------------------

  managedRetroArch() {
    const version = this.installer.installedVersion(this.retroarchDir);
    return version ? { version, dir: this.retroarchDir, exe: path.join(this.retroarchDir, 'retroarch.exe') } : null;
  }

  async checkRetroArchLatest() {
    this.raLatest = await this.installer.latestStable();
    this.emitState();
    return this.raLatest;
  }

  async installRetroArch() {
    if (this.hosting || this.playing) throw new Error('Close RetroArch (finish your game) before installing');
    return this.withBusy('Installing RetroArch', async () => {
      let result;
      try {
        result = await this.installer.install({
          installDir: this.retroarchDir,
          release: this.raLatest,
          onProgress: (p) => this.progress(p),
          log: (m) => this.log(m),
        });
      } catch (err) {
        if (['EBUSY', 'EPERM'].includes(err.code)) {
          throw new Error('RetroArch is running. Close it and try again.');
        }
        throw err;
      }
      clearVersionCache();
      this.raLatest = this.raLatest || { version: result.version };
      // Point RetroConnect at it. Unless a cores folder was chosen by hand,
      // cores are then found next to retroarch.exe automatically.
      this.cfg = config.save(this.configFile, { ...this.cfg, retroarchCommand: [result.exe] });
      await this.applyConfig();
      this.log(`RetroArch ${result.version} is ready. Get cores from RetroArch → Online Updater → Core Downloader.`);
      return result;
    });
  }

  // ----- actions -------------------------------------------------------------

  async withBusy(label, fn) {
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    this.busy = label;
    this.emitState();
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.emitState();
    }
  }

  progress(p) {
    this.emit('progress', p);
  }

  async host(romSha, coreOverride = null) {
    if (this.hosting) throw new Error("You're already hosting a game");
    const rom = await this.library.findRomBySha(romSha);
    if (!rom) throw new Error('That game is no longer in your ROM folder');
    let coreName = coreOverride || config.coreForExtension(this.cfg, path.extname(rom.path));
    if (!coreName) throw new Error(`No core is set for ${path.extname(rom.path)} files. Pick one in Settings → Cores.`);
    if (!coreName.endsWith('_libretro')) coreName += '_libretro';
    const core = await this.library.findCore(coreName);
    if (!core) {
      throw new Error(`${coreName} isn't installed. Get it in RetroArch → Online Updater → Core Downloader.`);
    }
    if (!this.cfg.sharedSecret) throw new Error('Set up a shared secret first (Settings)');

    this.hosting = { rom, core, child: null };
    if (!this.server) await this.restartServer();
    if (!this.server) {
      this.hosting = null;
      throw new Error(`Can't share files with your buddy: ${this.serverError}`);
    }
    await this.server.manifest();
    this.server.session = {
      host_nickname: this.cfg.nickname,
      platform: this.library.platformTag,
      retroarch_version: this.raVersion,
      netplay_port: this.cfg.netplayPort,
      connection_mode: this.cfg.connectionMode,
      relay_server: this.cfg.relayServer,
      rom,
      core,
      started_at: Date.now(),
    };
    this.log(`Hosting ${rom.path} with ${coreName}`);
    this.emitState();

    const done = this.launch(this.cfg, 'host', this.library.corePath(core), this.library.romPath(rom), {},
      { onSpawn: (child) => { if (this.hosting) this.hosting.child = child; } });
    done.catch((err) => this.log(err.message, 'error')).finally(async () => {
      if (this.server) this.server.session = null;
      this.hosting = null;
      this.log('Stopped hosting');
      if (!this.cfg.shareLibrary) await this.restartServer();
      this.emitState();
    });
    return this.state();
  }

  stopHosting() {
    if (this.hosting && this.hosting.child) this.hosting.child.kill();
  }

  async join() {
    return this.withBusy('Getting ready to join', async () => {
      const client = this.client();
      const session = await client.session();
      if (!session) throw new Error("Your buddy isn't hosting a game right now");
      this.log(`Matching ${session.rom.path} (${session.core.name}) with ${session.host_nickname}`);
      const syncer = new Syncer(this.library, client, {
        buildbotFallback: this.cfg.buildbotFallback,
        onProgress: (p) => this.progress(p),
        log: (m) => this.log(m),
        ...(this.fetchCore ? { fetchCore: this.fetchCore } : {}),
      });
      const result = await syncer.syncSession(session);
      for (const w of result.warnings) this.log(w, 'warn');
      this.log(result.downloaded.length
        ? `Downloaded ${result.downloaded.join(', ')}. Everything matches.`
        : 'You already had the same core and ROM.');

      const relay = session.connection_mode === 'relay' || this.cfg.connectionMode === 'relay';
      const cfg = relay ? { ...this.cfg, connectionMode: 'relay' } : this.cfg;
      if (relay) {
        this.log(`Relay mode: in RetroArch open Netplay → Refresh Host List and join ${session.host_nickname}.`, 'warn');
      }
      this.playing = { rom: session.rom, core: session.core, host: session.host_nickname };
      this.emitState();
      this.launch(cfg, 'guest', result.corePath, result.romPath,
        { connectTo: this.cfg.peerAddress, port: session.netplay_port })
        .catch((err) => this.log(err.message, 'error'))
        .finally(() => { this.playing = null; this.emitState(); });
      return { warnings: result.warnings, downloaded: result.downloaded };
    });
  }

  async syncGames(shas = null) {
    return this.withBusy(shas ? 'Downloading games' : 'Syncing library', async () => {
      const client = this.client();
      const manifest = await client.manifest();
      const syncer = new Syncer(this.library, client, {
        buildbotFallback: this.cfg.buildbotFallback,
        onProgress: (p) => this.progress(p),
        log: (m) => this.log(m),
      });
      const result = await syncer.syncLibrary(manifest, { onlySha: shas, includeCores: !shas });
      for (const w of result.warnings) this.log(w, 'warn');
      this.log(result.downloaded.length ? `Downloaded ${result.downloaded.length} file(s)` : 'Already in sync');
      this.buddyManifestAt = 0;
      return result;
    });
  }
}

module.exports = { Controller, localAddresses, isTailscaleIp };
