'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('../src/main/config');

const R = (...p) => path.join(__dirname, '..', ...p);

test('theme setting: 8-bit platformer by default, unknown values fall back', () => {
  assert.equal(config.defaults().theme, 'pixel');
  assert.equal(config.normalize({ ...config.defaults(), theme: 'synthwave' }).theme, 'synthwave');
  assert.equal(config.normalize({ ...config.defaults(), theme: 'space' }).theme, 'space');
  assert.equal(config.normalize({ ...config.defaults(), theme: '../evil' }).theme, 'pixel');
  assert.equal(config.normalize({ ...config.defaults(), theme: undefined }).theme, 'pixel');
});

test('theme files: all stylesheets exist, the page starts on the 8-bit one', () => {
  const html = fs.readFileSync(R('src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="theme-pixel\.css" id="theme-css">/);
  for (const f of ['theme-pixel.css', 'theme-space.css', 'theme-synthwave.css', 'fonts/orbitron-700.woff2']) {
    assert.ok(fs.existsSync(R('src', 'renderer', f)), f);
  }
  // Every scene part the stylesheets animate is in the page.
  for (const cls of [
    'px-clouds', 'px-hills-far', 'px-hills-near', 'px-platforms', 'px-ground', 'px-coins', 'px-hero',
    'sp-nebula', 'sp-stars-far', 'sp-stars-mid', 'sp-stars-near', 'sp-planet', 'sp-rock', 'sp-wave', 'sp-boom',
    'sp-player', 'sp-shot', 'sp-flame',
  ]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${cls}\\b`), cls);
  }
});

for (const [css, script] of [['theme-pixel.css', 'make-pixel-sprites.js'], ['theme-space.css', 'make-space-sprites.js']]) {
  test(`${css}: generated sprites are up to date and only use data: URLs`, () => {
    const file = R('src', 'renderer', css);
    const before = fs.readFileSync(file, 'utf8');
    execFileSync(process.execPath, [R('scripts', script)], { stdio: 'ignore' });
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, before, `run node scripts/${script} and commit the result`);
    // The stylesheet's own url("...") values (gradient refs inside the SVGs are url(%23id), not files).
    const urls = [...after.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 7);
    for (const u of urls) assert.ok(u.startsWith('data:image/svg+xml,') || u.startsWith('fonts/'), u.slice(0, 40));
  });
}
