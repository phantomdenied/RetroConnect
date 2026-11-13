'use strict';
// Sending other files (not games) to your buddy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');

const transfer = require('../src/main/transfer');
const { Controller } = require('../src/main/controller');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-xfer-'));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}`);
}

function get(port, urlPath, secret = 's') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { Authorization: `Bearer ${secret}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('names from the network: no escaping the folder, Windows-safe', () => {
  assert.deepEqual(transfer.safeNameParts('Mods/cool mod.zip'), ['Mods', 'cool mod.zip']);
  assert.deepEqual(transfer.safeNameParts('a\\b.txt'), ['a', 'b.txt']);
  assert.deepEqual(transfer.safeNameParts('what?.txt'), ['what_.txt']);
  assert.deepEqual(transfer.safeNameParts('con.txt'), ['_con.txt']);
  assert.deepEqual(transfer.safeNameParts('trailing dot.'), ['trailing dot']);
  for (const bad of ['../evil.exe', 'a/../../b', '/etc/passwd', '', 'a//b', '.', 42, null]) {
    assert.throws(() => transfer.safeNameParts(bad), /bad name/, String(bad));
  }
  // A drive letter's colon is replaced, so it can't point at another drive.
  assert.deepEqual(transfer.safeNameParts('C:/Windows/x'), ['C_', 'Windows', 'x']);
});

test('incoming lists are filtered to well-formed entries', () => {
  const good = { id: 'abc123', name: 'Pack/readme.txt', group: 'Pack', size: 5, sha256: 'a'.repeat(64), addedAt: 1 };
  const out = transfer.cleanIncoming([
    good,
    { ...good, id: 'NOT HEX' },
    { ...good, sha256: 'xyz' },
    { ...good, size: -1 },
    { ...good, name: '../../x' },
    'junk',
  ]);
  assert.deepEqual(out, [good]);
  assert.deepEqual(transfer.cleanIncoming(undefined), []);
});

test('outbox: add files and folders, skip repeats, remove a folder, survive restarts', async () => {
  const dir = tmpdir();
  const one = write(path.join(dir, 'notes.txt'), 'hello');
  write(path.join(dir, 'Pack', 'a.txt'), 'aaa');
  write(path.join(dir, 'Pack', 'sub', 'b.bin'), Buffer.alloc(3000, 7));
  const file = path.join(dir, 'data', 'outbox.json');
  const ob = new transfer.Outbox(file);
  const progress = [];
  const added = await ob.add([one, path.join(dir, 'Pack')], { onProgress: (p) => progress.push(p) });
  assert.deepEqual(added.map((i) => i.name), ['notes.txt', 'Pack/a.txt', 'Pack/sub/b.bin']);
  assert.deepEqual(added.map((i) => i.group), [null, 'Pack', 'Pack']);
  assert.equal(progress.at(-1).done, progress.at(-1).total);
  assert.equal((await ob.add([one])).length, 0); // already there

  // Nothing local leaks into what the buddy sees.
  assert.ok(ob.publicList().every((i) => !('path' in i)));

  const again = new transfer.Outbox(file);
  assert.equal(again.items.length, 3);
  again.remove(['group:Pack']);
  assert.deepEqual(again.items.map((i) => i.name), ['notes.txt']);

  // A file edited after it was added isn't served (its size/hash no longer match).
  assert.equal(await again.lookup(again.items[0].sha256), one);
  fs.writeFileSync(one, 'changed!');
  assert.equal(await again.lookup(again.items[0].sha256), null);
  assert.equal(await again.lookup('f'.repeat(64)), null);
});

test('receive destination: same file is reused, different file gets "(2)"', async () => {
  const dir = tmpdir();
  const sha = await transfer.shaFile(write(path.join(dir, 'x.txt'), 'one'));
  assert.deepEqual(await transfer.destFor(dir, 'x.txt', sha), { dest: path.join(dir, 'x.txt'), already: true });
  assert.deepEqual(await transfer.destFor(dir, 'x.txt', 'b'.repeat(64)), { dest: path.join(dir, 'x (2).txt'), already: false });
  assert.deepEqual(await transfer.destFor(dir, 'Pack/new.txt', sha), { dest: path.join(dir, 'Pack', 'new.txt'), already: false });
});

async function pair(t) {
  const root = tmpdir();
  const sync = await freePort();
  const mk = async (name, extra) => {
    const dir = path.join(root, name);
    const c = new Controller({ dataDir: dir, pollMs: 40, downloadsDir: path.join(dir, 'Downloads'), launch: () => new Promise(() => {}) });
    await c.init();
    await c.saveSettings({
      nickname: name, romsDir: path.join(dir, 'roms'), coresDir: path.join(dir, 'cores'),
      retroarchCommand: ['/nonexistent/retroarch'], sharedSecret: 's', peerAddress: '127.0.0.1', syncPort: sync, ...extra,
    });
    return c;
  };
  const alex = await mk('alex', { netplayPort: await freePort() });
  const sam = await mk('sam', { netplayPort: await freePort(), shareLibrary: false });
  t.after(async () => { await alex.dispose(); await sam.dispose(); });
  await until(() => sam.buddy.status === 'online', 'sam to see alex');
  return { alex, sam, root, sync };
}

test('send a file and a folder: the buddy sees them, downloads on request, gets identical bytes', async (t) => {
  const { alex, sam, root, sync } = await pair(t);
  const src = path.join(root, 'stuff');
  write(path.join(src, 'Manual.pdf'), Buffer.alloc(200000, 3));
  write(path.join(src, 'Texture Pack', 'a.png'), 'png-a');
  write(path.join(src, 'Texture Pack', 'deep', 'b.png'), 'png-b');
  const announced = [];
  sam.on('files', (info) => announced.push(info));

  await alex.addToOutbox([path.join(src, 'Manual.pdf'), path.join(src, 'Texture Pack')]);
  assert.equal(alex.state().files.outbox.length, 3);

  // Nothing is fetched until Sam asks; he just sees the offer.
  await until(() => sam.state().files.incoming.length === 3, 'sam to see the offer');
  assert.equal(announced.length, 1);
  assert.equal(announced[0].count, 3);
  assert.equal(fs.existsSync(path.join(root, 'sam', 'Downloads', 'RetroConnect')), false);

  const pdf = sam.state().files.incoming.find((i) => i.name === 'Manual.pdf');
  const r = await sam.receiveFiles([pdf.id]);
  const dest = path.join(root, 'sam', 'Downloads', 'RetroConnect', 'Manual.pdf');
  assert.deepEqual(r.saved, [dest]);
  assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(src, 'Manual.pdf')));
  assert.equal(sam.state().files.incoming.find((i) => i.id === pdf.id).savedTo, dest);

  // The folder keeps its layout.
  const rest = sam.state().files.incoming.filter((i) => !i.savedTo).map((i) => i.id);
  await sam.receiveFiles(rest);
  assert.equal(fs.readFileSync(path.join(root, 'sam', 'Downloads', 'RetroConnect', 'Texture Pack', 'deep', 'b.png'), 'utf8'), 'png-b');

  // Only outbox files can be fetched, by hash; anything else is a 404.
  const other = await get(sync, `/files/send/${'0'.repeat(64)}`);
  assert.equal(other.status, 404);

  // Dismissing hides an offer; removing it from the outbox makes it disappear for the buddy.
  await alex.removeFromOutbox(alex.state().files.outbox.filter((i) => i.name === 'Manual.pdf').map((i) => i.id));
  await until(() => sam.state().files.incoming.length === 2, 'the removed file to vanish');
  assert.equal(announced.length, 1); // removals don't announce anything
});

test('a different receive folder can be set; a dismissed offer is remembered', async (t) => {
  const { alex, sam, root } = await pair(t);
  const custom = path.join(root, 'Mine');
  await sam.saveSettings({ receiveDir: custom });
  assert.equal(sam.state().files.receiveDir, custom);
  await alex.addToOutbox([write(path.join(root, 'x.sav'), 'save data')]);
  await until(() => sam.state().files.incoming.length === 1, 'the offer');
  const [item] = sam.state().files.incoming;
  sam.dismissIncoming([item.id]);
  assert.equal(sam.state().files.incoming[0].dismissed, true);
  const reloaded = JSON.parse(fs.readFileSync(path.join(root, 'sam', 'received.json'), 'utf8'));
  assert.deepEqual(reloaded.dismissed, [item.id]);
  // Still downloadable later if they change their mind.
  await sam.receiveFiles([item.id]);
  assert.equal(fs.readFileSync(path.join(custom, 'x.sav'), 'utf8'), 'save data');
  assert.equal(sam.state().files.incoming[0].dismissed, false);
});

test('the server starts just for sending, even with library sharing off', async (t) => {
  const root = tmpdir();
  const port = await freePort();
  const c = new Controller({ dataDir: path.join(root, 'd'), pollMs: 60000, launch: () => new Promise(() => {}) });
  await c.init();
  t.after(() => c.dispose());
  await c.saveSettings({ sharedSecret: 's', syncPort: port, shareLibrary: false, romsDir: path.join(root, 'roms') });
  assert.equal(c.server, null);
  await c.addToOutbox([write(path.join(root, 'f.txt'), 'hi')]);
  assert.ok(c.server);
  const status = JSON.parse((await get(port, '/api/status')).body);
  assert.equal(status.outbox.length, 1);
  assert.equal(status.outbox[0].name, 'f.txt');
  assert.equal((await get(port, `/files/send/${status.outbox[0].sha256}`)).body.toString(), 'hi');
  assert.equal((await get(port, '/api/status', 'wrong')).status, 401);
  await c.removeFromOutbox([status.outbox[0].id]);
  assert.equal(c.server, null);
});
