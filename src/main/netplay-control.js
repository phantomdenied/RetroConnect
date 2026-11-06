'use strict';
// Talk to a running RetroArch during netplay:
//   - follow its log file to know who is playing as which player
//     ("You have joined as player 2", "Sam has joined as player 1", ...);
//   - send it network commands (UDP on localhost), e.g. NETPLAY_GAME_WATCH,
//     which switches between playing and watching.
//
// That is enough to swap players mid-game: everyone steps out, and RetroArch
// gives each player who steps back in the lowest free port, so whoever steps
// in first becomes Player 1. (This only works when nobody asks RetroArch for
// a fixed port with netplay_request_device_pN, so RetroConnect doesn't.)

const fs = require('fs');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const DEFAULT_CMD_PORT = 55355;

/** Parse one RetroArch log line into a netplay event, or null. */
function parseLine(line) {
  const s = String(line);
  let m = /\[Netplay\] You have joined as player (\d+)/i.exec(s);
  if (m) return { who: 'me', port: Number(m[1]) };
  if (/\[Netplay\] You have (left the game|joined as a spectator)/i.test(s)) return { who: 'me', port: null };
  m = /\[Netplay\] (.+?) has joined as player (\d+)/i.exec(s);
  if (m) return { who: m[1], port: Number(m[2]) };
  m = /\[Netplay\] (?:Player )?(.+?) has (?:left the game|joined as a spectator|disconnected)/i.exec(s);
  if (m) return { who: m[1], port: null };
  return null;
}

class NetplayLog extends EventEmitter {
  constructor(file, { pollMs = 250 } = {}) {
    super();
    this.file = file;
    this.pollMs = pollMs;
    this.offset = 0;
    this.rest = '';
    this.me = null; // my player port, or null while watching
    this.others = new Map(); // nickname -> port (null = watching)
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref(); // never keeps the app (or a test run) alive on its own
  }

  poll() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.rest = ''; } // file restarted
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      this.feed(buf.toString('utf8'));
    } catch { /* not created yet */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  feed(text) {
    const lines = (this.rest + text).split(/\r?\n/);
    this.rest = lines.pop();
    let changed = false;
    for (const line of lines) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (ev.who === 'me') this.me = ev.port;
      else this.others.set(ev.who, ev.port);
      changed = true;
    }
    if (changed) this.emit('change', this.snapshot());
  }

  snapshot() {
    return { me: this.me, others: Object.fromEntries(this.others) };
  }

  /** Port the other player (anyone but me) holds, or null if they're watching. */
  otherPort() {
    for (const port of this.others.values()) if (port) return port;
    return null;
  }

  /** Resolve once pred(snapshot) is true; reject after timeoutMs. */
  waitFor(pred, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        this.poll();
        const snap = this.snapshot();
        if (pred(snap)) { cleanup(); resolve(snap); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('RetroArch didn\'t respond in time')); }, timeoutMs);
      const iv = setInterval(check, this.pollMs);
      timer.unref();
      iv.unref();
      const cleanup = () => { clearTimeout(timer); clearInterval(iv); this.off('closed', onClosed); };
      const onClosed = () => { cleanup(); reject(new Error('The game ended')); };
      this.once('closed', onClosed);
      check();
    });
  }

  close() { clearInterval(this.timer); this.emit('closed'); }
}

/** Send a network command to the RetroArch on this PC. */
function sendCommand(text, port = DEFAULT_CMD_PORT) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.send(`${text}\n`, port, '127.0.0.1', (err) => { sock.close(); if (err) reject(err); else resolve(); });
  });
}

/**
 * Make sure this RetroArch is playing (want = true) or watching (false).
 * NETPLAY_GAME_WATCH toggles, so only send it when the state differs.
 */
async function setPlaying(log, want, { send = sendCommand, cmdPort = DEFAULT_CMD_PORT, timeoutMs = 15000 } = {}) {
  log.poll();
  if (Boolean(log.me) === want) return log.snapshot();
  await send('NETPLAY_GAME_WATCH', cmdPort);
  return log.waitFor((s) => Boolean(s.me) === want, timeoutMs);
}

module.exports = { parseLine, NetplayLog, sendCommand, setPlaying, DEFAULT_CMD_PORT };
