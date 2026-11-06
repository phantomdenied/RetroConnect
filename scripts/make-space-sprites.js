'use strict';
// Builds the vector art for the space shooter theme (src/renderer/theme-space.css)
// as SVG data URIs:
//
//   node scripts/make-space-sprites.js
//
// rewrites the block between "sprites:start" and "sprites:end" in that file.
// All designs here are original. Star fields use a fixed seed, so the output
// only changes when this file does.

const fs = require('fs');
const path = require('path');

function uri(svgText) {
  const s = svgText.replace(/\s*\n\s*/g, ' ').trim();
  return `url("data:image/svg+xml,${s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, "'")}")`;
}

// Small seeded random (mulberry32) so the stars stay put between builds.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stars({ size, count, rMin, rMax, seed, colors }) {
  const r = rng(seed);
  let dots = '';
  for (let i = 0; i < count; i++) {
    const x = (r() * size).toFixed(1);
    const y = (r() * size).toFixed(1);
    const rad = (rMin + r() ** 2 * (rMax - rMin)).toFixed(2);
    const c = colors[Math.floor(r() * colors.length)];
    const o = (0.45 + r() * 0.55).toFixed(2);
    dots += `<circle cx='${x}' cy='${y}' r='${rad}' fill='${c}' opacity='${o}'/>`;
  }
  return uri(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>${dots}</svg>`);
}

// Big stars with a soft cross glint.
function brightStars({ size, count, seed }) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = (r() * size).toFixed(1);
    const y = (r() * size).toFixed(1);
    const s = 3 + r() * 5;
    const c = ['#ffffff', '#cfe8ff', '#ffe9c4', '#b7f3ff'][Math.floor(r() * 4)];
    out += `<g transform='translate(${x} ${y})' opacity='${(0.6 + r() * 0.4).toFixed(2)}'>
      <circle r='${(s / 2.6).toFixed(2)}' fill='url(#g)'/>
      <rect x='-${(s * 1.6).toFixed(1)}' y='-.35' width='${(s * 3.2).toFixed(1)}' height='.7' fill='${c}' opacity='.55'/>
      <rect x='-.35' y='-${(s * 1.6).toFixed(1)}' width='.7' height='${(s * 3.2).toFixed(1)}' fill='${c}' opacity='.55'/>
      <circle r='${(s / 7).toFixed(2)}' fill='#fff'/></g>`;
  }
  return uri(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
    <defs><radialGradient id='g'><stop offset='0' stop-color='#fff' stop-opacity='.9'/><stop offset='1' stop-color='#8fd8ff' stop-opacity='0'/></radialGradient></defs>${out}</svg>`);
}

const SHIP = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 96' width='80' height='96'>
  <defs>
    <linearGradient id='hull' x1='0' x2='1'>
      <stop offset='0' stop-color='#7d8bb8'/><stop offset='.45' stop-color='#f2f6ff'/><stop offset='.55' stop-color='#dfe7fb'/><stop offset='1' stop-color='#6f7ca8'/>
    </linearGradient>
    <linearGradient id='wing' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#3a4d8f'/><stop offset='1' stop-color='#141c3d'/>
    </linearGradient>
    <linearGradient id='glass' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#bff6ff'/><stop offset='.4' stop-color='#22d3ff'/><stop offset='1' stop-color='#0a3a7a'/>
    </linearGradient>
  </defs>
  <path d='M40 4 L47 34 L76 70 L74 80 L50 72 L46 84 L34 84 L30 72 L6 80 L4 70 L33 34 Z' fill='url(#wing)' stroke='#9fb4ff' stroke-width='1'/>
  <path d='M40 4 L47 34 L50 72 L46 84 L34 84 L30 72 L33 34 Z' fill='url(#hull)' stroke='#ffffff' stroke-opacity='.7' stroke-width='.8'/>
  <path d='M12 72 L36 46 L36 54 L16 76 Z M68 72 L44 46 L44 54 L64 76 Z' fill='#22d3ff' opacity='.9'/>
  <path d='M4 70 L4 60 L8 58 L9 68 Z M76 70 L76 60 L72 58 L71 68 Z' fill='#ff3d81'/>
  <ellipse cx='40' cy='36' rx='4.6' ry='11' fill='url(#glass)' stroke='#e9fbff' stroke-width='.8'/>
  <ellipse cx='38.6' cy='31' rx='1.3' ry='4' fill='#ffffff' opacity='.8'/>
  <rect x='34' y='82' width='4.5' height='5' rx='1' fill='#2a3358'/><rect x='41.5' y='82' width='4.5' height='5' rx='1' fill='#2a3358'/>
</svg>`;

const DRONE = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 52' width='64' height='52'>
  <defs>
    <linearGradient id='d' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#ff7ab0'/><stop offset='.5' stop-color='#d0246a'/><stop offset='1' stop-color='#4a0b3c'/>
    </linearGradient>
    <radialGradient id='e'><stop offset='0' stop-color='#fff'/><stop offset='.35' stop-color='#ffe066'/><stop offset='1' stop-color='#ff3b1f' stop-opacity='0'/></radialGradient>
  </defs>
  <path d='M32 6 L44 18 L60 14 L52 32 L40 30 L32 46 L24 30 L12 32 L4 14 L20 18 Z' fill='url(#d)' stroke='#ffc2dc' stroke-width='1'/>
  <path d='M20 18 L32 24 L44 18' fill='none' stroke='#ffd1e4' stroke-opacity='.6' stroke-width='1'/>
  <circle cx='32' cy='22' r='9' fill='url(#e)'/>
  <circle cx='32' cy='22' r='2.6' fill='#fff'/>
</svg>`;

const ASTEROID = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 52' width='60' height='52'>
  <defs><radialGradient id='a' cx='.35' cy='.3'><stop offset='0' stop-color='#a59a8c'/><stop offset='.7' stop-color='#5b5148'/><stop offset='1' stop-color='#2b2520'/></radialGradient></defs>
  <path d='M14 4 L34 2 L50 10 L58 26 L52 42 L36 50 L18 48 L6 38 L2 22 Z' fill='url(#a)' stroke='#3a322b' stroke-width='1'/>
  <ellipse cx='22' cy='18' rx='6' ry='4.5' fill='#3d352e' opacity='.75'/>
  <ellipse cx='40' cy='32' rx='8' ry='5.5' fill='#3d352e' opacity='.7'/>
  <ellipse cx='20' cy='36' rx='4' ry='3' fill='#3d352e' opacity='.6'/>
  <path d='M14 4 L34 2 L50 10' fill='none' stroke='#c9bfb2' stroke-opacity='.45' stroke-width='1.2'/>
</svg>`;

const PLANET = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 420 300' width='420' height='300'>
  <defs>
    <radialGradient id='p' cx='.38' cy='.32' r='.75'>
      <stop offset='0' stop-color='#7ef0ff'/><stop offset='.35' stop-color='#3a7bd5'/><stop offset='.7' stop-color='#3b1f7a'/><stop offset='1' stop-color='#120a2e'/>
    </radialGradient>
    <linearGradient id='band' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='.5' stop-color='#d7f8ff' stop-opacity='.16'/><stop offset='1' stop-color='#fff' stop-opacity='0'/>
    </linearGradient>
    <linearGradient id='ring' x1='0' x2='1'>
      <stop offset='0' stop-color='#ff9ad5' stop-opacity='0'/><stop offset='.25' stop-color='#ffb86b' stop-opacity='.85'/><stop offset='.5' stop-color='#fff1c7' stop-opacity='.95'/><stop offset='.75' stop-color='#ff7ab0' stop-opacity='.8'/><stop offset='1' stop-color='#9a7bff' stop-opacity='0'/>
    </linearGradient>
    <clipPath id='front'><rect x='0' y='150' width='420' height='150'/></clipPath>
    <radialGradient id='halo'><stop offset='.62' stop-color='#4fd8ff' stop-opacity='.35'/><stop offset='1' stop-color='#4fd8ff' stop-opacity='0'/></radialGradient>
  </defs>
  <circle cx='210' cy='150' r='150' fill='url(#halo)'/>
  <ellipse cx='210' cy='150' rx='200' ry='40' fill='none' stroke='url(#ring)' stroke-width='9' transform='rotate(-14 210 150)'/>
  <circle cx='210' cy='150' r='96' fill='url(#p)'/>
  <ellipse cx='210' cy='122' rx='94' ry='10' fill='url(#band)'/>
  <ellipse cx='210' cy='160' rx='92' ry='14' fill='url(#band)'/>
  <ellipse cx='210' cy='192' rx='80' ry='8' fill='url(#band)'/>
  <g clip-path='url(#front)'><ellipse cx='210' cy='150' rx='200' ry='40' fill='none' stroke='url(#ring)' stroke-width='9' transform='rotate(-14 210 150)'/></g>
</svg>`;

const SPRITES = {
  'stars-far': stars({ size: 512, count: 260, rMin: 0.35, rMax: 0.9, seed: 7, colors: ['#ffffff', '#cfe0ff', '#9fb8ff'] }),
  'stars-mid': stars({ size: 640, count: 90, rMin: 0.7, rMax: 1.5, seed: 21, colors: ['#ffffff', '#b7f3ff', '#ffe2c4'] }),
  'stars-near': brightStars({ size: 900, count: 14, seed: 99 }),
  ship: uri(SHIP),
  drone: uri(DRONE),
  asteroid: uri(ASTEROID),
  planet: uri(PLANET),
};

const file = path.join(__dirname, '..', 'src', 'renderer', 'theme-space.css');
const css = fs.readFileSync(file, 'utf8');
const block = [
  '/* sprites:start (generated by scripts/make-space-sprites.js; edit the art there) */',
  ':root {',
  ...Object.entries(SPRITES).map(([k, v]) => `  --sp-${k}: ${v};`),
  '}',
  '/* sprites:end */',
].join(css.includes('\r\n') ? '\r\n' : '\n'); // keep the file's line endings
if (!css.includes('sprites:start')) throw new Error('No sprites:start/end markers in theme-space.css');
fs.writeFileSync(file, css.replace(/\/\* sprites:start[\s\S]*?sprites:end \*\//, block));
console.log(`Wrote ${Object.keys(SPRITES).length} sprites into ${path.relative(process.cwd(), file)}`);
