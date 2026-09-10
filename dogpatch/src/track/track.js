/**
 * The Dogpatch Waterfront circuit.
 *
 * A street circuit on San Francisco's eastern shore, laid over the real Overture road network:
 * every control point below is a measured intersection of the actual grid, with 40 m corner arcs
 * between them. Anticlockwise, five lefts and one right, about 1.7 km.
 *
 *   Pier 70 Straight ..... Illinois St northbound, the fast leg past the old shipyard
 *   Twentieth Street ..... west across the neighbourhood, Esprit Park on the left
 *   Esprit Park Esses .... Indiana St south down the park's western edge
 *   Dogpatch Corner ...... the 22nd St block, into the lap's only right-hander
 *   Tennessee Run ........ south past the American Industrial Center
 *   Twenty-Third Turn .... east back to the start/finish line
 *
 * Metres, +X east / +Z south. These points are NOT snapped to the road data at build time: they
 * were generated from it, and re-snapping displaces alternate points of a corner arc by several
 * metres, which turns a smooth radius into a zigzag and makes the racing line report absurd
 * curvature. That cost a day to work out the first time.
 */
import * as THREE from 'three';
import { clamp, lerp, wrapPi } from '../core/math.js';

const CONTROL = [
  [246, 147], [248, 131], [244, 77], [239, 22], [235, -33], [231, -87],
  [227, -142], [223, -197], [218, -251], [214, -306], [210, -361], [206, -376],
  [196, -388], [183, -396], [168, -398], [104, -394], [41, -390], [-22, -386],
  [-86, -382], [-101, -378], [-113, -369], [-121, -356], [-123, -341], [-121, -288],
  [-118, -236], [-116, -184], [-113, -132], [-109, -117], [-100, -104], [-86, -96],
  [-70, -94], [20, -101], [35, -99], [48, -92], [58, -79], [62, -65],
  [69, 4], [75, 73], [81, 141], [87, 160], [102, 173], [122, 178],
  [209, 174], [225, 171], [238, 161],
];

const SECTORS = [
  { i: 0,  name: 'Pier 70 Straight',  w: 14.0 },
  { i: 12, name: 'Twentieth Street',  w: 13.0 },
  { i: 20, name: 'Esprit Park Esses', w: 12.5 },
  { i: 28, name: 'Dogpatch Corner',   w: 12.5 },
  { i: 33, name: 'Tennessee Run',     w: 13.0 },
  { i: 40, name: 'Twenty-Third Turn', w: 13.5 },
];

/** Closed Catmull-Rom through the control points, resampled to a fixed step. */
function resample(ctrl, ds) {
  const n = ctrl.length;
  const cr = (a, b, c, d, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  const dense = [];
  for (let i = 0; i < n; i++) {
    const a = ctrl[(i - 1 + n) % n], b = ctrl[i], c = ctrl[(i + 1) % n], d = ctrl[(i + 2) % n];
    for (let k = 0; k < 12; k++) {
      const t = k / 12;
      dense.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t), i + t]);
    }
  }
  // arc-length resample so `s` is metres everywhere, which every consumer assumes
  let total = 0;
  const seg = dense.map((p, i) => {
    const q = dense[(i + 1) % dense.length];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    total += d; return d;
  });
  const out = [];
  let acc = 0, i = 0, carry = 0;
  for (let s = 0; s < total; s += ds) {
    while (acc + seg[i] < s && i < seg.length - 1) { acc += seg[i]; i++; }
    const f = seg[i] > 0 ? (s - acc) / seg[i] : 0;
    const p = dense[i], q = dense[(i + 1) % dense.length];
    let u0 = p[2], u1 = q[2];
    if (u1 < u0) u1 += n;                       // do not wrap backwards across the seam
    out.push([lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(u0, u1, f) % n]);
    carry = s;
  }
  void carry;
  return { pts: out, length: total };
}

export function buildTrack(world, opts = {}) {
  const ds = opts.ds ?? 2.0;
  const laps = opts.laps ?? 3;
  const { pts, length } = resample(CONTROL, ds);
  const N = pts.length;

  // per-sample sector, width and height
  const sectorOf = new Int32Array(N);
  const width = new Float32Array(N);
  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = pts[i][2];
    let k = 0;
    for (let j = 0; j < SECTORS.length; j++) if (u >= SECTORS[j].i) k = j;
    sectorOf[i] = k;
    width[i] = SECTORS[k].w;
    y[i] = world.heightAt(pts[i][0], pts[i][1]);
  }
  // Smooth the vertical profile: the DEM is a 3 m grid and draping raw gives the road a stair
  // step every post, which the suspension reads as a kerb.
  for (let pass = 0; pass < 24; pass++) {
    const prev = y.slice();
    for (let i = 0; i < N; i++) y[i] = (prev[(i - 1 + N) % N] + 2 * prev[i] + prev[(i + 1) % N]) * 0.25;
  }

  // tangents and normals
  const tan = new Float32Array(N * 2), nrm = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
    tan[i * 2] = tx / l; tan[i * 2 + 1] = tz / l;
    nrm[i * 2] = -tan[i * 2 + 1]; nrm[i * 2 + 1] = tan[i * 2];   // left of travel
  }

  const at = i => ((i % N) + N) % N;
  const sample = s => {
    const f = (s / ds) % N, i = at(Math.floor(f)), j = at(i + 1), t = f - Math.floor(f);
    return {
      pos: new THREE.Vector3(lerp(pts[i][0], pts[j][0], t), lerp(y[i], y[j], t), lerp(pts[i][1], pts[j][1], t)),
      tangent: new THREE.Vector3(lerp(tan[i * 2], tan[j * 2], t), 0, lerp(tan[i * 2 + 1], tan[j * 2 + 1], t)).normalize(),
      normal: new THREE.Vector3(lerp(nrm[i * 2], nrm[j * 2], t), 0, lerp(nrm[i * 2 + 1], nrm[j * 2 + 1], t)).normalize(),
      width: lerp(width[i], width[j], t),
      sector: SECTORS[sectorOf[i]],
    };
  };

  // A uniform grid over the circuit's bounding box makes `nearest` O(1) instead of O(N); the
  // vehicle, the AI and every lap check call it several times a frame.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const CELL = 24, gw = Math.ceil((maxX - minX) / CELL) + 2, gh = Math.ceil((maxZ - minZ) / CELL) + 2;
  const bins = Array.from({ length: gw * gh }, () => []);
  const cellOf = (x, z) => {
    const cx = clamp(Math.floor((x - minX) / CELL) + 1, 0, gw - 1);
    const cz = clamp(Math.floor((z - minZ) / CELL) + 1, 0, gh - 1);
    return cz * gw + cx;
  };
  for (let i = 0; i < N; i++) bins[cellOf(pts[i][0], pts[i][1])].push(i);

  function nearest(p) {
    const cx = clamp(Math.floor((p.x - minX) / CELL) + 1, 0, gw - 1);
    const cz = clamp(Math.floor((p.z - minZ) / CELL) + 1, 0, gh - 1);
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {           // widen only if the ring came up empty
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) continue;
        for (const i of bins[gz * gw + gx]) {
          const d = (pts[i][0] - p.x) ** 2 + (pts[i][1] - p.z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best < 0) best = 0;
    const dx = p.x - pts[best][0], dz = p.z - pts[best][1];
    const lateral = dx * nrm[best * 2] + dz * nrm[best * 2 + 1];
    return { s: best * ds, i: best, lateral, width: width[best],
             onTrack: Math.abs(lateral) < width[best] * 0.5 + 1.2, y: y[best] };
  }

  // Checkpoints exist to stop a lap counting when someone cuts the course; one every ~140 m is
  // plenty and keeps the wrong-way test cheap.
  const checkpoints = [];
  for (let s = 0; s < length; s += length / 12) checkpoints.push(sample(s));

  /** Eight slots, two abreast, backwards from the line. */
  const startGrid = [];
  for (let k = 0; k < (opts.grid ?? 8); k++) {
    const sm = sample(length - 8 - Math.floor(k / 2) * 7);
    const side = (k % 2 ? 1 : -1) * 2.7;
    startGrid.push({
      pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y, z: sm.pos.z + sm.normal.z * side },
      rot: Math.atan2(sm.tangent.x, sm.tangent.z),
    });
  }

  return {
    name: 'Dogpatch Waterfront', length, ds, laps, count: N, sectors: SECTORS,
    sample, nearest, checkpoints, startGrid, startS: 0,
    points: pts, heights: y, widths: width,
    headingAt: s => { const m = sample(s); return Math.atan2(m.tangent.x, m.tangent.z); },
    wrapS: s => ((s % length) + length) % length,
    /** Signed gap from a to b the short way round, for wrong-way and place ordering. */
    delta: (a, b) => { let d = b - a; while (d > length / 2) d -= length; while (d < -length / 2) d += length; return d; },
    curvatureAt: s => {
      const a = sample(s - 12), b = sample(s), c = sample(s + 12);
      const h1 = Math.atan2(b.tangent.x, b.tangent.z) - Math.atan2(a.tangent.x, a.tangent.z);
      const h2 = Math.atan2(c.tangent.x, c.tangent.z) - Math.atan2(b.tangent.x, b.tangent.z);
      return (wrapPi(h1) + wrapPi(h2)) / 24;
    },
  };
}
