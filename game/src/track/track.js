/**
 * Amikam Village Circuit — the racing line.
 *
 * The lap is stitched together from the *real* Moshav Amikam road network (Overture/OSM
 * geometry in `world.roads`) plus a handful of purpose-built connectors where a kart circuit
 * needs something the village does not have. Travelling from the start/finish line:
 *
 *   1  Rehov Rakefet .............. start/finish straight through the village (tarmac)
 *   2  Rakefet West ............... two long left sweepers climbing out of the moshav
 *   3  The Menashe Climb .......... real farm track, 79 m -> 149 m over 400 m
 *   4  Ridge Road ................. the plateau track at 155-166 m, the roof of the map
 *   5  Pisgat Amikam hairpin ...... 170 deg switchback at the highest point of the lap
 *   6  The Nose .................... 330 m of flat-out descent with the Rakia jump
 *   7  Wadi hairpin ................ 180 deg at the bottom of the descent
 *   8  The Plunge .................. the real hill footpath, up to 30% down to the fields
 *   9  Narkis Straight ............ fast tarmac with a bale chicane
 *  10  Kalanit Sweeper ............ long banked right climbing back into the village
 *  11  Tzivoni .................... tight village streets back onto the start straight
 *
 * Everything downstream (physics, AI, HUD, minimap) talks to this module through
 * `buildTrack(world, opts)`; see the returned object for the contract.
 */
import * as THREE from 'three';
import { clamp, lerp, wrapPi, rng } from '../core/mathx.js';
import { courseOf } from './courses.js';

/* ------------------------------------------------------------------ route ---- */





/**
 * The orchard cut: a rough 5.5 m dirt line straight across the inside of the Pisgat Amikam
 * hairpin, through the olive grove on the plateau. About 95 m shorter than the hairpin, and
 * slow enough on loose ground that you need a boost to make it pay.
 */
const SHORTCUT = [[-292.5, -641], [-290, -620], [-288, -600], [-286.5, -580], [-287, -570]];

/** Profile features baked into the vertical profile after draping (arc fractions of a lap). */
const JUMP = { at: [-323, -392], rise: 2.55, up: 15, lip: 3.4, gapAfter: 26, land: 1.35, landLen: 17 };

/* ------------------------------------------------------- road resolution ---- */

/**
 * Pull the circuit's control points back onto the live `world.roads` geometry. The baked
 * coordinates already come from that data, so this normally moves nothing; it exists so the
 * track keeps following the real streets if the world data is ever rebuilt. Anything that
 * would move more than `tol` is left alone (it is one of the purpose-built connectors).
 */
function snapToRoads(world, ctrl, tol = 6) {
  const roads = world && world.roads;
  if (!Array.isArray(roads) || !roads.length) return ctrl;
  const out = ctrl.map(p => p.slice());
  for (let k = 0; k < out.length; k++) {
    const px = out[k][0], pz = out[k][1];
    let bx = px, bz = pz, bd = tol;
    for (const r of roads) {
      if (r.poly) continue;
      for (const path of (r.paths || [])) {
        for (let i = 1; i < path.length; i++) {
          const ax = path[i - 1][0], az = path[i - 1][1], cx = path[i][0], cz = path[i][1];
          const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          const t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
          const qx = ax + dx * t, qz = az + dz * t;
          const d = Math.hypot(px - qx, pz - qz);
          if (d < bd) { bd = d; bx = qx; bz = qz; }
        }
      }
    }
    out[k][0] = bx; out[k][1] = bz;
  }
  return out;
}

/* ---------------------------------------------------------------- spline ---- */

/** Closed centripetal-ish Catmull-Rom through `ctrl`, evaluated at ~`ds` metre steps. */
function catmullClosed(ctrl, ds) {
  const N = ctrl.length, g = i => ctrl[((i % N) + N) % N];
  const out = [];
  for (let i = 0; i < N; i++) {
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(seg / ds));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const cm = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([cm(p0[0], p1[0], p2[0], p3[0]), cm(p0[1], p1[1], p2[1], p3[1]), i + t]);
    }
  }
  return out;
}

/** Resample a closed polyline at exactly `ds` metres of arc length. Carries lane `u` through. */
function resampleClosed(pts, ds) {
  const N = pts.length, cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[N];
  const n = Math.max(16, Math.round(total / ds));
  const out = [];
  let lo = 0;
  for (let k = 0; k < n; k++) {
    const s = k * total / n;
    while (lo + 1 < N && cum[lo + 1] <= s) lo++;
    const f = (s - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1);
    const a = pts[lo], b = pts[(lo + 1) % N];
    // control-parameter u must not wrap backwards across the seam
    let ua = a[2], ub = b[2];
    if (ub < ua) ub += ctrlCount;
    out.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(ua, ub, f)]);
  }
  return { pts: out, total: total };
}
let ctrlCount = 0;   // set per build, from the selected course

/* ------------------------------------------------------------ buildTrack ---- */

/**
 * Build the Amikam Village Circuit over `world`.
 *
 * @returns {{
 *   spline: THREE.CatmullRomCurve3, length: number, laps: number, startS: number,
 *   sample: (s:number)=>{pos:THREE.Vector3,tangent:THREE.Vector3,normal:THREE.Vector3,width:number,banking:number,surface:string},
 *   nearest: (p:{x:number,z:number})=>{s:number,lateral:number,onTrack:boolean,surface:string,width:number},
 *   checkpoints: Array, startGrid: Array, boostPads: Array, itemBoxes: Array,
 *   sectors: Array, corners: Array, points: Array
 * }}
 */
export function buildTrack(world, opts = {}) {
  const o = Object.assign({
    seed: 20250820,
    ds: 2.0,              // centreline resample step, metres
    laps: 3,
    smoothPasses: 34,     // vertical profile smoothing (kills DEM stair-steps)
    rawBlend: 0.20,       // how much of the raw drape to keep, so the hill still reads
    maxBank: 0.185,       // radians (~10.6 deg)
    jump: true,
    // Kat Racing runs an EIGHT-kart field (src/main.js), and trackMesh paints one numbered
    // box per published slot. Publishing twelve painted '9'..'12' boxes in front of an
    // eight-kart grid — which is what the grid camera was looking at — is simply wrong.
    // race.js extends the grid backwards itself if a larger field is ever requested.
    grid: 8,
  }, opts);

  // The course supplies the circuit; everything below is course-agnostic.
  const CO = courseOf(o.course);
  const CONTROL = CO.control, SECTORS = CO.sectors;
  ctrlCount = CONTROL.length;
  // Snapping pulls each control point onto the nearest real road centreline, which is what
  // makes Amikam's lap follow the actual village. A course whose control polyline was already
  // generated FROM the road network gains nothing from it and loses a great deal: displacing
  // alternate points of a corner arc by several metres turns a smooth radius into a zigzag,
  // and the racing line then reports absurd curvature regardless of how wide the corner is.
  const ctrl = CO.snap === false ? CONTROL.map(p => p.slice()) : snapToRoads(world, CONTROL, CO.snapTol);
  const dense = catmullClosed(ctrl, o.ds * 0.75);
  const { pts: flat, total: flatLen } = resampleClosed(dense, o.ds);
  const N = flat.length;

  /* --- per-sample sector lookup (width + surface) --- */
  const sectorOf = new Int32Array(N);
  const width = new Float32Array(N);
  {
    const bounds = SECTORS.map(s => s.i);
    for (let i = 0; i < N; i++) {
      const u = flat[i][2] % ctrlCount;
      let k = 0;
      for (let j = 0; j < bounds.length; j++) if (u >= bounds[j]) k = j;
      sectorOf[i] = k;
      width[i] = SECTORS[k].w;
    }
    // widths blend over 24 m so the ribbon never steps
    const w2 = Float32Array.from(width), R = Math.max(2, Math.round(12 / o.ds));
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let d = -R; d <= R; d++) sum += w2[((i + d) % N + N) % N];
      width[i] = sum / (2 * R + 1);
    }
  }

  /* --- drape + smooth the vertical profile --- */
  const y = new Float64Array(N), raw = new Float64Array(N);
  for (let i = 0; i < N; i++) raw[i] = y[i] = world.heightAt(flat[i][0], flat[i][1]);
  {
    let a = Float64Array.from(y), b = new Float64Array(N);
    for (let p = 0; p < o.smoothPasses; p++) {
      for (let i = 0; i < N; i++) b[i] = a[((i - 1) % N + N) % N] * 0.25 + a[i] * 0.5 + a[(i + 1) % N] * 0.25;
      const t = a; a = b; b = t;
    }
    for (let i = 0; i < N; i++) y[i] = lerp(a[i], raw[i], o.rawBlend);
  }

  /* --- arc length of the draped 3D line --- */
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = flat[i], b = flat[(i + 1) % N];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], y[(i + 1) % N] - y[i], b[1] - a[1]);
  }
  let length = cum[N];

  /* --- the jump: a kicker ramp, a lip, and a landing ramp downslope --- */
  const jumpInfo = { kickerS: 0, lipS: 0, landS: 0, landEndS: 0, active: false };
  // Amikam launches off the Rakia ridge; Dogpatch is flat reclaimed waterfront.
  if (o.jump && CO.jump !== false) {
    let ji = 0, jd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(flat[i][0] - JUMP.at[0], flat[i][1] - JUMP.at[1]);
      if (d < jd) { jd = d; ji = i; }
    }
    if (jd < 40) {
      const s0 = cum[ji];
      jumpInfo.active = true;
      jumpInfo.kickerS = s0; jumpInfo.lipS = s0 + JUMP.up;
      jumpInfo.landS = s0 + JUMP.up + JUMP.lip + JUMP.gapAfter;
      jumpInfo.landEndS = jumpInfo.landS + JUMP.landLen;
      for (let i = 0; i < N; i++) {
        const s = cum[i];
        let add = 0;
        if (s >= s0 && s <= s0 + JUMP.up) {               // ramp up
          const t = (s - s0) / JUMP.up; add = JUMP.rise * t * t * (3 - 2 * t) * 0.5 + JUMP.rise * 0.5 * t;
        } else if (s > s0 + JUMP.up && s <= s0 + JUMP.up + JUMP.lip) {
          add = JUMP.rise;                                 // flat lip
        } else if (s > jumpInfo.landS && s < jumpInfo.landEndS) {
          const t = (s - jumpInfo.landS) / JUMP.landLen;   // landing ramp, tapering out
          add = JUMP.land * (1 - t) * (1 - t);
        }
        y[i] += add;
      }
      for (let i = 0; i < N; i++) cum[i + 1] = cum[i] +
        Math.hypot(flat[(i + 1) % N][0] - flat[i][0], y[(i + 1) % N] - y[i], flat[(i + 1) % N][1] - flat[i][1]);
      length = cum[N];
    }
  }

  /* --- tangents, curvature, banking --- */
  const tanX = new Float32Array(N), tanY = new Float32Array(N), tanZ = new Float32Array(N);
  const curv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = flat[(i - 1 + N) % N], b = flat[(i + 1) % N];
    const dx = b[0] - a[0], dz = b[1] - a[1], dy = y[(i + 1) % N] - y[(i - 1 + N) % N];
    const l = Math.hypot(dx, dy, dz) || 1;
    tanX[i] = dx / l; tanY[i] = dy / l; tanZ[i] = dz / l;
  }
  for (let i = 0; i < N; i++) {
    const h0 = Math.atan2(tanX[(i - 1 + N) % N], tanZ[(i - 1 + N) % N]);
    const h1 = Math.atan2(tanX[(i + 1) % N], tanZ[(i + 1) % N]);
    curv[i] = wrapPi(h1 - h0) / (2 * o.ds);
  }
  {   // smooth curvature over ~20 m before it drives banking
    const R = Math.max(2, Math.round(10 / o.ds));
    const src = Float64Array.from(curv);
    for (let i = 0; i < N; i++) {
      let sum = 0, wt = 0;
      for (let d = -R; d <= R; d++) { const w = 1 - Math.abs(d) / (R + 1); sum += src[((i + d) % N + N) % N] * w; wt += w; }
      curv[i] = sum / wt;
    }
  }
  // Banking follows v^2/R: fast, open corners get real camber, slow hairpins barely any.
  // `lateral` (and sample().normal) point to the LEFT of travel, and collision.js lifts the
  // ribbon by tan(bank) * lateral, so a right-hand corner (negative curvature) wants bank > 0.
  const bank = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(curv[i]);
    const R = k > 1e-5 ? 1 / k : 1e5;
    const v = Math.min(34, Math.sqrt(9.0 * R));           // achievable corner speed, m/s
    const ideal = (v * v) / (9.81 * Math.max(R, 8));      // tan(theta) for a neutral corner
    bank[i] = -Math.sign(curv[i]) * clamp(ideal * 0.62, 0, o.maxBank);
  }
  {
    const R = Math.max(2, Math.round(14 / o.ds));
    const src = Float64Array.from(bank);
    for (let i = 0; i < N; i++) {
      let sum = 0, wt = 0;
      for (let d = -R; d <= R; d++) { const w = 1 - Math.abs(d) / (R + 1); sum += src[((i + d) % N + N) % N] * w; wt += w; }
      bank[i] = sum / wt;
    }
  }

  /* --- surfaces --- */
  const surface = new Array(N);
  for (let i = 0; i < N; i++) surface[i] = SECTORS[sectorOf[i]].surface;

  /* ---------------------------------------------------------- sampling ---- */
  const idxOfS = s => {
    let t = s % length; if (t < 0) t += length;
    let lo = 0, hi = N;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    return { i: lo, f: (t - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1) };
  };

  function sample(s) {
    const { i, f } = idxOfS(s), j = (i + 1) % N;
    const pos = new THREE.Vector3(
      lerp(flat[i][0], flat[j][0], f), lerp(y[i], y[j], f), lerp(flat[i][1], flat[j][1], f));
    const tangent = new THREE.Vector3(
      lerp(tanX[i], tanX[j], f), lerp(tanY[i], tanY[j], f), lerp(tanZ[i], tanZ[j], f)).normalize();
    const hl = Math.hypot(tangent.x, tangent.z) || 1;
    const normal = new THREE.Vector3(tangent.z / hl, 0, -tangent.x / hl);
    return {
      pos, tangent, normal,
      width: lerp(width[i], width[j], f),
      banking: lerp(bank[i], bank[j], f),
      curvature: lerp(curv[i], curv[j], f),
      surface: surface[f < 0.5 ? i : j],
      s: ((s % length) + length) % length,
    };
  }

  /* ------------------------------------------------------------ nearest ---- */
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of flat) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  x0 -= 160; x1 += 160; z0 -= 160; z1 += 160;
  const G = 96, gw = (x1 - x0) / G, gh = (z1 - z0) / G;
  const seed = new Int32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const px = x0 + (i + 0.5) * gw, pz = z0 + (j + 0.5) * gh;
    let best = 0, bd = Infinity;
    for (let k = 0; k < N; k += 2) {
      const d = (flat[k][0] - px) ** 2 + (flat[k][1] - pz) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    seed[j * G + i] = best;
  }
  const SPAN = Math.ceil(Math.max(gw, gh) / o.ds) + 6;

  function nearest(pos) {
    const px = pos.x, pz = pos.z;
    const gi = clamp(Math.floor((px - x0) / gw), 0, G - 1), gj = clamp(Math.floor((pz - z0) / gh), 0, G - 1);
    const s0 = seed[gj * G + gi];
    let best = s0, bd = Infinity;
    for (let d = -SPAN; d <= SPAN; d++) {
      const k = ((s0 + d) % N + N) % N;
      const dd = (flat[k][0] - px) ** 2 + (flat[k][1] - pz) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    }
    let bs = cum[best], blat = 0, bdist = Infinity, bi = best;
    for (let d = -1; d <= 0; d++) {
      const ia = ((best + d) % N + N) % N, ib = (ia + 1) % N;
      const ax = flat[ia][0], az = flat[ia][1];
      const dx = flat[ib][0] - ax, dz = flat[ib][1] - az;
      const l2 = dx * dx + dz * dz || 1, tl = Math.sqrt(l2);
      const t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
      const cx = ax + dx * t, cz = az + dz * t;
      const dist = Math.hypot(px - cx, pz - cz);
      if (dist < bdist) {
        bdist = dist; bs = cum[ia] + t * tl; bi = ia;
        blat = (px - cx) * (dz / tl) + (pz - cz) * (-dx / tl);
      }
    }
    const w = width[bi];
    return {
      s: ((bs % length) + length) % length,
      lateral: blat, distance: bdist, width: w,
      onTrack: Math.abs(blat) <= w * 0.5,
      surface: surface[bi],
    };
  }

  /* ------------------------------------------------------------- corners ---- */
  const corners = [];
  {
    let run = 0, startI = 0, sign = 0, peak = 0;
    for (let i = 0; i <= N; i++) {
      const k = curv[i % N] * o.ds;
      const sg = Math.sign(k), big = Math.abs(k) > 0.006;
      if (big && sg === sign) { run += k; peak = Math.max(peak, Math.abs(curv[i % N])); }
      else {
        if (Math.abs(run) > 0.6) {
          const mid = (startI + i) >> 1;
          corners.push({
            s: cum[mid % N], angle: run, radius: peak > 1e-5 ? 1 / peak : 1e5,
            dir: run > 0 ? 'left' : 'right',
            pos: { x: flat[mid % N][0], y: y[mid % N], z: flat[mid % N][1] },
          });
        }
        run = big ? k : 0; sign = big ? sg : 0; startI = i; peak = big ? Math.abs(curv[i % N]) : 0;
      }
    }
  }

  /* -------------------------------------------------- start line and grid ---- */
  // The line lives on Rehov Rakefet, a few metres after the last village corner.
  let startS = 0;
  {
    let bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(flat[i][0] - (-60), flat[i][1] - 68);
      if (d < bd) { bd = d; startS = cum[i]; }
    }
  }
  const startGrid = [];
  for (let i = 0; i < o.grid; i++) {
    const s = startS - 9 - Math.floor(i / 2) * 7.5;
    const sm = sample(s);
    const side = (i % 2 ? 1 : -1) * (sm.width * 0.22);
    startGrid.push({
      pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y + 0.05, z: sm.pos.z + sm.normal.z * side },
      rot: Math.atan2(sm.tangent.x, sm.tangent.z),
    });
  }

  /* ---------------------------------------------------------- checkpoints ---- */
  const checkpoints = [];
  {
    const n = Math.max(12, Math.round(length / 145));
    for (let i = 0; i < n; i++) {
      const s = ((startS + i / n * length) % length + length) % length;
      const sm = sample(s);
      checkpoints.push({ index: i, s, pos: { x: sm.pos.x, y: sm.pos.y, z: sm.pos.z }, width: sm.width });
    }
  }

  /* ------------------------------------------------------------ pickups ---- */
  const rand = rng(o.seed);
  const boostPads = [];
  {
    // Pads live on corner exits and at the foot of the two climbs — where a kart wants them.
    const spots = [0.045, 0.155, 0.315, 0.395, 0.505, 0.585, 0.700, 0.815, 0.905];
    for (const f of spots) {
      const s = ((startS + f * length) % length + length) % length;
      const sm = sample(s);
      for (const lane of [-1, 1]) {
        const off = lane * sm.width * 0.20;
        boostPads.push({
          pos: { x: sm.pos.x + sm.normal.x * off, y: sm.pos.y + 0.02, z: sm.pos.z + sm.normal.z * off },
          dir: { x: sm.tangent.x, y: sm.tangent.y, z: sm.tangent.z },
          radius: 3.4, s, lateral: off, heading: Math.atan2(sm.tangent.x, sm.tangent.z),
        });
      }
    }
  }
  const itemBoxes = [];
  {
    const rows = [0.085, 0.225, 0.360, 0.470, 0.545, 0.655, 0.760, 0.870, 0.955];
    for (const f of rows) {
      const s = ((startS + f * length) % length + length) % length;
      const sm = sample(s);
      const n = 5, span = Math.min(sm.width * 0.72, 9.5);
      for (let k = 0; k < n; k++) {
        const off = (k / (n - 1) - 0.5) * span;
        itemBoxes.push({
          pos: { x: sm.pos.x + sm.normal.x * off, y: sm.pos.y + 1.35, z: sm.pos.z + sm.normal.z * off },
          s, lateral: off,
        });
      }
    }
    void rand;
  }

  /* ---------------------------------------------------------- shortcuts ---- */
  const shortcuts = [];
  // The Orchard Cut is a feature of Amikam's terrain, not of every course: a flat street
  // circuit hemmed in by warehouses has nothing to cut through.
  if (CO.shortcut) {
    const pts = SHORTCUT.map(p => ({ x: p[0], z: p[1], y: world.heightAt(p[0], p[1]) }));
    const a = nearest(pts[0]), b = nearest(pts[pts.length - 1]);
    let saved = b.s - a.s; if (saved < 0) saved += length;
    let cut = 0;
    for (let i = 1; i < pts.length; i++) cut += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    shortcuts.push({
      name: 'Orchard Cut', he: 'קיצור הכרם',
      path: SHORTCUT.map(p => [p[0], p[1]]), points: pts,
      width: 5.5, surface: 'dirt', enterS: a.s, exitS: b.s, saves: saved - cut,
    });
  }

  /* ------------------------------------------------------ exported spline ---- */
  const curvePts = [];
  for (let s = 0; s < length; s += 8) { const p = sample(s); curvePts.push(p.pos); }
  const spline = new THREE.CatmullRomCurve3(curvePts, true, 'centripetal', 0.5);

  const points = [];
  for (let i = 0; i < N; i++) points.push({ x: flat[i][0], y: y[i], z: flat[i][1] });

  return {
    spline, length, laps: o.laps, startS,
    sample, nearest,
    checkpoints, startGrid, boostPads, itemBoxes, shortcuts,
    corners, sectors: SECTORS, jump: jumpInfo,
    points, count: N, ds: o.ds,
    widthAt: i => width[i], bankAt: i => bank[i], surfaceAt: i => surface[i],
    name: CO.name, nameHe: CO.nameHe, course: CO.slug, theme: CO.theme,
  };
}

export default buildTrack;
