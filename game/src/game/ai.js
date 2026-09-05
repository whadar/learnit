/**
 * Kat Racing — opponent AI.
 *
 * Three layers:
 *
 *  1. `buildRacingLine(track)` — an optimised line around the circuit. A minimum-curvature
 *     relaxation inside the legal corridor produces out-in-out geometry on its own; a
 *     per-corner "late apex" shift then delays the apex of any corner that leads onto a
 *     straight, because exit speed is worth more than entry speed there. A speed profile is
 *     precomputed from curvature, banking, surface grip and gradient with a backward
 *     (braking) and forward (traction) pass, so the AI brakes at the right *distance*
 *     instead of the right *moment*.
 *
 *  2. The driver — every opponent runs the player's `createVehicle()` physics and is steered
 *     with a pure-pursuit controller plus a Stanley cross-track term, throttled from the
 *     speed profile, and drifts through hairpins to charge mini-turbos. It hunts boost pads
 *     and item boxes, uses items with some sense, dodges hazards, and overtakes by shifting
 *     its line offset rather than driving through a rival.
 *
 *     Measured, not assumed (`node tools/sim/race.mjs grip | drift`): the kart sustains about
 *     1.2 g of lateral grip on tarmac, which sets the speed profile's budget; and a slide holds
 *     only 55-75 % of its entry speed, so a drift only pays where the corner is slower than the
 *     slide anyway. Hence `driftCornerV`: the field drifts hairpins and grips everything else,
 *     which is what a quick driver does in this physics.
 *
 *  3. Personality — four difficulty tiers times per-racer traits (pace, aggression,
 *     consistency, mistake rate, preferred line offset) so a twelve-kart field argues with
 *     itself instead of running as a train. Over the top of that sits pack cohesion: the field
 *     is banded towards its own centre — a dropped kart gets target speed back, a kart running
 *     away with it gives some up — so eight karts are still racing each other on lap three
 *     instead of touring the circuit alone. It is capped at the corner's grip limit
 *     (`paceCap`) and it never touches a kart a human is driving.
 *
 *   const ai = createAI(world, track, (i, o) => createVehicle(world, track, o), { count: 11 });
 *   ai.update(dt);                       // steers and steps every AI vehicle
 *
 * No Three.js import: this file runs unchanged in the browser and in tools/sim/race.mjs.
 */
import { clamp, lerp, smoothstep, damp, wrapPi, rng } from '../core/mathx.js';
import { createVehicle, makeFallbackTrack, DEFAULTS } from '../physics/vehicle.js';
import { surfaceInfo } from '../physics/collision.js';

const G = 9.81;
const EPS = 1e-6;

/* ==================================================================== track == */

export function validTrack(t) {
  if (!t) return false;
  try {
    if (typeof t.sample !== 'function' || typeof t.nearest !== 'function') return false;
    if (!Number.isFinite(t.length) || t.length < 20) return false;
    const s = t.sample(0), n = t.nearest({ x: 0, y: 0, z: 0 });
    return !!(s && s.pos && Number.isFinite(s.pos.x) && n && Number.isFinite(n.s));
  } catch (e) { return false; }
}

/** The real course when it exists, a closed loop over the real terrain when it does not. */
export function resolveTrack(world, track, opts = {}) {
  if (validTrack(track)) return track;
  try { return makeFallbackTrack(world, opts); } catch (e) { return null; }
}

/* ============================================================== racing line == */

/**
 * @param {object} track  buildTrack() result
 * @param {object} opts   corridor + vehicle limits used to build the speed profile
 * @returns {object} line { at(s), speedAt(s), offsetAt(s), curvatureAt(s), headingAt(s), stats }
 */
export function buildRacingLine(track, opts = {}) {
  const O = Object.assign({
    ds: 3.0,               // centre-line sampling step
    margin: 1.95,          // metres of tarmac kept between the line and the edge
    minHalf: 0.8,
    iterations: 900,       // Gauss-Seidel sweeps of the min-curvature relaxation
    relax: 0.42,
    apexShift: 8.5,        // metres the apex is delayed on a corner that leads to a straight
    apexLook: 80,
    smooth: 2,
    // vehicle envelope (defaults track src/physics/vehicle.js)
    latGrip: 1.14,         // the kart measures ~1.2 g on clean tarmac (tools/sim skidpad); the line is
                           // built at ~87 % of that, because a profile with no margin left is a
                           // profile every kerb, crest and dusty apex throws into the olives.
    bankAssist: 0.55,      // how much of the banking angle is worth extra lateral grip
    accelLimit: 8.5,       // m/s^2 available for acceleration at low speed
    brakeLimit: 10.5,      // m/s^2 available for braking
    topSpeed: DEFAULTS.topSpeed,
    speedCap: 1.06,        // the profile may ask for a little more than topSpeed (boosts)
    minSpeed: 6.0,
    dragK: DEFAULTS.dragCdA / DEFAULTS.mass,
    passes: 3,
  }, opts);

  const len = track.length;
  const N = Math.max(32, Math.round(len / O.ds));
  const ds = len / N;

  const cx = new Float64Array(N), cy = new Float64Array(N), cz = new Float64Array(N);
  const nx = new Float64Array(N), nz = new Float64Array(N);
  const hw = new Float64Array(N), wid = new Float64Array(N);
  const bank = new Float64Array(N), mu = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    let sm;
    try { sm = track.sample(i * ds); } catch (e) { sm = null; }
    if (!sm || !sm.pos) sm = { pos: { x: 0, y: 0, z: 0 }, tangent: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 }, width: 12, banking: 0, surface: 'tarmac' };
    cx[i] = sm.pos.x; cy[i] = sm.pos.y; cz[i] = sm.pos.z;
    const nl = Math.hypot(sm.normal.x, sm.normal.z) || 1;
    nx[i] = sm.normal.x / nl; nz[i] = sm.normal.z / nl;
    const w = Math.max(4, sm.width || 12);
    wid[i] = w;
    hw[i] = Math.max(O.minHalf, w * 0.5 - O.margin);
    bank[i] = sm.banking || 0;
    const si = surfaceInfo(sm.surface || 'tarmac');
    mu[i] = O.latGrip * (si ? si.grip : 1);
  }

  /* ---- minimum-curvature relaxation inside the corridor ---- */
  const off = new Float64Array(N);
  for (let it = 0; it < O.iterations; it++) {
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const ax = cx[a] + nx[a] * off[a], az = cz[a] + nz[a] * off[a];
      const bx = cx[b] + nx[b] * off[b], bz = cz[b] + nz[b] * off[b];
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const t = (mx - cx[i]) * nx[i] + (mz - cz[i]) * nz[i];
      off[i] = clamp(lerp(off[i], t, O.relax), -hw[i], hw[i]);
    }
  }

  /* ---- geometry of the relaxed line ---- */
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const seg = new Float64Array(N);       // length of segment i -> i+1
  const head = new Float64Array(N);      // heading of that segment (atan2(dx, dz))
  const curv = new Float64Array(N);      // signed rad/m, positive = the way positive steer turns
  const grade = new Float64Array(N);     // sin(slope), positive = uphill

  function rebuild() {
    for (let i = 0; i < N; i++) { px[i] = cx[i] + nx[i] * off[i]; py[i] = cy[i]; pz[i] = cz[i] + nz[i] * off[i]; }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const dx = px[j] - px[i], dz = pz[j] - pz[i], dy = py[j] - py[i];
      const l = Math.hypot(dx, dz) || EPS;
      seg[i] = Math.hypot(dx, dy, dz) || EPS;
      head[i] = Math.atan2(dx, dz);
      grade[i] = dy / seg[i];
    }
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N;
      const dh = wrapPi(head[i] - head[a]);
      curv[i] = dh / (0.5 * (seg[i] + seg[a]) || EPS);
    }
    // curvature is noisy at 3 m spacing; a light smooth keeps the speed profile sane
    for (let pass = 0; pass < 2; pass++) {
      const src = Float64Array.from(curv);
      for (let i = 0; i < N; i++) curv[i] = src[(i - 1 + N) % N] * 0.25 + src[i] * 0.5 + src[(i + 1) % N] * 0.25;
    }
  }
  rebuild();

  /* ---- late apex: delay the apex of corners that lead onto a straight ---- */
  if (O.apexShift > 0) {
    const aheadK = new Float64Array(N);
    const win = Math.max(2, Math.round(O.apexLook / ds));
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = 1; k <= win; k++) sum += Math.abs(curv[(i + k) % N]);
      aheadK[i] = sum / win;
    }
    let kRef = 0;
    for (let i = 0; i < N; i++) kRef = Math.max(kRef, Math.abs(curv[i]));
    kRef = Math.max(kRef, 0.01);
    const shifted = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const cornerNow = clamp(Math.abs(curv[i]) / (kRef * 0.35), 0, 1);
      const straightAhead = 1 - clamp(aheadK[i] / (kRef * 0.28), 0, 1);
      const d = O.apexShift * cornerNow * straightAhead;      // metres to delay by
      // read the offset from *earlier* on the lap: the apex now arrives later
      const u = i - d / ds;
      const i0 = Math.floor(u), f = u - i0;
      const a = off[((i0 % N) + N) % N], b = off[(((i0 + 1) % N) + N) % N];
      shifted[i] = clamp(lerp(a, b, f), -hw[i], hw[i]);
    }
    off.set(shifted);
    for (let pass = 0; pass < O.smooth; pass++) {
      const src = Float64Array.from(off);
      for (let i = 0; i < N; i++) {
        off[i] = clamp(src[(i - 1 + N) % N] * 0.25 + src[i] * 0.5 + src[(i + 1) % N] * 0.25, -hw[i], hw[i]);
      }
    }
    rebuild();
  }

  /* ---- speed profile ---- */
  const vmax = new Float64Array(N);
  const cap = O.topSpeed * O.speedCap;
  for (let i = 0; i < N; i++) {
    const k = Math.abs(curv[i]);
    // banking pays for part of the lateral load; treat it as extra available mu
    const aLat = mu[i] * G * (1 + O.bankAssist * Math.abs(Math.sin(bank[i])));
    const v = k > 1e-5 ? Math.sqrt(aLat / k) : cap;
    vmax[i] = clamp(v, O.minSpeed, cap);
  }
  const spd = Float64Array.from(vmax);

  const gripCircle = (i, v) => {
    // whatever lateral grip the corner is already using is not available for accel/brake
    const aLat = Math.abs(curv[i]) * v * v;
    const total = mu[i] * G;
    return Math.sqrt(Math.max(0, total * total - aLat * aLat)) / Math.max(total, EPS);
  };
  for (let pass = 0; pass < O.passes; pass++) {
    // backward: brake early enough for the corner ahead (and note that uphill braking is easier)
    for (let n = N; n > 0; n--) {
      const i = n % N, j = (i + 1) % N;
      const frac = gripCircle(i, spd[i]);
      const a = O.brakeLimit * (0.35 + 0.65 * frac) + G * grade[i];
      const lim = Math.sqrt(Math.max(0, spd[j] * spd[j] + 2 * Math.max(a, 1.0) * seg[i]));
      if (lim < spd[i]) spd[i] = Math.max(lim, O.minSpeed);
    }
    // forward: traction and drag limit how fast the exit can be
    for (let n = 0; n < N; n++) {
      const i = n % N, h = (i - 1 + N) % N;
      const frac = gripCircle(i, spd[i]);
      const v = spd[h];
      const accel = O.accelLimit * (0.3 + 0.7 * frac) * clamp(1 - (v / cap) ** 2, 0.06, 1)
        - O.dragK * v * v - G * grade[h];
      const lim = Math.sqrt(Math.max(0, v * v + 2 * Math.max(accel, 0.15) * seg[h]));
      if (lim < spd[i]) spd[i] = Math.max(lim, O.minSpeed);
    }
  }

  /* ---- sampling ---- */
  const idx = s => {
    let u = (s / ds) % N; if (u < 0) u += N;
    const i = Math.floor(u);
    return { i, j: (i + 1) % N, f: u - i };
  };
  const _out = { x: 0, y: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0, offset: 0, curvature: 0, speed: 0, width: 12, heading: 0, radius: 1e6 };
  function at(s, out = _out) {
    const { i, j, f } = idx(s);
    out.x = lerp(px[i], px[j], f); out.y = lerp(py[i], py[j], f); out.z = lerp(pz[i], pz[j], f);
    out.nx = lerp(nx[i], nx[j], f); out.nz = lerp(nz[i], nz[j], f);
    const nl = Math.hypot(out.nx, out.nz) || 1; out.nx /= nl; out.nz /= nl;
    out.heading = head[i] + wrapPi(head[j] - head[i]) * f;
    out.tx = Math.sin(out.heading); out.tz = Math.cos(out.heading);
    out.offset = lerp(off[i], off[j], f);
    out.curvature = lerp(curv[i], curv[j], f);
    out.speed = lerp(spd[i], spd[j], f);
    out.width = lerp(wid[i], wid[j], f);
    out.radius = 1 / Math.max(Math.abs(out.curvature), 1e-5);
    return out;
  }
  const speedAt = s => { const { i, j, f } = idx(s); return lerp(spd[i], spd[j], f); };
  const offsetAt = s => { const { i, j, f } = idx(s); return lerp(off[i], off[j], f); };
  const curvatureAt = s => { const { i, j, f } = idx(s); return lerp(curv[i], curv[j], f); };
  const headingAt = s => { const { i, j, f } = idx(s); return head[i] + wrapPi(head[j] - head[i]) * f; };
  /** Signed heading change from s over `win` metres — the sign a corner steers in. */
  const turnOver = (s, win) => wrapPi(headingAt(s + win) - headingAt(s));
  /** Mean |curvature| over a window, for "is there a corner coming" questions. */
  function meanCurvature(s0, s1) {
    const n = Math.max(2, Math.round(Math.abs(s1 - s0) / ds));
    let sum = 0;
    for (let k = 0; k < n; k++) sum += Math.abs(curvatureAt(s0 + (s1 - s0) * (k / n)));
    return sum / n;
  }
  /** Signed mean curvature — which way the next `win` metres bend, on average. */
  function bend(s0, win) {
    const n = Math.max(2, Math.round(win / ds));
    let sum = 0;
    for (let k = 0; k < n; k++) sum += curvatureAt(s0 + win * (k / n));
    return sum / n;
  }

  let lineLen = 0, est = 0, vmin = Infinity, vmaxs = 0, vsum = 0, minR = Infinity;
  for (let i = 0; i < N; i++) {
    lineLen += seg[i]; est += seg[i] / Math.max(spd[i], 1);
    vmin = Math.min(vmin, spd[i]); vmaxs = Math.max(vmaxs, spd[i]); vsum += spd[i];
    minR = Math.min(minR, 1 / Math.max(Math.abs(curv[i]), 1e-5));
  }

  return {
    N, ds, length: len, lineLength: lineLen,
    offset: off, curvature: curv, speed: spd, segment: seg, heading: head, halfWidth: hw,
    point(i) { const k = ((i % N) + N) % N; return { x: px[k], y: py[k], z: pz[k] }; },
    at, speedAt, offsetAt, curvatureAt, headingAt, turnOver, meanCurvature, bend,
    stats: {
      estLap: est, minSpeed: vmin, maxSpeed: vmaxs, meanSpeed: vsum / N, minRadius: minR,
      maxOffset: Math.max(...Array.from(off, Math.abs)),
    },
  };
}

/* =============================================================== difficulty == */

/** Four tiers. `speed` scales the profile, the rest scale skill and patience. */
export const TIERS = [
  { id: 'sunday', name: 'Sunday Driver', speed: 0.855, look: 1.20, brake: 0.84, drift: 0.30, item: 0.35, mistake: 2.4, catch: 1.15, react: 0.30 },
  { id: 'club', name: 'Club Racer', speed: 0.912, look: 1.10, brake: 0.91, drift: 0.60, item: 0.60, mistake: 1.5, catch: 1.00, react: 0.20 },
  { id: 'pro', name: 'Pro', speed: 0.962, look: 1.02, brake: 0.97, drift: 0.85, item: 0.85, mistake: 0.8, catch: 0.80, react: 0.13 },
  { id: 'ace', name: 'Ace', speed: 1.000, look: 0.96, brake: 1.00, drift: 1.00, item: 1.00, mistake: 0.4, catch: 0.60, react: 0.08 },
];
export const tierByName = n => TIERS.find(t => t.id === n) || TIERS[2];

/** Difficulty presets: how the field's tiers are drawn for a 12-kart grid. */
export const DIFFICULTY = {
  50: [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2],
  100: [0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3],
  150: [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3],
  200: [2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
};

/* ==================================================================== the AI == */

/**
 * @param {object} world      WorldData
 * @param {object} track      buildTrack() result (a fallback loop is substituted if absent)
 * @param {Function} vehicleFactory (index, opts) => createVehicle(...)
 * @param {object} opts       { count, vehicles, grid, seed, items, difficulty, tiers, line }
 * @returns {{ racers: Array, update: Function }}
 */
export function createAI(world, track, vehicleFactory, opts = {}) {
  const O = Object.assign({
    count: 11,
    seed: 20250820,
    difficulty: 150,
    tiers: null,               // explicit per-racer tier indices
    items: null,               // createItemSystem() instance
    line: null,                // prebuilt racing line (shared with the race / HUD)
    lineOpts: null,
    vehicles: null,            // pre-made vehicles (race.js makes the whole field at once)
    grid: null,                // [{pos, rot}] starting slots
    ids: null, names: null, stats: null,
    vehicleOpts: {},
    // steering gains (tuned in tools/sim/race.mjs)
    aimBase: 4.6, aimGain: 0.56, aimMin: 6.0, aimMax: 21.0,
    aimCurve: 26.0,        // how hard the look-ahead shortens in a corner (see below)
    brakeAccel: 8.0,       // m/s^2 the AI plans its braking distances with (the tyres have ~10.5)
    stanley: 0.42, crossGain: 0.85, yawDamp: 0.055,
    padDetour: 3.4,        // metres off the racing line the AI will go for a boost pad
    boxDetour: 3.0,        // … or for an item box
    driftSkill: 1.0,       // global multiplier on how willing the field is to drift
    driftSteerMin: 0.24,   // sustained steering that counts as "this is a corner"
    driftHold: 0.22,       // seconds it must be held before hopping
    driftMinSpeed: 8.0,    // m/s below which a hop is pointless
    driftEntry: 0.86,      // target-speed trim while sliding
    driftCornerV: 11.0,    // only true hairpins: above this the slide costs more than the boost pays
    /* ---- pack cohesion ----
       A kart field is only worth looking at while it is still a field. The band is measured
       against the *centre of the pack*, not the leader (every kart but one is behind the
       leader, so a leader-relative band could never slow a runaway down), and it is spent on
       target speed rather than on grip: `paceCap` below keeps the fastest catching kart at the
       corner's own limit, so nobody ever asks the tyres for more than the circuit has. */
    rubberBand: true,
    packDead: 4.0,             // metres either side of the pack centre that count as "with the pack"
    packSpan: 28.0,            // … and the distance at which the band saturates
    catchMax: 0.170,           // +17 % target speed for the tail of the field …
    leadDrag: 0.130,           // … and -13 % for a kart running away with it
    packSolo: 0.60,            // how much of the band a kart keeps while wheel to wheel with a rival
    /* An autopilot hero kart — attract mode, the demo, every review plate — is not trying to
       win a race, it is the thing the camera is pointed at, and a camera subject alone on an
       empty road is a wasted shot. So when nobody is driving it, it is banded towards the
       middle of its own field this much harder than the rest of the grid, and the pack it was
       seeded in front of gets to race it. A human's kart is never touched by any of this. */
    heroBand: 1.8,
    heroDragMax: 0.175,
    paceCap: 1.02,             // hard ceiling on tier x personality x catch-up: the grip limit
    tailGap: 6.0,              // metres: inside this, square behind a rival, match its speed
    catchBoost: true,          // top-speed tow for a kart that is already flat out and dropping
    catchBoostGap: 32,         // … only this far off the pack, where a target-speed band is spent
    catchBoostPower: 0.20,
    step: true,                // call vehicle.update() ourselves
  }, opts);

  const trk = resolveTrack(world, track, { seed: O.seed }) || track;
  const len = trk.length;
  const line = O.line || buildRacingLine(trk, O.lineOpts || {});
  const rand = rng(O.seed >>> 0);

  /* ---- points of interest, resolved into track space once ---- */
  const pads = [];
  for (const p of (trk.boostPads || [])) {
    const pos = p.pos || p;
    try { const n = trk.nearest(pos); pads.push({ pos, s: n.s, lateral: n.lateral, radius: p.radius || 3.5 }); } catch (e) { /* skip */ }
  }
  const boxSlots = [];
  for (const b of (trk.itemBoxes || [])) {
    const pos = b.pos || b;
    try {
      const n = trk.nearest(pos);
      boxSlots.push({ pos, s: b.s ?? n.s, lateral: b.lateral ?? n.lateral });
    } catch (e) { /* skip */ }
  }

  const dS = (a, b) => { let d = a - b; while (d > len * 0.5) d -= len; while (d < -len * 0.5) d += len; return d; };

  /* ---- the field ---- */
  const tiers = O.tiers || (DIFFICULTY[O.difficulty] || DIFFICULTY[150]);
  const racers = [];
  for (let i = 0; i < O.count; i++) {
    const ti = clamp(Array.isArray(tiers) ? (tiers[i % tiers.length] | 0) : 2, 0, TIERS.length - 1);
    const tier = TIERS[ti];
    const r0 = rand(), r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
    const stats = O.stats?.[i] || null;
    // roster stats (0..5) nudge the personality so the grid matches the character select
    const sSpeed = stats ? (stats.speed - 3.25) / 5 : 0;
    const sHandling = stats ? (stats.handling - 3.25) / 5 : 0;
    const sDrift = stats ? (stats.drift - 3.25) / 5 : 0;
    const person = {
      pace: 1 + (r0 - 0.5) * 0.030 + sSpeed * 0.05,
      aggression: clamp(0.25 + r1 * 0.7 + (stats ? (stats.weight - 3) * 0.04 : 0), 0, 1),
      consistency: clamp(0.35 + r2 * 0.6 + sHandling * 0.4, 0.05, 1),
      lineOffset: (r3 - 0.5) * 2.6 * (1.25 - clamp(0.35 + r2 * 0.6, 0, 1)),
      driftLove: clamp(0.35 + r4 * 0.65 + sDrift * 0.5, 0, 1.2),
      launch: 0.06 + r1 * 1.55,          // seconds before GO the throttle goes down (tier-sharpened below)
      itemDelay: 0.25 + r2 * 1.5,
    };
    const v = O.vehicles?.[i] || vehicleFactory?.(i, Object.assign({ seed: (O.seed + i * 7919) >>> 0 }, O.vehicleOpts))
      || createVehicle(world, trk, Object.assign({ seed: (O.seed + i * 7919) >>> 0 }, O.vehicleOpts));
    const slot = O.grid?.[i] || trk.startGrid?.[i % Math.max(1, (trk.startGrid || [1]).length)];
    if (slot && O.vehicles == null) { try { v.reset(slot.pos, slot.rot); } catch (e) { /* keep the default */ } }
    // a sharper driver launches closer to the perfect window; a slow one bogs or jumps
    person.launch = lerp(person.launch, 0.34, clamp(tier.item * 0.55 + (1 - tier.react) * 0.35, 0, 0.92));
    racers.push({
      index: i,
      id: O.ids?.[i] || ('cpu' + i),
      name: O.names?.[i] || ('CPU ' + (i + 1)),
      vehicle: v, tier, tierIndex: ti, personality: person,
      isPlayer: false, isAI: true,
      rand: rng((O.seed ^ (i * 2654435761)) >>> 0),
      input: { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 },
      s: 0, lateral: 0, progress: 0, place: i + 1, targetSpeed: 0, speedScale: 1, catchup: 1,
      avoid: 0, attract: 0, mistake: { t: 2 + rand() * 6, kind: null, left: 0, steer: 0, pace: 1 },
      drift: { on: false, dir: 0, t: 0, cool: 0, hold: 0, dirHold: 0 },
      hold: 0, useTimer: 0, boostCool: 0, react: 0, aim: { s: 0, lat: 0 },
      offTrackTime: 0, stats: { drifts: 0, miniturbos: 0, items: 0, mistakes: 0, catchBoosts: 0, maxBehind: 0 },
    });
  }

  /* ---- shared race context (race.js keeps this fresh; we can also derive it) ---- */
  let field = racers;               // every racer on track, player included
  let leaderProgress = 0;
  let packProgress = 0;             // the centre of the field, in race metres
  let gate = { racing: true, tMinus: 0, go: true, playerAuto: false };

  // NB: race.js drives the field through control() and never calls update(), so the pack
  // centre has to be refreshed from the setters it *does* call every frame — otherwise it
  // stays at 0 and every kart on the far side of the start line reads as a lap adrift.
  function setField(list) { field = (list && list.length) ? list : racers; updatePackCentre(); }
  function setGate(g) { gate = Object.assign({ racing: true, tMinus: 0, go: true, playerAuto: false }, g || {}); }

  /**
   * Where the middle of the field is. A plain mean lets one spun-out straggler drag the whole
   * pack's reference backwards, so the tail is trimmed: the centre is the mean of everyone
   * within `packSpan * 2` of the leader, which is the group a viewer would call "the race".
   */
  function updatePackCentre() {
    let sum = 0, n = 0;
    const cut = leaderProgress - O.packSpan * 2;
    for (const o of field) {
      if (!o || !o.vehicle) continue;
      if ((o.progress ?? 0) < cut) continue;
      sum += o.progress ?? 0; n++;
    }
    packProgress = n ? sum / n : leaderProgress;
  }

  /* -------------------------------------------------------------- steering -- */

  const _l1 = { x: 0, y: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0, offset: 0, curvature: 0, speed: 0, width: 12, heading: 0, radius: 1e6 };
  const _l2 = Object.assign({}, _l1);

  function rivalPressure(r) {
    // nearest rival ahead and behind, in track space
    let ahead = null, behind = null, aheadD = 1e9, behindD = 1e9;
    for (const o of field) {
      if (o === r || !o.vehicle) continue;
      const d = dS(o.s, r.s);
      const lat = (o.lateral ?? 0) - (r.lateral ?? 0);
      if (d > 0 && d < aheadD) { aheadD = d; ahead = { r: o, d, lat }; }
      if (d < 0 && -d < behindD) { behindD = -d; behind = { r: o, d: -d, lat }; }
    }
    return { ahead, behind };
  }

  function chooseAvoid(r, near, dt) {
    const { ahead } = near;
    let want = 0;
    if (ahead && ahead.d < 26 && Math.abs(ahead.lat) < 3.6) {
      const p = r.personality;
      const closing = r.vehicle.state.forwardSpeed - (ahead.r.vehicle?.state.forwardSpeed ?? 0);
      const drafting = ahead.d > 8 && ahead.d < 15 && closing < 1.2 && p.aggression < 0.55;
      if (!drafting) {
        // pass on whichever side has room; break ties with personality
        const room = line.at(r.s + 20, _l2);
        const half = room.width * 0.5 - 1.6;
        const mine = r.lateral ?? 0, his = (ahead.r.lateral ?? 0);
        const leftRoom = half + his, rightRoom = half - his;     // space either side of the rival
        let side = his > 0 ? -1 : 1;
        if (Math.abs(his) < 0.8) side = Math.sign(mine || p.lineOffset || 1) || 1;
        if (side < 0 && leftRoom < 3.4) side = 1;
        if (side > 0 && rightRoom < 3.4) side = -1;
        const urgency = clamp((26 - ahead.d) / 18, 0, 1) * (0.55 + 0.75 * p.aggression);
        want = side * clamp(3.0 * urgency, 0, half - 0.4);
      }
    }
    // side-by-side: don't share the same metre of tarmac
    for (const o of field) {
      if (o === r || !o.vehicle) continue;
      const d = dS(o.s, r.s);
      if (Math.abs(d) > 4.2) continue;
      const lat = (o.lateral ?? 0) - (r.lateral ?? 0);
      if (Math.abs(lat) < 2.4) want += -Math.sign(lat || 1) * (2.4 - Math.abs(lat)) * 0.9;
    }
    r.avoid = damp(r.avoid, clamp(want, -6, 6), 3.4, dt);
    return r.avoid;
  }

  function chooseAttract(r, dt) {
    let want = 0, bestScore = 0;
    const spd = Math.max(r.vehicle.state.forwardSpeed, 4);
    const reach = clamp(spd * 1.7, 18, 45);
    const baseLat = line.offsetAt(r.s + 12);
    // A pad or a box is only worth a detour if it is nearly on the line already: leaving the
    // racing line to fetch one costs more than it pays.
    const consider = (s, lat, weight, maxDetour) => {
      const d = dS(s, r.s);
      if (d < 5 || d > reach) return;
      const detour = Math.abs(lat - baseLat);
      if (detour > maxDetour) return;
      const score = weight * (1 - detour / maxDetour) * (1 - clamp(d / reach, 0, 1) * 0.4);
      if (score > bestScore) { bestScore = score; want = clamp(lat - baseLat, -maxDetour, maxDetour); }
    };
    for (const p of pads) consider(p.s, p.lateral, 1.0, O.padDetour);
    if (O.items) {
      let hud = null;
      try { hud = O.items.hud(r.vehicle); } catch (e) { hud = null; }
      if (hud && !hud.item && !hud.spinning) {
        for (const b of O.items.boxes) { if (b.active) consider(b.s, b.lateral ?? 0, 0.9, O.boxDetour); }
      }
    }
    r.attract = damp(r.attract, clamp(want, -6, 6), 2.2, dt);
    return r.attract;
  }

  function hazardDodge(r) {
    if (!O.items) return 0;
    let push = 0;
    const st = r.vehicle.state;
    const scan = (list, rad) => {
      for (const h of list) {
        if (!h || h.dead || !h.pos) continue;
        if (h.owner === r.vehicle) continue;
        const dx = h.pos.x - st.pos.x, dz = h.pos.z - st.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 34) continue;
        const fwdDot = dx * Math.sin(st.yaw) + dz * Math.cos(st.yaw);
        if (fwdDot < -2) continue;
        const side = dx * Math.cos(st.yaw) - dz * Math.sin(st.yaw);
        const near = clamp(1 - d / 34, 0, 1);
        if (Math.abs(side) < (h.radius || rad) + 2.4) push += -Math.sign(side || 1) * 3.2 * near * near;
      }
    };
    try { scan(O.items.hazards || [], 2.0); scan(O.items.projectiles || [], 1.8); } catch (e) { /* ignore */ }
    return clamp(push, -4, 4);
  }

  /* ---------------------------------------------------------------- items --- */

  function useItems(r, dt, near) {
    const items = O.items;
    if (!items) return;
    let hud;
    try { hud = items.hud(r.vehicle); } catch (e) { return; }
    if (!hud || !hud.item) { r.hold = 0; return; }
    r.hold += dt;
    const def = items.ITEMS?.[hud.item];
    if (!def) return;
    const skill = r.tier.item;
    const p = r.personality;
    const wait = p.itemDelay * (1.6 - skill);
    if (r.hold < wait * 0.35) return;

    const behind = near.behind && near.behind.d < 24 ? near.behind : null;
    const ahead = near.ahead && near.ahead.d < 70 ? near.ahead : null;
    const threat = incomingThreat(r);
    const straight = Math.abs(line.bend(r.s + 6, 60)) < 0.006 && line.meanCurvature(r.s, r.s + 55) < 0.010;
    const kind = def.kind;
    let fire = false, backwards = false;

    if (kind === 'shield') {
      // hold the pan out as a shield; throw it back at whoever is right behind
      if (threat || (behind && behind.d < 13 && r.rand() < 0.6 + 0.4 * skill)) { fire = true; backwards = true; }
      else if (r.hold > 6 && !behind) { fire = true; backwards = false; }
    } else if (kind === 'drop') {
      if (threat) { fire = true; backwards = true; }
      else if (r.hold > wait + 1.2) { fire = true; backwards = true; }
    } else if (kind === 'shot') {
      if (def.orbit > 1) {
        if (ahead && ahead.d < 40 && Math.abs(ahead.lat) < 5) fire = true;
        else if (behind && behind.d < 12 && r.rand() < 0.3) { fire = true; backwards = true; }
        else if (r.hold > 5) fire = true;
      } else {
        if (threat && r.rand() < skill) { fire = true; backwards = true; }
        else if (ahead && ahead.d < 26 && Math.abs(ahead.lat) < 3.5) fire = true;
        else if (r.hold > wait + 2.5) { fire = true; backwards = !!behind; }
      }
    } else if (kind === 'homing' || kind === 'hunter' || kind === 'field') {
      if (ahead && ahead.d < 65) fire = true;
      else if (r.hold > wait + 1.5 && r.place > 1) fire = true;
      else if (r.hold > 5) fire = true;
    } else if (kind === 'self') {
      const boostable = !!def.boost;
      const busy = r.vehicle.state.boost.time > 0.25 || r.drift.on;
      if (!boostable) fire = r.hold > wait;                      // hamsa / watermelon: just pop it
      else if (straight && !busy && r.vehicle.state.onTrack) fire = true;
      else if (r.hold > 7) fire = true;
      // low skill wastes boosts in odd places
      if (!fire && skill < 0.5 && r.hold > wait + 1.5 && r.rand() < 0.02) fire = true;
    } else if (kind === 'rush') {
      fire = r.hold > wait;
    }

    if (fire) {
      try { items.useItem(r.vehicle, backwards); r.stats.items++; } catch (e) { /* ignore */ }
      r.hold = 0;
    }
  }

  function incomingThreat(r) {
    const items = O.items;
    if (!items) return false;
    const st = r.vehicle.state;
    try {
      for (const p of items.projectiles) {
        if (!p || p.dead || p.owner === r.vehicle || !p.pos) continue;
        if (p.kind === 'orbit') continue;
        const dx = p.pos.x - st.pos.x, dz = p.pos.z - st.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 26) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* --------------------------------------------------------------- driving -- */

  function drive(r, dt) {
    const v = r.vehicle, st = v.state, P = v.params || DEFAULTS;
    const inp = r.input;
    const tf = v.getTransform();
    const spd = Math.max(st.forwardSpeed, 0);

    // where am I
    let nr = null;
    try { nr = trk.nearest(st.pos); } catch (e) { nr = null; }
    if (nr) { r.s = nr.s; r.lateral = nr.lateral; }
    r.offTrackTime = st.onTrack ? 0 : r.offTrackTime + dt;

    /* -- grid / countdown: sit still, then launch -- */
    if (!gate.racing) {
      const launch = gate.tMinus <= r.personality.launch;
      inp.throttle = launch ? 1 : 0;
      inp.brake = gate.tMinus > 0.05 && !launch ? 0.15 : 0;
      inp.steer = 0; inp.drift = 0;
      if (O.step) v.update(dt, inp);
      return;
    }

    /* -- mistakes -- */
    const m = r.mistake;
    m.t -= dt;
    if (m.left > 0) {
      m.left -= dt;
      if (m.left <= 0) { m.kind = null; m.steer = 0; m.pace = 1; }
    } else if (m.t <= 0) {
      const rate = r.tier.mistake * (1.35 - r.personality.consistency);   // events per minute-ish
      m.t = 6 + r.rand() * 26 / Math.max(rate, 0.05);
      const pick = r.rand();
      if (pick < 0.4) { m.kind = 'wide'; m.left = 0.7 + r.rand() * 0.9; m.steer = (r.rand() < 0.5 ? -1 : 1) * (0.10 + r.rand() * 0.14); m.pace = 1; }
      else if (pick < 0.78) { m.kind = 'late'; m.left = 0.5 + r.rand() * 0.8; m.steer = 0; m.pace = 1.10 + r.rand() * 0.10; }
      else { m.kind = 'lift'; m.left = 0.25 + r.rand() * 0.35; m.steer = 0; m.pace = 0.55; }
      r.stats.mistakes++;
    }

    /* -- who is around us -- */
    const near = rivalPressure(r);

    /* -- pack cohesion: catch-up behind the pack, drag out in front of it -- */
    // A human's kart is never touched. An *autopilot* player's kart is a computer driver like
    // any other (attract mode, the demo, every review plate) and joins the band, or the field
    // it was seeded in front of could never race it.
    let catchup = 1;
    if (O.rubberBand && (!r.isPlayer || gate.playerAuto)) {
      // progress is monotonic metres of race distance, so these are plain differences
      const behindBy = Math.max(0, leaderProgress - r.progress);
      if (behindBy > r.stats.maxBehind) r.stats.maxBehind = behindBy;
      const off = packProgress - r.progress;        // + behind the pack, - out in front of it
      const band = clamp((Math.abs(off) - O.packDead) / O.packSpan, 0, 1) * Math.sign(off);
      // …but only while the kart is actually on its own. A leader with a rival on its bumper
      // must not be dragged back into it — that is not a battle, it is a rear-end shunt, and
      // it was pitching the review's lead kart off the road at the first squeeze. Equally, a
      // chaser inside striking distance stops being towed and has to make the pass itself.
      const hero = r.isPlayer ? O.heroBand : 1;
      const solo = r.isPlayer ? 1 : O.packSolo + (1 - O.packSolo) * (band > 0
        ? clamp(((near.ahead ? near.ahead.d : 1e9) - 4) / 18, 0, 1)
        : clamp(((near.behind ? near.behind.d : 1e9) - 5) / 20, 0, 1));
      const rate = band > 0 ? O.catchMax * r.tier.catch * hero
        : Math.min(O.leadDrag * hero, r.isPlayer ? O.heroDragMax : O.leadDrag);
      catchup = 1 + band * solo * rate;
      // A tow, not a rocket: once a dropped kart is already flat out, target speed has nothing
      // left to give, so the only honest currency is top speed. Reserved for the far tail so
      // the karts in shot are racing on the throttle, not on a permanent boost flame.
      r.boostCool -= dt;
      if (O.catchBoost && off > O.catchBoostGap && r.boostCool <= 0 && st.onTrack && st.grounded
        && st.boost.time <= 0 && spd > (st.surfaceTop ?? 1) * P.topSpeed * 0.93) {
        try { v.addBoost(0.85, O.catchBoostPower, 'catchup'); r.stats.catchBoosts++; } catch (e) { /* ignore */ }
        r.boostCool = 3.2;
      }
    }
    r.catchup = catchup;

    /* -- aim point -- */
    // Pure pursuit cuts whatever it aims at: a look-ahead sized for a straight, carried into a
    // hairpin, aims *across* the corner and the kart drives straight on into the scenery — which
    // is precisely what put the review's lead kart into the grass on Rehov Rakefet, because the
    // slower tiers use the longest look-ahead of all. So the rig looks as far as the corner
    // allows and no further.
    const bend = Math.abs(line.curvatureAt(r.s + 8));
    const look = clamp((O.aimBase + spd * O.aimGain) * r.tier.look / (1 + bend * O.aimCurve),
      O.aimMin, O.aimMax);
    const avoid = chooseAvoid(r, near, dt);
    const attract = chooseAttract(r, dt);
    const dodge = hazardDodge(r);
    const cornerNow = clamp(Math.abs(line.curvatureAt(r.s + 10)) / 0.035, 0, 1);
    const bias = r.personality.lineOffset * (0.35 + 0.65 * (1 - cornerNow));

    const L = line.at(r.s + look, _l1);
    const half = L.width * 0.5 - 1.3;
    let delta = clamp(bias + avoid + attract + dodge + (m.kind === 'wide' ? m.steer * 12 : 0), -6.5, 6.5);
    const latTarget = clamp(L.offset + delta, -half, half);
    delta = latTarget - L.offset;
    r.aim.s = r.s + look; r.aim.lat = latTarget;

    const tx = L.x + L.nx * delta, tz = L.z + L.nz * delta;

    // pure pursuit
    const relx = tx - st.pos.x, relz = tz - st.pos.z;
    const fx = tf.forward.x, fz = tf.forward.z;
    const rx = tf.right.x, rz = tf.right.z;
    const ahead = relx * fx + relz * fz;
    const side = relx * rx + relz * rz;
    const Ld = Math.max(Math.hypot(ahead, side), 1.5);
    const alpha = Math.atan2(side, Math.max(ahead, 0.35));
    const kPP = 2 * Math.sin(alpha) / Ld;
    const steerMax = lerp(P.steerMaxLow, P.steerMaxHigh, smoothstep(0, P.topSpeed * 1.05, spd));
    let steer = Math.atan(P.wheelBase * kPP) / Math.max(steerMax, 0.05);

    // Stanley cross-track term: kills the slow drift off-line pure pursuit leaves on long corners
    const nearLat = line.offsetAt(r.s + 4) + delta * 0.55;
    const cross = nearLat - (r.lateral ?? 0);
    steer += clamp(Math.atan2(O.crossGain * cross, spd + 5.0) / Math.max(steerMax, 0.05), -0.6, 0.6) * O.stanley;
    // damp the yaw rate toward what the aim actually needs
    steer += clamp((kPP * spd - st.angVel.y) * O.yawDamp, -0.25, 0.25);
    if (m.kind === 'wide') steer += m.steer;
    if (O.items) { try { steer += O.items.steerBias(r.vehicle); } catch (e) { /* ignore */ } }

    // when badly off-track, forget the racing line: aim at the middle of the road instead
    let recovering = 0;
    if (r.offTrackTime > 0.35 || Math.abs(r.lateral ?? 0) > L.width * 0.5 + 0.5) {
      recovering = clamp(r.offTrackTime * 1.2, 0, 1);
      let cm = null;
      try { cm = trk.sample(r.s + clamp(spd * 0.8, 8, 20)); } catch (e) { cm = null; }
      if (cm) {
        const bx = cm.pos.x - st.pos.x, bz = cm.pos.z - st.pos.z;
        const a2 = Math.atan2(bx * rx + bz * rz, Math.max(bx * fx + bz * fz, 0.35));
        steer = lerp(steer, clamp(Math.atan(P.wheelBase * 2 * Math.sin(a2) / Math.max(Math.hypot(bx, bz), 2)) / Math.max(steerMax, 0.05), -1, 1), recovering * 0.85);
      }
    }
    inp.steer = clamp(steer, -1, 1);

    /* -- speed -- */
    const preview = clamp(spd * 0.28, 3, 12);
    // The speed profile IS the grip limit, so pace is a fraction of it: a Sunday driver runs at
    // 0.855 of the corner, an Ace at 1.000. Catch-up spends the difference and no more —
    // `paceCap` is what stops a rubber-banded kart asking the tyres for grip the corner has not
    // got and understeering into the olives on every catch-up lap.
    const pace = Math.min(r.tier.speed * r.personality.pace * catchup, O.paceCap);
    let vTarget = line.speedAt(r.s + preview) * pace * m.pace;
    // Brake at the right *distance*, not the right moment. The profile's own backward pass is
    // a ramp you have to already be on; a controller that only samples one preview ahead sits
    // a metre or two above it all the way down and arrives at the apex carrying speed it
    // cannot turn — which is how a kart ends up understeering straight on into the grass with
    // the throttle still open. So scan forward over the kart's own braking distance and take
    // the hardest demand: for every corner within reach, the fastest speed from which this
    // kart could still make it.
    const brakeA = O.brakeAccel * r.tier.brake;
    const horizon = clamp(spd * spd / (2 * brakeA) + 10, 12, 110);
    for (let d = Math.max(preview, 6); d <= horizon; d += 5) {
      const vd = line.speedAt(r.s + d) * pace * m.pace;
      const allowed = Math.sqrt(vd * vd + 2 * brakeA * d);
      if (allowed < vTarget) vTarget = allowed;
    }
    const surf = surfaceInfo(st.surface || 'tarmac');
    if (surf && surf.top < 1) vTarget = Math.min(vTarget, P.topSpeed * surf.top * 0.98);
    if (recovering > 0) vTarget = Math.min(vTarget, lerp(vTarget, 9.5, recovering));
    if (r.drift.on) vTarget *= O.driftEntry;   // a slide needs a slower entry than a grip lap
    // Don't drive into the back of the kart in front. Once we are inside two kart lengths and
    // still square behind it, match its speed instead of climbing over it — the pass has to be
    // made with the line (chooseAvoid has already picked a side), not with the bumper. Without
    // this the field piles into one interpenetrating clump every time the leader lifts.
    if (O.tailGap > 0 && near.ahead && near.ahead.d < O.tailGap && Math.abs(near.ahead.lat) < 1.7) {
      const his = near.ahead.r.vehicle?.state.forwardSpeed ?? vTarget;
      const squeeze = clamp((O.tailGap - near.ahead.d) / (O.tailGap * 0.57), 0, 1);
      vTarget = Math.min(vTarget, lerp(vTarget, his + 1.2, squeeze));
    }
    r.targetSpeed = vTarget;
    const err = vTarget - spd;
    if (err > 0.2) { inp.throttle = 1; inp.brake = 0; }
    else if (err > -0.55) { inp.throttle = clamp(0.5 + err, 0.12, 1); inp.brake = 0; }
    else { inp.throttle = 0; inp.brake = clamp(-err * 0.5 * r.tier.brake, 0.12, 1); }
    if (m.kind === 'lift') { inp.throttle = 0; inp.brake = 0; }

    /* -- drift -- */
    // Commit to a slide only once the steering has genuinely held one way for a moment: hopping
    // on a transient correction points the slide out of the corner instead of through it. The
    // corner's own profile speed decides whether a mini-turbo is worth the lost grip at all.
    const d = r.drift;
    const skill = clamp(r.tier.drift * O.driftSkill, 0, 1.4);
    const cornerV = line.speedAt(r.s + clamp(spd * 0.6, 5, 20));
    const sgn = Math.sign(inp.steer) || 0;
    const loaded = Math.abs(inp.steer) > O.driftSteerMin && spd > O.driftMinSpeed
      && Math.abs(cross) < 2.0 && st.onTrack && st.grounded;
    if (loaded && (d.dirHold === sgn || d.hold === 0)) { d.hold += dt; d.dirHold = sgn; }
    else { d.hold = 0; d.dirHold = 0; }

    if (d.on) {
      d.t += dt;
      const lost = !st.onTrack || Math.abs(cross) > 3.0 || spd < 8;
      const straight = Math.abs(inp.steer) < O.driftSteerMin * 0.5 && d.t > 0.5;
      if (lost || straight || d.t > 5.0 || (sgn !== 0 && sgn !== d.dir && d.t > 0.5)) {
        d.on = false; d.cool = 0.35 + r.rand() * 0.25;
        if (st.drift.tier > 0) r.stats.miniturbos++;
      }
    } else if (d.cool > 0) {
      d.cool -= dt;
    } else if (d.hold > O.driftHold && skill > 0.25 && cornerV < O.driftCornerV
      && spd < cornerV * 1.6
      && r.rand() < 0.6 + 0.4 * skill) {
      d.on = true; d.dir = d.dirHold || 1; d.t = 0; r.stats.drifts++;
    }
    inp.drift = d.on ? 1 : 0;
    if (st.drift.active) {
      // invert the kart's drift lock — steerLock = dir * (innerBias + range * inward) — so the
      // slide holds the line the controller asked for instead of the tightest one available.
      const dd = st.drift.dir || d.dir || 1;
      const want = clamp(inp.steer * dd, -1, 1);
      inp.steer = dd * clamp((want - P.driftInnerBias) / Math.max(P.driftSteerRange, 0.05), -1, 1);
    }

    /* -- items -- */
    useItems(r, dt, near);

    if (O.step) v.update(dt, inp);
  }

  /* ---------------------------------------------------------------- update -- */

  function update(dt, ctx) {
    dt = clamp(dt || 0, 0, 0.1);
    if (ctx) {
      if (ctx.field) setField(ctx.field);
      if (typeof ctx.leaderProgress === 'number') leaderProgress = ctx.leaderProgress;
      if (ctx.gate) setGate(ctx.gate);
    }
    if (!ctx || !ctx.field) {
      // stand-alone mode: derive progress and places ourselves
      for (const r of racers) {
        let nr = null;
        try { nr = trk.nearest(r.vehicle.state.pos); } catch (e) { /* keep */ }
        if (nr) {
          if (r.prevS === undefined) { r.prevS = nr.s; r.progress = nr.s; }
          else { const d = dS(nr.s, r.prevS); if (Math.abs(d) < len * 0.4) r.progress += d; r.prevS = nr.s; }
          r.s = nr.s; r.lateral = nr.lateral;
        }
      }
      const order = racers.slice().sort((a, b) => b.progress - a.progress);
      order.forEach((r, i) => { r.place = i + 1; });
      leaderProgress = order[0]?.progress ?? 0;
      field = racers;
    }
    updatePackCentre();
    for (const r of racers) drive(r, dt);
    return api;
  }

  const api = {
    racers, line, track: trk, tiers: TIERS, pads, boxSlots,
    update, setField, setGate,
    get leaderProgress() { return leaderProgress; },
    get packProgress() { return packProgress; },
    setLeaderProgress(p) { leaderProgress = p; updatePackCentre(); },
    /** Drive one racer without stepping its vehicle (race.js owns the integration order). */
    control(r, dt) { const keep = O.step; O.step = false; drive(r, dt); O.step = keep; return r.input; },
    setDifficulty(d) {
      const t = DIFFICULTY[d] || DIFFICULTY[150];
      racers.forEach((r, i) => { r.tierIndex = clamp(t[i % t.length] | 0, 0, 3); r.tier = TIERS[r.tierIndex]; });
      return api;
    },
    setItems(sys) { O.items = sys; return api; },
    telemetry() {
      return racers.map(r => ({
        id: r.id, tier: r.tier.id, place: r.place,
        kmh: +(r.vehicle.state.speed * 3.6).toFixed(1),
        target: +(r.targetSpeed * 3.6).toFixed(1),
        drift: r.drift.on, lat: +(r.lateral ?? 0).toFixed(2), catchup: +r.catchup.toFixed(3),
      }));
    },
  };
  return api;
}

/* ============================================================ item plumbing == */

/**
 * Apply an item system's per-racer effects to a real vehicle. The item module deliberately
 * knows nothing about physics, so somebody has to translate: this is that somebody, and both
 * the AI field and the player go through it so a spin costs everyone the same.
 */
export function applyItemEffects(items, vehicle, dt, inp) {
  if (!items || !vehicle) return inp;
  let fx = null;
  try { fx = items.effects(vehicle); } catch (e) { return inp; }
  if (!fx) return inp;
  const st = vehicle.state;

  // Boosts: the item system already hands them to any racer that exposes addBoost(), and marks
  // them external so its own speed multiplier stops counting them. This is the fallback for the
  // frames where it could not, so an item boost is never silently dropped.
  if (fx.boostTime > 0 && !fx.boostExternal) {
    try { vehicle.addBoost(fx.boostTime, fx.boostPower, 'item'); fx.boostExternal = true; } catch (e) { /* ignore */ }
  }

  // Hoopoe rush: the bird takes the wheel. Physics-side that is a held boost plus pinned throttle;
  // the steering stays with whoever is driving, which is exactly what an autopilot should feel like.
  if (fx.autopilot > 0) {
    if (inp) { inp.throttle = 1; inp.brake = 0; inp.drift = 0; }
    try { vehicle.addBoost(0.3, clamp((fx.speedMul ?? 1.6) - 1, 0.2, 0.6), 'rush'); } catch (e) { /* ignore */ }
  }

  const stunned = Math.max(fx.spin, fx.slip, fx.squash, fx.stall);
  if (stunned > 0 && inp) {
    inp.throttle = 0; inp.brake = 0; inp.drift = 0;
    inp.steer *= 0.15;
  }
  if (stunned > 0) {
    let mul = 1;
    try { mul = items.speedMultiplier(vehicle); } catch (e) { mul = 1; }
    const cap = Math.max(1.2, DEFAULTS.topSpeed * mul);
    const sp = Math.hypot(st.vel.x, st.vel.z);
    if (sp > cap) {
      const k = Math.max(cap / sp, 1 - 6 * dt);
      st.vel.x *= k; st.vel.z *= k;
    }
    if (fx.spin > 0 || fx.slip > 0 || fx.stall > 0) st.angVel.y += (fx.stall > 0 ? 9 : 6.5) * dt;
  }
  return inp;
}

export default createAI;
