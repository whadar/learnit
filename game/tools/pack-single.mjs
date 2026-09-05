/**
 * Packs the game into ONE self-contained HTML file that needs no server and no network.
 *
 * The build normally fetches its world data at runtime. Here every course is embedded instead:
 * the vector JSON verbatim, and each 1025x1025 Float32 heightfield requantised to uint16 over
 * its own min/max — roughly 2 mm precision, at half the bytes — expanded back to Float32 by a
 * fetch shim before the game ever sees it.
 *
 *   node tools/pack-single.mjs                # every course found in dist-single/data
 *   node tools/pack-single.mjs amikam         # just one, for a smaller file
 *
 * Each world's JSON is inserted with a single JSON.stringify. Building the map with one
 * stringify over the whole object instead would escape every quote in every vector file a
 * second time, which on a dense city adds megabytes for nothing.
 */
import fs from 'node:fs';

const B = 'dist-single';
const bundle = fs.readFileSync(`${B}/bundle.js`, 'utf8');

const want = process.argv.slice(2);
const slugs = (want.length ? want : fs.readdirSync(`${B}/data`)
  .filter(f => f.endsWith('-height.bin'))
  .map(f => f.replace('-height.bin', ''))).sort();
if (!slugs.length) throw new Error(`no worlds in ${B}/data`);

const mb = n => (n / 1048576).toFixed(2) + ' MB';
const parts = [];
for (const slug of slugs) {
  const json = fs.readFileSync(`${B}/data/${slug}.json`, 'utf8');
  const heights = new Float32Array(fs.readFileSync(`${B}/data/${slug}-height.bin`).buffer);
  let lo = Infinity, hi = -Infinity;
  for (const h of heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const span = hi - lo;
  const q = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) q[i] = Math.round((heights[i] - lo) / span * 65535);
  const b64 = Buffer.from(q.buffer).toString('base64');
  parts.push(`${JSON.stringify(slug)}:{lo:${lo},span:${span},b64:${JSON.stringify(b64)},json:${JSON.stringify(json)}}`);
  console.log(`${slug.padEnd(10)} heightfield ${mb(heights.byteLength)} -> ${mb(q.byteLength)} `
    + `quantised (${lo.toFixed(2)}..${hi.toFixed(2)} m, step ${(span / 65535).toFixed(4)} m)   vectors ${mb(json.length)}`);
}

const shell = fs.readFileSync('tools/single-shell.html', 'utf8');
const out = shell
  .replace('/*__WORLDS__*/null', () => '{' + parts.join(',') + '}')
  .replace('/*__BUNDLE__*/', () => bundle);

if (out.includes('__WORLDS__')) throw new Error('world placeholder not substituted');
fs.writeFileSync('kat-racing.html', out);
console.log(`bundle ${mb(bundle.length)}`);
console.log(`kat-racing.html  ${mb(out.length)}   courses: ${slugs.join(', ')}`);
