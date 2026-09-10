/**
 * LOD-pop detector over a captured sequence.
 *
 * A pop is a discontinuity in time: between two consecutive frames a patch of the image changes
 * far more than its neighbours do, without the camera having moved enough to explain it. That is
 * mechanically detectable — it needs no judgement and no critic, which matters because eight
 * rounds of frame-scoring never looked at two frames together and so could not see popping at
 * all.
 *
 *   node tools/popcheck.mjs [seqDir]        # default shots/seq
 *
 * Method. For each adjacent pair of frames, split the image into a grid of tiles and take the
 * mean absolute luma difference per tile. Camera motion raises EVERY tile roughly together, so
 * the median tile difference is a good estimate of "how much the whole picture moved". A pop is
 * a tile whose difference stands far above that baseline — a local change against a globally
 * smooth flow. Reported per pair with the offending tile's position, so it can be found.
 *
 * Exits non-zero if any pop exceeds the threshold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = process.argv[2] || 'shots/seq';
const TILES_X = 16, TILES_Y = 9;
/** A tile must exceed this multiple of the median tile change to count as a pop. */
const RATIO = +(process.env.POP_RATIO || 6.0);
/** …and also change by at least this much absolute luma, so noise on a still frame is ignored. */
const FLOOR = +(process.env.POP_FLOOR || 9.0);

const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

function tileDiff(a, b) {
  const w = a.width, h = a.height;
  const tw = Math.floor(w / TILES_X), th = Math.floor(h / TILES_Y);
  const out = [];
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      let sum = 0, n = 0;
      for (let y = ty * th; y < (ty + 1) * th; y += 2) {
        for (let x = tx * tw; x < (tx + 1) * tw; x += 2) {
          const i = (y * w + x) * 4;
          sum += Math.abs(luma(a.data, i) - luma(b.data, i));
          n++;
        }
      }
      out.push({ tx, ty, d: sum / n });
    }
  }
  return out;
}

const median = xs => { const s = [...xs].sort((p, q) => p - q); return s[s.length >> 1]; };

let worst = null, failures = 0, pairs = 0;
const scenes = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name);

if (!scenes.length) { console.error(`no sequences in ${ROOT}`); process.exit(2); }

for (const scene of scenes) {
  const dir = path.join(ROOT, scene);
  const frames = fs.readdirSync(dir).filter(f => /^f\d+\.png$/.test(f)).sort();
  if (frames.length < 2) { console.log(`${scene.padEnd(16)} skipped — needs 2+ frames`); continue; }

  // Telemetry lets a real camera cut be told apart from a pop: if the camera teleported between
  // two frames the whole image legitimately changes, and that is not a LOD failure.
  let tel = null;
  try { tel = JSON.parse(fs.readFileSync(path.join(dir, 'telemetry.json'), 'utf8')); } catch { /* optional */ }
  const camJump = i => {
    if (!tel || !tel[i]?.cam || !tel[i - 1]?.cam) return 0;
    const a = tel[i - 1].cam, b = tel[i].cam;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  };

  let scenePops = 0;
  for (let i = 1; i < frames.length; i++) {
    const A = PNG.sync.read(fs.readFileSync(path.join(dir, frames[i - 1])));
    const B = PNG.sync.read(fs.readFileSync(path.join(dir, frames[i])));
    if (A.width !== B.width || A.height !== B.height) continue;
    pairs++;

    const tiles = tileDiff(A, B);
    const base = median(tiles.map(t => t.d));
    const top = tiles.reduce((m, t) => (t.d > m.d ? t : m), tiles[0]);
    const ratio = base > 0.01 ? top.d / base : 0;
    const jump = camJump(i);

    // A camera cut (metres of movement in one step) explains a whole-image change; skip it.
    const isCut = jump > 8;
    const pop = !isCut && ratio >= RATIO && top.d >= FLOOR;
    if (pop) {
      scenePops++; failures++;
      console.log(`  POP  ${scene}/${frames[i - 1]}→${frames[i]}  tile(${top.tx},${top.ty})`
        + `  Δ${top.d.toFixed(1)} vs median ${base.toFixed(1)} (${ratio.toFixed(1)}x), cam moved ${jump.toFixed(2)} m`);
    }
    if (!worst || ratio > worst.ratio) worst = { scene, pair: `${frames[i - 1]}→${frames[i]}`, ratio, d: top.d };
  }
  console.log(`${scene.padEnd(16)} ${frames.length} frames, ${frames.length - 1} pairs — ${scenePops ? `${scenePops} POPS` : 'clean'}`);
}

console.log(`\n${pairs} frame pairs checked; ${failures} pop(s) over ${RATIO}x median and ${FLOOR} luma`);
if (worst) console.log(`worst local change: ${worst.scene} ${worst.pair} at ${worst.ratio.toFixed(1)}x median (Δ${worst.d.toFixed(1)})`);
process.exit(failures ? 1 : 0);
