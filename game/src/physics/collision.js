/**
 * Collision + ground queries for Kat Racing.
 *
 * Owns everything the vehicle needs to know about the shape of the world:
 *   - ray-vs-terrain probes (heightfield root-find along a near-vertical ray)
 *   - the *driving surface*: terrain, optionally flattened + banked onto the track ribbon
 *   - a surface-material raster (tarmac / kerb / dirt / grass / orchard / sand ...) built once
 *     from the real Overture land-cover, land-use and road data
 *   - static blockers (building footprints, optional track barriers) in a uniform grid hash
 *   - chassis-vs-wall sliding resolution and kart-vs-kart momentum exchange
 *
 * No Three.js dependency: this runs identically in the browser and in the headless sim.
 * World convention: +X east, +Z south, +Y up, metres. Vehicle local forward is +Z.
 */
import { clamp } from '../core/mathx.js';

/* ------------------------------------------------------------------ vec/quat */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vadd = (o, a, b) => vset(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const vsub = (o, a, b) => vset(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const vmad = (o, a, b, s) => vset(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const vscale = (o, a, s) => vset(o, a.x * s, a.y * s, a.z * s);
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (o, a, b) => vset(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const vlen = a => Math.hypot(a.x, a.y, a.z);
export const vlenXZ = a => Math.hypot(a.x, a.z);
export const vnorm = (o, a = o) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return vset(o, a.x / l, a.y / l, a.z / l); };

export const q4 = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });
export function qmul(o, a, b) {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
}
export function qnorm(q) {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= l; q.y /= l; q.z /= l; q.w /= l; return q;
}
export const qconj = (o, q) => { o.x = -q.x; o.y = -q.y; o.z = -q.z; o.w = q.w; return o; };
/** Rotate vector a by quaternion q. */
export function qrot(o, q, a) {
  const ix = q.w * a.x + q.y * a.z - q.z * a.y;
  const iy = q.w * a.y + q.z * a.x - q.x * a.z;
  const iz = q.w * a.z + q.x * a.y - q.y * a.x;
  const iw = -q.x * a.x - q.y * a.y - q.z * a.z;
  return vset(o,
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
/** Inverse-rotate (world -> body) for unit quaternions. */
export function qrotInv(o, q, a) { const c = qconj(_qt, q); return qrot(o, c, a); }
const _qt = q4();
export function qAxisAngle(o, ax, ay, az, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  o.x = ax * s; o.y = ay * s; o.z = az * s; o.w = Math.cos(h); return o;
}
export const qYaw = (o, yaw) => qAxisAngle(o, 0, 1, 0, yaw);
/** q += 0.5 * w * q * dt, then normalise. w is a world-space angular velocity. */
export function qIntegrate(q, w, dt) {
  const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
  const dx = hx * q.w + hy * q.z - hz * q.y;
  const dy = hy * q.w + hz * q.x - hx * q.z;
  const dz = hz * q.w + hx * q.y - hy * q.x;
  const dw = -hx * q.x - hy * q.y - hz * q.z;
  q.x += dx; q.y += dy; q.z += dz; q.w += dw;
  return qnorm(q);
}
/** Yaw of a quaternion under the "local +Z is forward" convention. */
export function qToYaw(q) {
  const f = qrot(v3(), q, FWD);
  return Math.atan2(f.x, f.z);
}
export const FWD = Object.freeze({ x: 0, y: 0, z: 1 });
export const UP = Object.freeze({ x: 0, y: 1, z: 0 });
export const RIGHT = Object.freeze({ x: 1, y: 0, z: 0 });

/* ------------------------------------------------------------------ surfaces */

/**
 * Per-surface driving characteristics.
 *   grip  — tyre friction multiplier (1 = race tarmac)
 *   roll  — rolling-resistance coefficient (fraction of normal load)
 *   drag  — extra quadratic drag coefficient added to the body
 *   top   — top-speed multiplier: this is what makes going off-track *hurt* in a kart game
 *   dust  — particle spawn strength for the FX layer
 *   rough — vertical rumble amplitude (kerbs and ploughed soil shake the kart)
 */
export const SURFACES = {
  tarmac:     { grip: 1.00, roll: 0.014, drag: 0.00, top: 1.00, dust: 0.00, rough: 0.00 },
  asphalt:    { grip: 1.00, roll: 0.014, drag: 0.00, top: 1.00, dust: 0.00, rough: 0.00 },
  road:       { grip: 1.00, roll: 0.014, drag: 0.00, top: 1.00, dust: 0.00, rough: 0.00 },
  concrete:   { grip: 0.96, roll: 0.017, drag: 0.00, top: 0.99, dust: 0.02, rough: 0.03 },
  paved:      { grip: 0.97, roll: 0.016, drag: 0.00, top: 0.99, dust: 0.02, rough: 0.05 },
  kerb:       { grip: 0.86, roll: 0.030, drag: 0.02, top: 0.97, dust: 0.06, rough: 0.60 },
  curb:       { grip: 0.86, roll: 0.030, drag: 0.02, top: 0.97, dust: 0.06, rough: 0.60 },
  rumble:     { grip: 0.86, roll: 0.030, drag: 0.02, top: 0.97, dust: 0.06, rough: 0.60 },
  dirt_track: { grip: 0.78, roll: 0.048, drag: 0.04, top: 0.91, dust: 0.70, rough: 0.16 },
  dirt:       { grip: 0.72, roll: 0.062, drag: 0.06, top: 0.87, dust: 0.85, rough: 0.22 },
  unpaved:    { grip: 0.74, roll: 0.056, drag: 0.05, top: 0.89, dust: 0.80, rough: 0.20 },
  gravel:     { grip: 0.64, roll: 0.095, drag: 0.11, top: 0.81, dust: 0.95, rough: 0.36 },
  grass:      { grip: 0.60, roll: 0.130, drag: 0.15, top: 0.75, dust: 0.45, rough: 0.28 },
  crop:       { grip: 0.56, roll: 0.150, drag: 0.19, top: 0.71, dust: 0.60, rough: 0.32 },
  scrub:      { grip: 0.54, roll: 0.165, drag: 0.21, top: 0.69, dust: 0.62, rough: 0.42 },
  forest:     { grip: 0.52, roll: 0.175, drag: 0.23, top: 0.67, dust: 0.50, rough: 0.46 },
  orchard:    { grip: 0.55, roll: 0.158, drag: 0.20, top: 0.70, dust: 0.88, rough: 0.34 },
  soil:       { grip: 0.58, roll: 0.142, drag: 0.18, top: 0.73, dust: 0.92, rough: 0.30 },
  farmyard:   { grip: 0.66, roll: 0.090, drag: 0.10, top: 0.83, dust: 0.85, rough: 0.30 },
  sand:       { grip: 0.46, roll: 0.225, drag: 0.32, top: 0.61, dust: 1.20, rough: 0.24 },
  water:      { grip: 0.34, roll: 0.300, drag: 0.48, top: 0.48, dust: 0.00, rough: 0.10 },
};
for (const k of Object.keys(SURFACES)) SURFACES[k].name = k;
export const surfaceInfo = s => SURFACES[s] || SURFACES.dirt;

/** Map raw Overture class/subclass strings onto our surface table. */
function classifySurface(cls, sub, surface) {
  const s = String(surface || '').toLowerCase();
  if (SURFACES[s]) return s;
  if (/asphalt|paved|tarmac|chipseal/.test(s)) return 'tarmac';
  if (/gravel|compacted|fine_gravel/.test(s)) return 'gravel';
  if (/ground|earth|mud|unpaved|dirt/.test(s)) return 'dirt';
  if (/sand/.test(s)) return 'sand';
  if (/grass/.test(s)) return 'grass';
  const c = String(sub || cls || '').toLowerCase();
  if (SURFACES[c]) return c;
  if (/motorway|trunk|primary|secondary|tertiary|residential|living|service|unclassified/.test(c)) return 'tarmac';
  if (/track/.test(c)) return 'dirt_track';
  if (/path|footway|cycleway|steps/.test(c)) return 'dirt';
  if (/forest|wood|tree/.test(c)) return 'forest';
  if (/shrub|scrub|heath/.test(c)) return 'scrub';
  if (/grass|meadow|park|pitch/.test(c)) return 'grass';
  if (/crop|farmland|field/.test(c)) return 'crop';
  if (/orchard|vineyard|plant_nursery/.test(c)) return 'orchard';
  if (/farmyard|yard/.test(c)) return 'farmyard';
  if (/barren|bare|rock|desert/.test(c)) return 'dirt';
  if (/water|river|stream|pond|reservoir/.test(c)) return 'water';
  return null;
}

/* ------------------------------------------------------------------ helpers */

function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from p to segment ab in XZ, plus the closest point. */
function segDistXZ(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cz = az + dz * t;
  out.x = cx; out.z = cz; out.t = t;
  return Math.hypot(px - cx, pz - cz);
}

/* ------------------------------------------------------------------ world */

export function createCollisionWorld(world, track, opts = {}) {
  const o = Object.assign({
    surfaceCell: 6,          // metres per surface-raster cell
    nearestCache: 0.30,      // reuse a track.nearest() result within this radius (perf)
    blockerCell: 24,         // metres per spatial-hash cell for static blockers
    buildings: true,         // building footprints are solid
    buildingPad: 0.35,       // inflate footprints slightly so we never clip a wall
    carveTrack: true,        // never leave a solid blocker standing in the middle of the road
    carveMargin: 1.0,
    trackBarriers: false,    // hard walls along the track edge (off: off-track is legal, just slow)
    barrierMargin: 2.4,
    flattenTrack: true,      // blend terrain height toward the track ribbon's own height
    banking: true,
    kerbWidth: 1.4,          // width of the rumble strip either side of the racing surface
    maxBlockerRange: 900,    // only hash blockers within this radius of the track/world centre
  }, opts);

  const half = world.half ?? (world.extent ? world.extent / 2 : 1536);

  /* ---------- surface raster ---------- */
  const cell = o.surfaceCell;
  const gN = Math.max(32, Math.ceil((half * 2) / cell));
  const grid = new Uint8Array(gN * gN);
  const names = ['dirt'];                     // index 0 = default
  const nameIdx = new Map([['dirt', 0]]);
  const idOf = n => {
    if (!n) return 0;
    let i = nameIdx.get(n);
    if (i === undefined) { i = names.length; names.push(n); nameIdx.set(n, i); }
    return i;
  };
  const gx = x => Math.floor((x + half) / cell);
  const gz = z => Math.floor((z + half) / cell);
  const cx = i => -half + (i + 0.5) * cell;

  function stampPolys(list, prio) {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const name = classifySurface(f.cls, f.sub, f.surface);
      if (!name) continue;
      const id = idOf(name);
      const rings = f.rings || (f.poly ? f.paths : null) || (f.poly ? [f.poly] : null) || f.paths;
      if (!rings) continue;
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const p of ring) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
        const i0 = clamp(gx(x0), 0, gN - 1), i1 = clamp(gx(x1), 0, gN - 1);
        const j0 = clamp(gz(z0), 0, gN - 1), j1 = clamp(gz(z1), 0, gN - 1);
        if ((i1 - i0) * (j1 - j0) > 400000) continue;   // absurdly large polygon: skip
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          if (pointInRing(ring, cx(i), cx(j))) grid[j * gN + i] = id;
        }
      }
      void prio;
    }
  }

  function stampPaths(list) {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const name = classifySurface(f.cls, f.sub, f.surface);
      if (!name) continue;
      const id = idOf(name);
      const w = Math.max(2.5, (f.width || 4)) * 0.5 + 0.6;
      const r = Math.ceil(w / cell);
      for (const path of (f.paths || [])) {
        for (let k = 1; k < path.length; k++) {
          const ax = path[k - 1][0], az = path[k - 1][1], bx = path[k][0], bz = path[k][1];
          const len = Math.hypot(bx - ax, bz - az);
          const steps = Math.max(1, Math.ceil(len / (cell * 0.6)));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
            const ci = gx(px), cj = gz(pz);
            for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
              if (i < 0 || j < 0 || i >= gN || j >= gN) continue;
              if (Math.hypot(cx(i) - px, cx(j) - pz) <= w) grid[j * gN + i] = id;
            }
          }
        }
      }
    }
  }

  try {
    stampPolys(world.landcover, 0);
    stampPolys(world.landuse, 1);
    stampPolys(world.water, 2);
    stampPaths(world.roads);
  } catch (e) { /* raster is an optimisation, never fatal */ }

  function rasterSurface(x, z) {
    const i = gx(x), j = gz(z);
    if (i < 0 || j < 0 || i >= gN || j >= gN) return 'dirt';
    return names[grid[j * gN + i]] || 'dirt';
  }

  /* ---------- static blockers ---------- */
  const segs = [];   // flat [ax, az, bx, bz, kind] tuples
  const hash = new Map();
  const bc = o.blockerCell;
  const key = (i, j) => i * 73856093 ^ j * 19349663;

  function addSeg(ax, az, bx, bz, kind = 0) {
    const id = segs.length;
    segs.push({ ax, az, bx, bz, kind });
    const i0 = Math.floor(Math.min(ax, bx) / bc), i1 = Math.floor(Math.max(ax, bx) / bc);
    const j0 = Math.floor(Math.min(az, bz) / bc), j1 = Math.floor(Math.max(az, bz) / bc);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = key(i, j);
      let a = hash.get(k); if (!a) hash.set(k, a = []);
      a.push(id);
    }
  }

  /** True when any part of a footprint sits on the racing surface — those get bulldozed. */
  function onRacingSurface(ring) {
    if (!o.carveTrack || !track || typeof track.nearest !== 'function') return false;
    for (let k = 0; k < ring.length; k++) {
      try {
        const n = track.nearest({ x: ring[k][0], y: 0, z: ring[k][1] });
        let hw = 6.5;
        if (typeof track.sample === 'function') { const sm = track.sample(n.s); if (sm && sm.width) hw = sm.width * 0.5; }
        if (Math.abs(n.lateral) < hw + o.carveMargin) return true;
      } catch (e) { return false; }
    }
    return false;
  }

  if (o.buildings && Array.isArray(world.buildings)) {
    for (const b of world.buildings) {
      const rings = b.rings; if (!rings) continue;
      if (rings[0] && onRacingSurface(rings[0])) continue;
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        // inflate the ring about its centroid so we stop just short of the wall
        let ox = 0, oz = 0;
        for (const p of ring) { ox += p[0]; oz += p[1]; }
        ox /= ring.length; oz /= ring.length;
        const pad = o.buildingPad;
        for (let k = 0; k < ring.length; k++) {
          const p = ring[k], q = ring[(k + 1) % ring.length];
          const pl = Math.hypot(p[0] - ox, p[1] - oz) || 1, ql = Math.hypot(q[0] - ox, q[1] - oz) || 1;
          addSeg(ox + (p[0] - ox) * (1 + pad / pl), oz + (p[1] - oz) * (1 + pad / pl),
                 ox + (q[0] - ox) * (1 + pad / ql), oz + (q[1] - oz) * (1 + pad / ql), 1);
        }
      }
    }
  }

  if (o.trackBarriers && track && typeof track.sample === 'function' && track.length > 0) {
    const step = 6, n = Math.max(8, Math.floor(track.length / step));
    let prevL = null, prevR = null;
    for (let i = 0; i <= n; i++) {
      const s = (i % n) * (track.length / n);
      const sm = track.sample(s);
      const side = lateralAxis(sm);
      const w = (sm.width || 12) * 0.5 + o.barrierMargin;
      const L = { x: sm.pos.x - side.x * w, z: sm.pos.z - side.z * w };
      const R = { x: sm.pos.x + side.x * w, z: sm.pos.z + side.z * w };
      if (prevL) { addSeg(prevL.x, prevL.z, L.x, L.z, 2); addSeg(prevR.x, prevR.z, R.x, R.z, 2); }
      prevL = L; prevR = R;
    }
  }

  /** The in-plane "right" axis of a track sample, defensive about what `normal` means. */
  function lateralAxis(sm, out = v3()) {
    const t = sm.tangent || { x: 0, y: 0, z: 1 };
    if (sm.normal && Math.abs(sm.normal.y ?? 0) < 0.7 && (Math.abs(sm.normal.x) + Math.abs(sm.normal.z)) > 0.2) {
      // `normal` is the in-plane lateral vector
      const l = Math.hypot(sm.normal.x, sm.normal.z) || 1;
      return vset(out, sm.normal.x / l, 0, sm.normal.z / l);
    }
    const l = Math.hypot(t.x, t.z) || 1;
    return vset(out, t.z / l, 0, -t.x / l);       // up x forward = right-hand side of travel
  }

  function nearbySegs(x, z, r) {
    const out = [];
    const i0 = Math.floor((x - r) / bc), i1 = Math.floor((x + r) / bc);
    const j0 = Math.floor((z - r) / bc), j1 = Math.floor((z + r) / bc);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const a = hash.get(key(i, j)); if (!a) continue;
      for (const id of a) if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  /* ---------- driving surface ---------- */
  const _lat = v3(), _tmp = v3();
  const nearestCache = { x: 1e9, z: 1e9, res: null };

  function trackNearest(x, z) {
    if (!track || typeof track.nearest !== 'function') return null;
    if (Math.abs(x - nearestCache.x) < o.nearestCache && Math.abs(z - nearestCache.z) < o.nearestCache) return nearestCache.res;
    let r = null;
    try { r = track.nearest({ x, y: 0, z }); } catch (e) { r = null; }
    nearestCache.x = x; nearestCache.z = z; nearestCache.res = r;
    return r;
  }

  /**
   * Height of the *driving* surface at x/z: terrain, blended toward the track ribbon where
   * the ribbon exists, plus the bank cross-slope. Returns { y, bank, lateral, onTrack, s }.
   */
  const _sd = { y: 0, bank: 0, lateral: 0, onTrack: false, s: 0, width: 12, tanX: 0, tanZ: 1, latX: 1, latZ: 0, blend: 0 };
  function surfaceData(x, z) {
    const ty = world.heightAt(x, z);
    _sd.y = ty; _sd.bank = 0; _sd.lateral = 0; _sd.onTrack = false; _sd.s = 0; _sd.blend = 0;
    _sd.width = 12; _sd.tanX = 0; _sd.tanZ = 1; _sd.latX = 1; _sd.latZ = 0;
    const nr = trackNearest(x, z);
    if (!nr || typeof track.sample !== 'function') return _sd;
    let sm = null;
    try { sm = track.sample(nr.s); } catch (e) { return _sd; }
    if (!sm || !sm.pos) return _sd;
    const lat = (nr.lateral !== undefined) ? nr.lateral : 0;
    const w = (sm.width || nr.width || 12);
    const hw = w * 0.5;
    lateralAxis(sm, _lat);
    _sd.s = nr.s; _sd.lateral = lat; _sd.width = w;
    _sd.latX = _lat.x; _sd.latZ = _lat.z;
    const tl = Math.hypot(sm.tangent?.x ?? 0, sm.tangent?.z ?? 1) || 1;
    _sd.tanX = (sm.tangent?.x ?? 0) / tl; _sd.tanZ = (sm.tangent?.z ?? 1) / tl;
    _sd.onTrack = (nr.onTrack !== undefined) ? !!nr.onTrack : Math.abs(lat) <= hw;
    // fade the ribbon influence out over ~4 m past the edge so there is no cliff
    const blend = 1 - clamp((Math.abs(lat) - hw) / 4, 0, 1);
    _sd.blend = blend;
    if (blend <= 0) return _sd;
    const bank = o.banking ? (sm.banking || 0) : 0;
    _sd.bank = bank * blend;
    if (o.flattenTrack && Number.isFinite(sm.pos.y)) {
      const ribbon = sm.pos.y + Math.tan(_sd.bank) * lat;
      _sd.y = ty + (ribbon - ty) * blend;
    } else if (bank) {
      _sd.y = ty + Math.tan(_sd.bank) * lat * blend;
    }
    return _sd;
  }

  function groundHeight(x, z) { return surfaceData(x, z).y; }

  /**
   * Surface normal of the driving surface. The terrain part comes from the heightfield;
   * the ribbon part is built analytically from the tangent and the bank angle, which is both
   * exact and ~5x cheaper than central-differencing the blended height (this runs four times
   * per wheel per substep, so it matters).
   */
  const _rn = v3(), _tn = v3(), _lb = v3();
  function groundNormal(x, z, out = v3()) {
    const sd = surfaceData(x, z);
    world.normalAt(x, z, _tn);
    if (sd.blend <= 0.001) return vset(out, _tn.x, _tn.y, _tn.z);
    // longitudinal slope of the ribbon + its bank cross-slope
    let sm = null;
    try { sm = track.sample(sd.s); } catch (e) { sm = null; }
    const t = sm && sm.tangent ? sm.tangent : { x: sd.tanX, y: 0, z: sd.tanZ };
    const cb = Math.cos(sd.bank), sb = Math.sin(sd.bank);
    vset(_lb, sd.latX * cb, sb, sd.latZ * cb);
    vcross(_rn, t, _lb);
    if (_rn.y < 0) vscale(_rn, _rn, -1);
    vnorm(_rn);
    const k = o.flattenTrack ? sd.blend : sd.blend * 0.65;
    return vnorm(vset(out,
      _tn.x + (_rn.x - _tn.x) * k,
      _tn.y + (_rn.y - _tn.y) * k,
      _tn.z + (_rn.z - _tn.z) * k));
  }

  /** Material at a point: the track's own surface wins where we're on the ribbon. */
  function surfaceAt(x, z) {
    const sd = surfaceData(x, z);
    if (sd.blend > 0) {
      const hw = sd.width * 0.5;
      const a = Math.abs(sd.lateral);
      if (a <= hw) {
        let name = null;
        const nr = trackNearest(x, z);
        name = classifySurface(null, null, nr?.surface) || (nr?.surface && SURFACES[nr.surface] ? nr.surface : null);
        if (!name) { let sm = null; try { sm = track.sample(sd.s); } catch (e) {} name = classifySurface(null, null, sm?.surface); }
        if (a > hw - o.kerbWidth && a > hw * 0.55) return 'kerb';
        return name || 'tarmac';
      }
      if (a <= hw + o.kerbWidth) return 'kerb';
    }
    return rasterSurface(x, z);
  }

  /* ---------- ray probe ---------- */
  /**
   * Root-find the driving surface along a (near-vertical, downward) ray.
   * Returns hit info in `out`; out.hit is false when the ray never reaches the ground.
   */
  function probe(ox, oy, oz, dx, dy, dz, maxDist, out = {}) {
    out.hit = false; out.dist = maxDist; out.surface = 'dirt';
    const f = t => (oy + dy * t) - groundHeight(ox + dx * t, oz + dz * t);
    let f0 = f(0);
    if (f0 <= 0) {          // already under the surface
      out.hit = true; out.dist = 0; out.penetration = -f0;
      out.px = ox; out.py = oy; out.pz = oz;
    } else {
      const f1 = f(maxDist);
      if (f1 > 0) return out;
      let lo = 0, hi = maxDist;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) * 0.5;
        if (f(mid) > 0) lo = mid; else hi = mid;
      }
      const t = (lo + hi) * 0.5;
      out.hit = true; out.dist = t; out.penetration = 0;
      out.px = ox + dx * t; out.py = oy + dy * t; out.pz = oz + dz * t;
    }
    const n = groundNormal(out.px, out.pz, out.n || (out.n = v3()));
    out.nx = n.x; out.ny = n.y; out.nz = n.z;
    out.surface = surfaceAt(out.px, out.pz);
    out.py = groundHeight(out.px, out.pz);
    return out;
  }

  /* ---------- chassis vs walls ---------- */
  const _cp = { x: 0, z: 0, t: 0 };
  /**
   * Push a circular chassis out of static blockers and slide along them.
   * Mutates pos/vel in place. Returns null or { nx, nz, depth, impact, speedLoss }.
   */
  function resolveChassis(pos, vel, radius, restitution = 0.25, friction = 0.86) {
    const ids = nearbySegs(pos.x, pos.z, radius + 2);
    if (!ids.length) return null;
    let best = null;
    for (let pass = 0; pass < 2; pass++) {
      let touched = false;
      for (const id of ids) {
        const s = segs[id];
        const d = segDistXZ(pos.x, pos.z, s.ax, s.az, s.bx, s.bz, _cp);
        if (d >= radius) continue;
        let nx = pos.x - _cp.x, nz = pos.z - _cp.z;
        let nl = Math.hypot(nx, nz);
        if (nl < 1e-5) {                     // dead centre: use the segment's perpendicular
          nx = -(s.bz - s.az); nz = (s.bx - s.ax); nl = Math.hypot(nx, nz) || 1;
        }
        nx /= nl; nz /= nl;
        const depth = radius - d;
        pos.x += nx * depth; pos.z += nz * depth;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) {
          const impact = -vn;
          // remove the normal component (plus a little bounce) and scrub tangential speed
          vel.x -= nx * vn * (1 + restitution);
          vel.z -= nz * vn * (1 + restitution);
          const tx = -nz, tz = nx;
          const vt = vel.x * tx + vel.z * tz;
          const scrub = friction * (1 - clamp(impact / 26, 0, 0.45));
          vel.x += tx * (vt * scrub - vt);
          vel.z += tz * (vt * scrub - vt);
          if (!best || impact > best.impact) best = { nx, nz, depth, impact, kind: s.kind };
        } else if (!best) best = { nx, nz, depth, impact: 0, kind: s.kind };
        touched = true;
      }
      if (!touched) break;
    }
    return best;
  }

  /** Elastic-ish kart-vs-kart bump. a/b are { pos, vel, mass, radius }. Returns impact speed. */
  function bumpKarts(a, b, restitution = 0.55, pushOut = true) {
    let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
    const dy = (b.pos.y - a.pos.y);
    if (Math.abs(dy) > 1.6) return 0;
    let d = Math.hypot(dx, dz);
    const rr = (a.radius ?? 0.85) + (b.radius ?? 0.85);
    if (d >= rr) return 0;
    if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }
    dx /= d; dz /= d;
    const ma = a.mass ?? 200, mb = b.mass ?? 200;
    if (pushOut) {
      const pen = (rr - d), wa = mb / (ma + mb), wb = ma / (ma + mb);
      a.pos.x -= dx * pen * wa; a.pos.z -= dz * pen * wa;
      b.pos.x += dx * pen * wb; b.pos.z += dz * pen * wb;
    }
    const rel = (b.vel.x - a.vel.x) * dx + (b.vel.z - a.vel.z) * dz;
    if (rel > 0) return 0;
    const j = -(1 + restitution) * rel / (1 / ma + 1 / mb);
    a.vel.x -= dx * j / ma; a.vel.z -= dz * j / ma;
    b.vel.x += dx * j / mb; b.vel.z += dz * j / mb;
    return -rel;
  }

  return {
    world, track, opts: o,
    SURFACES, surfaceInfo,
    probe, groundHeight, groundNormal, surfaceAt, surfaceData, lateralAxis,
    resolveChassis, bumpKarts, nearbySegs, segs,
    rasterSurface,
    get blockerCount() { return segs.length; },
    surfaceGridSize: gN,
  };
}
