/**
 * Moshav Amikam, built out of its own 552 real Overture footprints.
 *
 * The pipeline per building is: clean the ring -> sit it on the terrain (highest corner wins,
 * a plinth skirt follows the ground down) -> infer storeys from class + footprint area ->
 * raise plastered or stone-clad walls with real recessed window reveals, sills and rolling
 * shutters -> cover it with a hip or gable pantile roof generated from a rectangle
 * decomposition of the footprint, with overhanging eaves, fascia, soffit and ridge caps ->
 * dress it with the things that make a roofline Israeli: a dud shemesh on nearly every house,
 * black water tanks, satellite dishes, A/C condensers, chimneys, pergolas and garden walls.
 *
 * Everything is merged per material into 256 m chunks, each with a near and a far version, so
 * the whole village is a few dozen draw calls; repeated roof furniture is instanced.
 *
 *   const b = createBuildings(engine, world, { quality: 1 });
 *   b.update(dt); b.setQuality(0.5);
 */
import * as THREE from 'three';
import { rng, clamp, lerp, smoothstep } from '../core/mathx.js';
import { createBuildingMaterials } from '../render/materials/buildingMaterials.js';

const CHUNK = 256;
const EPS = 1e-6;

/* ====================================================================== ring math == */

function ringArea(r) {                       // signed, in the (x,z) plane
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/**
 * Drop the closing duplicate, weld points closer than 8 cm, drop collinear vertices, and
 * orient so that the outward edge normal is `(-dz, dx)`. Overture rings are clockwise in
 * (x, z); that is exactly the orientation we want, but never trust the data.
 */
function cleanRing(src) {
  const r = [];
  for (const p of src) {
    const x = +p[0], z = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const last = r[r.length - 1];
    if (last && Math.abs(last[0] - x) < 0.08 && Math.abs(last[1] - z) < 0.08) continue;
    r.push([x, z]);
  }
  while (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.08 && Math.abs(a[1] - b[1]) < 0.08) r.pop(); else break;
  }
  if (r.length < 3) return null;
  // collinear cull
  const out = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[(i - 1 + r.length) % r.length], c = r[i], q = r[(i + 1) % r.length];
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < EPS || lb < EPS) continue;
    const cross = Math.abs((ax * bz - az * bx) / (la * lb));
    if (cross < 0.012) continue;             // < ~0.7 degrees of turn
    out.push(c);
  }
  if (out.length < 3) return null;
  if (ringArea(out) > 0) out.reverse();      // want negative area in (x,z)
  return out;
}

/** Minimum-area oriented bounding box by rotating calipers over the edges. */
function obbOf(r) {
  let best = null;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 0.05) continue;
    const ux = dx / l, uz = dz / l;
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const p of r) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      if (u < mnu) mnu = u; if (u > mxu) mxu = u;
      if (v < mnv) mnv = v; if (v > mxv) mxv = v;
    }
    const w = mxu - mnu, d = mxv - mnv, area = w * d;
    if (!best || area < best.area) {
      const cu = (mnu + mxu) * 0.5, cv = (mnv + mxv) * 0.5;
      best = { area, w, d, ux, uz, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux };
    }
  }
  if (!best) return null;
  if (best.d > best.w) {                     // long axis is always U
    const t = best.w; best.w = best.d; best.d = t;
    const ux = best.ux; best.ux = -best.uz; best.uz = ux;
  }
  return best;
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > z) !== (b[1] > z) &&
        x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + EPS) + a[0]) inside = !inside;
  }
  return inside;
}

/** Largest all-set axis-aligned rectangle in a boolean grid (histogram sweep). */
function largestRect(grid, W, H) {
  const heights = new Int32Array(W);
  let best = { area: 0 };
  const stackI = new Int32Array(W + 1), stackH = new Int32Array(W + 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) heights[x] = grid[y * W + x] ? heights[x] + 1 : 0;
    let sp = 0;
    for (let x = 0; x <= W; x++) {
      const h = x < W ? heights[x] : 0;
      let start = x;
      while (sp > 0 && stackH[sp - 1] > h) {
        sp--;
        const hh = stackH[sp], ss = stackI[sp], area = hh * (x - ss);
        if (area > best.area) best = { area, x0: ss, x1: x, y0: y - hh + 1, y1: y + 1 };
        start = ss;
      }
      if (h > 0 && (sp === 0 || stackH[sp - 1] < h)) { stackH[sp] = h; stackI[sp] = start; sp++; }
    }
  }
  return best.area > 0 ? best : null;
}

/**
 * Break a footprint into at most `maxRects` rectangles aligned to its bounding box. Almost
 * every moshav footprint is a rectangle or an L, so this converges in one or two passes and
 * gives each mass its own ridge — which is what a straight skeleton would have produced for
 * the same shapes, at a fraction of the code.
 */
function decomposeRects(ring, obb, maxRects = 3, cell = 0.55) {
  const W = clamp(Math.round(obb.w / cell), 1, 160), H = clamp(Math.round(obb.d / cell), 1, 160);
  const cw = obb.w / W, ch = obb.d / H;
  const grid = new Uint8Array(W * H);
  let filled = 0;
  const { ux, uz, cx, cz, w, d } = obb;
  for (let j = 0; j < H; j++) {
    const v = -d / 2 + (j + 0.5) * ch;
    for (let i = 0; i < W; i++) {
      const u = -w / 2 + (i + 0.5) * cw;
      const x = cx + ux * u - uz * v, z = cz + uz * u + ux * v;
      if (pointInRing(x, z, ring)) { grid[j * W + i] = 1; filled++; }
    }
  }
  if (!filled) return [{ cx, cz, ux, uz, w, d }];
  const rects = [];
  let covered = 0;
  for (let k = 0; k < maxRects; k++) {
    const r = largestRect(grid, W, H);
    if (!r || r.area < 6) break;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) grid[y * W + x] = 0;
    covered += r.area;
    const u0 = -w / 2 + r.x0 * cw, u1 = -w / 2 + r.x1 * cw;
    const v0 = -d / 2 + r.y0 * ch, v1 = -d / 2 + r.y1 * ch;
    const mu = (u0 + u1) * 0.5, mv = (v0 + v1) * 0.5;
    let rw = u1 - u0, rd = v1 - v0, rux = ux, ruz = uz;
    if (rd > rw) { const t = rw; rw = rd; rd = t; rux = -uz; ruz = ux; }
    rects.push({ cx: cx + ux * mu - uz * mv, cz: cz + uz * mu + ux * mv, ux: rux, uz: ruz, w: rw, d: rd });
    if (covered / filled > 0.93) break;
  }
  return rects.length ? rects : [{ cx, cz, ux, uz, w, d }];
}

/* ================================================================ mesh accumulator == */

const _n = [0, 0, 0];
function faceNormal(a, b, c, out) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  return out;
}

class Surf {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; }
  get empty() { return this.i.length === 0; }
  vert(x, y, z, n, u, v, col) {
    const k = this.p.length / 3;
    this.p.push(x, y, z); this.n.push(n[0], n[1], n[2]);
    this.uv.push(u, v); this.c.push(col[0], col[1], col[2]);
    return k;
  }
  /** Convex polygon fan. `pts` = [[x,y,z]..], `uvs` = [[u,v]..], oriented toward `ref`. */
  poly(pts, uvs, col, ref) {
    if (pts.length < 3) return;
    const n = faceNormal(pts[0], pts[1], pts[2], _n);
    let order = pts, ord2 = uvs;
    if (ref && (n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2]) < 0) {
      order = pts.slice().reverse(); ord2 = uvs.slice().reverse();
      faceNormal(order[0], order[1], order[2], _n);
    }
    const base = [];
    for (let i = 0; i < order.length; i++) base.push(this.vert(order[i][0], order[i][1], order[i][2], _n, ord2[i][0], ord2[i][1], col));
    for (let i = 1; i < order.length - 1; i++) this.i.push(base[0], base[i], base[i + 1]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    const big = this.p.length / 3 > 65535;
    g.setIndex(new THREE.BufferAttribute(big ? new Uint32Array(this.i) : new Uint16Array(this.i), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Axis-aligned-in-local box helper: centre, half extents along U/up/V, world U axis. */
function addBox(S, cx, cy, cz, ux, uz, hw, hh, hd, col, us) {
  const vx = -uz, vz = ux;
  const P = (su, sh, sv) => [cx + ux * su * hw + vx * sv * hd, cy + sh * hh, cz + uz * su * hw + vz * sv * hd];
  const s = us || 1;
  const q = (a, b, c, d, ref, w, h) => S.poly([a, b, c, d],
    [[0, 0], [w / s, 0], [w / s, h / s], [0, h / s]], col, ref);
  q(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), [-vx, 0, -vz], hw * 2, hh * 2);
  q(P(1, -1, 1), P(-1, -1, 1), P(-1, 1, 1), P(1, 1, 1), [vx, 0, vz], hw * 2, hh * 2);
  q(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1), [ux, 0, uz], hd * 2, hh * 2);
  q(P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), [-ux, 0, -uz], hd * 2, hh * 2);
  q(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), [0, 1, 0], hw * 2, hd * 2);
  q(P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1), [0, -1, 0], hw * 2, hd * 2);
}

/* ======================================================================= design ==== */

const PLASTER_TINTS = [
  [1.00, 0.99, 0.96], [0.99, 0.95, 0.87], [0.97, 0.91, 0.79],
  [1.00, 0.97, 0.92], [0.94, 0.88, 0.76], [0.98, 0.95, 0.90],
  [0.92, 0.85, 0.72], [1.00, 0.98, 0.94], [0.88, 0.84, 0.78],
  [0.99, 0.92, 0.85], [0.96, 0.94, 0.91], [0.91, 0.86, 0.75],
  [1.00, 0.94, 0.90], [0.86, 0.83, 0.79],
];
// clay pantiles run from fresh orange to sun-bleached brown; a few roofs are re-laid grey.
const ROOF_TINTS = [
  [1.00, 0.95, 0.90], [0.86, 0.78, 0.73], [1.12, 1.00, 0.88],
  [0.76, 0.70, 0.68], [1.05, 0.90, 0.79], [0.94, 0.88, 0.84],
  [1.08, 0.97, 0.85], [0.82, 0.74, 0.68], [0.90, 0.84, 0.80],
];
// fibre-cement / galvanised sheeting on the farm buildings
const SHEET_TINTS = [[0.60, 0.64, 0.68], [0.70, 0.71, 0.70], [0.52, 0.56, 0.60], [0.66, 0.66, 0.64]];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function design(b, world, idx) {
  const ring = cleanRing(b.rings?.[0] || []);
  if (!ring || ring.length < 3) return null;
  const area = Math.abs(ringArea(ring));
  if (area < 6) return null;
  const obb = obbOf(ring);
  if (!obb || obb.w < 1.6 || obb.d < 1.2) return null;

  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cz += p[1]; }
  cx /= ring.length; cz /= ring.length;
  if (Math.abs(cx) > 1480 || Math.abs(cz) > 1480) return null;   // outside the heightfield

  const rand = rng(hashStr(b.id || String(idx)) ^ 0x9e37);
  const aspect = obb.w / Math.max(obb.d, 0.5);

  // --- ground: highest footprint sample carries the floor, lowest carries the plinth ---
  let hMax = -Infinity, hMin = Infinity;
  const sample = (x, z) => { const h = world.heightAt(x, z); if (h > hMax) hMax = h; if (h < hMin) hMin = h; };
  for (const p of ring) sample(p[0], p[1]);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    sample((a[0] + c[0]) * 0.5, (a[1] + c[1]) * 0.5);
  }
  sample(cx, cz);
  const floorY = hMax + 0.14;

  // --- typology -----------------------------------------------------------------------
  let kind = 'house';
  if (b.cls === 'greenhouse' || (area > 220 && aspect > 3.0)) kind = 'greenhouse';
  else if (area > 900) kind = 'packing';
  else if (area > 260 && aspect > 1.9) kind = 'barn';
  else if (area < 26) kind = 'shed';
  else if (area > 420) kind = 'barn';

  let storeys = 1, storeyH = 3.15, roofKind = 'hip';
  const r0 = rand(), r1 = rand(), r2 = rand();
  if (kind === 'house') {
    const twoUp = clamp((area - 95) / 260, 0, 1) * 0.46 + 0.07;
    storeys = r0 < twoUp ? 2 : 1;
    storeyH = 3.0 + r1 * 0.4;
    roofKind = r2 < 0.13 ? 'flat' : (r2 < 0.56 ? 'gable' : 'hip');
  } else if (kind === 'shed') {
    storeys = 1; storeyH = 2.5 + r1 * 0.4;
    roofKind = r2 < 0.42 ? 'flat' : 'gable';
  } else if (kind === 'barn') {
    storeys = 1; storeyH = 4.6 + r1 * 2.0;
    roofKind = r2 < 0.30 ? 'flat' : 'gable';
  } else if (kind === 'packing') {
    storeys = 1; storeyH = 6.0 + r1 * 2.4;
    roofKind = r2 < 0.55 ? 'flat' : 'gable';
  } else {                                     // greenhouse
    storeys = 1; storeyH = 2.6 + r1 * 1.0; roofKind = 'gable';
  }
  if (b.lv) storeys = clamp(b.lv | 0, 1, 3);
  if (b.h) storeyH = clamp(b.h / storeys, 2.4, 9);

  const wallH = storeys * storeyH;
  const pitch = (kind === 'house' ? 19 + rand() * 6 : 15 + rand() * 6) * Math.PI / 180;
  const ov = kind === 'house' ? 0.56 + rand() * 0.22 : 0.34 + rand() * 0.20;

  // --- surfacing ----------------------------------------------------------------------
  const mr = rand();
  let wallMat = 'plaster';
  if (kind === 'house') wallMat = mr < 0.20 ? 'stone' : (mr < 0.44 ? 'mixed' : 'plaster');
  else if (kind === 'packing' || kind === 'barn') wallMat = mr < 0.12 ? 'stone' : 'plaster';
  const tint = PLASTER_TINTS[(rand() * PLASTER_TINTS.length) | 0];
  const sheeted = kind !== 'house' && kind !== 'greenhouse' && rand() < 0.55;
  const roofTint = sheeted ? SHEET_TINTS[(rand() * SHEET_TINTS.length) | 0]
                           : ROOF_TINTS[(rand() * ROOF_TINTS.length) | 0];

  const rects = (roofKind === 'flat')
    ? [{ cx: obb.cx, cz: obb.cz, ux: obb.ux, uz: obb.uz, w: obb.w, d: obb.d }]
    : decomposeRects(ring, obb, area > 120 ? 3 : 2);

  // longest edge is the street front: door, veranda and pergola go there
  let ei = 0, elen = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (l > elen) { elen = l; ei = i; }
  }

  return {
    id: b.id, ring, area, obb, cx, cz, floorY, groundMin: hMin, hMax,
    kind, storeys, storeyH, wallH, roofKind, pitch, ov, wallMat, tint, roofTint, sheeted,
    rects, entrance: ei, entranceLen: elen, rand,
    seed: hashStr(b.id || String(idx)),
  };
}

/* ==================================================================== wall bands === */

const WINDOW_W = 1.18, WINDOW_H = 1.42, SILL_H = 0.94, REVEAL = 0.155;
const DOOR_W = 1.00, DOOR_H = 2.14;

function edgeFrame(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  if (L < EPS) return null;
  return { L, tx: dx / L, tz: dz / L, ox: -dz / L, oz: dx / L };
}

/**
 * One storey of one facade: solid wall with rectangular holes, then for every hole a set of
 * reveal jambs, a projecting sill, a shutter box lintel, the shutter itself and the glass.
 */
function addWallBand(out, mat, a, b, y0, y1, holes, col, us, opt) {
  const f = edgeFrame(a, b);
  if (!f) return;
  const { L, tx, tz, ox, oz } = f;
  const S = out[mat];
  const N = [ox, 0, oz];
  const P = (s, y, off = 0) => [a[0] + tx * s + ox * off, y, a[1] + tz * s + oz * off];
  const uv = (s, y) => [s / us, y / us];
  const quad = (s0, s1, ya, yb) => {
    if (s1 - s0 < 0.01 || yb - ya < 0.01) return;
    S.poly([P(s0, ya), P(s1, ya), P(s1, yb), P(s0, yb)],
      [uv(s0, ya), uv(s1, ya), uv(s1, yb), uv(s0, yb)], col, N);
  };
  const hs = holes.slice().sort((p, q) => p.s0 - q.s0);
  let cursor = 0;
  for (const h of hs) {
    quad(cursor, h.s0, y0, y1);
    quad(h.s0, h.s1, y0, h.y0);
    quad(h.s0, h.s1, h.y1, y1);
    cursor = h.s1;
  }
  quad(cursor, L, y0, y1);

  if (!opt || opt.plain) return;
  const trim = out.plaster, tc = opt.trimCol;
  for (const h of hs) {
    const d = REVEAL;
    const A = (s, y) => P(s, y, 0), B = (s, y) => P(s, y, -d);
    const w = h.s1 - h.s0, hh = h.y1 - h.y0;
    // jambs + head + inner sill, all facing into the opening
    trim.poly([A(h.s0, h.y0), A(h.s0, h.y1), B(h.s0, h.y1), B(h.s0, h.y0)],
      [[0, 0], [0, hh / 4], [d / 4, hh / 4], [d / 4, 0]], tc, [tx, 0, tz]);
    trim.poly([A(h.s1, h.y0), A(h.s1, h.y1), B(h.s1, h.y1), B(h.s1, h.y0)],
      [[0, 0], [0, hh / 4], [d / 4, hh / 4], [d / 4, 0]], tc, [-tx, 0, -tz]);
    trim.poly([A(h.s0, h.y1), A(h.s1, h.y1), B(h.s1, h.y1), B(h.s0, h.y1)],
      [[0, 0], [w / 4, 0], [w / 4, d / 4], [0, d / 4]], opt.soffitCol, [0, -1, 0]);
    trim.poly([A(h.s0, h.y0), A(h.s1, h.y0), B(h.s1, h.y0), B(h.s0, h.y0)],
      [[0, 0], [w / 4, 0], [w / 4, d / 4], [0, d / 4]], tc, [0, 1, 0]);

    if (h.type === 'door') {
      out.plaster.poly([B(h.s0, h.y0), B(h.s1, h.y0), B(h.s1, h.y1), B(h.s0, h.y1)],
        [[0, 0], [w / 4, 0], [w / 4, hh / 4], [0, hh / 4]], opt.doorCol, N);
      // door frame reveal band + a handle-height rail
      continue;
    }
    // white frame ring + centre mullion, then the glass a little further back
    const fw = 0.055, gd = d + 0.03;
    const G = (s, y) => P(s, y, -gd);
    const fr = opt.frameCol;
    const bar = (s0, y0b, s1, y1b) => trim.poly([B(s0, y0b), B(s1, y0b), B(s1, y1b), B(s0, y1b)],
      [[0, 0], [(s1 - s0) / 2, 0], [(s1 - s0) / 2, (y1b - y0b) / 2], [0, (y1b - y0b) / 2]], fr, N);
    bar(h.s0, h.y0, h.s1, h.y0 + fw);
    bar(h.s0, h.y1 - fw, h.s1, h.y1);
    bar(h.s0, h.y0 + fw, h.s0 + fw, h.y1 - fw);
    bar(h.s1 - fw, h.y0 + fw, h.s1, h.y1 - fw);
    const mc = (h.s0 + h.s1) * 0.5;
    bar(mc - fw * 0.5, h.y0 + fw, mc + fw * 0.5, h.y1 - fw);
    out.glass.poly([G(h.s0 + fw, h.y0 + fw), G(h.s1 - fw, h.y0 + fw), G(h.s1 - fw, h.y1 - fw), G(h.s0 + fw, h.y1 - fw)],
      [[0, 0], [w, 0], [w, hh], [0, hh]], opt.glassCol, N);
    // projecting stone sill
    const sd = 0.075, st = 0.055;
    addBox(trim, (A(h.s0, h.y0)[0] + A(h.s1, h.y0)[0]) * 0.5 + ox * (sd * 0.5 - d * 0.5),
      h.y0 - st * 0.5, (A(h.s0, h.y0)[2] + A(h.s1, h.y0)[2]) * 0.5 + oz * (sd * 0.5 - d * 0.5),
      tx, tz, w * 0.5 + 0.07, st * 0.5, (sd + d) * 0.5, tc, 2);
    // shutter box above the head
    addBox(trim, (A(h.s0, h.y1)[0] + A(h.s1, h.y1)[0]) * 0.5 + ox * 0.03,
      h.y1 + 0.13, (A(h.s0, h.y1)[2] + A(h.s1, h.y1)[2]) * 0.5 + oz * 0.03,
      tx, tz, w * 0.5 + 0.05, 0.13, 0.09, tc, 2);
    // the shutter itself, dropped by a per-window amount
    const drop = h.drop ?? 0;
    if (drop > 0.02) {
      const sy = h.y1 - hh * drop;
      const inset = d - 0.045;
      const C = (s, y) => P(s, y, -inset);
      out.shutter.poly([C(h.s0, sy), C(h.s1, sy), C(h.s1, h.y1), C(h.s0, h.y1)],
        [[0, 0], [w, 0], [w, hh * drop], [0, hh * drop]], opt.shutterCol, N);
    }
  }
}

/** Window/door layout for one facade band. */
function planHoles(L, y0, storeyH, isGround, isEntrance, rand, kind) {
  const holes = [];
  if (kind === 'greenhouse') return holes;
  const usable = L - 1.0;
  if (usable < 1.4) return holes;
  const wide = kind === 'barn' || kind === 'packing';
  const pitch = wide ? 5.2 : 3.35;
  let n = clamp(Math.round(usable / pitch), 1, 6);
  const step = L / n;
  const yTop = y0 + Math.min(SILL_H + WINDOW_H, storeyH - 0.55);
  for (let i = 0; i < n; i++) {
    const c = step * (i + 0.5);
    const isDoor = isGround && isEntrance && i === (n > 2 ? 1 : 0) && !wide;
    if (isDoor) {
      holes.push({ s0: c - DOOR_W / 2, s1: c + DOOR_W / 2, y0: y0 + 0.02, y1: y0 + DOOR_H, type: 'door' });
      continue;
    }
    const big = isGround && !wide && rand() < 0.30;
    const w = big ? WINDOW_W * 1.65 : WINDOW_W * (0.86 + rand() * 0.3);
    if (w + 0.7 > step) continue;
    const dropR = rand();
    holes.push({
      s0: c - w / 2, s1: c + w / 2, y0: y0 + SILL_H, y1: yTop, type: 'win',
      drop: dropR < 0.42 ? 0 : (dropR < 0.80 ? 0.25 + rand() * 0.45 : 1.0),
    });
  }
  return holes;
}

/* ======================================================================== roofs ==== */

/**
 * Hip or gable pantile roof over one rectangle. `wallTopY` is the top of the masonry; the roof
 * plane meets the wall 22 cm above it so the soffit has somewhere to live, then overhangs by
 * `ov` with a fascia board hanging off the eave.
 */
function addRoof(out, rect, wallTopY, pitch, ov, gable, roofCol, trimCol, soffitCol, wallCol, us) {
  const { cx, cz, ux, uz } = rect;
  const vx = -uz, vz = ux;
  const hw = rect.w / 2, hd = rect.d / 2;
  const ehw = hw + ov, ehd = hd + ov;
  const tp = Math.tan(pitch), cosP = Math.cos(pitch);
  const eaveY = wallTopY + 0.22 - tp * ov;
  const ridgeY = eaveY + tp * ehd;
  const P = (u, v, y) => [cx + ux * u + vx * v, y, cz + uz * u + vz * v];
  const T = out.tile, plaster = out.plaster;
  const UP = [0, 1, 0];
  const rx = gable ? ehw : Math.max(0, ehw - ehd);
  // slope-space uv: u along the ridge, v measured up the slope from the eave
  const sv = y => (y - eaveY) / Math.max(tp, 0.02) / cosP / us;

  // main slopes
  T.poly([P(-ehw, -ehd, eaveY), P(ehw, -ehd, eaveY), P(rx, 0, ridgeY), P(-rx, 0, ridgeY)],
    [[-ehw / us, 0], [ehw / us, 0], [rx / us, sv(ridgeY)], [-rx / us, sv(ridgeY)]], roofCol, UP);
  T.poly([P(ehw, ehd, eaveY), P(-ehw, ehd, eaveY), P(-rx, 0, ridgeY), P(rx, 0, ridgeY)],
    [[ehw / us, 0], [-ehw / us, 0], [-rx / us, sv(ridgeY)], [rx / us, sv(ridgeY)]], roofCol, UP);
  if (!gable) {
    T.poly([P(ehw, -ehd, eaveY), P(ehw, ehd, eaveY), P(rx, 0, ridgeY)],
      [[-ehd / us, 0], [ehd / us, 0], [0, sv(ridgeY)]], roofCol, UP);
    T.poly([P(-ehw, ehd, eaveY), P(-ehw, -ehd, eaveY), P(-rx, 0, ridgeY)],
      [[ehd / us, 0], [-ehd / us, 0], [0, sv(ridgeY)]], roofCol, UP);
  }

  // fascia + soffit around the eave
  const FD = 0.21;
  const eave = [[-ehw, -ehd], [ehw, -ehd], [ehw, ehd], [-ehw, ehd]];
  const wall = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  for (let i = 0; i < 4; i++) {
    const isEnd = (i === 1 || i === 3);
    if (gable && isEnd) continue;                        // gable verge handled below
    const a = eave[i], b = eave[(i + 1) % 4];
    const wa = wall[i], wb = wall[(i + 1) % 4];
    const nx = (a[1] === b[1]) ? 0 : Math.sign(a[0]), nz = (a[1] === b[1]) ? Math.sign(a[1]) : 0;
    const on = [nx * ux + nz * vx, 0, nx * uz + nz * vz];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    plaster.poly([P(a[0], a[1], eaveY), P(b[0], b[1], eaveY), P(b[0], b[1], eaveY - FD), P(a[0], a[1], eaveY - FD)],
      [[0, 0], [len / 4, 0], [len / 4, FD / 4], [0, FD / 4]], trimCol, on);
    plaster.poly([P(a[0], a[1], eaveY - FD), P(b[0], b[1], eaveY - FD),
                  P(wb[0], wb[1], wallTopY + 0.22 - FD), P(wa[0], wa[1], wallTopY + 0.22 - FD)],
      [[0, 0], [len / 4, 0], [len / 4, ov / 4], [0, ov / 4]], soffitCol, [0, -1, 0]);
  }
  if (gable) {
    for (const sgn of [1, -1]) {
      const u = sgn * ehw, uw = sgn * hw;
      // barge board follows the two rake lines
      for (const vs of [-1, 1]) {
        const p0 = P(u, vs * ehd, eaveY), p1 = P(u, 0, ridgeY);
        const len = Math.hypot(ehd, ridgeY - eaveY);
        plaster.poly([p0, p1, [p1[0], p1[1] - FD, p1[2]], [p0[0], p0[1] - FD, p0[2]]],
          [[0, 0], [len / 4, 0], [len / 4, FD / 4], [0, FD / 4]], trimCol, [sgn * ux, 0, sgn * uz]);
        plaster.poly([[p0[0], p0[1] - FD, p0[2]], [p1[0], p1[1] - FD, p1[2]],
                      P(uw, 0, ridgeY - FD), P(uw, vs * ehd, eaveY - FD)],
          [[0, 0], [len / 4, 0], [len / 4, ov / 4], [0, ov / 4]], soffitCol, [0, -1, 0]);
      }
      // gable wall infill
      plaster.poly([P(uw, -hd, wallTopY), P(uw, hd, wallTopY), P(uw, hd, wallTopY + 0.22),
                    P(uw, 0, ridgeY), P(uw, -hd, wallTopY + 0.22)],
        [[-hd / us, wallTopY / us], [hd / us, wallTopY / us], [hd / us, (wallTopY + 0.22) / us],
         [0, ridgeY / us], [-hd / us, (wallTopY + 0.22) / us]], wallCol, [sgn * ux, 0, sgn * uz]);
    }
  }

  // ridge and hip capping
  const cap = (p0, p1) => {
    const dx = p1[0] - p0[0], dz = p1[2] - p0[2], l = Math.hypot(dx, dz);
    if (l < 0.2) return;
    const kx = -dz / l, kz = dx / l, cw = 0.17, rise = 0.115;
    const A0 = [p0[0] - kx * cw, p0[1] - 0.02, p0[2] - kz * cw], A1 = [p1[0] - kx * cw, p1[1] - 0.02, p1[2] - kz * cw];
    const B0 = [p0[0] + kx * cw, p0[1] - 0.02, p0[2] + kz * cw], B1 = [p1[0] + kx * cw, p1[1] - 0.02, p1[2] + kz * cw];
    const C0 = [p0[0], p0[1] + rise, p0[2]], C1 = [p1[0], p1[1] + rise, p1[2]];
    T.poly([A0, A1, C1, C0], [[0, 0], [l / us, 0], [l / us, 0.2], [0, 0.2]], roofCol, [-kx, 0.6, -kz]);
    T.poly([B1, B0, C0, C1], [[0, 0], [l / us, 0], [l / us, 0.2], [0, 0.2]], roofCol, [kx, 0.6, kz]);
  };
  cap(P(-rx, 0, ridgeY), P(rx, 0, ridgeY));
  if (!gable) {
    cap(P(rx, 0, ridgeY), P(ehw, -ehd, eaveY));
    cap(P(rx, 0, ridgeY), P(ehw, ehd, eaveY));
    cap(P(-rx, 0, ridgeY), P(-ehw, -ehd, eaveY));
    cap(P(-rx, 0, ridgeY), P(-ehw, ehd, eaveY));
  }
  return { eaveY, ridgeY, rx, ehw, ehd, tp };
}

/* ================================================================= prop geometry === */

function tintGeo(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}

function mergeGeos(list) {
  if (!list.length) return null;
  const pos = [], nrm = [], col = [], idx = [];
  let base = 0;
  for (const g of list) {
    const p = g.attributes.position, nn = g.attributes.normal, cc = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i));
      col.push(cc.getX(i), cc.getY(i), cc.getZ(i));
    }
    const ix = g.index;
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
    base += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  out.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

function box(w, h, d, x, y, z, col, rot) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateX(rot);
  g.translate(x, y, z);
  return tintGeo(g, col[0], col[1], col[2]);
}
function cyl(r, h, seg, x, y, z, col, axis) {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return tintGeo(g, col[0], col[1], col[2]);
}

/**
 * Prop kit. Local frame: origin on the mounting plane, +Y is the plane normal, +Z points
 * down-slope (south-ish). Each entry may have a `metal` and a `glass` geometry so the dark
 * collector glazing keeps its own material without a second transform.
 */
function buildPropKit() {
  const WHITE = [0.93, 0.93, 0.91], GALV = [0.72, 0.74, 0.75], DARK = [0.10, 0.12, 0.16];
  const BLACK = [0.11, 0.11, 0.12], GREY = [0.80, 0.80, 0.79];

  // --- dud shemesh on a pitched roof: tank across the slope, panel lying on the tiles ---
  const solarPitchedMetal = mergeGeos([
    cyl(0.295, 1.55, 12, 0, 0.62, -0.30, WHITE, 'x'),
    cyl(0.315, 0.10, 12, -0.78, 0.62, -0.30, GALV, 'x'),
    cyl(0.315, 0.10, 12, 0.78, 0.62, -0.30, GALV, 'x'),
    box(0.07, 0.62, 0.07, -0.62, 0.31, -0.30, GALV),
    box(0.07, 0.62, 0.07, 0.62, 0.31, -0.30, GALV),
    box(0.07, 0.10, 0.66, -0.62, 0.34, 0.02, GALV),
    box(0.07, 0.10, 0.66, 0.62, 0.34, 0.02, GALV),
    box(2.02, 0.10, 1.16, 0, 0.06, 0.62, GALV),
    cyl(0.035, 0.55, 6, 0.30, 0.40, -0.05, GALV),
  ]);
  const solarPitchedGlass = mergeGeos([box(1.88, 0.05, 1.02, 0, 0.135, 0.62, DARK)]);

  // --- dud shemesh on a flat roof: A-frame tilts the collector to ~28 deg -------------
  const tilt = -28 * Math.PI / 180;
  const panel = box(1.95, 0.09, 1.10, 0, 0, 0, GALV, tilt);
  panel.translate(0, 0.62, 0.30);
  const glassP = box(1.82, 0.05, 0.98, 0, 0.05, 0, DARK, tilt);
  glassP.translate(0, 0.62, 0.30);
  const solarFlatMetal = mergeGeos([
    panel,
    box(0.08, 0.95, 0.08, -0.90, 0.47, 0.60, GALV),
    box(0.08, 0.95, 0.08, 0.90, 0.47, 0.60, GALV),
    box(0.08, 0.30, 0.08, -0.90, 0.15, -0.10, GALV),
    box(0.08, 0.30, 0.08, 0.90, 0.15, -0.10, GALV),
    cyl(0.295, 1.55, 12, 0, 1.18, -0.42, WHITE, 'x'),
    cyl(0.315, 0.10, 12, -0.78, 1.18, -0.42, GALV, 'x'),
    cyl(0.315, 0.10, 12, 0.78, 1.18, -0.42, GALV, 'x'),
    box(0.08, 1.18, 0.08, -0.62, 0.59, -0.42, GALV),
    box(0.08, 1.18, 0.08, 0.62, 0.59, -0.42, GALV),
  ]);
  const solarFlatGlass = mergeGeos([glassP]);

  const waterTank = mergeGeos([
    cyl(0.56, 1.15, 14, 0, 0.70, 0, BLACK),
    cyl(0.30, 0.12, 10, 0, 1.33, 0, [0.35, 0.35, 0.36]),
    box(1.30, 0.12, 1.30, 0, 0.07, 0, GREY),
    box(0.10, 0.20, 0.10, 0, 0.22, 0.62, GALV),
  ]);

  // local +Y is the wall normal, local +Z points down the wall
  const ac = mergeGeos([
    box(0.84, 0.29, 0.58, 0, 0.165, 0, GREY),
    cyl(0.23, 0.035, 12, 0, 0.325, 0.02, [0.26, 0.27, 0.29]),
    cyl(0.055, 0.045, 8, 0, 0.335, 0.02, [0.45, 0.46, 0.47]),
    box(0.86, 0.03, 0.05, 0, 0.31, -0.26, [0.66, 0.67, 0.67]),
    box(0.05, 0.05, 0.12, -0.36, 0.06, 0.32, GALV),
    box(0.05, 0.05, 0.12, 0.36, 0.06, 0.32, GALV),
  ]);

  const dishG = new THREE.SphereGeometry(0.40, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
  dishG.rotateX(Math.PI - 0.55);            // hollow face toward +Y, tipped up toward +Z
  dishG.translate(0, 0.50, 0.14);
  const dish = mergeGeos([
    tintGeo(dishG, 0.92, 0.92, 0.90),
    box(0.055, 0.50, 0.055, 0, 0.25, 0.02, GREY),
    cyl(0.042, 0.30, 6, 0, 0.34, 0.30, [0.52, 0.53, 0.53], 'z'),
    box(0.24, 0.045, 0.18, 0, 0.025, 0.02, GREY),
  ]);

  const chimney = mergeGeos([
    box(0.46, 1.05, 0.46, 0, 0.52, 0, [0.95, 0.93, 0.88]),
    box(0.60, 0.09, 0.60, 0, 1.08, 0, [0.72, 0.70, 0.66]),
    cyl(0.10, 0.34, 8, 0, 1.28, 0, [0.30, 0.30, 0.31]),
  ]);

  const vent = mergeGeos([
    cyl(0.09, 0.62, 8, 0, 0.31, 0, GALV),
    cyl(0.16, 0.10, 10, 0, 0.66, 0, GALV),
  ]);

  return {
    solarPitched: { metal: solarPitchedMetal, glass: solarPitchedGlass },
    solarFlat: { metal: solarFlatMetal, glass: solarFlatGlass },
    waterTank: { metal: waterTank }, ac: { metal: ac }, dish: { metal: dish },
    chimney: { metal: chimney }, vent: { metal: vent },
  };
}

/* ======================================================================== public === */

export function createBuildings(engine, world, opts = {}) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const M = createBuildingMaterials(opts);
  const kit = buildPropKit();

  const designs = [];
  world.buildings.forEach((b, i) => { const d = design(b, world, i); if (d) designs.push(d); });

  // ---- chunking -------------------------------------------------------------------
  const chunks = new Map();
  const key = d => `${Math.floor(d.cx / CHUNK)},${Math.floor(d.cz / CHUNK)}`;
  for (const d of designs) {
    let c = chunks.get(key(d));
    if (!c) {
      c = {
        near: { plaster: new Surf(), stone: new Surf(), tile: new Surf(), shutter: new Surf(), glass: new Surf(), sheeting: new Surf(), foliage: new Surf() },
        far: { farSurface: new Surf(), farRoof: new Surf() },
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
        meshes: { near: [], far: [] },
      };
      chunks.set(key(d), c);
    }
    c.list = c.list || [];
    c.list.push(d);
  }

  const props = { solarPitched: [], solarFlat: [], waterTank: [], ac: [], dish: [], chimney: [], vent: [] };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);

  /** Place a prop with its local +Y along `normal` and local +Z along `fwd`. */
  function place(kind, x, y, z, normal, fwd, scale = 1) {
    const n = _v.set(normal[0], normal[1], normal[2]).normalize();
    const f = new THREE.Vector3(fwd[0], fwd[1], fwd[2]);
    f.addScaledVector(n, -f.dot(n));
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1).addScaledVector(n, -n.z);
    f.normalize();
    const r = new THREE.Vector3().crossVectors(n, f);
    const m = new THREE.Matrix4().makeBasis(r, n.clone(), f);
    m.scale(_s.set(scale, scale, scale));
    m.setPosition(x, y, z);
    props[kind].push(m);
  }

  for (const [, chunk] of chunks) {
    for (const d of chunk.list) buildOne(d, chunk, world, M, place);
  }

  // ---- meshes ----------------------------------------------------------------------
  let drawCalls = 0;
  const chunkList = [];
  for (const [k, c] of chunks) {
    const sphere = new THREE.Sphere();
    const bb = new THREE.Box3();
    const rec = { key: k, near: [], far: [], center: new THREE.Vector3(), radius: 1 };
    for (const [name, surf] of Object.entries(c.near)) {
      if (surf.empty) continue;
      const g = surf.geometry();
      const mesh = new THREE.Mesh(g, M[name]);
      mesh.name = 'bld-' + name + '-' + k;
      mesh.castShadow = true; mesh.receiveShadow = true;
      rec.near.push(mesh); group.add(mesh); drawCalls++;
      bb.union(new THREE.Box3().setFromBufferAttribute(g.attributes.position));
    }
    for (const [name, surf] of Object.entries(c.far)) {
      if (surf.empty) continue;
      const g = surf.geometry();
      const mesh = new THREE.Mesh(g, M[name]);
      mesh.name = 'bldfar-' + name + '-' + k;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.visible = false;
      rec.far.push(mesh); group.add(mesh); drawCalls++;
    }
    bb.getBoundingSphere(sphere);
    rec.center.copy(sphere.center); rec.radius = sphere.radius || 1;
    chunkList.push(rec);
  }

  // ---- instanced roof furniture -----------------------------------------------------
  const instanced = [];
  for (const [name, mats] of Object.entries(props)) {
    if (!mats.length) continue;
    const def = kit[name];
    for (const slot of ['metal', 'glass']) {
      const geo = def[slot];
      if (!geo) continue;
      const im = new THREE.InstancedMesh(geo, slot === 'glass' ? M.glass : M.metal, mats.length);
      im.name = 'bldprop-' + name + '-' + slot;
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = false;
      group.add(im); instanced.push(im); drawCalls++;
    }
  }

  engine.scene.add(group);

  // ---- LOD ---------------------------------------------------------------------------
  let lodDist = opts.lodDistance ?? 300;
  const cam = engine.camera;
  function refreshLOD() {
    for (const c of chunkList) {
      const d = cam.position.distanceTo(c.center) - c.radius;
      const near = d < lodDist;
      for (const m of c.near) m.visible = near;
      for (const m of c.far) m.visible = !near;
    }
  }
  refreshLOD();

  let acc = 0;
  const api = {
    group,
    count: designs.length,
    chunks: chunkList.length,
    drawCalls,
    materials: M,
    update(dt) {
      acc += dt;
      if (acc > 0.12) { acc = 0; refreshLOD(); }
    },
    setQuality(t) {
      lodDist = lerp(110, 460, clamp(t, 0, 1));
      for (const im of instanced) im.visible = t > 0.22;
      refreshLOD();
    },
  };
  engine.add(api);
  if (opts.quality != null) api.setQuality(opts.quality);
  return api;
}

/* ==================================================================== one building = */

function buildOne(d, chunk, world, M, place) {
  const out = chunk.near;
  const { ring, floorY, wallH, storeys, storeyH, kind, tint, roofTint } = d;
  const wallTopY = floorY + wallH;
  const isGH = kind === 'greenhouse';
  const trimCol = [Math.min(tint[0] * 1.06, 1.1), Math.min(tint[1] * 1.06, 1.1), Math.min(tint[2] * 1.05, 1.1)];
  const soffitCol = [tint[0] * 0.62, tint[1] * 0.61, tint[2] * 0.60];
  const doorCol = [0.30 + d.rand() * 0.25, 0.22 + d.rand() * 0.16, 0.16 + d.rand() * 0.12];
  const glassCol = [1, 1, 1];
  const frameCol = [1.06, 1.05, 1.03];
  const shutterCol = [0.92 + d.rand() * 0.1, 0.92, 0.90];
  const stoneCol = [0.96 + d.rand() * 0.08, 0.96, 0.95];

  // ---------------------------------------------------------------- plinth skirt ----
  const plinthCol = [tint[0] * 0.70, tint[1] * 0.69, tint[2] * 0.66];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const f = edgeFrame(a, b);
    if (!f) continue;
    const segs = clamp(Math.ceil(f.L / 2.5), 1, 24);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs * f.L, t1 = (s + 1) / segs * f.L;
      const x0 = a[0] + f.tx * t0 + f.ox * 0.06, z0 = a[1] + f.tz * t0 + f.oz * 0.06;
      const x1 = a[0] + f.tx * t1 + f.ox * 0.06, z1 = a[1] + f.tz * t1 + f.oz * 0.06;
      const y0 = Math.min(world.heightAt(x0, z0), floorY) - 0.55;
      const y1 = Math.min(world.heightAt(x1, z1), floorY) - 0.55;
      out.plaster.poly(
        [[x0, y0, z0], [x1, y1, z1], [x1, floorY + 0.28, z1], [x0, floorY + 0.28, z0]],
        [[t0 / 4, 0], [t1 / 4, 0], [t1 / 4, (floorY + 0.28 - y1) / 4], [t0 / 4, (floorY + 0.28 - y0) / 4]],
        plinthCol, [f.ox, 0, f.oz]);
    }
  }

  // ---------------------------------------------------------------------- walls -----
  for (let s = 0; s < storeys; s++) {
    const y0 = floorY + s * storeyH, y1 = y0 + storeyH;
    const stoneBand = d.wallMat === 'stone' || (d.wallMat === 'mixed' && s === 0);
    const mat = isGH ? 'sheeting' : (stoneBand ? 'stone' : 'plaster');
    const us = stoneBand ? 2.0 : (isGH ? 2.0 : 4.0);
    const col = isGH ? [1, 1, 1] : (stoneBand ? stoneCol : tint);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const f = edgeFrame(a, b);
      if (!f) continue;
      const holes = isGH ? [] : planHoles(f.L, y0, storeyH, s === 0, i === d.entrance, d.rand, kind);
      addWallBand(out, mat, a, b, y0, y1, holes, col, us,
        isGH ? { plain: true } : { trimCol, soffitCol, doorCol, glassCol, shutterCol, frameCol });
    }
  }

  // ---------------------------------------------------------------------- roof ------
  const roofCol = roofTint;
  let roofTop = wallTopY + 0.4;
  if (d.roofKind === 'flat') {
    addFlatRoof(out, d, wallTopY, trimCol, tint, world);
    roofTop = wallTopY + 0.10;
  } else {
    // insurance cap so any footprint area the rectangles miss still reads as roof, not sky
    addCapSlab(out, ring, wallTopY + 0.06, [tint[0] * 0.72, tint[1] * 0.71, tint[2] * 0.70]);
    for (const rect of d.rects) {
      if (rect.w < 1.4 || rect.d < 1.0) continue;
      const info = addRoof(out, rect, wallTopY, d.pitch, d.ov,
        d.roofKind === 'gable', roofCol, trimCol, soffitCol, tint, 2.0);
      roofTop = Math.max(roofTop, info.ridgeY);
    }
  }

  // ------------------------------------------------------------------- furniture ----
  addFurniture(d, world, out, place, wallTopY, trimCol, tint);

  // ---------------------------------------------------------------------- far LOD ---
  buildFar(d, chunk.far, wallTopY);
}

/** Flat roof: slab, parapet with coping, and a stair bulkhead on some. */
function addFlatRoof(out, d, wallTopY, trimCol, tint, world) {
  const { ring } = d;
  addCapSlab(out, ring, wallTopY + 0.06, [tint[0] * 0.76, tint[1] * 0.75, tint[2] * 0.73]);
  const PH = 0.92 + d.rand() * 0.34, PT = 0.20;
  const copeCol = [trimCol[0] * 0.68, trimCol[1] * 0.66, trimCol[2] * 0.62];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const f = edgeFrame(a, b);
    if (!f) continue;
    const ex = PT * 0.5;
    const mx = (a[0] + b[0]) * 0.5 - f.ox * PT * 0.5, mz = (a[1] + b[1]) * 0.5 - f.oz * PT * 0.5;
    addBox(out.plaster, mx, wallTopY + PH * 0.5, mz, f.tx, f.tz,
      f.L * 0.5 + ex, PH * 0.5, PT * 0.5, trimCol, 4);
    // grey precast coping, proud of the parapet on both faces
    addBox(out.plaster, mx, wallTopY + PH + 0.045, mz, f.tx, f.tz,
      f.L * 0.5 + ex + 0.05, 0.045, PT * 0.5 + 0.055, copeCol, 2);
  }
  // corner piers, a little taller than the run between them
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    addBox(out.plaster, a[0], wallTopY + (PH + 0.22) * 0.5, a[1], 1, 0,
      0.19, (PH + 0.22) * 0.5, 0.19, trimCol, 2);
    addBox(out.plaster, a[0], wallTopY + PH + 0.28, a[1], 1, 0,
      0.24, 0.05, 0.24, copeCol, 2);
  }
}

/** Triangulated footprint slab (also the fallback ceiling under pitched roofs). */
function addCapSlab(out, ring, y, col) {
  const pts = ring.map(p => new THREE.Vector2(p[0], p[1]));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { tris = null; }
  if (!tris || !tris.length) return;
  for (const t of tris) {
    const A = [pts[t[0]].x, y, pts[t[0]].y], B = [pts[t[1]].x, y, pts[t[1]].y], C = [pts[t[2]].x, y, pts[t[2]].y];
    out.plaster.poly([A, B, C], [[A[0] / 4, A[2] / 4], [B[0] / 4, B[2] / 4], [C[0] / 4, C[2] / 4]], col, [0, 1, 0]);
  }
}

/* ------------------------------------------------------------------- furniture ---- */

function addFurniture(d, world, out, place, wallTopY, trimCol, tint) {
  const r = d.rand;
  const flat = d.roofKind === 'flat';
  const main = d.rects[0];
  const isHouse = d.kind === 'house';

  // ---- solar water heater: nearly every dwelling has one -----------------------------
  if (d.kind !== 'greenhouse' && (isHouse ? r() < 0.94 : r() < 0.5)) {
    if (flat) {
      const px = d.cx + (r() - 0.5) * Math.max(main.w - 2.8, 0) * 0.5;
      const pz = d.cz + (r() - 0.5) * Math.max(main.d - 2.8, 0) * 0.5;
      place('solarFlat', px, wallTopY + 0.10, pz, [0, 1, 0], [0, 1, 0.0001]);
    } else {
      // the sun-facing slope of the biggest rectangle
      const vx = -main.uz, vz = main.ux;
      const sgn = vz > 0 ? 1 : -1;                       // +z is south
      const tp = Math.tan(d.pitch), c = Math.cos(d.pitch);
      const ehd = main.d / 2 + d.ov;
      const vOff = sgn * (ehd * 0.42);
      const eaveY = wallTopY + 0.22 - tp * d.ov;
      const y = eaveY + tp * (ehd - Math.abs(vOff)) + 0.05;
      const uOff = (r() - 0.5) * Math.max(main.w - 2.6, 0) * 0.55;
      const px = main.cx + main.ux * uOff + vx * vOff;
      const pz = main.cz + main.uz * uOff + vz * vOff;
      const nrm = [vx * sgn * Math.sin(d.pitch), c, vz * sgn * Math.sin(d.pitch)];
      place('solarPitched', px, y, pz, nrm, [vx * sgn, -tp * c, vz * sgn]);
    }
  }

  // ---- black poly water tank ---------------------------------------------------------
  if (flat && r() < 0.55) {
    const px = d.cx + (r() - 0.5) * Math.max(main.w - 2.2, 0) * 0.7;
    const pz = d.cz + (r() - 0.5) * Math.max(main.d - 2.2, 0) * 0.7;
    place('waterTank', px, wallTopY + 0.10, pz, [0, 1, 0], [0, 0, 1]);
  } else if (!flat && d.kind !== 'house' && d.kind !== 'greenhouse' && r() < 0.3) {
    place('waterTank', d.cx, wallTopY + 0.10, d.cz, [0, 1, 0], [0, 0, 1]);
  }

  // ---- chimney / vent through the roof ------------------------------------------------
  if (d.kind !== 'greenhouse' && r() < (isHouse ? 0.42 : 0.25)) {
    const vx = -main.ux * 0.0 - (-main.uz), vz = main.ux;
    const uOff = (r() - 0.5) * main.w * 0.5;
    const px = main.cx + main.ux * uOff, pz = main.cz + main.uz * uOff;
    const y = flat ? wallTopY + 0.10 : wallTopY + 0.22 + Math.tan(d.pitch) * (main.d / 2) - 0.35;
    place('chimney', px, y, pz, [0, 1, 0], [0, 0, 1]);
  }
  if (flat && r() < 0.45) {
    const uOff = (r() - 0.5) * main.w * 0.6, vOff = (r() - 0.5) * main.d * 0.5;
    const vx2 = -main.uz, vz2 = main.ux;
    place('vent', main.cx + main.ux * uOff + vx2 * vOff, wallTopY + 0.10,
      main.cz + main.uz * uOff + vz2 * vOff, [0, 1, 0], [0, 0, 1]);
  }

  // ---- satellite dish on the parapet or the gable wall ---------------------------------
  if (isHouse && r() < 0.45) {
    const e = d.ring[d.entrance], e2 = d.ring[(d.entrance + 1) % d.ring.length];
    const f = edgeFrame(e, e2);
    if (f) {
      const s = f.L * (0.2 + r() * 0.6);
      const y = d.floorY + d.wallH - 0.85 - r() * 0.6;
      place('dish', e[0] + f.tx * s + f.ox * 0.05, y, e[1] + f.tz * s + f.oz * 0.05,
        [f.ox, 0, f.oz], [0, 1, 0]);
    }
  }

  // ---- A/C condensers on the facade ----------------------------------------------------
  const acN = d.kind === 'house' ? 1 + (r() < 0.5 ? 1 : 0) : (r() < 0.4 ? 1 : 0);
  for (let k = 0; k < acN; k++) {
    const i = (r() * d.ring.length) | 0;
    const a = d.ring[i], b = d.ring[(i + 1) % d.ring.length];
    const f = edgeFrame(a, b);
    if (!f || f.L < 2.2) continue;
    const s = f.L * (0.2 + r() * 0.6);
    const y = d.floorY + (d.storeys > 1 && r() < 0.5 ? d.storeyH + 0.6 : 0.55);
    place('ac', a[0] + f.tx * s + f.ox * 0.22, y, a[1] + f.tz * s + f.oz * 0.22,
      [f.ox, 0, f.oz], [0, -1, 0]);
  }

  // ---- pergola + veranda along the street front ----------------------------------------
  if (isHouse && r() < 0.5) addPergola(d, world, out, trimCol, tint);
  // ---- low garden wall with piers and a gate --------------------------------------------
  if (isHouse && r() < 0.5) addGardenWall(d, world, out, tint);
  // ---- exterior stair to the roof / upper flat -------------------------------------------
  if (d.storeys > 1 && r() < 0.3) addStair(d, world, out, trimCol);
}

function addPergola(d, world, out, trimCol, tint) {
  const a = d.ring[d.entrance], b = d.ring[(d.entrance + 1) % d.ring.length];
  const f = edgeFrame(a, b);
  if (!f || f.L < 3.2) return;
  const depth = 2.5, len = Math.min(f.L - 0.6, 6.5);
  const s0 = (f.L - len) * 0.5;
  const postCol = [0.52, 0.38, 0.24], beamCol = [0.58, 0.43, 0.28];
  const beamY = d.floorY + 2.55;
  const P = (s, off) => [a[0] + f.tx * s + f.ox * off, a[1] + f.tz * s + f.oz * off];
  // slab
  const c0 = P(s0, 0.0), c1 = P(s0 + len, 0.0), c2 = P(s0 + len, depth), c3 = P(s0, depth);
  const sy = d.floorY + 0.02;
  out.plaster.poly([[c0[0], sy, c0[1]], [c1[0], sy, c1[1]], [c2[0], sy, c2[1]], [c3[0], sy, c3[1]]],
    [[0, 0], [len / 4, 0], [len / 4, depth / 4], [0, depth / 4]],
    [tint[0] * 0.80, tint[1] * 0.79, tint[2] * 0.77], [0, 1, 0]);
  for (const s of [s0 + 0.25, s0 + len - 0.25]) {
    const p = P(s, depth - 0.2);
    addBox(out.plaster, p[0], d.floorY + 1.28, p[1], f.tx, f.tz, 0.075, 1.28, 0.075, postCol, 1);
  }
  const mid = P(s0 + len / 2, depth - 0.2);
  addBox(out.plaster, mid[0], beamY + 0.09, mid[1], f.tx, f.tz, len / 2 + 0.2, 0.09, 0.07, beamCol, 1);
  const midw = P(s0 + len / 2, depth * 0.5);
  // rafters across the pergola
  const n = Math.max(4, Math.round(len / 0.55));
  for (let i = 0; i <= n; i++) {
    const p = P(s0 + len * i / n, depth * 0.5);
    addBox(out.plaster, p[0], beamY, p[1], f.ox, f.oz, depth * 0.5 + 0.2, 0.05, 0.045, beamCol, 1);
  }
  // vine mat
  const vy = beamY + 0.16;
  const g = [P(s0 - 0.2, -0.1), P(s0 + len + 0.2, -0.1), P(s0 + len + 0.2, depth + 0.25), P(s0 - 0.2, depth + 0.25)];
  const vc = [0.30 + d.rand() * 0.1, 0.42 + d.rand() * 0.12, 0.20];
  out.foliage.poly(g.map((p, i) => [p[0], vy + (i % 2 ? 0.06 : 0), p[1]]),
    [[0, 0], [1, 0], [1, 1], [0, 1]], vc, [0, 1, 0]);
}

function addGardenWall(d, world, out, tint) {
  const a = d.ring[d.entrance], b = d.ring[(d.entrance + 1) % d.ring.length];
  const f = edgeFrame(a, b);
  if (!f || f.L < 4.5) return;
  const off = 5.0 + d.rand() * 2.5, H = 0.85 + d.rand() * 0.25;
  const len = Math.min(f.L * 1.1, 16);
  const s0 = (f.L - len) * 0.5;
  const gate = 1.3;
  const col = [tint[0] * 0.94, tint[1] * 0.93, tint[2] * 0.90];
  const P = (s) => [a[0] + f.tx * s + f.ox * off, a[1] + f.tz * s + f.oz * off];
  const segs = [[s0, s0 + len / 2 - gate / 2], [s0 + len / 2 + gate / 2, s0 + len]];
  for (const [q0, q1] of segs) {
    const n = clamp(Math.ceil((q1 - q0) / 2.5), 1, 10);
    for (let i = 0; i < n; i++) {
      const t0 = q0 + (q1 - q0) * i / n, t1 = q0 + (q1 - q0) * (i + 1) / n;
      const m = P((t0 + t1) * 0.5);
      const gy = world.heightAt(m[0], m[1]);
      addBox(out.plaster, m[0], gy + H * 0.5, m[1], f.tx, f.tz, (t1 - t0) * 0.5 + 0.05, H * 0.5 + 0.25, 0.14, col, 4);
    }
  }
  for (const s of [s0, s0 + len / 2 - gate / 2, s0 + len / 2 + gate / 2, s0 + len]) {
    const m = P(s);
    const gy = world.heightAt(m[0], m[1]);
    addBox(out.plaster, m[0], gy + (H + 0.35) * 0.5, m[1], f.tx, f.tz, 0.19, (H + 0.35) * 0.5 + 0.2, 0.19,
      [col[0] * 0.95, col[1] * 0.94, col[2] * 0.92], 2);
  }
  // mailbox post beside the gate
  const mb = P(s0 + len / 2 - gate / 2 - 0.5);
  const my = world.heightAt(mb[0], mb[1]);
  addBox(out.plaster, mb[0], my + 0.55, mb[1], f.tx, f.tz, 0.05, 0.55, 0.05, [0.35, 0.35, 0.34], 1);
  addBox(out.plaster, mb[0], my + 1.18, mb[1], f.tx, f.tz, 0.17, 0.11, 0.13, [0.30, 0.34, 0.40], 1);
}

function addStair(d, world, out, trimCol) {
  // pick the edge after the entrance so the stair does not sit on the front door
  const i = (d.entrance + 1) % d.ring.length;
  const a = d.ring[i], b = d.ring[(i + 1) % d.ring.length];
  const f = edgeFrame(a, b);
  if (!f || f.L < 4.0) return;
  const steps = 14, rise = d.storeyH / steps, run = 0.28;
  const s0 = 0.5;
  const col = [trimCol[0] * 0.9, trimCol[1] * 0.89, trimCol[2] * 0.87];
  for (let k = 0; k < steps; k++) {
    const s = s0 + k * run + run / 2;
    if (s > f.L - 0.4) break;
    const x = a[0] + f.tx * s + f.ox * 0.62, z = a[1] + f.tz * s + f.oz * 0.62;
    const y = d.floorY + rise * (k + 0.5);
    addBox(out.plaster, x, y * 0.5 + (d.floorY - 0.3) * 0.5, z, f.tx, f.tz,
      run * 0.5 + 0.02, (y - d.floorY + 0.3) * 0.5, 0.60, col, 2);
  }
  // railing
  const sEnd = Math.min(s0 + steps * run, f.L - 0.4);
  const mid = (s0 + sEnd) * 0.5;
  const mx = a[0] + f.tx * mid + f.ox * 1.2, mz = a[1] + f.tz * mid + f.oz * 1.2;
  const my = d.floorY + d.storeyH * 0.5 + 0.95;
  addBox(out.plaster, mx, my, mz, f.tx, f.tz, (sEnd - s0) * 0.5, 0.035, 0.035, [0.35, 0.36, 0.36], 1);
}

/* --------------------------------------------------------------------- far LOD ---- */

function buildFar(d, far, wallTopY) {
  const { ring, floorY, tint, roofTint } = d;
  const S = far.farSurface, R = far.farRoof;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const f = edgeFrame(a, b);
    if (!f) continue;
    const y0 = floorY - 0.8;
    S.poly([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], wallTopY, b[1]], [a[0], wallTopY, a[1]]],
      [[0, 0], [f.L / 4, 0], [f.L / 4, (wallTopY - y0) / 4], [0, (wallTopY - y0) / 4]],
      tint, [f.ox, 0, f.oz]);
  }
  if (d.roofKind === 'flat') {
    const pts = ring.map(p => new THREE.Vector2(p[0], p[1]));
    let tris = null;
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { /* ignore */ }
    if (tris) for (const t of tris) {
      const A = [pts[t[0]].x, wallTopY, pts[t[0]].y], B = [pts[t[1]].x, wallTopY, pts[t[1]].y], C = [pts[t[2]].x, wallTopY, pts[t[2]].y];
      S.poly([A, B, C], [[A[0] / 4, A[2] / 4], [B[0] / 4, B[2] / 4], [C[0] / 4, C[2] / 4]],
        [tint[0] * 0.8, tint[1] * 0.79, tint[2] * 0.77], [0, 1, 0]);
    }
    return;
  }
  const gable = d.roofKind === 'gable';
  for (const rect of d.rects) {
    if (rect.w < 1.4 || rect.d < 1.0) continue;
    const { cx, cz, ux, uz } = rect;
    const vx = -uz, vz = ux;
    const ehw = rect.w / 2 + d.ov, ehd = rect.d / 2 + d.ov;
    const tp = Math.tan(d.pitch);
    const eaveY = wallTopY + 0.22 - tp * d.ov, ridgeY = eaveY + tp * ehd;
    const rx = gable ? ehw : Math.max(0, ehw - ehd);
    const P = (u, v, y) => [cx + ux * u + vx * v, y, cz + uz * u + vz * v];
    R.poly([P(-ehw, -ehd, eaveY), P(ehw, -ehd, eaveY), P(rx, 0, ridgeY), P(-rx, 0, ridgeY)],
      [[-ehw / 2, 0], [ehw / 2, 0], [rx / 2, 2], [-rx / 2, 2]], roofTint, [0, 1, 0]);
    R.poly([P(ehw, ehd, eaveY), P(-ehw, ehd, eaveY), P(-rx, 0, ridgeY), P(rx, 0, ridgeY)],
      [[ehw / 2, 0], [-ehw / 2, 0], [-rx / 2, 2], [rx / 2, 2]], roofTint, [0, 1, 0]);
    if (!gable) {
      R.poly([P(ehw, -ehd, eaveY), P(ehw, ehd, eaveY), P(rx, 0, ridgeY)],
        [[-ehd / 2, 0], [ehd / 2, 0], [0, 2]], roofTint, [0, 1, 0]);
      R.poly([P(-ehw, ehd, eaveY), P(-ehw, -ehd, eaveY), P(-rx, 0, ridgeY)],
        [[ehd / 2, 0], [-ehd / 2, 0], [0, 2]], roofTint, [0, 1, 0]);
    } else {
      for (const sgn of [1, -1]) {
        S.poly([P(sgn * rect.w / 2, -rect.d / 2, wallTopY), P(sgn * rect.w / 2, rect.d / 2, wallTopY),
                P(sgn * rect.w / 2, 0, ridgeY)],
          [[0, 0], [rect.d / 4, 0], [rect.d / 8, (ridgeY - wallTopY) / 4]], tint, [sgn * ux, 0, sgn * uz]);
      }
    }
  }
}
