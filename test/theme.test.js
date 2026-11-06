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
  assert.equal(config.normalize({ ...config.defaults(), theme: '../evil' }).theme, 'pixel');
  assert.equal(config.normalize({ ...config.defaults(), theme: undefined }).theme, 'pixel');
});

test('theme files: both stylesheets exist, the page starts on the 8-bit one', () => {
  const html = fs.readFileSync(R('src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="theme-pixel\.css" id="theme-css">/);
  for (const f of ['theme-pixel.css', 'theme-synthwave.css']) assert.ok(fs.existsSync(R('src', 'renderer', f)), f);
  // Every scene layer the stylesheet animates is in the page.
  for (const cls of ['px-clouds', 'px-hills-far', 'px-hills-near', 'px-platforms', 'px-ground', 'px-coins', 'px-hero']) {
    assert.match(html, new RegExp(`class="[^"]*\\b${cls}\\b`), cls);
  }
});

test('pixel sprites: generated block is up to date and only uses data: URLs', () => {
  const file = R('src', 'renderer', 'theme-pixel.css');
  const before = fs.readFileSync(file, 'utf8');
  execFileSync(process.execPath, [R('scripts', 'make-pixel-sprites.js')], { stdio: 'ignore' });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before, 'run node scripts/make-pixel-sprites.js and commit the result');
  const urls = [...after.matchAll(/url\("?([^")]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 7);
  for (const u of urls) assert.ok(u.startsWith('data:image/svg+xml,') || u.startsWith('fonts/'), u.slice(0, 40));
});
