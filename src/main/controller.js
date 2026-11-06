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
const tailscaleLib = require('./tailscale');
const updater = require('./updater');
const raSetup = require('./retroarch-setup');
const { fetchCoreFromBuildbot } = require('./sync');
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
    tailscale = tailscaleLib,
    updateFeedDefault = '', fetchImpl = globalThis.fetch,
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
    this.tailscale = tailscale;
    this.ts = { installed: false, state: 'Unknown', peers: [] };
    this.tsLogin = null; // { child, authUrl } while signing in
    this.tsLatest = null;
    this.tick = 0;
    this.updateFeedDefault = updateFeedDefault;
    this.fetchImpl = fetchImpl;
    this.update = null; // result of the last update check
    this.suggestionSeq = 0;
    this.padsFile = path.join(dataDir, 'controllers.json');
    this.livePads = []; // controllers the window can see right now
    this.padData = { known: [], assign: {} }; // last seen controllers + player assignments
    this.ctrl = null; // driver + per-controller profile status
  }

  // ----- lifecycle -----------------------------------------------------------

  async init() {
    this.cfg = config.load(this.configFile);
    try { this.padData = { known: [], assign: {}, ...JSON.parse(require('fs').readFileSync(this.padsFile, 'utf8')) }; } catch { /* first run */ }
    await this.applyConfig();
    this.startPolling();
    return this.state();
  }

  async dispose() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.tsLogin && this.tsLogin.child) this.tsLogin.child.kill();
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
    const wanted = this.cfg.sharedSecret && (this.cfg.shareLibrary || this.hosting || this.mySuggestion);
    if (!wanted) return;
    try {
      const server = new SyncServer({
        library: this.library, secret: this.cfg.sharedSecret, port: this.cfg.syncPort, version: this.version,
      });
      await server.start();
      server.session = session;
      server.discordUrl = this.cfg.discordUrl;
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
      update: this.update,
      updateFeed: this.updateFeed(),
      discord: this.discordLink(),
      mySuggestion: this.mySuggestion || null,
      controllers: this.ctrl,
      tailscale: {
        ...this.ts,
        canInstall: platforms.osName() === 'windows' || process.env.RETROCONNECT_ALLOW_TS_INSTALL === '1',
        latest: this.tsLatest,
        signingIn: Boolean(this.tsLogin),
        authUrl: this.tsLogin ? this.tsLogin.authUrl : null,
        keysPage: tailscaleLib.KEYS_PAGE,
        machinesPage: tailscaleLib.MACHINES_PAGE,
      },
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
      // Tailscale status is cheap; check it often only while it matters.
      const tsMatters = this.cfg.connectionMode === 'tailscale' || this.tsLogin;
      if (this.tick++ % (tsMatters ? 1 : 5) === 0) await this.refreshTailscale();
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
      const status = await client.status();
      const session = status.session || null;
      // Only trust well-formed suggestions and real Discord links from the network.
      const sug = status.suggestion && status.suggestion.rom && typeof status.suggestion.rom.sha256 === 'string'
        ? status.suggestion : null;
      const m = this.buddyManifest;
      this.setBuddy({
        status: 'online',
        nickname: m.nickname || 'Buddy',
        platform: m.platform,
        retroarchVersion: m.retroarch_version,
        romCount: m.roms.length,
        session,
        suggestion: sug,
        discordUrl: config.isDiscordUrl(status.discord_url) ? status.discord_url : null,
      });
      if (sug && !(before.suggestion && before.suggestion.id === sug.id)) {
        this.emit('suggestion', sug);
        this.log(`${sug.from} suggests playing ${sug.rom.path}`);
      }
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

  // ----- controllers ----------------------------------------------------------

  /** The window reports the controllers it can see (browser Gamepad API). */
  async reportPads(list) {
    const pads = (Array.isArray(list) ? list : []).slice(0, 8)
      .map((g) => ({ index: Number(g.index) || 0, ...raSetup.classifyController(String(g.id || ''), String(g.mapping || '')) }));
    this.livePads = pads;
    if (pads.length) {
      // Remember them, so Host/Join still know your controller even if the
      // window hasn't seen a button press since it opened.
      this.padData.known = pads.map(({ index, ...p }) => p);
      this.savePadData();
    }
    return this.refreshControllers();
  }

  savePadData() {
    try {
      require('fs').mkdirSync(this.dataDir, { recursive: true });
      require('fs').writeFileSync(this.padsFile, JSON.stringify(this.padData, null, 2));
    } catch (err) {
      this.log(`Couldn't save controller info: ${err.message}`, 'warn');
    }
  }

  currentPads() {
    return this.livePads.length ? this.livePads : this.padData.known;
  }

  /** Work out the driver and check/create a RetroArch profile for each controller. */
  async refreshControllers() {
    const ra = config.retroarchCmd(this.cfg);
    const pads = this.currentPads();
    const driver = raSetup.chooseDriver(pads);
    const cfgValues = await raSetup.readSettings(raSetup.configPath(ra));
    const dir = raSetup.autoconfigDir(ra, cfgValues);
    let report = [];
    try {
      report = await raSetup.ensureProfiles(pads, driver, dir, { write: ra.length > 0 });
    } catch (err) {
      this.log(`Couldn't check controller profiles: ${err.message}`, 'warn');
      report = pads.map((p) => ({ ...p, profile: { status: 'unknown' } }));
    }
    for (const r of report) {
      const before = this.ctrl && this.ctrl.pads.find((p) => p.key === r.key);
      if (r.profile.status === 'created' && !(before && before.profile.status === 'created')) {
        this.log(`Created a RetroArch controller profile for ${r.name}`);
      }
    }
    this.ctrl = { live: this.livePads.length > 0, driver, autoconfigDir: dir, pads: report, assign: this.padData.assign };
    this.emitState();
    return this.ctrl;
  }

  /** Put a controller on a player number for local play (null = automatic). */
  async assignPad(key, player) {
    const assign = { ...this.padData.assign };
    for (const k of Object.keys(assign)) if (assign[k] === player) delete assign[k];
    if (player) assign[key] = player; else delete assign[key];
    this.padData.assign = assign;
    this.savePadData();
    return this.refreshControllers();
  }

  /** Extra RetroArch settings for this launch: controller driver, players, netplay slot. */
  async launchOverrides(netplaySlot) {
    let report = this.ctrl;
    try { report = await this.refreshControllers(); } catch { /* use what we have */ }
    const out = { input_autodetect_enable: 'true', ...raSetup.netplaySlotSettings(netplaySlot) };
    if (report && report.driver) out.input_joypad_driver = report.driver;
    if (report && Object.keys(this.padData.assign).length) Object.assign(out, raSetup.reservationSettings(report.pads, this.padData.assign));
    return out;
  }

  // ----- suggestions & Discord ------------------------------------------------

  /** Tell your buddy "let's play this". Shows up as a banner in their app. */
  async suggest(sha256) {
    const local = await this.library.manifest();
    let rom = local.roms.find((r) => r.sha256 === sha256);
    if (!rom && this.buddyManifest) rom = this.buddyManifest.roms.find((r) => r.sha256 === sha256);
    if (!rom) throw new Error('That game isn\'t in either library anymore');
    if (!this.cfg.sharedSecret) throw new Error('Set up a shared secret first (Settings)');
    const suggestion = {
      id: `${Date.now()}-${++this.suggestionSeq}`,
      rom: { path: rom.path, sha256: rom.sha256, size: rom.size },
      from: this.cfg.nickname,
      at: Date.now(),
    };
    this.mySuggestion = suggestion;
    // Your buddy reads suggestions from your server, so make sure it's running
    // even if "share my library" is off.
    if (!this.server) await this.restartServer();
    if (!this.server) {
      this.mySuggestion = null;
      throw new Error(`Can't send the suggestion: ${this.serverError}`);
    }
    this.server.suggestion = suggestion;
    this.log(`Suggested ${rom.path} to ${this.buddy.nickname || 'your buddy'}`);
    this.emitState();
    return this.mySuggestion;
  }

  clearSuggestion() {
    const had = this.mySuggestion;
    if (this.server) this.server.suggestion = null;
    this.mySuggestion = null;
    // Stop a server that only ran for the suggestion.
    if (had && this.server && !this.cfg.shareLibrary && !this.hosting) this.restartServer().then(() => this.emitState());
    this.emitState();
  }

  /** Your Discord link, or your buddy's if you haven't set one. */
  discordLink() {
    if (this.cfg.discordUrl) return { url: this.cfg.discordUrl, from: 'you' };
    if (this.buddy && this.buddy.discordUrl) return { url: this.buddy.discordUrl, from: this.buddy.nickname };
    return null;
  }

  // ----- app updates ----------------------------------------------------------

  updateFeed() {
    return this.cfg.updateFeedUrl || this.updateFeedDefault || '';
  }

  async checkForUpdates() {
    this.update = { ...(this.update || {}), checking: true };
    this.emitState();
    try {
      this.update = await updater.checkForUpdate({ feedUrl: this.updateFeed(), currentVersion: this.version, fetchImpl: this.fetchImpl });
      if (this.update.available) this.log(`RetroConnect ${this.update.latest} is available`);
    } catch (err) {
      this.update = { configured: true, error: err.message, checkedAt: Date.now() };
      throw err;
    } finally {
      this.emitState();
    }
    return this.update;
  }

  // ----- RetroArch setup assistant -------------------------------------------

  async retroarchSetupInfo() {
    const file = raSetup.configPath(config.retroarchCmd(this.cfg));
    const current = await raSetup.readSettings(file);
    const installed = new Set((await this.library.scanCores()).map((c) => c.name));
    return {
      configFile: file,
      configExists: Object.keys(current).length > 0,
      current: Object.fromEntries(Object.keys(raSetup.recommendedSettings({ controllerKind: 'xbox' }))
        .map((k) => [k, current[k] ?? null])),
      systems: raSetup.SYSTEMS.map((s) => ({ ...s, installed: installed.has(s.core) })),
    };
  }

  assertRetroArchClosed() {
    if (this.hosting || this.playing) throw new Error('Close RetroArch (finish your game) first');
  }

  async applyRetroArchSettings(opts = {}) {
    this.assertRetroArchClosed();
    const report = await this.refreshControllers();
    // The detected controllers decide the driver and player slots.
    const changes = {
      ...raSetup.recommendedSettings({ ...opts, controllerKind: null }),
      ...(report.driver ? { input_joypad_driver: report.driver } : {}),
      ...(Object.keys(this.padData.assign).length ? raSetup.reservationSettings(report.pads, this.padData.assign) : {}),
    };
    const file = raSetup.configPath(config.retroarchCmd(this.cfg));
    const r = await raSetup.applySettings(file, changes);
    this.log(`Updated RetroArch settings (${Object.keys(changes).length} changes) in ${file}`);
    return r;
  }

  async installCores(coreNames) {
    return this.withBusy('Installing cores', () => this._installCores(coreNames));
  }

  async _installCores(coreNames) {
    const fetchCore = this.fetchCore || fetchCoreFromBuildbot;
    const installed = new Set((await this.library.scanCores()).map((c) => c.name));
    const todo = [...new Set(coreNames)].filter((n) => !installed.has(n));
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      this.progress({ label: `Installing cores (${i + 1} of ${todo.length})`, done: i, total: todo.length, percent: false, count: true });
      try {
        await fetchCore(todo[i], this.library.coresDir, (m) => this.log(m));
      } catch (err) {
        failed.push(todo[i]);
        this.log(`${todo[i]}: ${err.message}`, 'warn');
      }
    }
    this.progress({ label: 'Installing cores', done: todo.length, total: todo.length || 1, count: true });
    this.log(todo.length ? `Installed ${todo.length - failed.length} core(s)` : 'Those cores were already installed');
    if (failed.length) throw new Error(`Couldn't install: ${failed.join(', ')}. Try again, or use RetroArch's Online Updater.`);
    return { installed: todo.length - failed.length };
  }

  /** The big button: RetroArch (if missing) + cores + settings. */
  async setUpEverything({ cores = [], settings = {} } = {}) {
    this.assertRetroArchClosed();
    if (!config.retroarchCmd(this.cfg).length) {
      if (!this.raLatest) await this.checkRetroArchLatest();
      await this.installRetroArch();
    }
    if (cores.length) await this.installCores(cores);
    await this.applyRetroArchSettings(settings);
    this.log('RetroArch is set up. Click "Test RetroArch" to try your controller.');
    return this.retroarchSetupInfo();
  }

  /** Open RetroArch's menu on its own, e.g. to check the controller is detected. */
  openRetroArch() {
    this.assertRetroArchClosed();
    const ra = config.retroarchCmd(this.cfg);
    if (!ra.length) throw new Error('Install RetroArch first');
    const { spawn } = require('child_process');
    const child = spawn(ra[0], ra.slice(1), { detached: true, stdio: 'ignore' });
    child.on('error', (err) => this.log(`Couldn't start RetroArch: ${err.message}`, 'error'));
    child.unref();
  }

  // ----- Tailscale ------------------------------------------------------------

  async refreshTailscale() {
    let next;
    try { next = await this.tailscale.status(); } catch (err) { next = { installed: false, state: 'Unknown', peers: [], error: err.message }; }
    const changed = JSON.stringify(next) !== JSON.stringify(this.ts);
    this.ts = next;
    if (changed) this.emitState();
    return next;
  }

  async checkTailscaleLatest() {
    this.tsLatest = await this.tailscale.latestInstaller();
    this.emitState();
    return this.tsLatest;
  }

  async installTailscale() {
    return this.withBusy('Installing Tailscale', async () => {
      const result = await this.tailscale.install({
        release: this.tsLatest,
        onProgress: (p) => this.progress(p),
        log: (m) => this.log(m),
      });
      // The service takes a moment to come up after install.
      for (let i = 0; i < 10; i++) {
        const st = await this.refreshTailscale();
        if (st.installed && st.state !== 'NotRunning') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.cfg.connectionMode !== 'tailscale') await this.saveSettings({ connectionMode: 'tailscale' });
      return result;
    });
  }

  /** Sign in (browser) or join with a key. Resolves once connected. */
  async loginTailscale({ authKey = null } = {}) {
    if (this.tsLogin) {
      if (this.tsLogin.authUrl && !authKey) this.emit('openUrl', this.tsLogin.authUrl);
      throw new Error('Already signing in. Finish in your browser, or cancel first.');
    }
    if (authKey && !/^tskey-/.test(authKey.trim())) {
      throw new Error('That doesn\'t look like a Tailscale key (they start with "tskey-")');
    }
    this.tsLogin = { child: null, authUrl: null };
    this.log(authKey ? 'Joining your buddy\'s Tailscale network with their key' : 'Opening Tailscale sign-in in your browser');
    this.emitState();
    try {
      await this.tailscale.login(undefined, {
        authKey,
        onStart: (child) => { if (this.tsLogin) this.tsLogin.child = child; },
        onAuthUrl: (url) => {
          if (this.tsLogin) this.tsLogin.authUrl = url;
          this.emit('openUrl', url);
          this.emitState();
        },
      });
    } finally {
      this.tsLogin = null;
      await this.refreshTailscale();
      this.emitState(); // signingIn changed even if Tailscale's own status didn't
    }
    if (this.cfg.connectionMode !== 'tailscale') await this.saveSettings({ connectionMode: 'tailscale' });
    const me = this.ts.self;
    this.log(`Connected to Tailscale${me ? ` as ${me.name} (${me.ip})` : ''}`);
    return this.state();
  }

  cancelTailscaleLogin() {
    if (this.tsLogin && this.tsLogin.child) this.tsLogin.child.kill();
  }

  async startTailscale() {
    this.tailscale.startApp();
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await this.refreshTailscale()).state !== 'NotRunning') break;
    }
    return this.state();
  }

  async useTailscalePeer(ip) {
    const peer = (this.ts.peers || []).find((p) => p.ip === ip);
    if (!peer) throw new Error('That device is no longer on your Tailscale network');
    await this.saveSettings({ peerAddress: peer.ip, connectionMode: 'tailscale' });
    this.log(`Your buddy is ${peer.name} (${peer.ip})`);
    return this.state();
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

    this.clearSuggestion(); // you're playing now; no need to keep suggesting
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
      host_player: this.cfg.hostPlayer, // which netplay player the host takes
      rom,
      core,
      started_at: Date.now(),
    };
    this.log(`Hosting ${rom.path} with ${coreName}`);
    this.emitState();

    const overrides = await this.launchOverrides(this.cfg.hostPlayer);
    const done = this.launch(this.cfg, 'host', this.library.corePath(core), this.library.romPath(rom), { overrides },
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
      // The guest takes whichever player the host didn't (old hosts: no preference).
      const hostPlayer = Number(session.host_player);
      const slot = hostPlayer === 1 ? 2 : hostPlayer === 2 ? 1 : null;
      const overrides = await this.launchOverrides(slot);
      this.launch(cfg, 'guest', result.corePath, result.romPath,
        { connectTo: this.cfg.peerAddress, port: session.netplay_port, overrides })
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
