/**
 * Headless kart-physics bench. No rendering: runs the real src/physics/vehicle.js against the
 * real terrain and prints hard numbers so the feel can be tuned against targets rather than vibes.
 *
 *   node tools/sim/vehicle.mjs            # full bench
 *   node tools/sim/vehicle.mjs laps       # just the lap test
 *   SIM_HZ=120 node tools/sim/vehicle.mjs # frame rate the game loop would run at
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createVehicle, makeFallbackTrack, DEFAULTS } from '../../src/physics/vehicle.js';
import { SURFACES } from '../../src/physics/collision.js';
import { clamp, lerp, wrapPi } from '../../src/core/mathx.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const FPS = +(process.env.SIM_HZ || 60);
const DT = 1 / FPS;
const only = process.argv[2] || 'all';

/* ---------------------------------------------------------------- world ---- */
async function loadWorld() {
  try {
    const { WorldData } = await import('../../src/world/worldData.js');
    const base = fs.existsSync(path.join(ROOT, 'public/data/amikam.json'))
      ? path.join(ROOT, 'public/data') : path.join(ROOT, 'dist/data');
    const json = JSON.parse(fs.readFileSync(path.join(base, 'amikam.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(base, 'amikam-height.bin'));
    const heights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const w = new WorldData(json, heights);
    if (!Number.isFinite(w.heightAt(0, 0))) throw new Error('bad heightfield');
    return w;
  } catch (e) {
    console.log('! real world unavailable (' + e.message + ') — using a synthetic heightfield');
    const res = 512, extent = 3072, step = extent / res;
    const heights = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = -extent / 2 + i * step, z = -extent / 2 + j * step;
      heights[j * res + i] = 100 + 8 * Math.sin(x / 260) * Math.cos(z / 310) + 3 * Math.sin(x / 70);
    }
    const half = extent / 2;
    const gridH = (i, j) => heights[clamp(j, 0, res - 1) * res + clamp(i, 0, res - 1)];
    return {
      res, extent, step, half, minH: 80, maxH: 130, buildings: [], roads: [], landuse: [], landcover: [], water: [],
      heightAt(x, z) {
        const fx = (x + half) / step, fz = (z + half) / step;
        const i = Math.floor(fx), j = Math.floor(fz), sx = fx - i, sz = fz - j;
        return (gridH(i, j) * (1 - sx) + gridH(i + 1, j) * sx) * (1 - sz) + (gridH(i, j + 1) * (1 - sx) + gridH(i + 1, j + 1) * sx) * sz;
      },
      normalAt(x, z, o = {}) { const d = step; const nx = this.heightAt(x - d, z) - this.heightAt(x + d, z), nz = this.heightAt(x, z - d) - this.heightAt(x, z + d), ny = 2 * d; const l = Math.hypot(nx, ny, nz); o.x = nx / l; o.y = ny / l; o.z = nz / l; return o; },
      inBounds(x, z) { return Math.abs(x) < half && Math.abs(z) < half; },
    };
  }
}

async function loadTrack(world) {
  try {
    const m = await import('../../src/track/track.js');
    const t = m.buildTrack(world, {});
    t.sample(0); t.nearest({ x: 0, y: 0, z: 0 });
    console.log('  track: src/track/track.js  length=' + t.length.toFixed(0) + ' m');
    return t;
  } catch (e) {
    const t = makeFallbackTrack(world, { seed: 7 });
    console.log('  track: fallback loop        length=' + t.length.toFixed(0) + ' m  (src/track/track.js not ready)');
    return t;
  }
}

/* ---------------------------------------------------------------- driver ---- */
/** A simple centre-line-following auto-driver: enough to expose the physics, not a racing AI. */
const DRIFT_BIAS = DEFAULTS.driftInnerBias, DRIFT_RANGE = DEFAULTS.driftSteerRange;
function makeDriver(track, kart, o = {}) {
  const P = Object.assign({ latAccel: 13.5, aim: 1.0, driftMin: 0.20, driftHold: 0.22, useDrift: true }, o);
  let driftTimer = 0, driftLatch = false, driftDir = 0;
  return function drive(dt) {
    const st = kart.state;
    const nr = track.nearest(st.pos);
    const spd = Math.max(st.forwardSpeed, 0);
    const look = clamp(7 + spd * 1.05, 9, 30);
    const a = track.sample(nr.s + look);
    const dx = a.pos.x - st.pos.x, dz = a.pos.z - st.pos.z;
    const want = Math.atan2(dx, dz);
    let err = wrapPi(want - st.yaw);
    // pull back toward the centre line
    err -= clamp(nr.lateral / 14, -0.4, 0.4) * 0.45;
    // pure-pursuit-ish steering with yaw-rate damping: without the damping term the
    // controller saturates and over-rotates the moment a drift starts.
    let steer = clamp(err * (1.9 * P.aim) - st.angVel.y * 0.30, -1, 1);
    const k = kart;

  // While drifting the kart applies its own lock, so invert that mapping: feed the amount of
  // counter-steer that lands on the lock this driver actually wants. Without this any AI
  // (or scripted scene) over-rotates the moment a drift starts and runs off the road.
  if (k.drifting) {
    const dd = k.state.drift.dir || 1;
    const want = clamp(steer * dd, -1, 1);
    steer = dd * clamp((want - DRIFT_BIAS) / DRIFT_RANGE, -1, 1);
  }

    // corner speed from the curvature of the next stretch
    let kmax = 0;
    for (let d = 8; d < 60; d += 8) {
      const p0 = track.sample(nr.s + d - 6), p1 = track.sample(nr.s + d), p2 = track.sample(nr.s + d + 6);
      const h0 = Math.atan2(p1.pos.x - p0.pos.x, p1.pos.z - p0.pos.z);
      const h1 = Math.atan2(p2.pos.x - p1.pos.x, p2.pos.z - p1.pos.z);
      kmax = Math.max(kmax, Math.abs(wrapPi(h1 - h0)) / 6);
    }
    const vmax = kmax > 1e-4 ? Math.sqrt(P.latAccel / kmax) : 999;
    let throttle = 1, brake = 0;
    if (spd > vmax * 1.06) { throttle = 0; brake = clamp((spd - vmax) / 5, 0, 1); }
    else if (spd > vmax * 0.98) throttle = 0.35;

    // drift through sustained tight corners
    if (P.useDrift) {
      // commit only once the steering has held one direction: hopping into a drift on a
      // transient correction points the slide out of the corner
      const sgn = Math.sign(steer) || 0;
      const tight = Math.abs(steer) > P.driftMin && spd > 12 && Math.abs(nr.lateral) < 4.5;
      if (tight && (driftDir === sgn || driftTimer === 0)) { driftTimer += dt; driftDir = sgn; }
      else { driftTimer = 0; driftDir = 0; }
      if (!driftLatch && driftTimer > P.driftHold) driftLatch = true;
      if (driftLatch && (spd < 8 || !nr.onTrack || Math.abs(nr.lateral) > 5.0)) driftLatch = false;
    }
    return { throttle, brake, steer, drift: driftLatch ? 1 : 0, item: 0, look: 0 };
  };
}

/* ---------------------------------------------------------------- helpers ---- */
const fmt = (v, n = 2) => (Math.round(v * 10 ** n) / 10 ** n).toFixed(n);
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function row(k, v, note = '') { console.log('  ' + k.padEnd(34) + String(v).padStart(10) + (note ? '   ' + note : '')); }

/* ---------------------------------------------------------------- tests ---- */
async function main() {
  head('SETUP');
  const world = await loadWorld();
  const track = await loadTrack(world);
  console.log('  sim rate: ' + FPS + ' Hz frames, ' + DEFAULTS.hz + ' Hz physics');

  const mk = (o = {}) => createVehicle(world, track, o);

  /* ---- 1. straight line ---- */
  if (only === 'all' || only === 'accel') {
    head('1. STRAIGHT LINE (flat tarmac plane, no track)');
    const flat = flatWorld(world);
    const k = createVehicle(flat, straightTrack(flat), {});
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    let t = 0, top = 0, t50 = -1, t90 = -1, t98 = -1;
    const target = DEFAULTS.topSpeed;
    while (t < 14) {
      k.update(DT, { throttle: 1, brake: 0, steer: 0, drift: 0 });
      t += DT; top = Math.max(top, k.speed);
      if (t50 < 0 && k.speed >= target * 0.5) t50 = t;
      if (t90 < 0 && k.speed >= target * 0.9) t90 = t;
      if (t98 < 0 && k.speed >= target * 0.98) t98 = t;
    }
    row('top speed', fmt(top) + ' m/s', fmt(top * 3.6) + ' km/h  (target 22-28)');
    row('0 -> 50% top', t50 > 0 ? fmt(t50) + ' s' : 'n/a');
    row('0 -> 90% top', t90 > 0 ? fmt(t90) + ' s' : 'n/a');
    row('0 -> 98% top', t98 > 0 ? fmt(t98) + ' s' : 'n/a', 'target ~2.5 s to top');
    // launch wheelspin
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    let maxSlip = 0;
    for (let i = 0; i < 40; i++) { k.update(DT, { throttle: 1, steer: 0 }); maxSlip = Math.max(maxSlip, Math.abs(k.wheels[3].slipRatio)); }
    row('launch peak slip ratio (rear)', fmt(maxSlip), 'wheelspin off the line');
    // braking
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 60 * 8; i++) k.update(DT, { throttle: 1, steer: 0 });
    const v0 = k.speed; let dist = 0, tb = 0;
    while (k.speed > 0.5 && tb < 8) { const p = k.state.pos.z; k.update(DT, { throttle: 0, brake: 1, steer: 0 }); dist += Math.abs(k.state.pos.z - p); tb += DT; }
    row('brake ' + fmt(v0, 1) + ' -> 0', fmt(tb) + ' s', fmt(dist) + ' m');
    // boost payoff
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 60 * 8; i++) k.update(DT, { throttle: 1, steer: 0 });
    const base = k.speed;
    k.addBoost(1.7, DEFAULTS.boostPower[2], 'test');
    let boostTop = 0;
    for (let i = 0; i < 60 * 2; i++) { k.update(DT, { throttle: 1, steer: 0 }); boostTop = Math.max(boostTop, k.speed); }
    row('ultra mini-turbo top speed', fmt(boostTop) + ' m/s', '+' + fmt(boostTop - base) + ' over ' + fmt(base));
  }

  /* ---- 2. surfaces ---- */
  if (only === 'all' || only === 'surface') {
    head('2. SURFACE COST (steady-state speed, full throttle, 12 s)');
    const flat = flatWorld(world);
    for (const name of ['tarmac', 'kerb', 'dirt_track', 'dirt', 'gravel', 'grass', 'orchard', 'soil', 'sand']) {
      const k = createVehicle(flat, straightTrack(flat, name), {});
      k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
      for (let i = 0; i < 12 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
      const s = SURFACES[name];
      row(name, fmt(k.speed) + ' m/s', 'grip ' + s.grip + '  top x' + s.top + '  surf=' + k.surface);
    }
    // transition cost
    head('   off-track transition (leaving the ribbon at speed)');
    const flat2 = flatWorld(world);
    const k2 = createVehicle(flat2, straightTrack(flat2, 'tarmac', 26), {});
    k2.reset({ x: 0, y: flat2.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 10 * FPS; i++) k2.update(DT, { throttle: 1, steer: 0 });
    const vOn = k2.speed;
    // steer off the ribbon
    let t = 0, vAfter1 = 0, vMin = 99;
    while (t < 3.0) { k2.update(DT, { throttle: 1, steer: 0.0 }); k2.state.pos.x += 70 * DT * (t < 0.5 ? 1 : 0); t += DT; if (Math.abs(t - 1.5) < DT) vAfter1 = k2.speed; vMin = Math.min(vMin, k2.speed); }
    row('on tarmac', fmt(vOn) + ' m/s', 'surface now: ' + k2.surface);
    row('1.5 s after leaving', fmt(vAfter1) + ' m/s', 'loss ' + fmt((1 - vAfter1 / vOn) * 100, 1) + '%');
    row('settled off-track', fmt(k2.speed) + ' m/s', 'loss ' + fmt((1 - k2.speed / vOn) * 100, 1) + '%');
  }

  /* ---- 3. drift ---- */
  if (only === 'all' || only === 'drift') {
    head('3. DRIFT / MINI-TURBO');
    const flat = flatWorld(world);
    const k = createVehicle(flat, straightTrack(flat, 'tarmac', 400), {});
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 6 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
    const entrySpeed = k.speed;
    let t = 0, tHop = -1, tDrift = -1, tier = [0, -1, -1, -1], maxSlipAng = 0, minSpeed = 99, peakYaw = 0;
    while (t < 6) {
      k.update(DT, { throttle: 1, steer: 0.85, drift: 1 });
      t += DT;
      if (tHop < 0 && !k.grounded) tHop = t;
      if (tDrift < 0 && k.drifting) tDrift = t;
      if (k.drifting) {
        for (let i = 1; i <= 3; i++) if (tier[i] < 0 && k.driftTier >= i) tier[i] = t - tDrift;
        maxSlipAng = Math.max(maxSlipAng, Math.abs(Math.atan2(k.state.lateralSpeed, Math.abs(k.state.forwardSpeed) + 0.1)));
        minSpeed = Math.min(minSpeed, k.speed);
        peakYaw = Math.max(peakYaw, Math.abs(k.state.angVel.y));
      }
      if (tier[3] > 0) break;
    }
    row('entry speed', fmt(entrySpeed) + ' m/s');
    row('hop at', tHop > 0 ? fmt(tHop, 3) + ' s' : 'no hop');
    row('drift engaged at', tDrift > 0 ? fmt(tDrift, 3) + ' s' : 'NEVER', 'after drift pressed');
    row('mini-turbo   (tier 1)', tier[1] > 0 ? fmt(tier[1]) + ' s' : 'n/a', 'threshold ' + DEFAULTS.driftTiers[0] + ' s');
    row('super  (tier 2)', tier[2] > 0 ? fmt(tier[2]) + ' s' : 'n/a', 'threshold ' + DEFAULTS.driftTiers[1] + ' s');
    row('ultra  (tier 3)', tier[3] > 0 ? fmt(tier[3]) + ' s' : 'n/a', 'threshold ' + DEFAULTS.driftTiers[2] + ' s');
    // settle for another second at full lock and read the steady state
    let ssSlip = 0, ssSpeed = 0, nss = 0;
    for (let i = 0; i < 1.2 * FPS; i++) {
      k.update(DT, { throttle: 1, steer: 0.85, drift: 1 });
      if (i > 0.7 * FPS) { ssSlip += Math.abs(Math.atan2(k.state.lateralSpeed, Math.abs(k.state.forwardSpeed) + 0.1)); ssSpeed += k.speed; nss++; }
    }
    ssSlip /= Math.max(nss, 1); ssSpeed /= Math.max(nss, 1);
    row('drift slip angle (peak)', fmt(maxSlipAng * 180 / Math.PI, 1) + ' deg', 'transient');
    row('drift slip angle (settled)', fmt(ssSlip * 180 / Math.PI, 1) + ' deg', 'MK-ish target 18-32 deg');
    row('settled full-lock drift speed', fmt(ssSpeed) + ' m/s', fmt(ssSpeed / entrySpeed * 100, 1) + '% of entry (want 55-75%)');
    row('lowest speed in drift', fmt(minSpeed) + ' m/s', fmt(minSpeed / entrySpeed * 100, 1) + '% of entry');
    row('peak yaw rate in drift', fmt(peakYaw) + ' rad/s');
    // release -> boost
    const vRelease = k.speed;
    let vBoost = 0, tb = 0;
    while (tb < 2.0) { k.update(DT, { throttle: 1, steer: 0, drift: 0 }); tb += DT; vBoost = Math.max(vBoost, k.speed); }
    row('speed at release', fmt(vRelease) + ' m/s');
    row('speed after ultra boost', fmt(vBoost) + ' m/s', '+' + fmt(vBoost - vRelease));
    // counter-steer authority
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 6 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
    for (let i = 0; i < 1.6 * FPS; i++) k.update(DT, { throttle: 1, steer: 0.9, drift: 1 });
    let yawIn = 0, nIn = 0; const wIn = Math.round(0.3 * FPS);
    for (let i = 0; i < 0.7 * FPS; i++) { k.update(DT, { throttle: 1, steer: 1.0, drift: 1 }); if (i >= 0.7 * FPS - wIn) { yawIn += Math.abs(k.state.angVel.y); nIn++; } }
    let yawOut = 0, nOut = 0;
    for (let i = 0; i < 0.9 * FPS; i++) { k.update(DT, { throttle: 1, steer: -1.0, drift: 1 }); if (i >= 0.9 * FPS - wIn) { yawOut += Math.abs(k.state.angVel.y); nOut++; } }
    yawIn /= Math.max(nIn, 1); yawOut /= Math.max(nOut, 1);
    // controllability: the same drift held at three steering positions
    const hold = (st) => {
      k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
      for (let i = 0; i < 5 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
      for (let i = 0; i < 1.4 * FPS; i++) k.update(DT, { throttle: 1, steer: 0.8, drift: 1 });
      let sl = 0, sp = 0, n = 0;
      for (let i = 0; i < 1.6 * FPS; i++) {
        k.update(DT, { throttle: 1, steer: st, drift: 1 });
        if (i > 1.0 * FPS) { sl += Math.abs(Math.atan2(k.state.lateralSpeed, Math.abs(k.state.forwardSpeed) + 0.1)); sp += k.speed; n++; }
      }
      return [sl / n * 180 / Math.PI, sp / n];
    };
    for (const [label, st] of [['full inward (+1)', 1], ['neutral (0)', 0], ['counter (-1)', -1]]) {
      const [sl, sp] = hold(st);
      row('drift slip @ ' + label, fmt(sl, 1) + ' deg', fmt(sp) + ' m/s');
    }
    row('yaw rate, steering in', fmt(yawIn) + ' rad/s');
    row('yaw rate, counter-steering', fmt(yawOut) + ' rad/s', 'ratio ' + fmt(yawOut / (yawIn || 1), 2));
  }

  /* ---- 4. air, tricks, landing ---- */
  if (only === 'all' || only === 'air') {
    head('4. AIR / TRICK / LANDING');
    const flat = flatWorld(world);
    const k = createVehicle(flat, straightTrack(flat, 'tarmac', 800), {});
    const launch = (trick) => {
      k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
      for (let i = 0; i < 8 * FPS; i++) k.update(DT, { throttle: 0.55, steer: 0 });
      const v0 = k.speed;
      k.state.vel.y += 8.0;
      let t = 0, air = 0, tricked = false;
      while (t < 4) {
        const inp = { throttle: 0.55, steer: 0, drift: (trick && !tricked && k.state.airTime > 0.2) ? 1 : 0 };
        k.update(DT, inp);
        if (inp.drift) tricked = true;
        if (!k.grounded) air += DT;
        t += DT;
        if (air > 0.2 && k.grounded && t > 1.4) { for (let j = 0; j < 1.1 * FPS; j++) k.update(DT, { throttle: 0.55, steer: 0 }); break; }
      }
      return { v0, air, v1: k.speed, boost: k.state.boost.source };
    };
    const a = launch(false);
    row('clean landing (no trick)', fmt(a.v1) + ' m/s', 'entry ' + fmt(a.v0) + ', airtime ' + fmt(a.air) + ' s, keep ' + fmt(a.v1 / a.v0 * 100, 1) + '%');
    const b = launch(true);
    row('trick landing', fmt(b.v1) + ' m/s', '+' + fmt(b.v1 - a.v1) + ' m/s vs no trick (trick boost)');
    // bad landing (nose down / sideways)
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 8 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
    const v0 = k.speed; k.state.vel.y += 8; k.state.angVel.x += 3.0;
    let t = 0; while (t < 3) { k.update(DT, { throttle: 1, steer: 0 }); t += DT; if (k.grounded && t > 1.2) break; }
    row('tumbled landing', fmt(k.speed) + ' m/s', 'keep ' + fmt(k.speed / v0 * 100, 1) + '% (should cost)');
    // air steering authority
    k.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    for (let i = 0; i < 8 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
    const yaw0 = k.state.yaw; k.state.vel.y += 9;
    for (let i = 0; i < 1.2 * FPS; i++) k.update(DT, { throttle: 1, steer: 1 });
    row('air yaw authority (1.2 s)', fmt(Math.abs(wrapPi(k.state.yaw - yaw0)) * 180 / Math.PI, 1) + ' deg');
  }

  /* ---- 5. collisions ---- */
  if (only === 'all' || only === 'collide') {
    head('5. COLLISIONS');
    const flat = flatWorld(world);
    const st = straightTrack(flat, 'tarmac', 800);
    const a = createVehicle(flat, st, {}), b = createVehicle(flat, st, {});
    a.reset({ x: 0, y: flat.heightAt(0, 0), z: 0 }, 0);
    b.reset({ x: 0.6, y: flat.heightAt(0, 0), z: 9 }, 0);
    let imp = 0, va0 = 0, vb0 = 0, touched = -1, t2 = 0;
    for (let i = 0; i < 20 * FPS; i++) {
      const pre = [a.speed, b.speed];
      a.update(DT, { throttle: 1, steer: 0 }); b.update(DT, { throttle: 0.42, steer: 0 });
      const j = a.bump(b);
      if (j > imp) { imp = j; va0 = pre[0]; vb0 = pre[1]; touched = t2; }
      t2 += DT;
      if (touched >= 0 && t2 - touched > 0.35) break;
    }
    row('kart-vs-kart peak impact', fmt(imp) + ' m/s');
    row('speeds after bump', fmt(a.speed) + ' / ' + fmt(b.speed), 'before ' + fmt(va0) + ' / ' + fmt(vb0));
    row('separation', fmt(Math.hypot(a.state.pos.x - b.state.pos.x, a.state.pos.z - b.state.pos.z)) + ' m', 'no interpenetration if > 1.8');

    // wall slide, using real building footprints if present
    if (world.buildings && world.buildings.length) {
      const bld = world.buildings.find(x => x.rings && x.rings[0] && x.rings[0].length > 3);
      const ring = bld.rings[0];
      let ox = 0, oz = 0; for (const p of ring) { ox += p[0]; oz += p[1]; } ox /= ring.length; oz /= ring.length;
      let brad = 0; for (const p of ring) brad = Math.max(brad, Math.hypot(p[0] - ox, p[1] - oz));
      const k = createVehicle(world, straightTrack(world, 'tarmac', 800), { collisionOpts: { carveTrack: false } });
      k.reset({ x: ox - 45, y: world.heightAt(ox - 45, oz), z: oz + brad * 0.45 }, Math.PI / 2);
      for (let i = 0; i < 6 * FPS; i++) k.update(DT, { throttle: 1, steer: 0 });
      const vIn = k.speed;
      let t = 0, minV = 99, stuck = 0, prev = { ...k.state.pos };
      while (t < 4) {
        k.update(DT, { throttle: 1, steer: 0 });
        const moved = Math.hypot(k.state.pos.x - prev.x, k.state.pos.z - prev.z);
        if (k.state.wallImpact > 0.2) minV = Math.min(minV, k.speed);
        if (moved < 0.02 && k.state.wallImpact > 0.05) stuck += DT;
        prev = { ...k.state.pos }; t += DT;
      }
      row('wall approach speed', fmt(vIn) + ' m/s');
      row('speed during wall contact', minV < 99 ? fmt(minV) + ' m/s' : 'no contact');
      row('time stuck on wall', fmt(stuck) + ' s', 'must be ~0 (slide, never stick)');
      row('speed 4 s later', fmt(k.speed) + ' m/s');
    }

    // respawn
    const k3 = createVehicle(world, track, {});
    k3.reset();
    k3.state.pos.y += 400;
    let rt = 0; while (rt < 12 && k3.state.respawns === 0) { k3.update(DT, { throttle: 0 }); rt += DT; }
    row('respawn after fall', k3.state.respawns ? fmt(rt) + ' s' : 'NEVER');
    // upside down
    const k4 = createVehicle(world, track, {});
    k4.reset();
    k4.state.quat.x = 1; k4.state.quat.w = 0;
    let ut = 0; while (ut < 12 && k4.state.respawns === 0) { k4.update(DT, { throttle: 0 }); ut += DT; }
    row('respawn when upside down', k4.state.respawns ? fmt(ut) + ' s' : 'NEVER');
  }

  /* ---- 6. laps ---- */
  if (only === 'all' || only === 'laps') {
    head('6. LAPS on ' + (track.fallback ? 'the fallback loop' : 'src/track/track.js') + '  (' + fmt(track.length, 0) + ' m)');
    const k = mk();
    const g = track.startGrid && track.startGrid[0];
    k.reset(g?.pos, g?.rot);
    const drive = makeDriver(track, k);
    const stats = { top: 0, sum: 0, n: 0, corner: [], off: 0, drifts: 0, boosts: 0, air: 0, respawn0: k.state.respawns, minCorner: 99 };
    const laps = [];
    let t = 0, lastS = track.nearest(k.state.pos).s, lapT = 0, wrapped = 0, prevDrift = false, prevBoost = null;
    const LIMIT = 260;
    while (t < LIMIT && laps.length < 3) {
      const inp = drive(DT);
      k.update(DT, inp);
      t += DT; lapT += DT;
      const s = k.state.trackS;
      if (lastS - s > track.length * 0.6) { if (wrapped > 0) laps.push(lapT); lapT = 0; wrapped++; }
      lastS = s;
      stats.top = Math.max(stats.top, k.speed); stats.sum += k.speed; stats.n++;
      if (Math.abs(inp.steer) > 0.18 && k.speed > 4) { stats.corner.push(k.speed); stats.minCorner = Math.min(stats.minCorner, k.speed); }
      if (!k.state.onTrack) stats.off += DT;
      if (!k.grounded) stats.air += DT;
      if (k.drifting && !prevDrift) stats.drifts++;
      prevDrift = k.drifting;
      if (k.state.boost.source && k.state.boost.source !== prevBoost) stats.boosts++;
      prevBoost = k.state.boost.source;
    }
    for (let i = 0; i < laps.length; i++) row('lap ' + (i + 1), fmt(laps[i]) + ' s', fmt(track.length / laps[i]) + ' m/s avg');
    if (!laps.length) row('lap', 'INCOMPLETE', 'ran ' + fmt(t) + ' s, s=' + fmt(lastS, 0) + '/' + fmt(track.length, 0));
    row('top speed', fmt(stats.top) + ' m/s', fmt(stats.top * 3.6) + ' km/h');
    row('mean speed', fmt(stats.sum / Math.max(stats.n, 1)) + ' m/s');
    const cs = stats.corner;
    row('mean cornering speed', cs.length ? fmt(cs.reduce((a, b) => a + b, 0) / cs.length) + ' m/s' : 'n/a', cs.length ? 'min ' + fmt(stats.minCorner) : '');
    row('time off-track', fmt(stats.off) + ' s', fmt(stats.off / t * 100, 1) + '% of ' + fmt(t) + ' s');
    row('airborne', fmt(stats.air) + ' s', fmt(stats.air / t * 100, 1) + '%');
    row('drifts initiated', stats.drifts);
    row('boosts collected', stats.boosts);
    row('respawns', k.state.respawns - stats.respawn0, 'want 0');
    if (laps.length >= 2) {
      const spread = Math.max(...laps) - Math.min(...laps);
      row('lap-time spread', fmt(spread) + ' s', fmt(spread / Math.min(...laps) * 100, 1) + '% — consistency');
    }
  }

  console.log('');
}

/* ---------------------------------------------------------------- rigs ---- */
/** A perfectly flat, empty world sharing the real one's extent — for repeatable straight-line tests. */
function flatWorld(w) {
  const h = 100;
  return {
    res: w.res ?? 1024, extent: w.extent ?? 3072, step: w.step ?? 3, half: w.half ?? 1536,
    minH: h - 1, maxH: h + 1, buildings: [], roads: [], landuse: [], landcover: [], water: [],
    heightAt: () => h,
    normalAt: (x, z, o = {}) => { o.x = 0; o.y = 1; o.z = 0; return o; },
    slopeAt: () => 0,
    inBounds: (x, z) => Math.abs(x) < (w.half ?? 1536) && Math.abs(z) < (w.half ?? 1536),
  };
}
/** A dead-straight ribbon along +Z with a chosen surface. */
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

main().catch(e => { console.error(e); process.exit(1); });
