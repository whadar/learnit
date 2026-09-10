/**
 * Handling-feel bench.
 *
 * "Feel" sounds unmeasurable, and treating it that way is why eight rounds of review never once
 * looked at it. But the things that make a kart feel good are response times, retained speed and
 * recovery behaviour, and every one of those is a number the physics already knows. This drives
 * the real src/physics/vehicle.js headlessly and prints them.
 *
 *   node tools/sim/feel.mjs
 *
 * Targets are Mario Kart 8-ish, stated per bench with the reasoning. They are opinions expressed
 * as numbers, which is the point: an opinion you can measure can be argued with and regressed
 * against, whereas "the drift feels floaty" cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createVehicle, makeFallbackTrack } from '../../src/physics/vehicle.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const { WorldData } = await import('../../src/world/worldData.js');
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/amikam.json'), 'utf8'));
const bin = fs.readFileSync(path.join(ROOT, 'public/data/amikam-height.bin'));
const real = new WorldData(json, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));

/** Flat ground isolates the handling from terrain slope. */
const flat = Object.create(real);
flat.heightAt = () => 80;
flat.normalAt = (x, z, o = { x: 0, y: 1, z: 0 }) => { o.x = 0; o.y = 1; o.z = 0; return o; };
flat.slopeAt = () => 0;
/**
 * A long straight, 14 m wide.
 *
 * makeFallbackTrack() is a tight test loop, so a kart on it is permanently cornering: with it
 * as the substrate "top speed" measured 39.8 km/h and "steering response" measured a kart that
 * was already turning. Handling benches need a neutral straight to perturb from — the same
 * substrate tools/sim/vehicle.mjs uses for exactly this reason.
 */
function straightTrack(w, surface = 'tarmac', width = 14) {
  const L = 6000, y = w.heightAt(0, 0);
  const sample = s => ({
    pos: { x: 0, y, z: ((s % L) + L) % L - L / 2 },
    tangent: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 },
    width, banking: 0, surface,
  });
  return {
    length: L, sample,
    nearest: p => ({ s: (((p.z + L / 2) % L) + L) % L, lateral: p.x, onTrack: Math.abs(p.x) <= width / 2, surface }),
    checkpoints: [], startGrid: [{ pos: { x: 0, y, z: 0 }, rot: 0 }], boostPads: [], itemBoxes: [], laps: 3, spline: [],
  };
}
const track = straightTrack(flat);
const loopTrack = makeFallbackTrack(flat);   // unused by the benches; kept for reference
// A drift curves by definition, so a sustained one always exits the side of a 14 m straight.
// The drift benches run on a wide apron instead — same surface, no artificial edge to fall off.
const apron = straightTrack(flat, 'tarmac', 260);
const mkApron = () => {
  const k = createVehicle(flat, apron, {});
  const p = apron.sample(60);
  k.reset({ x: p.pos.x, y: p.pos.y + 0.4, z: p.pos.z }, Math.atan2(p.tangent.x, p.tangent.z));
  return k;
};
const launchApron = (k, seconds = 6) => {
  for (let i = 0; i < seconds * 120; i++) k.update(DT, { throttle: 1, brake: 0, steer: 0, drift: 0 });
  return k;
};
const onApron = k => { const n = apron.nearest(k.state.pos); return n.onTrack && Math.abs(n.lateral) < 125; };

const DT = 1 / 120;
const kmh = v => v * 3.6;

/**
 * A kart placed ON the ribbon, pointing along it.
 *
 * This matters more than it looks: the first version of this bench used the default spawn, and
 * a trace showed the kart sitting 30 m off the track on `crop` surface, getting auto-respawned
 * mid-measurement. Three "drift" failures and an "offroad" failure were all that respawn. Start
 * on the road or measure nothing.
 */
function mk(s = 60) {
  const k = createVehicle(flat, track, {});
  const p = track.sample(s);
  k.reset({ x: p.pos.x, y: p.pos.y + 0.4, z: p.pos.z }, Math.atan2(p.tangent.x, p.tangent.z));
  return k;
}

/** Guard every bench: if the kart wandered off the ribbon the number measures a respawn. */
function onTrack(k) {
  const n = track.nearest ? track.nearest(k.state.pos) : null;
  return !n || (n.onTrack && Math.abs(n.lateral) < 6);
}

const results = [];
function bench(name, target, fn) {
  let out;
  try { out = fn(); } catch (e) { out = { value: NaN, unit: '', note: 'threw: ' + e.message }; }
  const pass = out.pass ?? (out.value >= target.lo && out.value <= target.hi);
  results.push({ name, pass, ...out, target });
  const val = Number.isFinite(out.value) ? out.value.toFixed(out.dp ?? 2) : 'n/a';
  console.log(`${pass ? '[ ok ]' : '[FAIL]'} ${name.padEnd(42)} ${String(val).padStart(7)} ${out.unit.padEnd(6)}`
    + ` target ${target.lo}-${target.hi}${out.note ? '  — ' + out.note : ''}`);
}

/** Run to a steady speed before the measurement starts. */
function launch(k, seconds = 6) {
  // On a straight, no correction is needed — and adding any would contaminate the very yaw
  // measurements these benches take.
  for (let i = 0; i < seconds * 120; i++) k.update(DT, { throttle: 1, brake: 0, steer: 0, drift: 0 });
  return k;
}

/* -------------------------------------------------------------- steering response --- */
// How long from asking for a turn to getting 90% of the yaw rate it settles at. Too quick and
// the kart feels twitchy and hard to hold a line with; too slow and it feels like steering a
// boat. Kart racers live around a fifth of a second.
bench('steering response (to 90% yaw rate)', { lo: 0.06, hi: 0.32 }, () => {
  const k = launch(mk());
  const yaws = [];
  for (let i = 0; i < 2.5 * 120; i++) {
    k.update(DT, { throttle: 1, brake: 0, steer: -1, drift: 0 });
    yaws.push(Math.abs(k.state.angVel.y));
  }
  const settled = yaws.slice(-60).reduce((a, b) => a + b, 0) / 60;
  const idx = yaws.findIndex(y => y >= settled * 0.9);
  return { value: idx < 0 ? NaN : idx * DT, unit: 's', dp: 3, note: `settles at ${settled.toFixed(2)} rad/s` };
});

/* ------------------------------------------------------------------ self-centring --- */
// Release the stick and the kart should straighten by itself, promptly but without snapping.
bench('recentre after release', { lo: 0.10, hi: 0.60 }, () => {
  const k = launch(mk());
  for (let i = 0; i < 1.5 * 120; i++) k.update(DT, { throttle: 1, steer: -1 });
  let t = 0;
  const start = Math.abs(k.state.angVel.y);
  for (let i = 0; i < 3 * 120; i++) {
    k.update(DT, { throttle: 1, steer: 0 });
    t += DT;
    if (Math.abs(k.state.angVel.y) < start * 0.1) break;
  }
  return { value: t, unit: 's', dp: 3 };
});

/* ------------------------------------------------------------------------- drift --- */
// A drift must be a controllable slide: it should reach a stable body-slip angle rather than
// spinning, and it should hold most of the entry speed or it is never worth taking.
bench('drift settles to a stable angle', { lo: 12, hi: 34 }, () => {
  const k = launchApron(mkApron());
  const entry = k.speed;
  const slips = [];
  for (let i = 0; i < 3 * 120; i++) {
    k.update(DT, { throttle: 1, steer: -0.85, drift: 1 });
    if (!onApron(k)) return { value: NaN, unit: 'deg', pass: false, note: 'left the apron — bench invalid, not a game defect' };
    slips.push(Math.abs(k.state.driftSlipDeg || 0));
  }
  const tail = slips.slice(-90);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const spread = Math.max(...tail) - Math.min(...tail);
  return {
    value: mean, unit: 'deg', dp: 1,
    pass: mean >= 12 && mean <= 34 && spread < 8,
    note: `spread ${spread.toFixed(1)} deg (needs <8 to count as stable), entry ${kmh(entry).toFixed(0)} km/h`,
  };
});

bench('drift keeps entry speed', { lo: 55, hi: 90 }, () => {
  const k = launchApron(mkApron());
  const entry = k.speed;
  for (let i = 0; i < 3 * 120; i++) {
    k.update(DT, { throttle: 1, steer: -0.85, drift: 1 });
    if (!onApron(k)) return { value: NaN, unit: '%', pass: false, note: 'left the apron — bench invalid, not a game defect' };
  }
  return { value: (k.speed / entry) * 100, unit: '%', dp: 1, note: `${kmh(entry).toFixed(0)} -> ${kmh(k.speed).toFixed(0)} km/h` };
});

bench('counter-steer straightens the drift', { lo: 0.15, hi: 1.0 }, () => {
  // Full opposite lock must measurably reduce the slide, or the drift is not really steerable.
  const k = launchApron(mkApron());
  for (let i = 0; i < 1.5 * 120; i++) k.update(DT, { throttle: 1, steer: -0.85, drift: 1 });
  const locked = Math.abs(k.state.driftSlipDeg || 0);
  for (let i = 0; i < 1.2 * 120; i++) k.update(DT, { throttle: 1, steer: +0.85, drift: 1 });
  const countered = Math.abs(k.state.driftSlipDeg || 0);
  const drop = locked > 0 ? (locked - countered) / locked : 0;
  return { value: drop, unit: 'frac', dp: 3, note: `${locked.toFixed(1)} -> ${countered.toFixed(1)} deg` };
});

/* -------------------------------------------------------------------- acceleration --- */
bench('0 to 50 km/h', { lo: 0.8, hi: 3.5 }, () => {
  const k = mk();
  let t = 0;
  while (kmh(k.speed) < 50 && t < 12) { k.update(DT, { throttle: 1 }); t += DT; }
  return { value: t, unit: 's', dp: 2, note: t >= 12 ? 'never reached 50' : '' };
});

bench('top speed', { lo: 60, hi: 130 }, () => {
  const k = launch(mk(), 20);
  return { value: kmh(k.speed), unit: 'km/h', dp: 1 };
});

bench('braking 60 km/h to stop', { lo: 8, hi: 45 }, () => {
  const k = launch(mk(), 20);
  let dist = 0, t = 0;
  while (k.speed > 0.6 && t < 10) {
    const p = { x: k.state.pos.x, z: k.state.pos.z };
    k.update(DT, { throttle: 0, brake: 1 });
    dist += Math.hypot(k.state.pos.x - p.x, k.state.pos.z - p.z);
    t += DT;
  }
  return { value: dist, unit: 'm', dp: 1, note: `in ${t.toFixed(2)} s` };
});

/* ------------------------------------------------------------------------ recovery --- */
// Running wide onto the verge should cost speed but must not be a death sentence.
bench('offroad speed penalty', { lo: 10, hi: 55 }, () => {
  const road = launch(mk(), 20).speed;
  // Leave the 14 m ribbon sideways, then straighten and hold throttle on the verge.
  const k = launch(mk(), 6);
  for (let i = 0; i < 1.4 * 120; i++) k.update(DT, { throttle: 1, steer: -0.6 });
  for (let i = 0; i < 5 * 120; i++) k.update(DT, { throttle: 1, steer: 0 });
  const off = k.speed;
  return { value: (1 - off / road) * 100, unit: '%', dp: 1, note: `${kmh(road).toFixed(0)} on road vs ${kmh(off).toFixed(0)} off` };
});

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} feel benches within target`);
if (failed) {
  console.log('\nA failing bench is not automatically a bug — the targets are opinions expressed as');
  console.log('numbers. But it is a claim about the game that someone can now argue with.');
}
process.exit(failed ? 1 : 0);
