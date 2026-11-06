'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gi = require('../src/main/gameinfo');

test('languages from No-Intro and GoodTools name tags', () => {
  assert.deepEqual(gi.languagesOf('SNES/Super Metroid (Japan, USA) (En,Ja).zip'), ['en', 'ja']);
  assert.deepEqual(gi.languagesOf('SNES/Secret of Mana (Germany).zip'), ['de']);
  assert.deepEqual(gi.languagesOf('SNES/Chrono Trigger (USA).zip'), ['en']);
  assert.deepEqual(gi.languagesOf('NES/Rockman (Japan).zip'), ['ja']);
  assert.deepEqual(gi.languagesOf('NES/Final Fantasy III (J) [T+Eng1.0].nes'), ['en']);
  assert.deepEqual(gi.languagesOf('Genesis/Sonic (UE) [!].bin'), ['en']);
  assert.deepEqual(gi.languagesOf('Genesis/Shadow Dancer - The Secret of Shinobi (World).zip'), ['en']);
  assert.deepEqual(gi.languagesOf('z/zelda3.sfc'), []);
});

test('hacks and homebrew from folder names and tags', () => {
  assert.equal(gi.kindOf('Nintendo - Super Nintendo Entertainment System - Hacks/Kaizo Mario.zip'), 'hack');
  assert.equal(gi.kindOf('NES/Super Mario Bros. (World) [h1].nes'), 'hack');
  assert.equal(gi.kindOf('NES/Final Fantasy III (J) [T+Eng1.0].nes'), 'hack');
  assert.equal(gi.kindOf('Nintendo - Nintendo Entertainment System - Homebrew/Micro Mages.zip'), 'homebrew');
  assert.equal(gi.kindOf('Genesis/Tanglewood (World) (Aftermarket) (Homebrew).zip'), 'homebrew');
  assert.equal(gi.kindOf('Nintendo - Nintendo Entertainment System/Contra (USA).zip'), 'official');
  assert.equal(gi.kindOf('NES/Bible Adventures (USA) (Unl).zip'), 'official');
});

test('system label for the filter', () => {
  assert.equal(gi.systemLabel('Nintendo - Super Famicom/x.zip'), 'Super Nintendo Entertainment System');
  assert.equal(gi.systemLabel('Sega - Mega Drive - Genesis - Hacks/x.zip'), 'Mega Drive - Genesis');
  assert.equal(gi.systemLabel('z/zelda3.sfc'), 'Super Nintendo Entertainment System');
  assert.equal(gi.systemLabel('loose/thing.zip'), 'ZIP');
});

const DAT = (field, value) => `clrmamepro (\n\tname "Nintendo - Super Nintendo Entertainment System"\n)\n\ngame (\n\tcomment "Super Mario World (USA)"\n\t${field} ${value}\n\trom ( crc B19ED489 )\n)\n\ngame (\n\tcomment "Super Metroid (Japan, USA) (En,Ja)"\n\t${field} ${field === 'users' ? '1' : '"Action"'}\n\trom ( crc D63ED5F8 )\n)\n`;

test('players and genre from libretro-database, by name or CRC, cached', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const kind = url.includes('/maxusers/') ? 'users' : 'genre';
    return { ok: true, status: 200, text: async () => DAT(kind, kind === 'users' ? '2' : '"Platform"') };
  };
  const db = new gi.GameInfoDb(dir, { fetchImpl });
  const rom = 'Nintendo - Super Nintendo Entertainment System/Super Mario World (USA).zip';
  assert.deepEqual(db.lookup(rom).players, null); // not loaded yet
  assert.equal(await db.ensure('Nintendo - Super Nintendo Entertainment System'), true);
  assert.deepEqual(db.lookup(rom), { players: 2, genre: 'Platform', system: 'Nintendo - Super Nintendo Entertainment System' });
  assert.equal(db.lookup('SNES/Super Metroid (Japan, USA) (En,Ja).zip').players, 1);
  assert.equal(db.lookup('SNES/Super Metroid (Japan, USA) (En,Ja).zip').genre, 'Action');
  // Renamed bare ROM: matched by its CRC. A .zip's CRC is the archive's, so not used.
  assert.equal(db.lookup('z/smw.sfc', 'b19ed489').players, 2);
  assert.equal(db.lookup('SNES/smw.zip', 'b19ed489').players, null);
  assert.equal(urls.length, 2);
  // A second instance reads the cache instead of downloading.
  const db2 = new gi.GameInfoDb(dir, { fetchImpl });
  await db2.ensure('Nintendo - Super Nintendo Entertainment System');
  assert.equal(urls.length, 2);
  assert.equal(db2.lookup(rom).genre, 'Platform');
});

test('public IP lookup: first good answer wins, junk and failures fall through', async () => {
  const { lookupPublicIp } = require('../src/main/controller');
  const answers = {
    'https://a': () => { throw new Error('offline'); },
    'https://b': () => ({ ok: true, text: async () => '<html>blocked</html>' }),
    'https://c': () => ({ ok: true, text: async () => '203.0.113.7\n' }),
  };
  const fetchImpl = async (url) => answers[url]();
  assert.equal(await lookupPublicIp(fetchImpl, ['https://a', 'https://b', 'https://c']), '203.0.113.7');
  await assert.rejects(lookupPublicIp(fetchImpl, ['https://a', 'https://b']), /Couldn't look up your internet address/);
});

test('port check from the internet: parses the checker, reports failures', async () => {
  const { checkPortsFromInternet } = require('../src/main/netcheck');
  let sent = null;
  const ok = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ error: false, check: [{ port: 55440, status: true }, { port: 55435, status: false }] }) }; };
  assert.deepEqual(await checkPortsFromInternet(ok, '203.0.113.7', [55440, 55435]), { 55440: true, 55435: false });
  assert.deepEqual(sent, { host: '203.0.113.7', ports: [55440, 55435] });
  const bad = async () => ({ ok: true, json: async () => ({ error: true, msg: 'rate limited' }) });
  await assert.rejects(checkPortsFromInternet(bad, '203.0.113.7', [1]), /rate limited/);
});

test('a system libretro has no data for, or no network, just means no info', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = new gi.GameInfoDb(dir, { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(await missing.ensure('Commodore - 64'), true);
  assert.equal(missing.lookup('Commodore - Commodore 64/x.zip').players, null);
  const offline = new gi.GameInfoDb(path.join(dir, 'b'), { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await offline.ensure('Atari - Lynx'), false);
  assert.equal(offline.lookup('Atari - Lynx/x.zip').players, null);
});
