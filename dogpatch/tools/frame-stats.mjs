/**
 * Objective statistics on rendered frames, so a round of work can be judged by measurement
 * rather than by how the picture feels.
 *
 * Critics said the frames crush to black on shadow sides and carry no texture. Both of those are
 * measurable: `dark` is the share of pixels below 6% luminance, and `detail` is the mean absolute
 * difference between neighbouring pixels — a flat untextured surface scores near zero however
 * pretty its colour is.
 *
 *   node tools/frame-stats.mjs shots/judge
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const dir = process.argv[2] || 'shots/judge';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const rows = [];

for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
  const { width: w, height: h, data } = png;
  const lum = new Float64Array(w * h);
  let sum = 0, dark = 0, clip = 0, sat = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[p] = l; sum += l;
    if (l < 0.06) dark++;
    if (r > 0.98 && g > 0.98 && b > 0.98) clip++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat += mx > 0 ? (mx - mn) / mx : 0;
  }
  // local detail: mean |difference| to the right and below, skipping the HUD margins
  let det = 0, n = 0;
  const m = 40;
  for (let y = m; y < h - m - 1; y++) {
    for (let x = m; x < w - m - 1; x++) {
      const p = y * w + x;
      det += Math.abs(lum[p] - lum[p + 1]) + Math.abs(lum[p] - lum[p + w]);
      n += 2;
    }
  }
  const px = w * h;
  rows.push({ frame: f.replace('.png', ''), lum: sum / px, dark: dark / px, clip: clip / px,
              sat: sat / px, detail: det / n });
}

const pc = v => (v * 100).toFixed(1).padStart(5) + '%';
const f3 = v => v.toFixed(3).padStart(6);
console.log('frame         lum    dark    clip     sat   detail');
for (const r of rows) console.log(`${r.frame.padEnd(11)}${f3(r.lum)} ${pc(r.dark)} ${pc(r.clip)} ${f3(r.sat)}  ${r.detail.toFixed(4)}`);
const avg = k => rows.reduce((a, r) => a + r[k], 0) / rows.length;
console.log(`${'MEAN'.padEnd(11)}${f3(avg('lum'))} ${pc(avg('dark'))} ${pc(avg('clip'))} ${f3(avg('sat'))}  ${avg('detail').toFixed(4)}`);
