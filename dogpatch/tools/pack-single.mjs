/**
 * The whole game as one HTML file.
 *
 * Everything is inlined: the bundle, the styles, the shell, and the world itself. The payload is
 * trimmed to what the game reads rather than what the extractor produced — only `world.buildings`
 * is touched at runtime, and only its first ring, height and storey count, so roads, water,
 * landuse and landcover (1.3 MB of the source JSON) are dropped, along with per-record UUIDs and
 * the all-null attribute columns. The heightfield goes from Float32 metres to Int16 decimetres:
 * half the bytes, and the only thing that would notice 10 cm is the road, which carve() regrades
 * to exact heights after loading anyway.
 *
 * The output carries no <!doctype>, <html>, <head> or <body> of its own so it can be published as
 * an artifact, which supplies that skeleton. Browsers wrap a bare fragment the same way, so the
 * same file also opens straight off disk.
 *
 *   node tools/pack-single.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = process.env.OUT || 'dist-single';
const P = +(process.env.PRECISION || 1);              // decimals kept on footprint coordinates

const round = v => +v.toFixed(P);

console.log('building…');
execFileSync('npx', ['vite', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });

/* ---- the bundle ---- */
const assets = path.join('dist', 'assets');
const js = fs.readdirSync(assets).filter(f => f.endsWith('.js'));
if (js.length !== 1) throw new Error(`expected one bundle, found ${js.length}: ${js}`);
const bundle = fs.readFileSync(path.join(assets, js[0]), 'utf8');
const css = fs.readdirSync(assets).filter(f => f.endsWith('.css'))
  .map(f => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');

/* ---- the world, trimmed ---- */
const src = JSON.parse(fs.readFileSync('public/data/world.json', 'utf8'));
const buildings = [];
for (const b of src.buildings) {
  const ring = b.rings?.[0];
  if (!ring || ring.length < 4) continue;             // buildings.js skips these anyway
  const out = { rings: [ring.map(p => [round(p[0]), round(p[1])])] };
  if (b.h > 0) out.h = round(b.h);
  else if (b.lv) out.lv = b.lv;
  buildings.push(out);
}

const hf = new Float32Array(fs.readFileSync('public/data/world-height.bin').buffer);
const dm = new Int16Array(hf.length);
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < hf.length; i++) {
  const v = Math.round(hf[i] * 10);
  if (v < -32768 || v > 32767) throw new Error(`height ${hf[i]} m does not fit Int16 decimetres`);
  dm[i] = v;
  if (hf[i] < lo) lo = hf[i];
  if (hf[i] > hi) hi = hf[i];
}
const payload = {
  meta: src.meta, terrain: src.terrain, buildings,
  h: Buffer.from(dm.buffer).toString('base64'),
};

/* ---- the page ---- */
const shell = fs.readFileSync('index.html', 'utf8');
const style = (shell.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '') + '\n' + css;
// The charset meta must come before the first non-ASCII byte in the stream. An artifact host
// supplies one in its own <head>, but served or opened directly this fragment is all there is,
// and without it the middots in the hoarding text render as "Â·".
const page = `<meta charset="utf-8">
<title>Dogpatch Kart</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Overpass:wght@600;900&family=Overpass+Mono:wght@600&display=swap">
<style>
html,body{margin:0;height:100%;background:#12161b;overflow:hidden}
${style}</style>
<div id="app"></div>
<script type="application/json" id="world">${JSON.stringify(payload)}</script>
<script>globalThis.__DOGPATCH_WORLD = JSON.parse(document.getElementById('world').textContent);</script>
<script type="module">${bundle}</script>
`;

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'dogpatch-kart.html');
fs.writeFileSync(file, page);

const mb = n => (n / 1e6).toFixed(2) + ' MB';
console.log(`world      ${src.buildings.length} buildings in, ${buildings.length} kept`);
console.log(`heights    ${lo.toFixed(1)}..${hi.toFixed(1)} m, Float32 ${mb(hf.byteLength)} -> Int16 ${mb(dm.byteLength)}`);
console.log(`bundle     ${mb(bundle.length)}`);
console.log(`payload    ${mb(JSON.stringify(payload).length)}`);
console.log(`${file}  ${mb(fs.statSync(file).size)}`);
