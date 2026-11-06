'use strict';
// Builds the pixel-art sprites for the 8-bit theme (src/renderer/theme-pixel.css)
// from the little character maps below, as crisp SVG data URIs.
//
//   node scripts/make-pixel-sprites.js
//
// rewrites the block between "sprites:start" and "sprites:end" in that file.
// All art here is original. One character = one pixel; "." = transparent.

const fs = require('fs');
const path = require('path');

const PAL = {
  K: '#1b1c3d', // outline / dark
  W: '#ffffff',
  L: '#d4e3ff', // cloud shade
  B: '#5fd3ff', // robot body
  b: '#2f8fc7', // robot shade
  E: '#1b1c3d', // eye
  R: '#ff5a4a', // red light
  Y: '#ffcf3a', // gold
  o: '#c98a00', // gold shade
  y: '#fff2a8', // gold shine
  G: '#4cc94a', // grass
  g: '#8ef06a', // grass light
  d: '#2f8f3a', // grass dark
  D: '#b8642e', // dirt
  p: '#8a4520', // dirt dark
  q: '#d98a4a', // dirt light
  S: '#9aa3c7', // stone
  s: '#6b739c', // stone shade
  t: '#d8ddf2', // stone light
  H: '#2e7d4f', // far hills
  h: '#3f9a5f', // far hills light
  N: '#46b85a', // near hills
  n: '#6fd77a', // near hills light
  M: '#2a7a3c', // near hills dark
};

function svg(rows, w = rows[0].length, h = rows.length) {
  let rects = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.' || c === ' ') continue;
      // merge runs of the same colour into one rect
      let run = 1;
      while (row[x + run] === c) run++;
      rects += `<rect x='${x}' y='${y}' width='${run}' height='1' fill='${PAL[c]}'/>`;
      x += run - 1;
    }
  });
  const doc = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' shape-rendering='crispEdges'>${rects}</svg>`;
  return `url("data:image/svg+xml,${doc.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
}

const blank = (w, h) => Array.from({ length: h }, () => '.'.repeat(w).split(''));
function stamp(canvas, rows, ox, oy) {
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c !== '.' && canvas[oy + y] && ox + x < canvas[0].length) canvas[oy + y][ox + x] = c; }));
}
const join = (canvas) => canvas.map((r) => r.join(''));

// ----- clouds: one tile, two clouds -------------------------------------------
const CLOUD = [
  '.....WWW....WW.....',
  '...WWWWWW.WWWWWW...',
  '..WWWWWWWWWWWWWWW..',
  '.WWWWWWWWWWWWWWWWW.',
  'WWWWWWWWWWWWWWWWWWW',
  'WWWWWWWWWWWWWWWWWWW',
  'LWWWWWWWWWWWWWWWWWL',
  '.LLLLLLLLLLLLLLLLL.',
];
const SMALL_CLOUD = [
  '...WWW.....',
  '.WWWWWWWW..',
  'WWWWWWWWWWW',
  'WWWWWWWWWWW',
  '.LLLLLLLLL.',
];
const clouds = blank(120, 30);
stamp(clouds, CLOUD, 6, 3);
stamp(clouds, SMALL_CLOUD, 62, 17);
stamp(clouds, CLOUD, 92, 9);

// ----- hills: periodic stepped mounds -----------------------------------------
function hills(width, height, bumps, body, light, dark) {
  const c = blank(width, height);
  for (let x = 0; x < width; x++) {
    let top = height;
    for (const { cx, r, hgt } of bumps) {
      const dx = Math.min(Math.abs(x - cx), width - Math.abs(x - cx)); // wraps, so the tile repeats
      if (dx < r) top = Math.min(top, Math.round(height - hgt * Math.sqrt(1 - (dx / r) ** 2)));
    }
    for (let y = top; y < height; y++) {
      let col = body;
      if (y === top) col = dark || body;
      else if (y <= top + 1) col = light;
      else if (dark && (x * 7 + y * 13) % 23 === 0) col = dark;
      c[y][x] = col;
    }
  }
  return join(c);
}

// ----- ground: grass on dirt ---------------------------------------------------
const GROUND = [
  'gggggggggggggggg',
  'GgGGGgGGGGgGGGgG',
  'GGGGGGGGGGGGGGGG',
  'GGdGGGGGdGGGGGdG',
  'dGdDdGGdDdGGdDdG',
  'DdDDDdDDDDDdDDDd',
  'DDDDDDDDDDDDDDDD',
  'DDqDDDDDDDpDDDDD',
  'DDDDDDpDDDDDDqDD',
  'DpDDDDDDDDDDDDDD',
  'DDDDqDDDDDDpDDDD',
  'DDDDDDDDDDDDDDpD',
  'DDDpDDDDqDDDDDDD',
  'DDDDDDDDDDDDDDDD',
  'DqDDDDDpDDDDDDDD',
  'DDDDDDDDDDDDqDDD',
  'DDDDpDDDDDDDDDDD',
  'DDDDDDDDDDpDDDDD',
  'DDDDDDDDDDDDDDDD',
  'DDpDDDqDDDDDDDDD',
  'DDDDDDDDDDDDDpDD',
  'DDDDDDDDDDDDDDDD',
  'DDDDDDpDDDDDDDDD',
  'DqDDDDDDDDDDqDDD',
  'DDDDDDDDDDDDDDDD',
  'DDDDDDDDDpDDDDDD',
  'DDDpDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDDD',
];

// ----- floating stone blocks ------------------------------------------------------
const BLOCK = [
  'tttttttK',
  'tSSSSSsK',
  'tSSSSSsK',
  'tSSKSSsK',
  'tSSSSSsK',
  'tSSSSSsK',
  'tssssssK',
  'KKKKKKKK',
];
const platforms = blank(120, 40);
for (let i = 0; i < 4; i++) stamp(platforms, BLOCK, 20 + i * 8, 4);
for (let i = 0; i < 3; i++) stamp(platforms, BLOCK, 78 + i * 8, 22);

// ----- coin: four spin frames side by side ------------------------------------------
const COIN = [
  [
    '..KKKK..',
    '.KYYYYK.',
    'KYyYYYoK',
    'KYyYoYoK',
    'KYyYoYoK',
    'KYyYYYoK',
    '.KooooK.',
    '..KKKK..',
  ],
  [
    '...KK...',
    '..KYYK..',
    '..KyYK..',
    '..KyoK..',
    '..KyoK..',
    '..KYoK..',
    '..KooK..',
    '...KK...',
  ],
  [
    '...KK...',
    '...KK...',
    '...KK...',
    '...KK...',
    '...KK...',
    '...KK...',
    '...KK...',
    '...KK...',
  ],
  [
    '...KK...',
    '..KYYK..',
    '..KYyK..',
    '..KoyK..',
    '..KoyK..',
    '..KoYK..',
    '..KooK..',
    '...KK...',
  ],
];
const coins = blank(32, 8);
COIN.forEach((f, i) => stamp(coins, f, i * 8, 0));

// ----- hero: an original little robot, two walking frames ---------------------------
const HERO_TOP = [
  '.....RR.....',
  '......K.....',
  '..KKKKKKKK..',
  '.KBBBBBBBBK.',
  '.KBWWBBWWBK.',
  '.KBWEBBWEBK.',
  '.KBBBBBBBBK.',
  '.KBBYYYYBBK.',
  '.KbBBBBBBbK.',
  '..KKKKKKKK..',
];
const HERO_LEGS = [
  ['..KbK..KbK..', '..KK....KK..'],
  ['...KbKKbK...', '...KK..KK...'],
];
const hero = blank(24, 12);
HERO_LEGS.forEach((legs, i) => stamp(hero, [...HERO_TOP, ...legs], i * 12, 0));

const SPRITES = {
  clouds: svg(join(clouds)),
  'hills-far': svg(hills(64, 24, [{ cx: 14, r: 16, hgt: 20 }, { cx: 44, r: 13, hgt: 14 }], 'H', 'h', null)),
  'hills-near': svg(hills(64, 20, [{ cx: 30, r: 14, hgt: 17 }, { cx: 56, r: 9, hgt: 9 }], 'N', 'n', 'M')),
  ground: svg(GROUND),
  platforms: svg(join(platforms)),
  coin: svg(join(coins)),
  hero: svg(join(hero)),
};

const file = path.join(__dirname, '..', 'src', 'renderer', 'theme-pixel.css');
const css = fs.readFileSync(file, 'utf8');
const block = [
  '/* sprites:start (generated by scripts/make-pixel-sprites.js; edit the maps there) */',
  ':root {',
  ...Object.entries(SPRITES).map(([k, v]) => `  --px-${k}: ${v};`),
  '}',
  '/* sprites:end */',
].join('\n');
const out = css.replace(/\/\* sprites:start[\s\S]*?sprites:end \*\//, block);
if (out === css && !css.includes('sprites:start')) throw new Error('No sprites:start/end markers in theme-pixel.css');
fs.writeFileSync(file, out);
console.log(`Wrote ${Object.keys(SPRITES).length} sprites into ${path.relative(process.cwd(), file)}`);
