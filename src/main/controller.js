'use strict';
// App state and actions, independent of Electron so it can be tested.
//
// Every RetroConnect app runs a sync server (while "share my library" is on)
// and polls the buddy's server. Either player can host; the other sees the
// invite appear and clicks Join.

const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const platforms = require('./platforms');
const launcher = require('./launcher');
const { Library, retroarchVersion, clearVersionCache } = require('./library');
const raInstaller = require('./retroarch-installer');
const tailscaleLib = require('./tailscale');
const updater = require('./updater');
const invite = require('./invite');
const raSetup = require('./retroarch-setup');
const { fetchCoreFromBuildbot, HttpError } = require('./sync');
const netcheck = require('./netcheck');
const savesLib = require('./saves');
const { ThumbCache } = require('./thumbnails');
const gameinfo = require('./gameinfo');
const systems = require('./systems');
const netplayControl = require('./netplay-control');
const { backupExisting } = require('./sync');
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

// Services that answer with the caller's public IPv4 address as plain text.
const PUBLIC_IP_URLS = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
const PUBLIC_IP_TTL_MS = 10 * 60e3;

/** This PC's internet (public) IPv4 address, as the outside world sees it. */
async function lookupPublicIp(fetchImpl, urls = PUBLIC_IP_URLS) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((n) => Number(n) <= 255)) return ip;
      throw new Error('unexpected answer');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Couldn't look up your internet address (${lastErr ? lastErr.message : 'no service'}). Are you online?`);
}

class Controller extends EventEmitter {
  constructor({
    dataDir, version = '0', pollMs = POLL_MS, launch = launcher.run, fetchCore,
    retroarchDir = path.join(dataDir, 'RetroArch'), installer = raInstaller,
    tailscale = tailscaleLib,
    updateFeedDefault = '', githubRepo = '', selfUpdate = false, fetchImpl = globalThis.fetch, resizeImage = null,
    netplaySend = netplayControl.sendCommand,
  } = {}) {
    super();
    this.dataDir = dataDir;
    this.configFile = path.join(dataDir, 'config.json');
    this.cacheFile = path.join(dataDir, 'hash-cache.json');
    this.version = version;
    this.pollMs = pollMs;
    this.launch = launch;
    this.fetchCore = fetchCore;
    this.netplaySend = netplaySend; // RetroArch network commands (swap players)
    this.netplay = null; // NetplayLog of the running game
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
    this.githubRepo = githubRepo;
    this.selfUpdate = selfUpdate; // installed copy (not portable, not dev): can run the new installer
    this.fetchImpl = fetchImpl;
    this.update = null; // result of the last update check
    this.suggestionSeq = 0;
    this.padsFile = path.join(dataDir, 'controllers.json');
    this.livePads = []; // controllers the window can see right now
    this.padData = { known: [], assign: {} }; // last seen controllers + player assignments
    this.ctrl = null; // driver + per-controller profile status
    this.connCheck = null; // last connection check result
    this.testListener = null; // short-lived listener on our netplay port
    this.compat = null; // "will joining this session work?" summary
    this.rtt = []; // recent round-trip times to the buddy (ms), from polling
    this.thumbs = new ThumbCache(path.join(dataDir, 'thumbs'), { fetchImpl, resize: resizeImage });
    this.gameInfo = new gameinfo.GameInfoDb(path.join(dataDir, 'gameinfo'), { fetchImpl });
    this.historyFile = path.join(dataDir, 'history.json');
    this.history = { favorites: [], plays: [] };
  }

  // ----- lifecycle -----------------------------------------------------------

  async init() {
    this.cfg = config.load(this.configFile);
    try { this.padData = { known: [], assign: {}, ...JSON.parse(require('fs').readFileSync(this.padsFile, 'utf8')) }; } catch { /* first run */ }
    try { this.history = { favorites: [], plays: [], ...JSON.parse(require('fs').readFileSync(this.historyFile, 'utf8')) }; } catch { /* first run */ }
    await this.applyConfig();
    this.startPolling();
    return this.state();
  }

  async dispose() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.testListener) this.testListener.close();
    if (this.tsLogin && this.tsLogin.child) this.tsLogin.child.kill();
    if (this.hosting && this.hosting.child) this.hosting.child.kill();
    this.stopNetplayLog();
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
      server.versions = { app: this.version, retroarch: this.raVersion };
      server.onNetplayProbe = () => this.openNetplayProbe();
      server.onSwapPoll = (request) => this.onSwapPoll(request);
      server.onRequest = (_url, addr) => this.noteBuddyAddress(addr);
      server.onProbeBack = (addr, port) => netcheck.tcpReachable(addr, port);
      server.onSaveLookup = (sha) => this.lookupSave(sha);
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
      netplay: this.netplayState(),
      busy: this.busy,
      update: this.update,
      selfUpdate: this.selfUpdate,
      updateFeed: this.updateFeed(),
      discord: this.discordLink(),
      mySuggestion: this.mySuggestion || null,
      controllers: this.ctrl,
      connCheck: this.connCheck,
      portCheck: this.portCheck || null,
      lag: this.lagInfo(),
      compat: this.compat,
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
      const t0 = Date.now();
      const status = await client.status();
      const lagBefore = JSON.stringify(this.lagInfo());
      this.rtt.push(Date.now() - t0);
      if (this.rtt.length > 10) this.rtt.shift();
      const lagAfter = this.lagInfo();
      // Tell the window when the recommendation changes (not on every ms of ping).
      if (JSON.stringify({ ...lagAfter, ping: null }) !== JSON.stringify({ ...JSON.parse(lagBefore), ping: null })) this.emitState();
      const session = status.session || null;
      // Only trust well-formed suggestions and real Discord links from the network.
      const sug = status.suggestion && status.suggestion.rom && typeof status.suggestion.rom.sha256 === 'string'
        ? status.suggestion : null;
      const m = this.buddyManifest;
      this.setBuddy({
        status: 'online',
        nickname: m.nickname || 'Buddy',
        platform: m.platform,
        romCount: m.roms.length,
        appVersion: status.app_version || null,
        retroarchVersion: status.retroarch_version || m.retroarch_version,
        session,
        suggestion: sug,
        discordUrl: config.isDiscordUrl(status.discord_url) ? status.discord_url : null,
      });
      if (sug && !(before.suggestion && before.suggestion.id === sug.id)) {
        this.emit('suggestion', sug);
        this.log(`${sug.from} suggests playing ${sug.rom.path}`);
      }
      if (session && !(this.compat && this.compat.startedAt === session.started_at)) {
        this.compat = await this.joinCompat(session);
        this.emitState();
      } else if (!session && this.compat) {
        this.compat = null;
        this.emitState();
      }
      if (session && !(before.session && before.session.started_at === session.started_at)) {
        this.emit('invite', session);
        this.log(`${session.host_nickname} is hosting ${session.rom.path}`);
      }
    } catch (err) {
      this.buddyManifest = null;
      this.rtt = [];
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
    const favs = new Set(this.history.favorites);
    const stats = this.playStats();
    const rows = compare(local, this.buddyManifest).map((row) => {
      const coreName = config.coreForRom(this.cfg, row.path);
      const sha = (row.mine || row.theirs).sha256;
      const st = stats.get(sha);
      const entry = row.mine || row.theirs;
      const info = this.gameInfo.lookup(row.path, entry.crc32);
      return {
        ...row,
        sha,
        coreName,
        system: gameinfo.systemLabel(row.path),
        systemShort: systems.shortSystemForRom(row.path),
        languages: gameinfo.languagesOf(row.path),
        kind: gameinfo.kindOf(row.path),
        players: info.players,
        genre: info.genre,
        coreInstalled: Boolean(coreName && local.cores.some((c) => c.name === coreName)),
        thumb: this.cfg.showBoxArt && this.thumbs.has(sha),
        favorite: favs.has(sha),
        lastPlayed: st ? st.last : null,
        playCount: st ? st.count : 0,
        minutesPlayed: st ? st.minutes : 0,
      };
    });
    // Player counts and genres: fetch each system's data once in the background;
    // 'gameinfo' makes the window reload the list when it arrives.
    for (const sys of new Set(rows.map((r) => this.gameInfo.lookup(r.path).system).filter(Boolean))) {
      this.gameInfo.ensure(sys).then((fresh) => { if (fresh) this.emit('gameinfo', sys); });
    }
    if (this.cfg.showBoxArt) {
      // Fetch missing covers in the background; the window refreshes as they arrive.
      for (const r of rows) {
        if (!r.thumb) this.thumbs.ensure(r.sha, r.path).then((ok) => { if (ok) this.emit('thumb', r.sha); });
      }
    }
    return { rows, cores: local.cores, buddyOnline: Boolean(this.buddyManifest), romsDir: this.cfg.romsDir };
  }

  /** { address, at } of this PC's internet address; cached for a few minutes. */
  async publicAddress({ refresh = false } = {}) {
    const c = this.publicIpCache;
    if (!refresh && c && Date.now() - c.at < PUBLIC_IP_TTL_MS) return c;
    this.publicIpCache = { address: await lookupPublicIp(this.fetchImpl), at: Date.now() };
    return this.publicIpCache;
  }

  thumbFile(sha) {
    return /^[0-9a-f]{64}$/.test(sha) && this.thumbs.has(sha) ? this.thumbs.file(sha) : null;
  }

  // ----- favorites & play history ---------------------------------------------

  saveHistory() {
    try {
      require('fs').mkdirSync(this.dataDir, { recursive: true });
      require('fs').writeFileSync(this.historyFile, JSON.stringify(this.history));
    } catch (err) {
      this.log(`Couldn't save play history: ${err.message}`, 'warn');
    }
  }

  toggleFavorite(sha) {
    const favs = new Set(this.history.favorites);
    if (favs.has(sha)) favs.delete(sha); else favs.add(sha);
    this.history.favorites = [...favs];
    this.saveHistory();
    return favs.has(sha);
  }

  startPlay(rom, role, withWhom) {
    const entry = { sha: rom.sha256, path: rom.path, role, with: withWhom || null, at: Date.now(), minutes: 0 };
    this.history.plays.push(entry);
    if (this.history.plays.length > 500) this.history.plays.splice(0, this.history.plays.length - 500);
    this.saveHistory();
    return entry;
  }

  endPlay(entry) {
    entry.minutes = Math.max(0, Math.round((Date.now() - entry.at) / 60000));
    this.saveHistory();
  }

  playStats() {
    const m = new Map();
    for (const p of this.history.plays) {
      const s = m.get(p.sha) || { last: 0, count: 0, minutes: 0 };
      s.last = Math.max(s.last, p.at);
      s.count += 1;
      s.minutes += p.minutes || 0;
      m.set(p.sha, s);
    }
    return m;
  }

  // ----- lag smoothing ----------------------------------------------------------

  currentPing() {
    if (this.rtt.length >= 3) {
      const sorted = [...this.rtt].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    return this.connCheck && this.connCheck.ping ? this.connCheck.ping.median : null;
  }

  /**
   * Netplay input delay. RetroArch hides lag by rolling back; a frame or two of
   * input delay (netplay_input_latency_frames_min) means fewer rollbacks and
   * less stutter, at the cost of slightly later inputs. The range lets
   * RetroArch add up to that many more frames when the connection gets worse.
   */
  lagInfo() {
    const ping = this.currentPing();
    const auto = this.cfg.lagFrames < 0;
    let frames = auto ? Controller.recommendFrames(ping) : this.cfg.lagFrames;
    const range = frames === null ? null : auto ? (frames > 0 ? 2 : 0) : 0;
    return { auto, frames, range, ping };
  }

  static recommendFrames(pingMs) {
    if (pingMs === null || pingMs === undefined) return null;
    if (pingMs < 30) return 0;
    if (pingMs < 70) return 1;
    if (pingMs < 120) return 2;
    if (pingMs < 180) return 3;
    return 4;
  }

  // ----- shared saves -----------------------------------------------------------

  saveContext() {
    const ra = config.retroarchCmd(this.cfg);
    return { ra, cfgFile: raSetup.configPath(ra) };
  }

  async saveRoot() {
    const { ra, cfgFile } = this.saveContext();
    return savesLib.savesRoot(ra, await raSetup.readSettings(cfgFile));
  }

  /** Buddy asks about our save for a game. */
  async lookupSave(romSha) {
    if (!this.cfg.shareSaves) return null;
    const rom = await this.library.findRomBySha(romSha);
    if (!rom) return null;
    const save = await savesLib.findSave(this.library.romPath(rom), await this.saveRoot());
    return save ? { path: save.path, info: await savesLib.describe(save) } : null;
  }

  /** Before hosting: if the buddy has a newer save for this game, use theirs (ours is backed up). */
  async pullNewerSave(rom) {
    if (!this.cfg.shareSaves || this.buddy.status !== 'online') return null;
    const client = this.client();
    let theirs;
    try {
      theirs = await client.getJson(`/api/save/${rom.sha256}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null; // no save, or an older app
      throw err;
    }
    const romFull = this.library.romPath(rom);
    const root = await this.saveRoot();
    const mineRaw = await savesLib.findSave(romFull, root);
    const mine = await savesLib.describe(mineRaw);
    if (!savesLib.theirsIsNewer(mine, theirs)) return null;
    const dest = mineRaw ? mineRaw.path : savesLib.targetPath(romFull, root, theirs.rel);
    const part = `${dest}.part`;
    await require('fs').promises.mkdir(path.dirname(dest), { recursive: true });
    const res = await client.open(`/files/save/${rom.sha256}`);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const data = Buffer.concat(chunks);
    if (require('crypto').createHash('sha256').update(data).digest('hex') !== theirs.sha256) {
      throw new Error('Their save arrived corrupted; keeping yours');
    }
    await require('fs').promises.writeFile(part, data);
    const backup = await backupExisting(dest);
    await require('fs').promises.rename(part, dest);
    const who = this.buddy.nickname || 'your buddy';
    this.log(`Using ${who}'s newer save for ${rom.path} (saved ${savesLib.ageText(theirs.age_ms)})${backup ? `; yours was kept as ${path.basename(backup)}` : ''}`);
    return { dest, backup };
  }

  // ----- connection check & compatibility -------------------------------------

  /** Buddy asked to test our netplay port: listen on it briefly (RetroArch does while hosting). */
  async openNetplayProbe() {
    const port = this.cfg.netplayPort;
    if (this.hosting) return { listening: true, port, hosting: true };
    if (this.testListener) this.testListener.close();
    const l = await netcheck.openTestListener(port);
    this.testListener = l.listening ? l : null;
    return l.listening ? { listening: true, port } : { listening: false, port, error: l.error };
  }

  /**
   * Ping + both directions of the netplay port:
   *  toBuddy:   can you connect to their netplay port (needed when they host)?
   *  fromBuddy: can they connect to yours (needed when you host)?
   */
  async checkConnection() {
    if (this.connCheck && this.connCheck.running) throw new Error('Already checking');
    const client = this.client();
    this.connCheck = { running: true };
    this.emitState();
    const result = { running: false, at: Date.now(), relay: this.cfg.connectionMode === 'relay' };
    const oldVersion = 'Ask your buddy to update RetroConnect to test this.';
    try {
      result.ping = await netcheck.measurePing(client);
      if (!result.relay) {
        // You -> buddy
        try {
          const probe = await client.getJson('/api/netplay-probe');
          result.toBuddy = probe.listening
            ? await netcheck.tcpReachable(this.cfg.peerAddress, probe.port || this.cfg.netplayPort)
            : { reachable: false, error: `their side couldn't listen: ${probe.error}` };
          result.toBuddy.port = probe.port;
        } catch (err) {
          result.toBuddy = { reachable: false, error: err instanceof HttpError && err.status === 404 ? oldVersion : err.message };
        }
        // Buddy -> you
        let mine = null;
        if (!this.hosting) {
          mine = await netcheck.openTestListener(this.cfg.netplayPort);
          if (!mine.listening) result.fromBuddy = { reachable: false, error: `couldn't listen here: ${mine.error}` };
        }
        if (!result.fromBuddy) {
          try {
            result.fromBuddy = await client.getJson(`/api/probe-back?port=${this.cfg.netplayPort}`);
          } catch (err) {
            result.fromBuddy = { reachable: false, error: err instanceof HttpError && err.status === 404 ? oldVersion : err.message };
          }
        }
        if (mine && mine.close) mine.close();
        result.fromBuddy.port = this.cfg.netplayPort;
      }
      const p = result.ping;
      this.log(`Connection check: ${p.median} ms ping (${p.quality})${result.relay ? '' : `; join them: ${result.toBuddy.reachable ? 'ok' : 'blocked'}; they join you: ${result.fromBuddy.reachable ? 'ok' : 'blocked'}`}`);
    } catch (err) {
      result.error = err.message;
    }
    this.connCheck = result;
    this.emitState();
    if (result.error) throw new Error(result.error);
    return result;
  }

  /**
   * "Are my ports open from the internet?" for whoever hosts in Direct mode,
   * without needing the buddy: make sure something is listening on both ports,
   * then have an outside service try to connect to this PC's internet address.
   */
  async checkMyPorts() {
    if (this.portCheck && this.portCheck.running) throw new Error('Already checking');
    this.portCheck = { running: true };
    this.emitState();
    const result = { running: false, at: Date.now(), ports: [] };
    const temp = [];
    try {
      const { address } = await this.publicAddress();
      result.publicIp = address;
      const wanted = [
        { port: this.cfg.syncPort, purpose: 'file sync (RetroConnect)' },
        { port: this.cfg.netplayPort, purpose: 'netplay (RetroArch)' },
      ];
      for (const w of wanted) {
        // Already served: the sync server (while sharing/hosting) or RetroArch (while hosting).
        const busy = (w.port === this.cfg.syncPort && this.server) || (w.port === this.cfg.netplayPort && this.hosting);
        if (busy) { w.listening = true; continue; }
        const l = await netcheck.openTestListener(w.port, 40000);
        w.listening = l.listening;
        if (l.listening) temp.push(l); else w.error = l.error;
      }
      const open = await netcheck.checkPortsFromInternet(this.fetchImpl, address, wanted.map((w) => w.port));
      for (const w of wanted) result.ports.push({ ...w, open: Boolean(open[w.port]) });
      this.log(`Port check from the internet (${address}): ${result.ports.map((p) => `${p.port} ${p.open ? 'open' : 'closed'}`).join(', ')}`);
    } catch (err) {
      result.error = err.message;
    } finally {
      for (const l of temp) l.close();
    }
    this.portCheck = result;
    this.emitState();
    if (result.error) throw new Error(`Couldn't check your ports: ${result.error}`);
    return result;
  }

  /** Before joining: RetroArch/core/app versions on both sides. */
  async joinCompat(session) {
    const out = { startedAt: session.started_at, warnings: [] };
    const mine = this.raVersion;
    const theirs = session.retroarch_version;
    out.retroarch = { mine, theirs, match: !mine || !theirs || mine === theirs };
    if (!out.retroarch.match) {
      out.warnings.push({
        kind: 'retroarch',
        text: `Different RetroArch versions: ${session.host_nickname} has ${theirs}, you have ${mine}. Matching versions avoids desyncs.`,
        fix: platforms.osName() === 'windows' || process.env.RETROCONNECT_ALLOW_RA_INSTALL === '1' ? { action: 'match-retroarch', version: theirs } : null,
      });
    }
    try {
      if (session.platform === this.library.platformTag && session.core) {
        const local = await this.library.findCore(session.core.name);
        if (local && local.sha256 !== session.core.sha256) {
          out.warnings.push({ kind: 'core', text: `Your ${session.core.name.replace(/_libretro$/, '')} differs from theirs. Joining swaps in their copy (yours is kept as .old).` });
        }
      }
    } catch { /* core check is best-effort */ }
    const app = this.buddy && this.buddy.appVersion;
    if (app && app !== this.version) {
      out.warnings.push({ kind: 'app', text: `${session.host_nickname} is on RetroConnect ${app}, you're on ${this.version}. Newer features may only work once you both update.` });
    }
    return out;
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

  /**
   * Extra RetroArch settings for this launch: controller driver, players, and
   * what swapping players needs. No fixed netplay port is requested
   * (netplay_request_device_pN), because a request sticks: after a swap
   * RetroArch would put everyone back where they asked to be. Instead whoever
   * steps in first gets Player 1, so a host who wants to be Player 2 starts
   * out watching and steps in once their buddy has joined.
   */
  async launchOverrides({ startWatching = false } = {}) {
    let report = this.ctrl;
    try { report = await this.refreshControllers(); } catch { /* use what we have */ }
    const out = {
      input_autodetect_enable: 'true',
      ...raSetup.netplaySlotSettings(null),
      netplay_start_as_spectator: startWatching ? 'true' : 'false',
      network_cmd_enable: 'true', // NETPLAY_GAME_WATCH for swapping players (localhost UDP)
      network_cmd_port: String(netplayControl.DEFAULT_CMD_PORT),
      frontend_log_level: '1', // the log RetroConnect follows: INFO and up is enough
    };
    const lag = this.lagInfo();
    if (lag.frames !== null) {
      out.netplay_input_latency_frames_min = String(lag.frames);
      out.netplay_input_latency_frames_range = String(lag.range);
    }
    if (report && report.driver) out.input_joypad_driver = report.driver;
    if (report && Object.keys(this.padData.assign).length) Object.assign(out, raSetup.reservationSettings(report.pads, this.padData.assign));
    return out;
  }

  // ----- player numbers during a game (swap players) --------------------------
  //
  // Both apps follow their own RetroArch's log. The host runs a swap: everyone
  // steps out to watch, then whoever should be Player 1 steps back in first
  // (RetroArch gives the lowest free port). The guest's app follows the host's
  // instructions from GET /api/swap, and asks for a swap with ?request=1.

  startNetplayLog() {
    this.stopNetplayLog();
    const file = path.join(os.tmpdir(), `retroconnect-ra-${process.pid}-${Date.now()}.log`);
    this.netplay = new netplayControl.NetplayLog(file);
    this.netplay.on('change', (s) => {
      this.log(s.me ? `You're Player ${s.me}` : 'You\'re watching (not playing)');
      this.emitState();
    });
    return file;
  }

  stopNetplayLog() {
    if (!this.netplay) return;
    this.netplay.close();
    const file = this.netplay.file;
    this.netplay = null;
    clearInterval(this.swapFollowTimer);
    this.swapFollowTimer = null;
    setTimeout(() => require('fs').rm(file, { force: true }, () => {}), 2000);
  }

  setNetplayPlaying(want, opts = {}) {
    if (!this.netplay) throw new Error('No game running');
    return netplayControl.setPlaying(this.netplay, want, { send: this.netplaySend, ...opts });
  }

  /** What the UI shows: your player number and whether a swap is running. */
  netplayState() {
    if (!this.netplay || (!this.hosting && !this.playing)) return null;
    return { me: this.netplay.me, other: this.netplay.otherPort(), swapping: Boolean(this.swapRunning || this.swapAsked) };
  }

  /** Tell the guest's app to play or watch (it polls /api/swap). */
  publishGuest(mode) {
    this.swapState = { seq: (this.swapState ? this.swapState.seq : 0) + 1, guest: mode };
  }

  /** Swap Player 1 and Player 2. On the guest's side this asks the host to do it. */
  async swapPlayers() {
    if (this.playing && !this.hosting) {
      if (!this.netplay) throw new Error('No game running');
      this.swapAsked = true; // sent with the next /api/swap poll
      this.emitState();
      return { requested: true };
    }
    if (!this.hosting || !this.netplay) throw new Error('Start a game first');
    if (this.swapRunning) throw new Error('Already swapping players');
    const log = this.netplay;
    log.poll();
    if (![...log.others.keys()].length) throw new Error(`${this.buddy.nickname || 'Your buddy'} hasn't joined the game yet`);
    this.swapRunning = true;
    this.emitState();
    const othersOut = (s) => !Object.values(s.others).some(Boolean);
    try {
      const hostWasP1 = log.me === 1;
      // 1. Everyone steps out.
      this.publishGuest('spectate');
      await this.setNetplayPlaying(false);
      await log.waitFor(othersOut);
      // 2. The new Player 1 steps in first, then the other.
      if (hostWasP1) {
        this.publishGuest('play');
        await log.waitFor((s) => Object.values(s.others).includes(1));
        await this.setNetplayPlaying(true);
      } else {
        await this.setNetplayPlaying(true);
        this.publishGuest('play');
        await log.waitFor((s) => Object.values(s.others).some(Boolean));
      }
      this.log(`Swapped players: you're Player ${log.me} now`);
      return log.snapshot();
    } catch (err) {
      // Don't leave anyone stuck watching.
      this.publishGuest('play');
      try { await this.setNetplayPlaying(true, { timeoutMs: 5000 }); } catch { /* best effort */ }
      throw new Error(`Couldn't swap players: ${err.message}`);
    } finally {
      this.swapRunning = false;
      this.emitState();
    }
  }

  /** GET /api/swap from the guest's app: the current instruction, and maybe a swap request. */
  onSwapPoll(request) {
    if (!this.hosting) return { error: 'not hosting' };
    if (request && !this.swapRunning) {
      this.swapPlayers().catch((err) => this.log(err.message, 'warn'));
    }
    return { ...(this.swapState || { seq: 0, guest: 'play' }), swapping: Boolean(this.swapRunning) };
  }

  /** Guest: follow the host's play/watch instructions while the game runs. */
  followHostSwaps(client, intervalMs = 700) {
    clearInterval(this.swapFollowTimer);
    let lastSeq = 0;
    let busy = false;
    this.swapAsked = false;
    this.swapFollowTimer = setInterval(async () => {
      if (busy || !this.netplay) return;
      busy = true;
      try {
        const ask = this.swapAsked;
        const r = await client.getJson(`/api/swap${ask ? '?request=1' : ''}`);
        if (ask) { this.swapAsked = false; this.emitState(); }
        if (r && r.seq > lastSeq) {
          lastSeq = r.seq;
          await this.setNetplayPlaying(r.guest === 'play');
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // The host's app predates swapping players: stop asking.
          clearInterval(this.swapFollowTimer);
          if (this.swapAsked) this.log('Your buddy needs to update RetroConnect to swap players', 'warn');
          this.swapAsked = false;
          this.emitState();
        }
      } finally {
        busy = false;
      }
    }, intervalMs);
    this.swapFollowTimer.unref();
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

  // Where updates come from: a custom link from Settings, else the built-in
  // link, else the repo's GitHub Releases. Returns a label for the UI.
  updateFeed() {
    const url = this.cfg.updateFeedUrl || this.updateFeedDefault || '';
    if (url) return url;
    return updater.isGithubRepo(this.githubRepo) ? `github.com/${this.githubRepo}/releases` : '';
  }

  async checkForUpdates() {
    this.update = { ...(this.update || {}), checking: true };
    this.emitState();
    try {
      const before = this.update;
      this.update = await updater.checkForUpdate({ feedUrl: this.cfg.updateFeedUrl || this.updateFeedDefault || '', githubRepo: this.githubRepo, currentVersion: this.version, fetchImpl: this.fetchImpl });
      if (before && before.downloaded && before.latest === this.update.latest) this.update.downloaded = before.downloaded;
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
      systemDir: raSetup.systemDir(file, current),
      systems: await Promise.all(raSetup.SYSTEMS.map(async (s) => ({
        ...s,
        installed: installed.has(s.core),
        bios: s.bios ? await raSetup.biosStatus(raSetup.systemDir(file, current), s.bios) : null,
      }))),
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

  // ----- invites ---------------------------------------------------------------

  /** One code for the buddy: the shared secret, an optional Tailscale key, my address. */
  makeInvite({ tsKey = null } = {}) {
    const ts = this.ts || {};
    const address = this.cfg.connectionMode === 'tailscale' && ts.self && ts.self.ip ? ts.self.ip : null;
    if (tsKey && !address) throw new Error('Connect this PC to Tailscale first');
    return invite.makeInvite({ secret: this.cfg.sharedSecret, tsKey: tsKey || null, address, nickname: this.cfg.nickname });
  }

  /**
   * The buddy's side: apply an invite (plus any first-run settings). Saves the
   * secret and the inviter's address, then installs and joins Tailscale with
   * the key in it.
   */
  async redeemInvite(code, extra = {}) {
    const inv = invite.parseInvite(code);
    const partial = { ...extra, sharedSecret: inv.secret };
    if (inv.tsKey) partial.connectionMode = 'tailscale';
    if (inv.address) partial.peerAddress = inv.address;
    await this.saveSettings(partial);
    this.log(`Invite accepted${inv.nickname ? ` from ${inv.nickname}` : ''}`);
    if (inv.tsKey) {
      let ts = await this.refreshTailscale();
      if (!ts.installed) {
        const canInstall = platforms.osName() === 'windows' || process.env.RETROCONNECT_ALLOW_TS_INSTALL === '1';
        if (!canInstall) throw new Error('Install Tailscale from tailscale.com, then paste the invite again');
        if (!this.tsLatest) await this.checkTailscaleLatest();
        await this.installTailscale();
        ts = this.ts;
      }
      if (ts.state === 'NotRunning') { await this.startTailscale(); ts = this.ts; }
      // Already on the inviter's network (e.g. pasted twice)? Then the key isn't needed.
      const already = ts.state === 'Running' && inv.address && (ts.peers || []).some((p) => p.ip === inv.address);
      if (!already) await this.loginTailscale({ authKey: inv.tsKey });
      if (inv.address) await this.saveSettings({ peerAddress: inv.address, connectionMode: 'tailscale' });
    }
    this.pollBuddy().catch(() => {});
    return this.state();
  }

  /**
   * Inviter's side: the buddy's app just made a request with our shared secret,
   * so its address is the buddy's. Saved only while no address is set yet.
   */
  noteBuddyAddress(remote) {
    const addr = String(remote || '').replace(/^::ffff:/, '');
    if (!addr || this.cfg.peerAddress || this.notingBuddy || /^127\.|^::1$/.test(addr)) return;
    this.notingBuddy = true;
    this.saveSettings({ peerAddress: addr })
      .then(() => { this.log(`Your buddy connected from ${addr}. Saved as their address.`); return this.pollBuddy(); })
      .catch(() => {})
      .finally(() => { this.notingBuddy = false; });
  }

  // ----- installing updates -----------------------------------------------------

  /** Download the new installer (setup .exe) from the release. */
  async downloadUpdate() {
    const u = this.update;
    if (!u || !u.available) throw new Error('No update to download');
    if (!this.selfUpdate || !u.asset) {
      this.emit('openUrl', u.asset ? u.pageUrl : u.url);
      return this.update;
    }
    return this.withBusy('Downloading update', async () => {
      const dir = path.join(this.dataDir, 'updates');
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(dir, { recursive: true });
      const dest = path.join(dir, u.asset.name);
      await updater.downloadAsset(u.asset, dest, {
        fetchImpl: this.fetchImpl,
        onProgress: (p) => this.progress({ label: `Downloading RetroConnect ${u.latest}`, ...p }),
      });
      this.update = { ...this.update, downloaded: dest };
      this.log(`RetroConnect ${u.latest} downloaded. Restart to update.`);
      return this.update;
    });
  }

  /** Start the installer silently; it closes this app and opens the new one. */
  installUpdate({ spawnImpl = require('child_process').spawn } = {}) {
    const file = this.update && this.update.downloaded;
    if (!file || !fs.existsSync(file)) throw new Error('Download the update first');
    if (this.hosting || this.playing) throw new Error('Finish your game first, then restart to update');
    // NSIS: /S = no questions, --force-run = open RetroConnect again afterwards.
    const child = spawnImpl(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
    if (child && child.unref) child.unref();
    this.log(`Installing RetroConnect ${this.update.latest}. It reopens by itself in a few seconds.`);
    return true;
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

  /** Install the latest stable RetroArch, or a specific version (e.g. to match your buddy). */
  async installRetroArch(version = null) {
    if (this.hosting || this.playing) throw new Error('Close RetroArch (finish your game) before installing');
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Not a RetroArch version number');
    const release = version ? { version, url: raInstaller.archiveUrl(version) } : this.raLatest;
    return this.withBusy('Installing RetroArch', async () => {
      let result;
      try {
        result = await this.installer.install({
          installDir: this.retroarchDir,
          release,
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
      this.compat = null; // re-check version warnings against the new RetroArch
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
    let coreName = coreOverride || config.coreForRom(this.cfg, rom.path);
    if (!coreName) throw new Error(`No core is set for ${path.extname(rom.path)} files. Pick one in Settings → Cores.`);
    if (!coreName.endsWith('_libretro')) coreName += '_libretro';
    const core = await this.library.findCore(coreName);
    if (!core) {
      throw new Error(`${coreName} isn't installed. Get it in RetroArch → Online Updater → Core Downloader.`);
    }
    if (!this.cfg.sharedSecret) throw new Error('Set up a shared secret first (Settings)');

    this.clearSuggestion(); // you're playing now; no need to keep suggesting
    if (this.testListener) { this.testListener.close(); this.testListener = null; } // free the netplay port for RetroArch
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

    try {
      await this.pullNewerSave(rom);
    } catch (err) {
      this.log(`Couldn't check your buddy's save: ${err.message}`, 'warn');
    }
    const hostAsP2 = this.cfg.hostPlayer === 2;
    const overrides = await this.launchOverrides({ startWatching: hostAsP2 });
    const play = this.startPlay(rom, 'host', this.buddy.nickname);
    const logFile = this.startNetplayLog();
    this.swapState = { seq: 0, guest: 'play' };
    // "When I host, Player 1 is: my buddy": step in once they've taken Player 1.
    if (hostAsP2) {
      const log = this.netplay;
      log.waitFor((s) => Object.values(s.others).includes(1), 30 * 60e3)
        .then(() => (this.netplay === log ? this.setNetplayPlaying(true) : null))
        .catch(() => {});
    }
    const done = this.launch(this.cfg, 'host', this.library.corePath(core), this.library.romPath(rom), { overrides, logFile },
      { onSpawn: (child) => { if (this.hosting) this.hosting.child = child; } });
    done.catch((err) => this.log(err.message, 'error')).finally(async () => {
      this.stopNetplayLog();
      this.endPlay(play);
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
      // Player numbers: whoever is playing first gets Player 1. The host sets
      // that up (see host()), so the guest asks for no particular port.
      const overrides = await this.launchOverrides();
      const play = this.startPlay(session.rom, 'guest', session.host_nickname);
      const logFile = this.startNetplayLog();
      this.followHostSwaps(client);
      this.launch(cfg, 'guest', result.corePath, result.romPath,
        { connectTo: this.cfg.peerAddress, port: session.netplay_port, overrides, logFile })
        .catch((err) => this.log(err.message, 'error'))
        .finally(() => { this.stopNetplayLog(); this.endPlay(play); this.playing = null; this.emitState(); });
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

module.exports = { Controller, localAddresses, isTailscaleIp, lookupPublicIp };
