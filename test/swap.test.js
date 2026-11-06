'use strict';
// Swap players mid-game, against a simulated RetroArch netplay session that
// follows the rules measured on RetroArch 1.22: whoever steps in to play gets
// the lowest free port, NETPLAY_GAME_WATCH toggles play/watch, and both sides
// log "You have joined as player N" / "<nick> has joined as player N" / ...
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Controller } = require('../src/main/controller');
const platforms = require('../src/main/platforms');
const np = require('../src/main/netplay-control');

test('log lines become player numbers', () => {
  assert.deepEqual(np.parseLine('[INFO] [Netplay] You have joined as player 2 (ping: 52 ms)'), { who: 'me', port: 2 });
  assert.deepEqual(np.parseLine('[INFO] [Netplay] You have left the game'), { who: 'me', port: null });
  assert.deepEqual(np.parseLine('[INFO] [Netplay] guest has joined as player 1 (ping: 10 ms)'), { who: 'guest', port: 1 });
  assert.deepEqual(np.parseLine('[INFO] [Netplay] Player guest has left the game'), { who: 'guest', port: null });
  assert.equal(np.parseLine('[INFO] [Netplay] Got connection from: "guest"'), null);
});

/** A fake netplay session shared by the host's and the guest's "RetroArch". */
function fakeNetplay() {
  const seats = { host: null, guest: null };
  const logs = {};
  const nick = { host: 'alex', guest: 'sam' };
  const write = (side, line) => fs.appendFileSync(logs[side], `[INFO] [Netplay] ${line}\n`);
  const other = (side) => (side === 'host' ? 'guest' : 'host');
  const play = (side) => {
    const taken = new Set(Object.values(seats));
    let p = 1;
    while (taken.has(p)) p++;
    seats[side] = p;
    write(side, `You have joined as player ${p}`);
    if (logs[other(side)]) write(other(side), `${nick[side]} has joined as player ${p}`);
  };
  const watch = (side) => {
    seats[side] = null;
    write(side, 'You have left the game');
    if (logs[other(side)]) write(other(side), `Player ${nick[side]} has left the game`);
  };
  return {
    seats,
    launch: (side) => (cfg, role, core, rom, opts) => {
      logs[side] = opts.logFile;
      fs.writeFileSync(opts.logFile, '');
      if (opts.overrides.netplay_start_as_spectator !== 'true') play(side);
      return new Promise(() => {}); // RetroArch keeps running
    },
    send: (side) => async (cmd) => {
      assert.equal(cmd, 'NETPLAY_GAME_WATCH');
      setTimeout(() => (seats[side] ? watch(side) : play(side)), 30); // RetroArch reacts a moment later
    },
  };
}

async function setup(t, hostPlayer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-swap-'));
  const port = 58000 + Math.floor(Math.random() * 900);
  const net = fakeNetplay();
  const mk = async (name, side, extra) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, launch: net.launch(side), netplaySend: net.send(side) });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: [path.join(root, 'retroarch.exe')], sharedSecret: 's', peerAddress: '127.0.0.1', syncPort: port, ...extra,
    });
    return c;
  };
  fs.mkdirSync(path.join(root, 'alex', 'roms'), { recursive: true });
  fs.mkdirSync(path.join(root, 'alex', 'cores'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alex', 'roms', 'Game.sfc'), 'game');
  fs.writeFileSync(path.join(root, 'alex', 'cores', platforms.coreFilename('snes9x_libretro')), 'core');
  const alex = await mk('alex', 'host', { hostPlayer });
  const sam = await mk('sam', 'guest', {});
  t.after(async () => { await alex.dispose(); await sam.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const until = async (pred, what) => {
    for (let i = 0; i < 300; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(() => sam.buddy.status === 'online', 'sam sees alex');
  const lib = await alex.getLibrary();
  await alex.host(lib.rows[0].mine.sha256);
  await until(() => sam.buddy.session, 'sam sees the session');
  await sam.join();
  return { alex, sam, net, until };
}

test('swap players: host is Player 1, swaps, then swaps back', async (t) => {
  const { alex, sam, net, until } = await setup(t, 1);
  await until(() => net.seats.host === 1 && net.seats.guest === 2, 'host P1, guest P2');
  await until(() => alex.state().netplay && alex.state().netplay.other === 2, 'host app sees guest as P2');

  await alex.swapPlayers();
  assert.deepEqual(net.seats, { host: 2, guest: 1 });
  assert.deepEqual([alex.state().netplay.me, alex.state().netplay.other], [2, 1]);

  await alex.swapPlayers();
  assert.deepEqual(net.seats, { host: 1, guest: 2 });
});

test('swap players: the guest asks, the host swaps', async (t) => {
  const { sam, net, until } = await setup(t, 1);
  await until(() => net.seats.guest === 2, 'guest joined');
  const r = await sam.swapPlayers();
  assert.equal(r.requested, true);
  await until(() => net.seats.guest === 1 && net.seats.host === 2, 'guest became Player 1');
  await until(() => sam.state().netplay.me === 1 && !sam.state().netplay.swapping, 'guest app shows Player 1');
});

test('"Player 1 is my buddy": host starts watching, steps in as Player 2', async (t) => {
  const { alex, net, until } = await setup(t, 2);
  await until(() => net.seats.guest === 1 && net.seats.host === 2, 'guest P1, host P2');
  await alex.swapPlayers();
  assert.deepEqual(net.seats, { host: 1, guest: 2 });
});

test('swapping before the buddy has joined says so', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = new Controller({ dataDir: root });
  await assert.rejects(c.swapPlayers(), /Start a game first/);
});
