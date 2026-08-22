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

// ---- drift VFX: present, but not a blown blob ------------------------------------------------
// driftCorner is shot mid-drift. Require some bright/saturated effect pixels near the kart, and
// require that they do NOT form a large near-white mass — that is the blob failure mode.
if (fs.existsSync(`${DIR}/driftCorner.png`)) {
  const p = read('driftCorner.png');
  let effect = 0, blown = 0, n = 0;
  for (let y = p.height * 0.55 | 0; y < p.height * 0.98; y += 2)
    for (let x = p.width * 0.30 | 0; x < p.width * 0.75; x += 2) {
      const c = px(p, x, y), L = luma(c), { sat, blueBias } = chroma(c);
      n++;
      if (L > 150 && (sat > 0.22 || blueBias > 22)) effect++;   // sparks / lit smoke
      if (L > 243 && sat < 0.10) blown++;                        // flat near-white mass
    }
  check('drift VFX present', effect / n > 0.004, `${(effect / n * 100).toFixed(2)}% effect pixels (>0.40%)`);
  check('drift VFX not blown', blown / n < 0.030, `${(blown / n * 100).toFixed(2)}% flat-white pixels (<3.0%)`);
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
