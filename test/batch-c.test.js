'use strict';
// Box art, clean names, favorites, play history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const thumbs = require('../src/main/thumbnails');
const { Controller } = require('../src/main/controller');
const platforms = require('../src/main/platforms');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-c-'));
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return f; };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** A fake thumbnails.libretro.com: `files` maps "System/Name" -> true. */
function fakeServer(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = decodeURIComponent(url.replace('https://thumbnails.libretro.com/', ''));
    const [system, , name] = u.split('/');
    if (u.endsWith('/Named_Boxarts/')) {
      const list = Object.keys(files).filter((k) => k.startsWith(system + '/')).map((k) => `<a href="${encodeURIComponent(k.split('/')[1])}.png">x</a>`);
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => list.join('\n') };
    }
    const hit = files[`${system}/${name.replace(/\.png$/, '')}`];
    return hit
      ? { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG }
      : { ok: false, status: 404, headers: { get: () => 'text/html' } };
  };
  return { fetchImpl, calls };
}

test('clean titles and regions', () => {
  assert.equal(thumbs.cleanTitle('Legend of Zelda, The - A Link to the Past (USA) [!]'), 'The Legend of Zelda - A Link to the Past');
  assert.equal(thumbs.cleanTitle('Addams Family, The (Europe)'), 'The Addams Family');
  assert.equal(thumbs.cleanTitle('Super_Mario_World'), 'Super Mario World');
  assert.equal(thumbs.regionOf('Tetris (World) (Rev 1)'), 'World');
  assert.equal(thumbs.regionOf('Sonic (USA, Europe)'), 'USA, Europe');
  assert.equal(thumbs.sanitize('Q*bert: Rebooted?'), 'Q_bert_ Rebooted_');
});

test('best match prefers your region, then USA/World, and avoids betas', () => {
  const names = ['Tetris (Japan) (En)', 'Tetris (World) (Rev 1)', 'Tetris (World)', 'Tetris 2 (USA)', 'Tetris (World) (Beta)'];
  assert.equal(thumbs.bestMatch(names, 'Tetris'), 'Tetris (World)');
  assert.equal(thumbs.bestMatch(names, 'Tetris (Japan)'), 'Tetris (Japan) (En)');
  assert.equal(thumbs.bestMatch(names, 'Tetris 2'), 'Tetris 2 (USA)');
  assert.equal(thumbs.bestMatch(names, 'Tetris 3'), null);
  assert.equal(thumbs.bestMatch(['Legend of Zelda, The - A Link to the Past (USA)'], 'The Legend of Zelda - A Link to the Past'), 'Legend of Zelda, The - A Link to the Past (USA)');
  // Loose pass: all your words in exactly one title (few extra words).
  const pk = ['Pokemon - Emerald Version (USA, Europe)', 'Pokemon - Ruby Version (USA, Europe) (Rev 2)', 'Pokemon - Sapphire Version (USA, Europe)'];
  assert.equal(thumbs.bestMatch(pk, 'pokemon emerald'), 'Pokemon - Emerald Version (USA, Europe)');
  assert.equal(thumbs.bestMatch(pk, 'pokemon version'), null); // ambiguous: no guess
  assert.equal(thumbs.bestMatch(pk, 'emerald'), null); // one word is too vague
});

test('thumbnail cache: exact name, fuzzy via the index, misses remembered, resized', async () => {
  const dir = tmpdir();
  const { fetchImpl, calls } = fakeServer({
    'Nintendo - Super Nintendo Entertainment System/Super Mario World (USA)': true,
    'Nintendo - Game Boy/Tetris (World) (Rev 1)': true,
  });
  let resized = 0;
  const cache = new thumbs.ThumbCache(dir, { fetchImpl, resize: async (b) => { resized++; return b; } });
  const sha = (c) => c.repeat(64);
  assert.equal(await cache.ensure(sha('a'), 'SNES/Super Mario World (USA).sfc'), true);
  assert.equal(await cache.ensure(sha('b'), 'GB/tetris.gb'), true); // via index: "Tetris (World) (Rev 1)"
  assert.ok(calls.some((u) => u.endsWith('/Named_Boxarts/')));
  assert.equal(await cache.ensure(sha('c'), 'GB/Not A Real Game.gb'), false);
  assert.ok(cache.isNegative(sha('c')));
  const before = calls.length;
  assert.equal(await cache.ensure(sha('c'), 'GB/Not A Real Game.gb'), false);
  assert.equal(calls.length, before); // not asked again for a week
  assert.equal(await cache.ensure(sha('d'), 'Arcade/sf2.zip'), false); // arcade short names: no lookup
  assert.ok(cache.has(sha('a')) && cache.has(sha('b')));
  assert.equal(resized, 2);
  assert.deepEqual(fs.readFileSync(cache.file(sha('a'))), PNG);
});

test('favorites, play history and covers in the library', async (t) => {
  const root = tmpdir();
  write(path.join(root, 'roms', 'Super Mario World (USA).sfc'), 'smw');
  write(path.join(root, 'roms', 'Contra (USA).nes'), 'contra');
  write(path.join(root, 'cores', platforms.coreFilename('snes9x_libretro')), 'core');
  const { fetchImpl } = fakeServer({ 'Nintendo - Super Nintendo Entertainment System/Super Mario World (USA)': true });
  let release;
  const launch = (cfg, role, core, rom, opts, hooks = {}) => new Promise((resolve) => { release = () => resolve(0); if (hooks.onSpawn) hooks.onSpawn({ kill: () => resolve(0) }); });
  const c = new Controller({ dataDir: path.join(root, 'data'), pollMs: 60000, fetchImpl, launch });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ romsDir: path.join(root, 'roms'), coresDir: path.join(root, 'cores'), sharedSecret: 's', retroarchCommand: ['/x/retroarch'], syncPort: 57000 + Math.floor(Math.random() * 900) });

  const thumbArrived = new Promise((resolve) => c.once('thumb', resolve));
  let lib = await c.getLibrary();
  const smw = lib.rows.find((r) => r.path.startsWith('Super Mario'));
  assert.equal(smw.thumb, false);
  assert.equal(await thumbArrived, smw.sha);
  lib = await c.getLibrary();
  assert.equal(lib.rows.find((r) => r.sha === smw.sha).thumb, true);
  assert.equal(c.thumbFile(smw.sha), path.join(root, 'data', 'thumbs', `${smw.sha}.png`));
  assert.equal(c.thumbFile('../../etc/passwd'), null);

  assert.equal(c.toggleFavorite(smw.sha), true);
  await c.host(smw.mine.sha256);
  release();
  for (let i = 0; i < 100 && c.hosting; i++) await new Promise((r) => setTimeout(r, 10));
  lib = await c.getLibrary();
  const row = lib.rows.find((r) => r.sha === smw.sha);
  assert.equal(row.favorite, true);
  assert.equal(row.playCount, 1);
  assert.ok(row.lastPlayed > Date.now() - 60e3);
  // Survives a restart.
  const again = new Controller({ dataDir: path.join(root, 'data'), pollMs: 60000, fetchImpl });
  await again.init();
  t.after(() => again.dispose());
  assert.deepEqual(again.history.favorites, [smw.sha]);
  assert.equal(again.history.plays[0].role, 'host');
  assert.equal(c.toggleFavorite(smw.sha), false);

  // Covers off: no lookups.
  await c.saveSettings({ showBoxArt: false });
  lib = await c.getLibrary();
  assert.ok(lib.rows.every((r) => r.thumb === false));
});
