/**
 * Kat Racing — arcade-sim kart physics.
 *
 * A 6-DOF rigid body with four raycast suspension struts, a Pacejka-flavoured combined-slip
 * tyre model with load sensitivity and per-surface grip, plus the arcade layer that makes it
 * feel like a kart game rather than a simulator: snappy speed-sensitive steering, a hop, a
 * locked drift with counter-steer control and mini-turbo charge tiers, boost pads, slipstream,
 * trick boosts, banking support and air control.
 *
 * Conventions: metres, +X east, +Z south, +Y up. Vehicle local forward is +Z, up is +Y,
 * right is +X. Yaw is measured as atan2(forward.x, forward.z).
 *
 *   const kart = createVehicle(world, track, { seed: 7 });
 *   kart.reset(track.startGrid[0].pos, track.startGrid[0].rot);
 *   kart.update(dt, { throttle: 1, brake: 0, steer: -0.6, drift: 1, item: 0, look: 0 });
 *   const t = kart.getTransform();   // { position, quaternion, forward, up, right, yaw... }
 *
 * No Three.js import: identical code runs in the browser and in tools/sim/vehicle.mjs.
 */
import { clamp, lerp, smoothstep, damp, wrapPi, rng } from '../core/mathx.js';
import {
  createCollisionWorld, SURFACES, surfaceInfo,
  v3, q4, vset, vcopy, vadd, vsub, vmad, vscale, vdot, vcross, vlen, vnorm,
  qmul, qnorm, qrot, qrotInv, qAxisAngle, qYaw, qIntegrate, qToYaw, FWD, UP, RIGHT,
} from './collision.js';

/* ============================================================ tyre curve ==== */

/**
 * Pacejka-flavoured normalised friction curve: rises to 1.0 at the peak slip, then falls
 * away to `tail` * peak for large slip (the sliding plateau that makes drifts controllable).
 */
function curveRaw(x, tail) {
  const ax = Math.abs(x);
  const rise = (2 * ax) / (1 + ax * ax);
  return ((1 - tail) * rise + tail * Math.tanh(1.55 * ax)) * Math.sign(x || 1);
}
function curvePeak(tail) {
  let m = 0;
  for (let i = 1; i <= 400; i++) { const v = Math.abs(curveRaw(i * 0.01, tail)); if (v > m) m = v; }
  return m;
}
const PEAK_CACHE = new Map();
function tyreForce(x, tail) {
  let p = PEAK_CACHE.get(tail);
  if (p === undefined) PEAK_CACHE.set(tail, p = curvePeak(tail));
  return curveRaw(x, tail) / p;
}

/* ================================================== fallback track ========== */

/**
 * A closed-loop course over the real terrain, used only when src/track/track.js is not
 * importable yet (or throws). Same interface as buildTrack()'s return value.
 */
export function makeFallbackTrack(world, opts = {}) {
  const o = Object.assign({ seed: 1337, radius: 205, width: 12.5, samples: 448, ctrl: 30, cx: 0, cz: 0, laps: 3 }, opts);
  const r = rng(o.seed);
  const a1 = r() * 6.283, a2 = r() * 6.283;
  const N = o.samples, C = o.ctrl;

  // Control ring: a wobbly ellipse. Everything downstream is a spline through these, so the
  // course stays smooth no matter how hard we shove the control points around.
  const ctrl = [];
  for (let i = 0; i < C; i++) {
    const th = i / C * Math.PI * 2;
    const rad = o.radius * (1 + 0.30 * Math.sin(3 * th + a1) + 0.17 * Math.sin(5 * th + a2) + 0.09 * Math.sin(7 * th + a1 * 1.7));
    ctrl.push({ x: o.cx + Math.cos(th) * rad, z: o.cz + Math.sin(th) * rad * 0.90 });
  }
  const cr = (u) => {
    const i = Math.floor(u), f = u - i;
    const p0 = ctrl[((i - 1) % C + C) % C], p1 = ctrl[((i) % C + C) % C];
    const p2 = ctrl[((i + 1) % C + C) % C], p3 = ctrl[((i + 2) % C + C) % C];
    const t2 = f * f, t3 = t2 * f;
    const cm = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return { x: cm(p0.x, p1.x, p2.x, p3.x), y: 0, z: cm(p0.z, p1.z, p2.z, p3.z) };
  };

  // Real building footprints, as centre + radius discs.
  const blds = [];
  for (const bl of (world.buildings || [])) {
    const ring = bl.rings && bl.rings[0];
    if (!ring || ring.length < 3) continue;
    let bx = 0, bz = 0;
    for (const q of ring) { bx += q[0]; bz += q[1]; }
    bx /= ring.length; bz /= ring.length;
    let rad = 0;
    for (const q of ring) rad = Math.max(rad, Math.hypot(q[0] - bx, q[1] - bz));
    blds.push({ x: bx, z: bz, r: rad });
  }
  const clear = o.width * 0.5 + 4.0;

  // Push the *control points* clear of the houses, then re-smooth the ring. Because the road
  // is a spline, this can never produce the 2 m hairpins a per-vertex push would.
  for (let it = 0; it < 40; it++) {
    const acc = [];
    for (let i = 0; i < C; i++) acc.push({ x: 0, z: 0, n: 0 });
    for (let k = 0; k < N; k++) {
      const u = k / N * C, p = cr(u);
      for (const b of blds) {
        const dx = p.x - b.x, dz = p.z - b.z, need = b.r + clear;
        const dd = Math.hypot(dx, dz);
        if (dd >= need) continue;
        const push = need - dd, ux = dd > 1e-3 ? dx / dd : 1, uz = dd > 1e-3 ? dz / dd : 0;
        const i0 = Math.floor(u), f = u - i0;
        const add = (idx, w) => { const t = acc[((idx % C) + C) % C]; t.x += ux * push * w; t.z += uz * push * w; t.n += w; };
        add(i0, 1 - f); add(i0 + 1, f);
      }
    }
    let moved = 0;
    for (let i = 0; i < C; i++) {
      if (!acc[i].n) continue;
      const sc = 0.85 / acc[i].n;
      ctrl[i].x += acc[i].x * sc; ctrl[i].z += acc[i].z * sc;
      moved += Math.hypot(acc[i].x * sc, acc[i].z * sc);
    }
    const src = ctrl.map(q => ({ x: q.x, z: q.z }));
    for (let i = 0; i < C; i++) {
      const a = src[(i - 1 + C) % C], b2 = src[i], c = src[(i + 1) % C];
      ctrl[i].x = a.x * 0.12 + b2.x * 0.76 + c.x * 0.12;
      ctrl[i].z = a.z * 0.12 + b2.z * 0.76 + c.z * 0.12;
    }
    if (moved < 0.04) break;
  }

  const pts = [];
  for (let k = 0; k < N; k++) pts.push(cr(k / N * C));
  for (const p of pts) p.y = world.heightAt(p.x, p.z);
  // Vertical smoothing: a race line doesn't follow every 3 m terrain post. Smooth hard, then
  // blend a little of the raw drape back so the course still reads as the real hillside.
  const rawY = pts.map(p => p.y);
  for (let pass = 0; pass < 30; pass++) {
    const src = pts.map(p => p.y);
    for (let i = 0; i < N; i++) pts[i].y = src[(i - 1 + N) % N] * 0.25 + src[i] * 0.5 + src[(i + 1) % N] * 0.25;
  }
  for (let i = 0; i < N; i++) pts[i].y = lerp(pts[i].y, rawY[i], 0.2);

  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const length = cum[N];

  // signed curvature (positive = turning right) -> banking
  const bank = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
    let t0x = b.x - a.x, t0z = b.z - a.z, l0 = Math.hypot(t0x, t0z) || 1; t0x /= l0; t0z /= l0;
    let t1x = c.x - b.x, t1z = c.z - b.z, l1 = Math.hypot(t1x, t1z) || 1; t1x /= l1; t1z /= l1;
    const h0 = Math.atan2(t0x, t0z), h1 = Math.atan2(t1x, t1z);
    const dh = wrapPi(h1 - h0);
    const ds = (l0 + l1) * 0.5 || 1;
    bank[i] = -clamp((dh / ds) * 15, -0.26, 0.26);
  }
  for (let pass = 0; pass < 4; pass++) {
    const src = Float64Array.from(bank);
    for (let i = 0; i < N; i++) bank[i] = src[(i - 1 + N) % N] * 0.25 + src[i] * 0.5 + src[(i + 1) % N] * 0.25;
  }

  const idxOfS = s => {
    let t = s % length; if (t < 0) t += length;
    let lo = 0, hi = N;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    return { i: lo, f: (t - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1) };
  };

  function sample(s) {
    const { i, f } = idxOfS(s);
    const a = pts[i], b = pts[(i + 1) % N];
    const pos = { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) };
    const c = pts[(i + 2) % N], p = pts[(i - 1 + N) % N];
    const t = { x: lerp(b.x - p.x, c.x - a.x, f), y: lerp(b.y - p.y, c.y - a.y, f), z: lerp(b.z - p.z, c.z - a.z, f) };
    const tl = Math.hypot(t.x, t.y, t.z) || 1; t.x /= tl; t.y /= tl; t.z /= tl;
    const hl = Math.hypot(t.x, t.z) || 1;
    const normal = { x: t.z / hl, y: 0, z: -t.x / hl };
    return { pos, tangent: t, normal, width: o.width, banking: lerp(bank[i], bank[(i + 1) % N], f), surface: 'tarmac' };
  }

  // nearest: coarse grid of seed indices, then a local refine
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  x0 -= 120; x1 += 120; z0 -= 120; z1 += 120;
  const G = 72, gw = (x1 - x0) / G, gh = (z1 - z0) / G;
  const seed = new Int32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const px = x0 + (i + 0.5) * gw, pz = z0 + (j + 0.5) * gh;
    let best = 0, bd = Infinity;
    for (let k = 0; k < N; k++) { const d = (pts[k].x - px) ** 2 + (pts[k].z - pz) ** 2; if (d < bd) { bd = d; best = k; } }
    seed[j * G + i] = best;
  }

  function nearest(pos) {
    const i = clamp(Math.floor((pos.x - x0) / gw), 0, G - 1), j = clamp(Math.floor((pos.z - z0) / gh), 0, G - 1);
    const s0 = seed[j * G + i];
    let best = s0, bd = Infinity;
    for (let d = -8; d <= 8; d++) {
      const k = (s0 + d + N * 2) % N;
      const dd = (pts[k].x - pos.x) ** 2 + (pts[k].z - pos.z) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    }
    // refine onto the segment
    const a = pts[best], b = pts[(best + 1) % N], pv = pts[(best - 1 + N) % N];
    let bs = cum[best], blat = 0, bdist = Infinity;
    for (const [p, q, base] of [[pv, a, cum[(best - 1 + N) % N]], [a, b, cum[best]]]) {
      const dx = q.x - p.x, dz = q.z - p.z, l2 = dx * dx + dz * dz || 1;
      let t = clamp(((pos.x - p.x) * dx + (pos.z - p.z) * dz) / l2, 0, 1);
      const cxp = p.x + dx * t, czp = p.z + dz * t;
      const dist = Math.hypot(pos.x - cxp, pos.z - czp);
      if (dist < bdist) {
        bdist = dist; bs = base + t * Math.sqrt(l2);
        const tl = Math.sqrt(l2);
        blat = (pos.x - cxp) * (dz / tl) + (pos.z - czp) * (-dx / tl);
      }
    }
    return { s: ((bs % length) + length) % length, lateral: blat, onTrack: Math.abs(blat) <= o.width * 0.5, surface: 'tarmac' };
  }

  // Start/finish belongs on the longest straight, not two metres before a corner.
  let startS = 0, straight = -1;
  {
    const step = 6, n = Math.floor(length / step), win = Math.round(120 / step);
    const turn = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = sample(i * step - step), b = sample(i * step), c = sample(i * step + step);
      const h0 = Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
      const h1 = Math.atan2(c.pos.x - b.pos.x, c.pos.z - b.pos.z);
      turn[i] = Math.abs(wrapPi(h1 - h0));
    }
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < win; j++) sum += turn[(i + j) % n];
      if (straight < 0 || sum < straight) { straight = sum; startS = ((i + win * 0.75) % n) * step; }
    }
  }
  const startGrid = [];
  for (let i = 0; i < 8; i++) {
    const s = startS - Math.floor(i / 2) * 6;
    const sm = sample(s);
    const side = (i % 2 ? 1 : -1) * 2.6;
    startGrid.push({
      pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y, z: sm.pos.z + sm.normal.z * side },
      rot: Math.atan2(sm.tangent.x, sm.tangent.z),
    });
  }
  const checkpoints = [];
  for (let i = 0; i < 24; i++) checkpoints.push({ s: i / 24 * length });
  const boostPads = [];
  for (let i = 0; i < 4; i++) {
    const sm = sample((0.14 + i * 0.25) * length);
    boostPads.push({ pos: { ...sm.pos }, radius: 4.0, dir: { ...sm.tangent } });
  }
  const itemBoxes = [];
  for (let i = 0; i < 12; i++) {
    const sm = sample((i / 12 + 0.05) * length);
    itemBoxes.push({ pos: { x: sm.pos.x, y: sm.pos.y + 1.2, z: sm.pos.z } });
  }
  return { spline: pts, length, sample, nearest, checkpoints, startGrid, boostPads, itemBoxes, laps: o.laps, startS, fallback: true };
}

function validTrack(t) {
  if (!t) return false;
  try {
    if (typeof t.sample !== 'function' || typeof t.nearest !== 'function') return false;
    const s = t.sample(0); const n = t.nearest({ x: 0, y: 0, z: 0 });
    return !!(s && s.pos && Number.isFinite(s.pos.x) && n && Number.isFinite(n.s));
  } catch (e) { return false; }
}

/* ================================================== tuning defaults ========= */

export const DEFAULTS = {
  seed: 7,
  hz: 200,                     // physics substep rate
  mass: 200,                   // kg, kart + cat
  wheelBase: 1.80,
  trackWidth: 1.44,
  comHeight: 0.20,             // centre of mass above the wheel-anchor plane
  wheelRadius: 0.33,
  chassisRadius: 0.92,         // collision circle
  inertia: { pitch: 74, yaw: 52, roll: 44 },

  suspRest: 0.26,
  suspTravel: 0.18,
  suspFreq: 2.25,              // Hz -> spring rate
  suspDampBump: 0.52,
  suspDampRebound: 0.78,

  gripBase: 1.62,              // arcade friction coefficient on clean tarmac
  loadSens: 0.16,
  antiRoll: 26000,             // N/m across each axle
  maxWheelLoad: 5.5,           // x static load: a spike bigger than this flips karts, not helps
  rollCouple: 0.28,            // fraction of the lateral tyre force's roll moment kept
  peakSlipRatio: 0.16,
  peakSlipAngle: 0.145,        // rad (~8.3 deg)
  tailLong: 0.74,
  tailLat: 0.76,
  wheelInertia: 2.6,
  frontGrip: 1.06,             // slight front bias -> stable, easy rotation
  rearGrip: 1.00,
  driveSplit: [0.14, 0.14, 0.36, 0.36],   // FL FR RL RR
  brakeSplit: [0.32, 0.32, 0.18, 0.18],

  topSpeed: 25.0,              // m/s on clean tarmac, no boost
  maxDriveForce: 4300,         // N at the wheels, governed by the speed curve
  maxBrakeTorque: 1500,        // Nm per axle-half
  reverseSpeed: 8.0,
  dragCdA: 0.42,               // 0.5*rho*Cd*A
  downforce: 1.05,             // N per (m/s)^2
  rollingScale: 1.0,

  steerMaxLow: 0.62,           // rad at standstill
  steerMaxHigh: 0.20,          // rad at top speed
  steerRate: 15,               // input smoothing (1/s)
  yawAssist: 7.0,              // how hard the arcade layer forces the target yaw rate
  gripAssist: 4.2,             // lateral-velocity scrub while gripping (1/s)
  driftGripAssist: 0.55,
  spinGuardStart: 0.55,        // rad of body slip where the anti-spin assist starts
  spinGuardFull: 1.15,
  spinGuardGain: 7.0,
  maxLatAccel: 1.45,           // multiplier on mu*g for the yaw-rate cap

  hopSpeed: 3.25,
  hopMinSpeed: 3.0,
  driftMinSpeed: 5.0,
  driftInnerBias: 0.55,        // steer fraction held automatically into the corner
  driftSteerRange: 0.45,
  driftSteerMaxLow: 0.36,      // the drift lock has its own, flatter steering curve
  driftSteerMaxHigh: 0.235,
  driftThrust: 0.40,           // fraction of lateral tyre force fed back as forward push
  driftRearGrip: 0.74,
  driftFrontGrip: 0.99,
  driftYawBias: 0.35,          // extra inward rotation while the slide is still building
  driftSlip: 0.33,             // rad of body slip the drift servo holds (~19 deg)
  driftSlipRange: 0.12,        // +- from counter-steer to full inward steer
  driftSlipGain: 3.4,
  driftSlipRecover: 3.2,
  driftYawCap: 1.12,
  maxYawRate: 2.6,
  driftTiers: [0.62, 1.55, 2.65],           // seconds of charge
  boostDur: [0.60, 1.10, 1.70],
  boostPower: [0.18, 0.27, 0.37],
  boostForce: 3200,
  padBoost: { dur: 1.25, power: 0.30 },
  trickBoost: { dur: 0.62, power: 0.22 },
  draftTime: 1.15,
  draftRange: 15,
  draftBoost: { dur: 0.85, power: 0.20 },

  airYawTorque: 46,
  airPitchTorque: 26,
  airRighting: 8.0,
  angDamp: { pitch: 3.6, yaw: 0.8, roll: 4.2 },
  landingBite: 0.30,           // how much a bad landing costs

  respawnOffTrackTime: 4.0,
  respawnUpsideTime: 1.3,
  respawnStuckTime: 2.5,
  respawnAirTime: 6.0,
  gravity: 9.81,
};

/* ================================================== the vehicle ============= */

export function createVehicle(world, track, opts = {}) {
  const P = Object.assign({}, DEFAULTS, opts);
  const trackOk = validTrack(track);
  const trk = trackOk ? track : makeFallbackTrack(world, { seed: P.seed, ...(opts.fallbackTrack || {}) });
  const col = opts.collision || createCollisionWorld(world, trk, opts.collisionOpts || {});
  const G = P.gravity;

  const springK = P.mass / 4 * (2 * Math.PI * P.suspFreq) ** 2;
  const critC = 2 * Math.sqrt(springK * P.mass / 4);
  const FzNom = P.mass * G / 4;
  const Iinv = { x: 1 / P.inertia.pitch, y: 1 / P.inertia.yaw, z: 1 / P.inertia.roll };

  /* ---- state ---- */
  const state = {
    pos: v3(0, 0, 0),
    vel: v3(0, 0, 0),
    quat: q4(),
    angVel: v3(0, 0, 0),
    grounded: false, groundFrac: 0, airTime: 0, groundTime: 0,
    surface: 'tarmac', surfaceGrip: 1, surfaceTop: 1,
    speed: 0, forwardSpeed: 0, lateralSpeed: 0,
    yaw: 0, pitch: 0, roll: 0,
    steer: 0, steerAngle: 0,
    throttle: 0, brake: 0,
    drift: { active: false, dir: 0, charge: 0, tier: 0, hop: false, hopTime: 0, armed: false },
    boost: { time: 0, dur: 0, power: 0, source: null },
    draft: 0, trick: { armed: false, spin: 0, count: 0 },
    rpm: 0, engineLoad: 0, yawTarget: 0, driftSlipDeg: 0, betaTarget: 0,
    onTrack: true, lateral: 0, trackS: 0,
    lap: 0, dust: 0, skid: 0, rumble: 0,
    wallImpact: 0, bumpImpact: 0, landImpact: 0,
    respawns: 0, offTrackTime: 0, upsideTime: 0, stuckTime: 0,
    look: 0, item: 0,
  };

  /* ---- wheels ---- */
  const hw = P.trackWidth * 0.5, hb = P.wheelBase * 0.5;
  const wheels = [
    mkWheel(-hw, hb, true, 0), mkWheel(hw, hb, true, 1),
    mkWheel(-hw, -hb, false, 2), mkWheel(hw, -hb, false, 3),
  ];
  function mkWheel(lx, lz, steerable, i) {
    return {
      index: i, steerable, front: steerable,
      local: v3(lx, -P.comHeight, lz),
      pos: v3(), normal: v3(0, 1, 0), contactPos: v3(), r: v3(),
      contact: false, susp: P.suspRest, compression: 0, compressionN: 0, suspVel: 0,
      load: 0, omega: 0, spin: 0, steerAngle: 0,
      slipRatio: 0, slipAngle: 0, forceLong: 0, forceLat: 0,
      surface: 'tarmac', grip: 1, skid: 0, dust: 0,
      radius: P.wheelRadius,
    };
  }

  /* ---- scratch ---- */
  const fwd = v3(0, 0, 1), right = v3(1, 0, 0), up = v3(0, 1, 0);
  const force = v3(), torque = v3(), tmp = v3(), tmp2 = v3(), tmp3 = v3(), rvec = v3(), wf = v3(), wr = v3(), vc = v3();
  const probeOut = {};
  const bodyT = v3(), bodyW = v3();
  const avgNormal = v3(0, 1, 0);

  let rivals = [];
  let padCooldown = new Map();
  const safeHistory = [];
  let acc = 0, elapsed = 0;
  let prevDrift = 0, prevGrounded = true;
  let lastLandQuality = 1;

  const input = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };

  /* -------------------------------------------------- basis ---- */
  function updateBasis() {
    qrot(fwd, state.quat, FWD);
    qrot(right, state.quat, RIGHT);
    qrot(up, state.quat, UP);
    state.yaw = Math.atan2(fwd.x, fwd.z);
    state.pitch = Math.asin(clamp(fwd.y, -1, 1));
    state.roll = Math.atan2(right.y, up.y);
  }

  /* -------------------------------------------------- reset ---- */
  function reset(pos, rot) {
    if (Array.isArray(pos)) pos = { x: pos[0], y: pos[1], z: pos[2] };
    let p = pos;
    if (!p) {
      const g = trk.startGrid && trk.startGrid[0];
      p = g ? g.pos : { x: 0, y: world.heightAt(0, 0), z: 0 };
      if (rot === undefined && g) rot = g.rot;
    }
    const gy = col.groundHeight(p.x, p.z);
    vset(state.pos, p.x, Math.max(p.y ?? gy, gy) + P.suspRest + P.comHeight + 0.06, p.z);
    vset(state.vel, 0, 0, 0);
    vset(state.angVel, 0, 0, 0);
    if (rot && typeof rot === 'object') {
      if ('w' in rot) { state.quat.x = rot.x; state.quat.y = rot.y; state.quat.z = rot.z; state.quat.w = rot.w; qnorm(state.quat); }
      else qYaw(state.quat, Math.atan2(rot.x || 0, rot.z || 1));
    } else qYaw(state.quat, rot || 0);
    for (const w of wheels) { w.omega = 0; w.susp = P.suspRest; w.compression = 0; w.compressionN = 0; w.contact = false; w.slipRatio = 0; w.slipAngle = 0; }
    state.drift.active = false; state.drift.charge = 0; state.drift.tier = 0; state.drift.dir = 0; state.drift.hop = false; state.drift.armed = false;
    state.boost.time = 0; state.boost.power = 0; state.draft = 0;
    state.airTime = 0; state.groundTime = 0; state.offTrackTime = 0; state.upsideTime = 0;
    state.trick.armed = false; state.trick.spin = 0;
    acc = 0;
    state.stuckTime = 0;
    updateBasis();
    // never leave the kart embedded in scenery: shove it out before the first step
    for (let i = 0; i < 6; i++) {
      const hit = col.resolveChassis(state.pos, state.vel, P.chassisRadius + 0.05, 0, 1);
      if (!hit || hit.depth < 1e-3) break;
      state.pos.y = Math.max(state.pos.y, col.groundHeight(state.pos.x, state.pos.z) + P.suspRest + P.comHeight + 0.06);
      vset(state.vel, 0, 0, 0);
    }
    return api;
  }

  function respawn() {
    state.respawns++;
    let p = null, yaw = state.yaw;
    if (safeHistory.length) {
      const s = safeHistory[0];
      p = { x: s.x, y: s.y, z: s.z }; yaw = s.yaw;
    }
    try {
      const nr = trk.nearest(state.pos);
      const sm = trk.sample(nr.s + 3);
      p = { x: sm.pos.x, y: sm.pos.y, z: sm.pos.z };
      yaw = Math.atan2(sm.tangent.x, sm.tangent.z);
    } catch (e) { /* keep the history fallback */ }
    if (!p) p = { x: 0, y: world.heightAt(0, 0), z: 0 };
    reset({ x: p.x, y: p.y + 0.5, z: p.z }, yaw);
    safeHistory.length = 0;
  }

  /* -------------------------------------------------- boosts ---- */
  function addBoost(dur, power, source) {
    const b = state.boost;
    // a stronger boost replaces a weaker one; an equal one extends it
    if (power > b.power || b.time <= 0) { b.power = power; b.time = dur; b.dur = dur; b.source = source; }
    else b.time = Math.max(b.time, dur * 0.75);
  }

  /* -------------------------------------------------- one physics step ---- */
  function step(h, inp) {
    updateBasis();
    const speed = vlen(state.vel);
    state.speed = speed;
    const vFwd = vdot(state.vel, fwd);
    const vLat = vdot(state.vel, right);
    state.forwardSpeed = vFwd; state.lateralSpeed = vLat;

    /* ---- track query ---- */
    let nr = null;
    try { nr = trk.nearest(state.pos); } catch (e) { nr = null; }
    if (nr) { state.trackS = nr.s; state.lateral = nr.lateral; state.onTrack = nr.onTrack !== undefined ? !!nr.onTrack : true; }

    /* ---- suspension + ground ---- */
    vset(force, 0, 0, 0); vset(torque, 0, 0, 0);
    let contacts = 0;
    vset(avgNormal, 0, 0, 0);
    const maxRay = P.suspRest + P.wheelRadius;

    // pass 1: raycast every wheel and read its travel
    for (const w of wheels) {
      qrot(tmp, state.quat, w.local);
      vadd(w.pos, state.pos, tmp);
      vcopy(w.r, tmp);
      col.probe(w.pos.x, w.pos.y, w.pos.z, -up.x, -up.y, -up.z, maxRay + 0.9, probeOut);
      const hit = probeOut.hit && probeOut.dist <= maxRay;
      if (hit) {
        w.susp = clamp(probeOut.dist - P.wheelRadius, -0.06, P.suspRest);
        w.compression = P.suspRest - w.susp;
        vset(w.normal, probeOut.nx, probeOut.ny, probeOut.nz);
        vset(w.contactPos, probeOut.px, probeOut.py, probeOut.pz);
        w.surface = probeOut.surface;
        w.contact = true;
        contacts++;
        avgNormal.x += w.normal.x; avgNormal.y += w.normal.y; avgNormal.z += w.normal.z;
        vcross(tmp2, state.angVel, w.r);
        vadd(vc, state.vel, tmp2);
        w.suspVel = -vdot(vc, up);
      } else {
        w.contact = false;
        w.susp = damp(w.susp, P.suspRest, 12, h);
        w.compression = P.suspRest - w.susp;
        w.suspVel = 0;
        w.load = 0;
        w.surface = state.surface;
      }
      w.compressionN = clamp(w.compression / P.suspTravel, 0, 1.15);
    }

    // pass 2: spring + damper + anti-roll bar, applied along the contact normals
    for (const w of wheels) {
      if (!w.contact) continue;
      const mate = wheels[w.index ^ 1];                       // the other end of this axle
      const damping = critC * (w.suspVel > 0 ? P.suspDampBump : P.suspDampRebound);
      let Fs = springK * w.compression + damping * w.suspVel;
      if (w.compression > P.suspTravel) Fs += springK * 4 * (w.compression - P.suspTravel);
      // anti-roll bar: resists the *difference* in travel across the axle, which is what
      // keeps a light, narrow kart from tripping over its outside wheels mid-corner
      if (mate.contact) Fs += P.antiRoll * (w.compression - mate.compression);
      Fs = clamp(Fs, 0, FzNom * P.maxWheelLoad);
      w.load = Fs;
      const align = Math.max(vdot(w.normal, up), 0.35);
      vscale(tmp3, w.normal, Fs / align);
      vadd(force, force, tmp3);
      vcross(tmp2, w.r, tmp3);
      vadd(torque, torque, tmp2);
    }

    if (contacts) vnorm(avgNormal); else vset(avgNormal, 0, 1, 0);
    state.groundFrac = contacts / 4;
    const grounded = contacts > 0;
    state.grounded = grounded;

    /* ---- surface material under the kart ---- */
    const surfName = (nr && state.onTrack && contacts) ? (wheels[2].contact ? wheels[2].surface : wheels[0].surface)
      : col.surfaceAt(state.pos.x, state.pos.z);
    const surf = surfaceInfo(surfName);
    state.surface = surf.name;
    state.surfaceGrip = surf.grip; state.surfaceTop = surf.top;

    /* ---- steering ---- */
    const d = state.drift;
    const spdT = smoothstep(0, P.topSpeed * 1.05, Math.abs(vFwd));
    const steerMax = d.active
      ? lerp(P.driftSteerMaxLow, P.driftSteerMaxHigh, spdT)     // the drift lock is its own curve
      : lerp(P.steerMaxLow, P.steerMaxHigh, spdT);
    let steerTarget = clamp(inp.steer, -1, 1);
    if (d.active) {
      const inward = clamp(steerTarget * d.dir, -1, 1);
      steerTarget = d.dir * (P.driftInnerBias + P.driftSteerRange * inward);
    }
    state.steer = damp(state.steer, steerTarget, P.steerRate, h);
    const steerAngle = state.steerAngle = state.steer * steerMax;

    /* ---- engine / brakes ---- */
    const b = state.boost;
    const boostP = b.time > 0 ? b.power : 0;
    const topSpeed = P.topSpeed * surf.top * (1 + boostP);
    let throttle = clamp(inp.throttle, 0, 1);
    let brake = clamp(inp.brake, 0, 1);
    let reversing = false;
    if (brake > 0.05 && vFwd < 0.6 && throttle < 0.05) { reversing = true; }
    state.throttle = throttle; state.brake = brake;

    let driveForce = 0;
    if (reversing) {
      driveForce = -P.maxDriveForce * 0.42 * brake * clamp(1 - (-vFwd / P.reverseSpeed) ** 3, 0, 1);
    } else {
      const topNow = topSpeed * (0.40 + 0.60 * throttle);
      const govern = clamp(1 - (Math.max(vFwd, 0) / Math.max(topNow, 1)) ** 3, 0, 1);
      driveForce = P.maxDriveForce * throttle * govern;
      if (boostP > 0) driveForce += P.boostForce * boostP * clamp(1 - Math.max(vFwd, 0) / (topSpeed * 1.06), 0, 1);
    }
    const brakeCmd = reversing ? 0 : brake;
    state.engineLoad = clamp(Math.abs(driveForce) / P.maxDriveForce, 0, 1);

    /* ---- tyres ---- */
    const gripSurf = surf.grip * (P.gripBase);
    let totalLoad = 0;
    for (const w of wheels) totalLoad += w.load;
    for (const w of wheels) {
      if (!w.contact) {
        // free wheel: spin toward rolling speed, or spin up under power
        const target = vFwd / P.wheelRadius;
        w.omega = damp(w.omega, target + (throttle > 0.1 ? 22 * throttle : 0), 3.5, h);
        w.slipRatio = 0; w.slipAngle = 0; w.forceLong = 0; w.forceLat = 0;
        w.skid = damp(w.skid, 0, 8, h); w.dust = damp(w.dust, 0, 8, h);
        w.spin += w.omega * h;
        continue;
      }
      const n = w.normal;
      // wheel heading in the contact plane
      const sa = w.steerable ? steerAngle : 0;
      w.steerAngle = damp(w.steerAngle, sa, 22, h);
      const cs = Math.cos(w.steerAngle), sn = Math.sin(w.steerAngle);
      vset(wf, fwd.x * cs + right.x * sn, fwd.y * cs + right.y * sn, fwd.z * cs + right.z * sn);
      const wfn = vdot(wf, n);
      vset(wf, wf.x - n.x * wfn, wf.y - n.y * wfn, wf.z - n.z * wfn); vnorm(wf);
      vcross(wr, n, wf); vnorm(wr);

      // contact-point velocity
      qrot(tmp, state.quat, w.local);
      vcross(tmp2, state.angVel, tmp);
      vadd(vc, state.vel, tmp2);
      const vLong = vdot(vc, wf), vSide = vdot(vc, wr);

      const denom = Math.max(Math.abs(vLong), 2.2);
      let kappa = (w.omega * P.wheelRadius - vLong) / denom;
      kappa = clamp(kappa, -3.2, 3.2);
      const alpha = Math.atan2(vSide, Math.abs(vLong) + 1.1);
      w.slipRatio = kappa; w.slipAngle = alpha;

      // load-sensitive friction
      const loadRatio = w.load / FzNom;
      const muScale = clamp(1 - P.loadSens * (loadRatio - 1), 0.55, 1.35);
      let axleGrip = w.front ? P.frontGrip : P.rearGrip;
      if (d.active) axleGrip *= w.front ? P.driftFrontGrip : P.driftRearGrip;
      const mu = gripSurf * muScale * axleGrip;
      const Fmax = mu * w.load;
      w.grip = mu;

      // combined slip on the friction ellipse
      const sx = kappa / P.peakSlipRatio, sy = -alpha / P.peakSlipAngle;
      const sMag = Math.hypot(sx, sy);
      let Fl = 0, Ft = 0;
      if (sMag > 1e-5) {
        const tail = lerp(P.tailLong, P.tailLat, Math.abs(sy) / (Math.abs(sx) + Math.abs(sy) + 1e-6));
        const Fm = Fmax * tyreForce(sMag, tail);
        Fl = Fm * (sx / sMag);
        Ft = Fm * (sy / sMag);
      }

      // rolling resistance + surface drag
      const roll = -Math.sign(vLong || 1) * surf.roll * P.rollingScale * w.load;
      Fl += roll;

      w.forceLong = Fl; w.forceLat = Ft;

      // wheel spin dynamics
      const share = totalLoad > 1 ? (w.load / totalLoad) : 0.25;
      const Td = driveForce * P.wheelRadius * lerp(P.driveSplit[w.index] * 4, share, 0.45);
      let Tb = 0;
      if (brakeCmd > 0.02) {
        const cap = Math.abs(w.omega) * P.wheelInertia / h;
        Tb = -Math.sign(w.omega || vLong || 1) * Math.min(P.maxBrakeTorque * brakeCmd * P.brakeSplit[w.index] * 4, cap + Math.abs(Fl) * P.wheelRadius);
      }
      w.omega += (Td + Tb - Fl * P.wheelRadius) / P.wheelInertia * h;
      const omegaCap = Math.abs(vLong) / P.wheelRadius + 42;
      w.omega = clamp(w.omega, -omegaCap, omegaCap);
      if (brakeCmd > 0.6 && Math.abs(w.omega) < 1.5) w.omega = 0;      // lock the wheel
      w.spin += w.omega * h;

      // Apply. Longitudinal force acts at the contact patch, so squat and dive are real.
      // The lateral force keeps its horizontal lever (yaw moment is untouched) but only a
      // fraction of its vertical lever: a real kart's roll couple would tip it over long
      // before 1.6 g, and a kart game must never spend the race on its roof.
      qrot(tmp, state.quat, w.local);
      vmad(tmp, tmp, n, -(P.suspRest - w.compression));    // contact patch, chassis-relative
      vset(tmp3, wf.x * Fl, wf.y * Fl, wf.z * Fl);
      vadd(force, force, tmp3);
      vcross(tmp2, tmp, tmp3);
      vadd(torque, torque, tmp2);
      vset(tmp3, wr.x * Ft, wr.y * Ft, wr.z * Ft);
      vadd(force, force, tmp3);
      const vert = vdot(tmp, up);
      vmad(tmp, tmp, up, -vert * (1 - P.rollCouple));
      vcross(tmp2, tmp, tmp3);
      vadd(torque, torque, tmp2);

      // FX
      const slide = clamp((Math.abs(sMag) - 1) / 2.2, 0, 1);
      w.skid = damp(w.skid, slide * (surf.dust < 0.3 ? 1 : 0.35), 10, h);
      w.dust = damp(w.dust, slide * surf.dust + surf.dust * clamp(Math.abs(vLong) / 16, 0, 1) * 0.5, 8, h);
    }

    // Drifting in a kart game must not scrub your race away: give back part of the induced
    // drag that the sideways tyre force costs, so a good drift is roughly speed-neutral.
    if (d.active && throttle > 0.25 && contacts) {
      let latMag = 0;
      for (const w of wheels) latMag += Math.abs(w.forceLat);
      vmad(force, force, fwd, P.driftThrust * latMag * throttle);
    }

    /* ---- body forces ---- */
    force.y -= P.mass * G;
    // aero drag + extra surface drag
    const dragK = P.dragCdA + surf.drag * 0.9 - (state.draft > 0.35 ? 0.16 : 0);
    if (speed > 0.01) vmad(force, force, state.vel, -dragK * speed);
    // downforce keeps the kart planted (and stops silly launches off crests)
    if (grounded) vmad(force, force, up, -P.downforce * speed * speed);

    /* ---- arcade assists ---- */
    if (grounded) {
      const gf = state.groundFrac;
      // 1. yaw-rate target from a bicycle model, capped by the friction circle
      const latCap = P.maxLatAccel * gripSurf * G;
      let maxYaw = Math.min(P.maxYawRate, latCap / Math.max(speed, 5.0));
      let yawTarget = Math.abs(vFwd) < 0.4 ? 0 : (vFwd * Math.tan(steerAngle) / P.wheelBase);
      state.betaTarget = 0;
      if (d.active && speed > 3) {
        // A drift is a *servoed* slide, not an emergent spin: hold a target body-slip angle
        // so the slide is controllable, repeatable, and always recoverable.
        maxYaw *= P.driftYawCap;
        const inward = clamp(inp.steer * d.dir, -1, 1);
        const betaTarget = -d.dir * (P.driftSlip + P.driftSlipRange * inward);
        const beta = Math.atan2(vLat, Math.abs(vFwd) + 0.6);
        // asymmetric: lazy about building the slide, firm about not letting it become a spin
        const over = Math.abs(beta) > Math.abs(betaTarget);
        yawTarget += P.driftSlipGain * (over ? P.driftSlipRecover : 1) * (beta - betaTarget);
        state.driftSlipDeg = beta * 180 / Math.PI;
        state.betaTarget = Math.abs(betaTarget);
        yawTarget += d.dir * P.driftYawBias * clamp(1 - Math.abs(beta) / 0.6, 0, 1);
      }
      // Outside a drift the body-slip readout is zero, not "whatever the last drift ended at".
      // It was only ever assigned inside the block above, so it latched: a motion capture found
      // it reading a constant -40.4 deg across every frame of two different scenarios, including
      // one where the kart was cruising a village street in a straight line. audio.js reads it
      // for tyre-scrub intensity, and any future consumer would have inherited the same lie.
      if (!(d.active && speed > 3)) { state.driftSlipDeg = 0; state.betaTarget = 0; }
      yawTarget = clamp(yawTarget, -maxYaw, maxYaw);
      const yawNow = vdot(state.angVel, up);
      const yawTorque = (yawTarget - yawNow) * P.inertia.yaw * P.yawAssist * gf;
      vmad(torque, torque, up, yawTorque);
      state.yawTarget = yawTarget;

      // 2. scrub off lateral velocity so the kart tracks its nose (less when drifting)
      const bodySlip = Math.atan2(Math.abs(vLat), Math.abs(vFwd) + 1.0);
      // While drifting the guard sits just outside the servo's target angle, so the slide is
      // held at the commanded slip instead of creeping into a spin.
      const gStart = d.active ? state.betaTarget + 0.06 : P.spinGuardStart;
      const gFull = gStart + (d.active ? 0.5 : P.spinGuardFull - P.spinGuardStart);
      const spinGuard = 1 + smoothstep(gStart, gFull, bodySlip) * P.spinGuardGain;
      const lam = (d.active ? P.driftGripAssist : P.gripAssist) * surf.grip * gf * spinGuard;
      const kill = vLat * (1 - Math.exp(-lam * h));
      vmad(state.vel, state.vel, right, -kill);

      // 3. anti-tip: keep the chassis roughly aligned with the ground it is on
      vcross(tmp, up, avgNormal);
      const tilt = vlen(tmp);
      if (tilt > 0.10) {
        const k = (tilt - 0.10) * 520 * gf;
        vmad(torque, torque, tmp, k / (tilt || 1));
      }
    } else {
      /* ---- air control ---- */
      const at = clamp(state.airTime / 0.35, 0, 1);
      vmad(torque, torque, up, clamp(inp.steer, -1, 1) * P.airYawTorque * at);
      vmad(torque, torque, right, (throttle - brake) * P.airPitchTorque * at * 0.9);
      // self-righting so we land on the wheels
      vcross(tmp, up, UP);
      const k = P.airRighting * P.inertia.roll * clamp(state.airTime / 0.5, 0, 1);
      vmad(torque, torque, tmp, k);
    }

    /* ---- integrate linear ---- */
    vmad(state.vel, state.vel, force, h / P.mass);
    // anti-creep: a stopped kart with no inputs stays stopped, even on a slope
    if (grounded && throttle < 0.02 && brake < 0.02 && speed < 1.4) {
      const f = Math.exp(-6 * h);
      state.vel.x *= f; state.vel.z *= f;
    }
    vmad(state.pos, state.pos, state.vel, h);

    /* ---- integrate angular ---- */
    qrotInv(bodyT, state.quat, torque);
    qrotInv(bodyW, state.quat, state.angVel);
    bodyW.x += bodyT.x * Iinv.x * h;
    bodyW.y += bodyT.y * Iinv.y * h;
    bodyW.z += bodyT.z * Iinv.z * h;
    const ad = grounded ? P.angDamp : { pitch: 0.5, yaw: 0.35, roll: 0.6 };
    bodyW.x *= Math.exp(-ad.pitch * h);
    bodyW.y *= Math.exp(-ad.yaw * h);
    bodyW.z *= Math.exp(-ad.roll * h);
    const wm = Math.hypot(bodyW.x, bodyW.y, bodyW.z);
    if (wm > 9) { const s = 9 / wm; bodyW.x *= s; bodyW.y *= s; bodyW.z *= s; }
    qrot(state.angVel, state.quat, bodyW);
    qIntegrate(state.quat, state.angVel, h);
    updateBasis();

    /* ---- walls ---- */
    const wall = col.resolveChassis(state.pos, state.vel, P.chassisRadius, 0.22, 0.88);
    if (wall && wall.impact > 0.4) {
      state.wallImpact = Math.max(state.wallImpact, wall.impact);
      // a glancing blow should scrub speed and nudge the nose, never stick
      const dotf = fwd.x * wall.nx + fwd.z * wall.nz;
      vmad(state.angVel, state.angVel, up, -dotf * clamp(wall.impact / 12, 0, 0.9) * 2.4);
      if (d.active && wall.impact > 3) { endDrift(true); }
    }

    /* ---- floor guard ----
       Last-resort net for the case where the suspension has been out-run entirely (a huge
       drop, a bad respawn). It must sit *above* the wheels: parked lower, the wheel rays
       start underground, every strut reads fully compressed, and the chassis visibly sinks
       into the road. */
    const gy = col.groundHeight(state.pos.x, state.pos.z);
    const minY = gy + P.comHeight + P.wheelRadius * 0.55;
    if (state.pos.y < minY) { state.pos.y = minY; if (state.vel.y < 0) state.vel.y *= -0.15; }

    elapsed += h;
  }

  /* -------------------------------------------------- drift state machine ---- */
  function endDrift(cancel) {
    const d = state.drift;
    if (!d.active) { d.hop = false; d.armed = false; return; }
    if (!cancel && d.tier > 0) {
      const i = d.tier - 1;
      addBoost(P.boostDur[i], P.boostPower[i], 'miniturbo' + d.tier);
    }
    d.active = false; d.charge = 0; d.tier = 0; d.dir = 0; d.armed = false;
  }

  function driftLogic(dt, inp) {
    const d = state.drift;
    const held = inp.drift > 0.5;
    const rising = held && prevDrift <= 0.5;
    const speed = Math.abs(state.forwardSpeed);

    if (d.hop) d.hopTime += dt;

    // hop
    if (rising && !d.active && state.grounded && speed > P.hopMinSpeed && !d.hop) {
      state.vel.y += P.hopSpeed;
      state.pos.y += 0.02;
      d.hop = true; d.hopTime = 0; d.armed = true;
      d.dir = Math.abs(inp.steer) > 0.18 ? Math.sign(inp.steer) : 0;
      vmad(state.angVel, state.angVel, fwd, -(d.dir || 0) * 1.1);   // little roll flourish
    }
    if (d.hop) {
      if (Math.abs(inp.steer) > 0.18) d.dir = Math.sign(inp.steer);
      if (state.grounded && d.hopTime > 0.06) {
        d.hop = false;
        if (held && d.dir !== 0 && speed > P.driftMinSpeed) {
          d.active = true; d.charge = 0; d.tier = 0;
        } else d.armed = false;
      } else if (d.hopTime > 1.2) { d.hop = false; d.armed = false; }
    }
    // late drift entry: hopped straight, then turned in while still holding
    if (!d.active && !d.hop && d.armed && held && state.grounded && speed > P.driftMinSpeed && Math.abs(inp.steer) > 0.22) {
      d.dir = Math.sign(inp.steer); d.active = true; d.charge = 0; d.tier = 0;
    }

    if (d.active) {
      if (!held || speed < P.driftMinSpeed * 0.62 || state.brake > 0.75) { endDrift(!held ? false : true); }
      else {
        // charge faster when actually sliding hard and quickly
        const slide = clamp(Math.abs(state.lateralSpeed) / 4.5, 0, 1);
        const spd = clamp(speed / 11, 0, 1);
        const inward = clamp(inp.steer * d.dir, -1, 1);
        const rate = spd * (0.72 + 0.28 * slide) * (0.86 + 0.20 * Math.max(inward, 0)) * (state.grounded ? 1 : 0.35);
        d.charge += rate * dt;
        d.tier = d.charge >= P.driftTiers[2] ? 3 : d.charge >= P.driftTiers[1] ? 2 : d.charge >= P.driftTiers[0] ? 1 : 0;
      }
    }
    prevDrift = inp.drift;
  }

  /* -------------------------------------------------- air / tricks / landing ---- */
  function airLogic(dt, inp) {
    if (!state.grounded) {
      state.airTime += dt; state.groundTime = 0;
      if (inp.drift > 0.5 && prevDrift <= 0.5 && state.airTime > 0.12 && !state.trick.armed) {
        state.trick.armed = true; state.trick.spin = 1;
      }
      if (state.trick.spin > 0) state.trick.spin = Math.max(0, state.trick.spin - dt / 0.55);
    } else {
      if (prevGrounded === false) {
        // landing
        const v = vlen(state.vel);
        let quality = 1;
        if (v > 1) {
          const dirDot = (state.vel.x * fwd.x + state.vel.y * fwd.y + state.vel.z * fwd.z) / v;
          const upDot = vdot(up, avgNormal);
          quality = clamp(smoothstep(0.55, 0.94, dirDot) * 0.55 + smoothstep(0.55, 0.95, upDot) * 0.45, 0, 1);
        }
        lastLandQuality = quality;
        state.landImpact = clamp(-vdot(state.vel, avgNormal) / 12, 0, 1);
        if (state.airTime > 0.14) {
          const keep = lerp(1 - P.landingBite, 1.0, quality);
          state.vel.x *= keep; state.vel.z *= keep;
          if (state.trick.armed && quality > 0.35) {
            addBoost(P.trickBoost.dur, P.trickBoost.power * lerp(0.7, 1, quality), 'trick');
            state.trick.count++;
          }
        }
        state.trick.armed = false;
        state.airTime = 0;
      }
      state.groundTime += dt;
      state.airTime = 0;
    }
    prevGrounded = state.grounded;
  }

  /* -------------------------------------------------- pads / draft ---- */
  function padLogic(dt) {
    const pads = trk.boostPads;
    if (!Array.isArray(pads)) return;
    for (let i = 0; i < pads.length; i++) {
      const cd = padCooldown.get(i) || 0;
      if (cd > 0) { padCooldown.set(i, cd - dt); continue; }
      const p = pads[i].pos || pads[i];
      const dx = state.pos.x - p.x, dz = state.pos.z - p.z, dy = (state.pos.y - (p.y ?? state.pos.y));
      const r = (pads[i].radius || 3.5) + 1.0;
      if (dx * dx + dz * dz < r * r && Math.abs(dy) < 4) {
        addBoost(pads[i].dur || P.padBoost.dur, pads[i].power || P.padBoost.power, 'pad');
        padCooldown.set(i, 1.2);
      }
    }
  }

  function draftLogic(dt) {
    if (!rivals.length || state.speed < 8) { state.draft = damp(state.draft, 0, 3, dt); return; }
    let best = 0;
    for (const r of rivals) {
      const rp = r.pos || r.position || (r.state && r.state.pos);
      if (!rp || rp === state.pos) continue;
      const dx = rp.x - state.pos.x, dz = rp.z - state.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.4 || dist > P.draftRange) continue;
      const ux = dx / dist, uz = dz / dist;
      const ahead = ux * fwd.x + uz * fwd.z;                   // rival is ahead of us
      let rf = r.forward || (r.getTransform && r.getTransform().forward);
      if (!rf && r.vel) { const l = Math.hypot(r.vel.x, r.vel.z) || 1; rf = { x: r.vel.x / l, z: r.vel.z / l }; }
      const aligned = rf ? (rf.x * fwd.x + rf.z * fwd.z) : 1;  // travelling the same way
      if (ahead > 0.86 && aligned > 0.7) {
        best = Math.max(best, (1 - dist / P.draftRange) * clamp((ahead - 0.86) / 0.1, 0, 1));
      }
    }
    if (best > 0.05) {
      state.draft = Math.min(1.6, state.draft + dt / P.draftTime * (0.5 + best));
      if (state.draft >= 1) { addBoost(P.draftBoost.dur, P.draftBoost.power, 'draft'); state.draft = 0.2; }
    } else state.draft = damp(state.draft, 0, 1.6, dt);
  }

  /* -------------------------------------------------- respawn watchdog ---- */
  function safetyLogic(dt) {
    const upDot = up.y;
    if (state.grounded && upDot > 0.55 && state.onTrack) {
      if (safeHistory.length === 0 || elapsed - (safeHistory[safeHistory.length - 1].t || 0) > 0.5) {
        safeHistory.push({ x: state.pos.x, y: state.pos.y, z: state.pos.z, yaw: state.yaw, t: elapsed });
        if (safeHistory.length > 8) safeHistory.shift();
      }
    }
    // "on your roof" must not depend on wheel contacts — a rolled kart still touches with one corner
    const nearGround = state.pos.y < col.groundHeight(state.pos.x, state.pos.z) + 2.0;
    state.upsideTime = (upDot < 0.20 && nearGround) ? state.upsideTime + dt : Math.max(0, state.upsideTime - dt * 2);
    state.offTrackTime = (!state.onTrack) ? state.offTrackTime + dt : 0;

    let bad = false;
    if (state.upsideTime > P.respawnUpsideTime) bad = true;
    if (!world.inBounds(state.pos.x, state.pos.z)) bad = true;
    if (!Number.isFinite(state.pos.x) || !Number.isFinite(state.pos.y)) bad = true;
    if (state.pos.y < (world.minH ?? -1000) - 40) bad = true;
    if (state.surface === 'water' && state.offTrackTime > 1.2) bad = true;
    if (state.offTrackTime > P.respawnOffTrackTime && Math.abs(state.lateral) > (12 * 3)) bad = true;
    // wedged against scenery with the throttle down, or falling forever
    state.stuckTime = (state.speed < 0.9 && (input.throttle > 0.4 || input.brake > 0.4))
      ? state.stuckTime + dt : 0;
    if (state.stuckTime > P.respawnStuckTime) bad = true;
    if (state.airTime > P.respawnAirTime) bad = true;
    if (bad) respawn();
  }

  /* -------------------------------------------------- public update ---- */
  function update(dt, inp = {}) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    input.throttle = clamp(inp.throttle ?? 0, 0, 1);
    input.brake = clamp(inp.brake ?? 0, 0, 1);
    input.steer = clamp(inp.steer ?? 0, -1, 1);
    input.drift = clamp(inp.drift ?? 0, 0, 1);
    input.item = clamp(inp.item ?? 0, 0, 1);
    input.look = clamp(inp.look ?? 0, -1, 1);
    state.look = input.look; state.item = input.item;

    state.wallImpact = damp(state.wallImpact, 0, 9, dt);
    state.bumpImpact = damp(state.bumpImpact, 0, 9, dt);
    state.landImpact = damp(state.landImpact, 0, 6, dt);

    const h = 1 / P.hz;
    acc += dt;
    let n = 0;
    while (acc >= h && n < 12) { step(h, input); acc -= h; n++; }
    if (n === 0) { /* very small dt: state is still valid from the last step */ }

    // boost timer
    if (state.boost.time > 0) { state.boost.time -= dt; if (state.boost.time <= 0) { state.boost.time = 0; state.boost.power = 0; state.boost.source = null; } }

    airLogic(dt, input);
    driftLogic(dt, input);
    padLogic(dt);
    draftLogic(dt);
    safetyLogic(dt);

    // presentation-side aggregates
    let dust = 0, skid = 0;
    for (const w of wheels) { dust = Math.max(dust, w.dust); skid = Math.max(skid, w.skid); }
    state.dust = dust; state.skid = skid;
    const surf = surfaceInfo(state.surface);
    state.rumble = surf.rough * clamp(state.speed / 14, 0, 1) * state.groundFrac;
    state.rpm = clamp((Math.abs(wheels[2].omega) + Math.abs(wheels[3].omega)) * 0.5 * P.wheelRadius / Math.max(P.topSpeed, 1), 0, 2.2);
    state.speed = vlen(state.vel);
    return api;
  }

  /* -------------------------------------------------- transform ---- */
  const _tf = {
    position: v3(), quaternion: q4(), forward: v3(), right: v3(), up: v3(),
    yaw: 0, pitch: 0, roll: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1],
  };
  function getTransform() {
    vcopy(_tf.position, state.pos);
    _tf.quaternion.x = state.quat.x; _tf.quaternion.y = state.quat.y;
    _tf.quaternion.z = state.quat.z; _tf.quaternion.w = state.quat.w;
    vcopy(_tf.forward, fwd); vcopy(_tf.right, right); vcopy(_tf.up, up);
    _tf.yaw = state.yaw; _tf.pitch = state.pitch; _tf.roll = state.roll;
    _tf.pos[0] = state.pos.x; _tf.pos[1] = state.pos.y; _tf.pos[2] = state.pos.z;
    _tf.quat[0] = state.quat.x; _tf.quat[1] = state.quat.y; _tf.quat[2] = state.quat.z; _tf.quat[3] = state.quat.w;
    return _tf;
  }

  /** Wheel transform for the renderer: world position of the hub + its visual spin/steer. */
  function wheelTransforms() {
    for (const w of wheels) {
      qrot(tmp, state.quat, w.local);
      vadd(w.pos, state.pos, tmp);
      // hub sits `susp` below the anchor along the chassis up axis
      vmad(w.pos, w.pos, up, -w.susp);
    }
    return wheels;
  }

  const api = {
    state, wheels, params: P, track: trk, collision: col,
    update, reset, respawn, getTransform, wheelTransforms, addBoost,
    setRivals(list) { rivals = Array.isArray(list) ? list : []; return api; },
    get rivals() { return rivals; },
    /** Kart-vs-kart bump; `other` is another createVehicle() instance. */
    bump(other) {
      const a = { pos: state.pos, vel: state.vel, mass: P.mass, radius: P.chassisRadius };
      const b = { pos: other.state.pos, vel: other.state.vel, mass: other.params?.mass ?? 200, radius: other.params?.chassisRadius ?? 0.92 };
      const imp = col.bumpKarts(a, b, 0.55);
      if (imp > 0.3) { state.bumpImpact = Math.max(state.bumpImpact, imp); other.state.bumpImpact = Math.max(other.state.bumpImpact, imp); }
      return imp;
    },
    get speed() { return state.speed; },
    get speedKmh() { return state.speed * 3.6; },
    get driftCharge() { return state.drift.charge; },
    get driftTier() { return state.drift.tier; },
    get drifting() { return state.drift.active; },
    get surface() { return state.surface; },
    get grounded() { return state.grounded; },
    get airborne() { return !state.grounded; },
    get boosting() { return state.boost.time > 0; },
    get boost() { return state.boost; },
    get position() { return state.pos; },
    get velocity() { return state.vel; },
    get quaternion() { return state.quat; },
    get landQuality() { return lastLandQuality; },
    telemetry() {
      return {
        speed: state.speed, kmh: state.speed * 3.6, surface: state.surface,
        drift: state.drift.active, dir: state.drift.dir, charge: state.drift.charge, tier: state.drift.tier,
        boost: state.boost.time > 0 ? state.boost.source : null, boostT: state.boost.time,
        grounded: state.grounded, air: state.airTime, lateral: state.lateral, onTrack: state.onTrack,
        slip: wheels.map(w => +w.slipAngle.toFixed(3)), load: wheels.map(w => Math.round(w.load)),
        comp: wheels.map(w => +w.compressionN.toFixed(2)),
      };
    },
  };

  reset(trk.startGrid?.[0]?.pos, trk.startGrid?.[0]?.rot);
  return api;
}

export default createVehicle;
