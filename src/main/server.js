'use strict';
// The sync server every RetroConnect app runs: it tells your buddy what
// you're playing and serves the exact core and ROM files so you both match.
//
// Endpoints (all require `Authorization: Bearer <sharedSecret>`):
//   GET /api/manifest          ROM + core library
//   GET /api/session           what's being hosted right now (404 if idle)
//   GET /api/status            { session, suggestion, discord_url, versions } in one poll
//   GET /api/netplay-probe     open a short-lived listener on our netplay port
//   GET /api/probe-back?port=N try to reach the caller's netplay port
//   GET /files/rom/<sha256>    a ROM, by content hash
//   GET /files/core/<sha256>   a core, by content hash
//
// Files are only looked up by hash from our own scan, so nobody can ask for
// arbitrary paths. `Range: bytes=N-` is honoured so downloads can resume.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const FILE_ROUTE = /^\/files\/(rom|core)\/([0-9a-f]{64})$/;
const RANGE = /^bytes=(\d+)-$/;

class SyncServer {
  constructor({ library, secret, host = '0.0.0.0', port = 55440, version = '0' }) {
    if (!secret) throw new Error('A shared secret is required to share your library');
    this.library = library;
    this.secret = secret;
    this.host = host;
    this.requestedPort = port;
    this.version = version;
    this.session = null;
    this.suggestion = null; // { id, rom, from, at }: "let's play this"
    this.discordUrl = '';
    this.versions = {}; // { app, retroarch }
    // Hooks the controller supplies for the connection check.
    this.onNetplayProbe = null; // () => Promise<{ listening, port, error? }>
    this.onProbeBack = null; // (address, port) => Promise<{ reachable, error? }>
    this.index = null; // Map "kind:sha" -> absolute path
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) this.json(res, 500, { error: String(err.message || err) });
        else res.destroy();
      });
    });
    this.onRequest = null; // optional hook for logging
  }

  get port() {
    const addr = this.server.address();
    return addr ? addr.port : null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => { this.server.off('listening', onListen); reject(err); };
      const onListen = () => { this.server.off('error', onError); resolve(this); };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(this.requestedPort, this.host);
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      if (this.server.closeAllConnections) this.server.closeAllConnections();
    });
  }

  async manifest() {
    const m = await this.library.manifest();
    const index = new Map();
    for (const r of m.roms) index.set(`rom:${r.sha256}`, this.library.romPath(r));
    for (const c of m.cores) index.set(`core:${c.sha256}`, this.library.corePath(c));
    this.index = index;
    return m;
  }

  authorized(req) {
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${this.secret}`);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Server': `RetroConnect/${this.version}`,
    });
    res.end(body);
  }

  async handle(req, res) {
    if (req.method !== 'GET') return this.json(res, 405, { error: 'method not allowed' });
    if (!this.authorized(req)) return this.json(res, 401, { error: 'bad or missing shared secret' });
    const url = req.url.split('?')[0];
    if (this.onRequest) this.onRequest(url, req.socket.remoteAddress);
    if (url === '/api/manifest') return this.json(res, 200, await this.manifest());
    if (url === '/api/status') {
      return this.json(res, 200, {
        session: this.session,
        suggestion: this.suggestion,
        discord_url: this.discordUrl || null,
        app_version: this.versions.app || null,
        retroarch_version: this.versions.retroarch || null,
      });
    }
    if (url === '/api/netplay-probe' && this.onNetplayProbe) {
      return this.json(res, 200, await this.onNetplayProbe());
    }
    if (url === '/api/probe-back' && this.onProbeBack) {
      const port = Number(new URL(req.url, 'http://x').searchParams.get('port'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return this.json(res, 400, { error: 'bad port' });
      // Only ever dials back the address that asked, never anywhere else.
      const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      return this.json(res, 200, await this.onProbeBack(addr, port));
    }
    if (url === '/api/session') {
      return this.session
        ? this.json(res, 200, this.session)
        : this.json(res, 404, { error: "not hosting a game" });
    }
    const m = FILE_ROUTE.exec(url);
    if (m) return this.sendFile(req, res, m[1], m[2]);
    return this.json(res, 404, { error: 'not found' });
  }

  async sendFile(req, res, kind, sha) {
    if (!this.index) await this.manifest();
    let file = this.index.get(`${kind}:${sha}`);
    if (!file) {
      await this.manifest(); // maybe added since the last scan
      file = this.index.get(`${kind}:${sha}`);
    }
    let st;
    try { st = file && (await fs.promises.stat(file)); } catch { st = null; }
    if (!st || !st.isFile()) return this.json(res, 404, { error: `that ${kind} isn't here` });

    const size = st.size;
    let start = 0;
    const range = RANGE.exec(String(req.headers.range || ''));
    if (range) {
      start = Number(range[1]);
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
        return res.end();
      }
    }
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size - start,
      'Accept-Ranges': 'bytes',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    const stream = fs.createReadStream(file, { start });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

module.exports = { SyncServer };
