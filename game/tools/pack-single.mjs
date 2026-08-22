/**
 * Packs the game into ONE self-contained HTML file that needs no server and no network.
 *
 * The build normally fetches two data files at runtime. Here they are embedded instead:
 * the vector JSON verbatim, and the 1025x1025 Float32 heightfield requantised to uint16
 * over its own min/max — 0.002 m precision on a 50-185 m range, at half the bytes — then
 * expanded back to Float32 by a fetch shim before the game ever sees it.
 */
import fs from 'node:fs';

const B = 'dist-single';
const bundle = fs.readFileSync(`${B}/bundle.js`, 'utf8');
const json = fs.readFileSync(`${B}/data/amikam.json`, 'utf8');
const heights = new Float32Array(fs.readFileSync(`${B}/data/amikam-height.bin`).buffer);

let lo = Infinity, hi = -Infinity;
for (const h of heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
const q = new Uint16Array(heights.length);
const span = hi - lo;
for (let i = 0; i < heights.length; i++) q[i] = Math.round((heights[i] - lo) / span * 65535);
const heightB64 = Buffer.from(q.buffer).toString('base64');

const shell = fs.readFileSync('tools/single-shell.html', 'utf8');
const out = shell
  .replace('/*__HEIGHT_LO__*/0', String(lo))
  .replace('/*__HEIGHT_SPAN__*/0', String(span))
  .replace('"__HEIGHT_B64__"', JSON.stringify(heightB64))
  .replace('"__WORLD_JSON__"', JSON.stringify(json))
  .replace('/*__BUNDLE__*/', () => bundle);

fs.writeFileSync('kat-racing.html', out);
const mb = n => (n / 1048576).toFixed(2) + ' MB';
console.log(`heightfield ${mb(heights.byteLength)} -> ${mb(q.byteLength)} quantised (${lo.toFixed(2)}..${hi.toFixed(2)} m, step ${(span / 65535).toFixed(4)} m)`);
console.log(`bundle ${mb(bundle.length)}   vectors ${mb(json.length)}`);
console.log(`kat-racing.html  ${mb(out.length)}`);
