/**
 * Frame regression guard.
 *
 * Three defects in this project keep oscillating between opposite failure modes: the drift VFX
 * (blown white blob <-> absent), the kart contact shadow (present <-> gone) and the road surface
 * (neutral tarmac <-> a blue/violet cast). Each has been "fixed", verified, and then broken again
 * by a later agent working a different brief on the same file.
 *
 * Eyeballing catches these only if someone remembers to look. This measures them instead, so a
 * regression fails loudly:
 *
 *   node tools/guard.mjs [shotsDir]        # default shots/review
 *
 * Exits non-zero if any check fails. Run it after every shoot.
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const DIR = process.argv[2] || 'shots/review';
const read = f => PNG.sync.read(fs.readFileSync(`${DIR}/${f}`));
const px = (p, x, y) => { const i = (y * p.width + x) * 4; return [p.data[i], p.data[i + 1], p.data[i + 2]]; };
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Saturation and hue-family of a mean colour, on 0..255 channels. */
function chroma([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return { sat: mx === 0 ? 0 : (mx - mn) / mx, blueBias: b - (r + g) / 2 };
}
function meanRegion(p, x0, y0, x1, y1, step = 3) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const c = px(p, x, y); r += c[0]; g += c[1]; b += c[2]; n++;
  }
  return [r / n, g / n, b / n];
}

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

// ---- road colour: the tarmac must read neutral, not blue ------------------------------------
// The road fills the lower-centre of every chase frame. A blue cast there is the "choppy water"
// regression; real sun-bleached asphalt sits near-neutral with a slight warm or cool tint.
for (const f of ['villageStreet.png', 'driftCorner.png', 'oliveGrove.png']) {
  if (!fs.existsSync(`${DIR}/${f}`)) continue;
  const p = read(f);
  const m = meanRegion(p, p.width * 0.10 | 0, p.height * 0.72 | 0, p.width * 0.40 | 0, p.height * 0.95 | 0);
  const { blueBias, sat } = chroma(m);
  check(`road neutral (${f})`, blueBias < 14 && sat < 0.30,
    `mean rgb ${m.map(v => v.toFixed(0)).join(',')}  blueBias ${blueBias.toFixed(1)} (<14)  sat ${sat.toFixed(2)} (<0.30)`);
}

// ---- contact shadow: NOT CHECKED ------------------------------------------------------------
// A naive "is the ground under the kart darker than the road beside it" test measures the kart's
// own bodywork, not its shadow, and returns a confident PASS while the critics correctly report
// no shadow at all. A check that green-lights a live regression is worse than no check, so this
// one is deliberately absent until it can be done properly — e.g. by rendering a known frame
// twice with the shadow pass forced on and off and diffing, rather than by sampling pixels.

// ---- drift VFX: present, but not a blown blob -----------------------------------------------
// driftCorner is shot mid-drift. Two things must hold at once, because this effect has swung
// between opposite failure modes five times: some lit effect pixels must exist near the kart,
// AND they must not form one large near-white mass.
//
// Counting the *fraction* of near-white pixels does not work: white kart liveries and the
// red-and-white kerb stripes are legitimately near-white and put the total over any useful
// threshold, which produced a false alarm on a frame whose drift smoke was perfectly fine.
// A blowout is distinguished by being ONE CONTIGUOUS MASS, so measure the largest connected
// component instead of the total.
if (fs.existsSync(`${DIR}/driftCorner.png`)) {
  const p = read('driftCorner.png');
  const x0 = p.width * 0.28 | 0, x1 = p.width * 0.78 | 0;
  const y0 = p.height * 0.50 | 0, y1 = p.height * 0.99 | 0;
  const w = x1 - x0, h = y1 - y0;
  const white = new Uint8Array(w * h);
  let effect = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const c = px(p, x, y), L = luma(c), { sat, blueBias } = chroma(c);
    n++;
    if (L > 150 && (sat > 0.22 || blueBias > 22)) effect++;      // sparks / lit smoke
    if (L > 243 && sat < 0.10) white[(y - y0) * w + (x - x0)] = 1;
  }
  // Largest connected component of near-white, 4-connected, iterative flood fill.
  let biggest = 0;
  const stack = [];
  for (let i = 0; i < white.length; i++) {
    if (white[i] !== 1) continue;
    let size = 0; stack.length = 0; stack.push(i); white[i] = 2;
    while (stack.length) {
      const j = stack.pop(); size++;
      const jx = j % w, jy = (j / w) | 0;
      if (jx > 0     && white[j - 1] === 1) { white[j - 1] = 2; stack.push(j - 1); }
      if (jx < w - 1 && white[j + 1] === 1) { white[j + 1] = 2; stack.push(j + 1); }
      if (jy > 0     && white[j - w] === 1) { white[j - w] = 2; stack.push(j - w); }
      if (jy < h - 1 && white[j + w] === 1) { white[j + w] = 2; stack.push(j + w); }
    }
    if (size > biggest) biggest = size;
  }
  check('drift VFX present', effect / n > 0.004, `${(effect / n * 100).toFixed(2)}% effect pixels (>0.40%)`);
  check('drift VFX not blown', biggest / n < 0.020,
    `largest contiguous white mass ${(biggest / n * 100).toFixed(2)}% of the region (<2.0%)`);
}

// ---- global exposure: no large clipped region in any frame -----------------------------------
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.png'))) {
  const p = read(f);
  let clip = 0, n = 0;
  for (let y = 0; y < p.height; y += 4) for (let x = 0; x < p.width; x += 4) {
    n++; if (luma(px(p, x, y)) > 252) clip++;
  }
  check(`exposure (${f})`, clip / n < 0.045, `${(clip / n * 100).toFixed(2)}% clipped (<4.5%)`);
}

let bad = 0;
for (const r of results) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.detail}`);
}
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
