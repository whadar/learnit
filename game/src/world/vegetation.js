/**
 * Everything that grows on the Amikam Village Circuit.
 *
 * Ramot Menashe in late summer: Jerusalem-pine plantation on the western hills, Mediterranean
 * maquis of Palestine oak, terebinth, sage and broom on the stony slopes, olive groves and
 * almond orchards in real 8 m rows, trellised vineyards, cypress windbreaks along the field
 * edges, prickly-pear hedges, and a sun-bleached carpet of dry grass, wheat stubble and
 * thistles over everything else.
 *
 * How it works
 * ------------
 * **Art** is procedural (`src/render/materials/vegetationMaterials.js`): one authored leaf
 * spray per species in an alpha atlas, tileable bark colour+normal pairs, and a stand-of-trees
 * impostor sheet for the far field.
 *
 * **Placement** is driven by the real Overture data. `world.landcover` (forest / shrub / grass
 * / crop / barren) and `world.landuse` (farmland / orchard / farmyard / meadow) are rasterised
 * into a class map; `world.roads`, `world.buildings` and `world.water` are rasterised into an
 * exclusion map with a clearance buffer. Natural vegetation is then a deterministic hash-grid
 * scatter over those maps — the same cell always yields the same plant, so nothing shifts
 * between review rounds — while orchards, vineyards and windbreaks are planted as real rows
 * aligned to each field's own principal axis.
 *
 * **Rendering** is one `InstancedMesh` per species per LOD, repacked on the CPU whenever the
 * camera moves: near trees get the full mesh (tapered branch tubes plus leaf cards with
 * spherical canopy normals), mid trees a cheap card cluster, and beyond that the hills are
 * carried by cross-quad stand impostors so the ridge lines read as forest instead of bald.
 * Instances outside the frustum are never packed, which keeps both the draw calls and the
 * software-rasteriser cost bounded.
 *
 *   const veg = createVegetation(engine, world, { quality: 1 });
 *   veg.update(dt, elapsed);
 *   veg.setQuality(0.5);
 */
import * as THREE from 'three';
import { rng, clamp, lerp } from '../core/mathx.js';
import { hash2i } from '../render/materials/noise.js';
import {
  buildFoliageAtlas, buildStandSheet, buildBarkTexture, buildCactusTexture,
  createWindUniforms, createFoliageMaterial, createBarkMaterial, createCactusMaterial,
  slotRect, STAND_RECT,
} from '../render/materials/vegetationMaterials.js';

const TAU = Math.PI * 2;
const GOLDEN = 2.39996323;

/* ============================================================ geometry kit ==== */

/** Accumulates positions/normals/uv plus the per-vertex wind attribute `aFol`. */
class Builder {
  constructor() { this.p = []; this.n = []; this.t = []; this.ph = []; this.fl = []; this.ao = []; this.i = []; }
  get count() { return this.p.length / 3; }
  v(x, y, z, nx, ny, nz, u, vv, ph, fl, ao = 1) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, vv);
    this.ph.push(ph); this.fl.push(fl); this.ao.push(ao);
    return this.p.length / 3 - 1;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /** `H` normalises the bend weight; `exp` shapes how the sway builds up the plant. */
  build(H, exp = 1.8) {
    const g = new THREE.BufferGeometry();
    const n = this.count;
    const fol = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      fol[k * 4] = Math.pow(clamp(this.p[k * 3 + 1] / H, 0, 1), exp);
      fol[k * 4 + 1] = this.ph[k];
      fol[k * 4 + 2] = this.fl[k];
      fol[k * 4 + 3] = this.ao[k];
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('aFol', new THREE.BufferAttribute(fol, 4));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** One flat leaf card: base-centre at p, growing along `up`, `w` wide and `h` tall. */
function addCard(b, p, up, right, w, h, rect, nrm, ph, fl, ao = 1) {
  const hw = w * 0.5;
  const corner = (sx, sy) => {
    const x = p.x + right.x * sx * hw + up.x * sy * h;
    const y = p.y + right.y * sx * hw + up.y * sy * h;
    const z = p.z + right.z * sx * hw + up.z * sy * h;
    return b.v(x, y, z, nrm.x, nrm.y, nrm.z,
      sx < 0 ? rect[0] : rect[2], sy < 0.5 ? rect[1] : rect[3], ph, fl * (0.25 + sy),
      ao * (0.78 + 0.22 * sy));
  };
  b.quad(corner(-1, 0), corner(1, 0), corner(1, 1), corner(-1, 1));
}

/** Tapered tube through a polyline, with parallel-transported frames. */
function addTube(b, pts, radii, rs, ph, uvLen = 1.6, uRepeat = 2) {
  const N = pts.length;
  if (N < 2) return;
  const tan = [];
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(N - 1, i + 1)];
    _a.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (_a.lengthSq() < 1e-9) _a.set(0, 1, 0);
    tan.push(_a.clone().normalize());
  }
  let nrm = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tan[0].x) > 0.9) nrm.set(0, 0, 1);
  nrm.addScaledVector(tan[0], -nrm.dot(tan[0])).normalize();
  let vlen = 0;
  const rings = [];
  for (let i = 0; i < N; i++) {
    if (i > 0) {
      nrm.addScaledVector(tan[i], -nrm.dot(tan[i]));
      if (nrm.lengthSq() < 1e-8) nrm.set(tan[i].y, -tan[i].x, 0);
      nrm.normalize();
      vlen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    }
    const bin = _b.crossVectors(tan[i], nrm);
    const ring = [];
    for (let k = 0; k <= rs; k++) {
      const a = (k / rs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = nrm.x * ca + bin.x * sa, dy = nrm.y * ca + bin.y * sa, dz = nrm.z * ca + bin.z * sa;
      ring.push(b.v(pts[i][0] + dx * radii[i], pts[i][1] + dy * radii[i], pts[i][2] + dz * radii[i],
        dx, dy, dz, (k / rs) * uRepeat, vlen / uvLen, ph, 0));
    }
    rings.push(ring);
  }
  for (let i = 0; i < N - 1; i++)
    for (let k = 0; k < rs; k++)
      b.quad(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]);
}

/**
 * A puff of leaf cards on an ellipsoid shell. Normals point radially out of the puff centre,
 * which is what makes a pile of flat cards shade like a solid canopy.
 */
function addPuff(b, r, cx, cy, cz, rx, ry, rz, count, rect, w, h, o = {}) {
  const pitch = o.pitch ?? 0.55, flut = o.flutter ?? 0.05, shell = o.shell ?? 0.45;
  const up = new THREE.Vector3(), right = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const th = r() * TAU, cph = 2 * r() - 1, sph = Math.sqrt(Math.max(0, 1 - cph * cph));
    const dx = sph * Math.cos(th), dy = cph, dz = sph * Math.sin(th);
    const rad = Math.pow(shell + (1 - shell) * r(), 0.4);
    p.set(cx + dx * rx * rad, cy + dy * ry * rad, cz + dz * rz * rad);
    n.set(dx / rx, dy / ry + 0.18, dz / rz).normalize();
    up.set(n.x * pitch, lerp(1, n.y, pitch) + 0.12, n.z * pitch).normalize();
    right.set(-Math.sin(th + 1.2), 0, Math.cos(th + 1.2));
    right.addScaledVector(up, -right.dot(up));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const s = 0.75 + r() * 0.5;
    p.addScaledVector(up, -h * s * 0.42);
    // baked canopy occlusion: cards buried in the middle of the puff are darker than the
    // sunlit shell, which is most of what turns a pile of flat quads into a solid crown
    const ao = clamp(0.40 + 0.52 * rad + 0.24 * Math.max(dy, 0), 0.34, 1.0);
    addCard(b, p, up, right, w * s, h * s, rect, n, r(), flut, ao);
  }
}

/* ============================================================== the species === */
// Each builder returns { trunk, foliage, H, R }. `detail` 1 = near mesh, 0 = mid card cluster.

/** Aleppo / Jerusalem pine: bare leaning bole, high irregular umbrella of needle plates. */
function buildPine(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 11.5 + r() * 4.5;
  const rs = detail ? 6 : 4;
  const lean = (r() - 0.5) * 0.11;
  const clear = 0.46 + r() * 0.12;
  const segs = detail ? 7 : 3;
  const pts = [], rad = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.sin(t * 2.3 + seed) * lean * H * 0.7 + t * lean * H * 1.5, t * H * 0.93,
              Math.cos(t * 1.6 + seed * 0.7) * lean * H * 0.5]);
    rad.push(lerp(0.36, 0.06, Math.pow(t, 0.72)));
  }
  addTube(tb, pts, rad, rs, 0, 2.2);
  const at = t => {
    const f = clamp(t, 0, 1) * segs, i = Math.min(segs - 1, f | 0), s = f - i;
    return [lerp(pts[i][0], pts[i + 1][0], s), lerp(pts[i][1], pts[i + 1][1], s), lerp(pts[i][2], pts[i + 1][2], s)];
  };
  const rects = [slotRect('pineA'), slotRect('pineB'), slotRect('pineC')];
  const nb = detail ? 9 : 5;
  let R = 0;
  for (let i = 0; i < nb; i++) {
    const t0 = clear + (i / nb) * (0.98 - clear) + (r() - 0.5) * 0.04;
    const base = at(t0);
    const az = i * GOLDEN + r() * 0.4;
    // longest limbs sit just below the crown: that is what makes the umbrella
    const shape = Math.sin(Math.PI * clamp((t0 - clear) / (1 - clear), 0, 1) * 0.82 + 0.42);
    const len = H * (0.20 + 0.24 * shape) * (0.75 + r() * 0.5);
    const rise = 0.30 + r() * 0.30;
    const bp = [], br = [];
    const bs = detail ? 3 : 2;
    for (let k = 0; k <= bs; k++) {
      const t = k / bs;
      const spread = len * t;
      bp.push([base[0] + Math.cos(az) * spread, base[1] + spread * rise * (1 - t * 0.55) + len * 0.06 * t,
               base[2] + Math.sin(az) * spread]);
      br.push(lerp(0.10, 0.022, t));
    }
    if (detail) addTube(tb, bp, br, 4, r(), 1.4);
    const tip = bp[bs];
    R = Math.max(R, Math.hypot(tip[0], tip[2]) + 1.6);
    const rect = rects[i % 3];
    addPuff(fb, r, tip[0], tip[1] + 0.20, tip[2],
      len * 0.46 + 0.5, len * 0.22 + 0.35, len * 0.46 + 0.5,
      detail ? 15 : 4, rect, detail ? 1.55 : 4.6, detail ? 1.35 : 3.8,
      { pitch: 0.82, flutter: 0.05, shell: 0.34 });
  }
  const top = at(1.0);
  addPuff(fb, r, top[0], top[1] - 0.6, top[2], H * 0.15, H * 0.08, H * 0.15,
    detail ? 16 : 5, rects[0], detail ? 1.6 : 4.4, detail ? 1.4 : 3.6,
    { pitch: 0.62, flutter: 0.055, shell: 0.3 });
  return { trunk: tb.build(H), foliage: fb.build(H, 2.0), H, R: Math.max(R, H * 0.30) };
}

/** Italian cypress: dark, narrow, absolutely vertical — the moshav's punctuation marks. */
function buildCypress(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 9 + r() * 6;
  const W = H * (0.085 + r() * 0.035);
  const pts = [], rad = [];
  const segs = detail ? 5 : 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.sin(t * 1.7 + seed) * 0.06 * H * 0.2, t * H * 0.9, 0]);
    rad.push(lerp(0.20, 0.04, t));
  }
  addTube(tb, pts, rad, detail ? 5 : 3, 0, 2.0);
  const rect = slotRect('cypress');
  const n = detail ? 40 : 12;
  const up = new THREE.Vector3(), right = new THREE.Vector3(), nn = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = 0.06 + (i / n) * 0.94 + (r() - 0.5) * 0.03;
    // spindle profile: widest around 45 % of the height, tapering to a point
    const prof = Math.pow(Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.78)), 0.55);
    const az = i * GOLDEN + r() * 0.3;
    const rad2 = W * prof * (0.55 + r() * 0.6);
    p.set(Math.cos(az) * rad2, t * H * 0.94, Math.sin(az) * rad2);
    nn.set(Math.cos(az), 0.35, Math.sin(az)).normalize();
    up.set(nn.x * 0.42, 1.0, nn.z * 0.42).normalize();
    right.set(-Math.sin(az), 0, Math.cos(az));
    const s = (detail ? 1 : 2.1) * (0.8 + r() * 0.5);
    const h = H * 0.16 * s, w = W * 1.9 * s;
    p.addScaledVector(up, -h * 0.45);
    addCard(fb, p, up, right, w, h, rect, nn, r(), 0.03);
  }
  return { trunk: tb.build(H), foliage: fb.build(H, 2.2), H, R: W * 1.6 };
}

/** Palestine oak / Tabor oak — dense dark rounded crown on a short thick bole. */
function buildOak(seed, detail, bush, rectOverride) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = bush ? 1.8 + r() * 1.4 : 5.0 + r() * 3.2;
  const stemH = H * (bush ? 0.16 : 0.30);
  const pts = [], rad = [];
  const segs = detail ? 4 : 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.sin(t * 2.0 + seed) * H * 0.02, t * stemH, Math.cos(t * 1.4 + seed) * H * 0.02]);
    rad.push(lerp(H * 0.055, H * 0.030, t));
  }
  addTube(tb, pts, rad, detail ? 6 : 4, 0, 1.6);
  const nb = detail ? (bush ? 4 : 6) : 3;
  const rect = rectOverride || slotRect('oak');
  const CR = H * (bush ? 0.52 : 0.44);
  for (let i = 0; i < nb; i++) {
    const az = i * GOLDEN + r() * 0.5;
    const len = H * (bush ? 0.42 : 0.40) * (0.7 + r() * 0.6);
    const bp = [], br = [];
    const bs = detail ? 2 : 1;
    for (let k = 0; k <= bs; k++) {
      const t = k / bs;
      bp.push([Math.cos(az) * len * t * 0.85, stemH + len * t * 0.9, Math.sin(az) * len * t * 0.85]);
      br.push(lerp(H * 0.032, H * 0.010, t));
    }
    if (detail) addTube(tb, bp, br, 4, r(), 1.2);
  }
  addPuff(fb, r, 0, stemH + H * (bush ? 0.42 : 0.44), 0, CR, CR * 0.80, CR,
    detail ? (bush ? 26 : 56) : (bush ? 5 : 9), rect,
    detail ? CR * 0.42 : CR * 1.9, detail ? CR * 0.38 : CR * 1.7,
    { pitch: 0.50, flutter: 0.05, shell: 0.30 });
  if (detail) {   // inner core so the crown is a solid mass, not a shell of cards
    addPuff(fb, r, 0, stemH + H * (bush ? 0.40 : 0.42), 0, CR * 0.62, CR * 0.52, CR * 0.62,
      bush ? 8 : 18, rect, CR * 0.44, CR * 0.40, { pitch: 0.35, flutter: 0.04, shell: 0.0 });
  }
  return { trunk: tb.build(H), foliage: fb.build(H, 1.7), H, R: CR * 1.15 };
}

/** Atlantic terebinth (butmeh): taller, airier and paler than the oak it grows beside. */
function buildTerebinth(seed, detail) {
  return buildOak(seed ^ 0x51f3, detail, false, slotRect('terebinth'));
}

/** Olive: gnarled multi-stem base, broad billowing silver-green canopy. */
function buildOlive(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 4.2 + r() * 2.2;
  const stems = detail ? 3 : 2;
  const rect = slotRect('olive');
  const forkY = H * 0.36;
  for (let s = 0; s < stems; s++) {
    const az = s * (TAU / stems) + r() * 0.6;
    const off = 0.16 + r() * 0.16;
    const pts = [], rad = [];
    const segs = detail ? 5 : 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // the classic olive twist: the stem corkscrews as it rises
      const tw = az + t * (1.1 + r() * 0.3);
      const rr = off * (1 - t * 0.35) * (1 + 0.5 * Math.sin(t * 5.0 + seed));
      pts.push([Math.cos(tw) * rr, t * forkY * 1.15, Math.sin(tw) * rr]);
      rad.push(lerp(0.20 + r() * 0.05, 0.085, t));
    }
    addTube(tb, pts, rad, detail ? 6 : 4, 0, 1.1);
    if (detail) {
      const nb = 3;
      for (let i = 0; i < nb; i++) {
        const a2 = az + (i - 1) * 0.8 + r() * 0.4;
        const len = H * 0.30 * (0.7 + r() * 0.6);
        const bp = [], br = [];
        for (let k = 0; k <= 2; k++) {
          const t = k / 2;
          bp.push([pts[segs][0] + Math.cos(a2) * len * t * 0.9, forkY * 1.15 + len * t * 0.85,
                   pts[segs][2] + Math.sin(a2) * len * t * 0.9]);
          br.push(lerp(0.075, 0.020, t));
        }
        addTube(tb, bp, br, 4, r(), 1.0);
      }
    }
  }
  const CR = H * 0.62;
  const lobes = detail ? 5 : 2;
  for (let i = 0; i < lobes; i++) {
    const az = i * GOLDEN + r();
    const rr = CR * 0.42 * (0.5 + r() * 0.8);
    addPuff(fb, r, Math.cos(az) * rr, forkY + H * (0.34 + r() * 0.18), Math.sin(az) * rr,
      CR * 0.60, CR * 0.44, CR * 0.60,
      detail ? 30 : 5, rect, detail ? CR * 0.30 : CR * 1.5, detail ? CR * 0.26 : CR * 1.3,
      { pitch: 0.55, flutter: 0.07, shell: 0.28 });
  }
  if (detail) {
    addPuff(fb, r, 0, forkY + H * 0.34, 0, CR * 0.66, CR * 0.44, CR * 0.66,
      26, rect, CR * 0.30, CR * 0.26, { pitch: 0.4, flutter: 0.05, shell: 0.0 });
  }
  return { trunk: tb.build(H), foliage: fb.build(H, 1.6), H, R: CR * 1.1 };
}

/** Almond: vase of pale limbs, thin dusty crown by late summer. */
function buildAlmond(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 3.6 + r() * 1.8;
  const stemH = H * 0.34;
  const pts = [], rad = [];
  for (let i = 0; i <= (detail ? 3 : 2); i++) {
    const t = i / (detail ? 3 : 2);
    pts.push([Math.sin(t * 2 + seed) * 0.06, t * stemH, 0]);
    rad.push(lerp(0.15, 0.10, t));
  }
  addTube(tb, pts, rad, detail ? 6 : 4, 0, 1.3);
  const rect = slotRect('almond');
  const nb = detail ? 5 : 3;
  const CR = H * 0.50;
  for (let i = 0; i < nb; i++) {
    const az = i * GOLDEN + r() * 0.4;
    const len = H * 0.52 * (0.75 + r() * 0.45);
    const bp = [], br = [];
    const bs = detail ? 2 : 1;
    for (let k = 0; k <= bs; k++) {
      const t = k / bs;
      bp.push([Math.cos(az) * len * t * 0.68, stemH + len * t * 0.95, Math.sin(az) * len * t * 0.68]);
      br.push(lerp(0.085, 0.018, t));
    }
    if (detail) addTube(tb, bp, br, 4, r(), 1.0);
    const tip = bp[bs];
    addPuff(fb, r, tip[0], tip[1], tip[2], CR * 0.46, CR * 0.38, CR * 0.46,
      detail ? 16 : 3, rect, detail ? CR * 0.34 : CR * 1.5, detail ? CR * 0.30 : CR * 1.3,
      { pitch: 0.5, flutter: 0.09, shell: 0.26 });
  }
  return { trunk: tb.build(H), foliage: fb.build(H, 1.6), H, R: CR * 1.15 };
}

/** Date palm: ringed bole, crown of arching pinnate fronds. */
function buildPalm(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 7 + r() * 5;
  const pts = [], rad = [];
  const segs = detail ? 8 : 3;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.sin(t * 1.4 + seed) * H * 0.02, t * H, Math.cos(t * 1.1 + seed) * H * 0.015]);
    // slight bulge where the old leaf bases stack
    rad.push(lerp(0.34, 0.26, t) * (1 + 0.06 * Math.sin(t * 22)));
  }
  addTube(tb, pts, rad, detail ? 8 : 5, 0, 1.1);
  const rect = slotRect('frond');
  const nf = detail ? 20 : 9;
  const up = new THREE.Vector3(), right = new THREE.Vector3(), nn = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < nf; i++) {
    const az = i * GOLDEN;
    const t = i / nf;
    const droop = lerp(-0.55, 0.75, Math.pow(t, 0.8)) + (r() - 0.5) * 0.2;  // outer fronds hang
    const L = H * (0.42 + r() * 0.12) * (detail ? 1 : 1.05);
    const segsF = detail ? 4 : 2;
    const ca = Math.cos(az), sa = Math.sin(az);
    const rectW = rect[2] - rect[0];
    let px = 0, py = H * 0.97, pz = 0;
    for (let k = 0; k < segsF; k++) {
      const t0 = k / segsF, t1 = (k + 1) / segsF;
      const y0 = py, x0 = px, z0 = pz;
      const rise0 = Math.sin(lerp(0.9, -droop, t0)), run0 = Math.cos(lerp(0.9, -droop, t0));
      const rise1 = Math.sin(lerp(0.9, -droop, t1)), run1 = Math.cos(lerp(0.9, -droop, t1));
      px = x0 + ca * L * run1 / segsF; pz = z0 + sa * L * run1 / segsF;
      py = y0 + L * rise1 / segsF;
      const w = H * 0.16 * (1 - t1 * 0.35);
      nn.set(ca * 0.3, 1, sa * 0.3).normalize();
      right.set(-sa, 0, ca);
      up.set(ca * run0, rise0, sa * run0).normalize();
      const u0 = rect[0] + rectW * t0, u1 = rect[0] + rectW * t1;
      const seg = [rect[1], rect[3]];
      // frond ribbon: one quad per segment, texture runs along its length
      const a = fb.v(x0 - right.x * w, y0 - right.y * w, z0 - right.z * w, nn.x, nn.y, nn.z, u0, seg[0], r(), 0.05);
      const b2 = fb.v(x0 + right.x * w, y0 + right.y * w, z0 + right.z * w, nn.x, nn.y, nn.z, u0, seg[1], r(), 0.05);
      const c2 = fb.v(px + right.x * w, py + right.y * w, pz + right.z * w, nn.x, nn.y, nn.z, u1, seg[1], r(), 0.09);
      const d2 = fb.v(px - right.x * w, py - right.y * w, pz - right.z * w, nn.x, nn.y, nn.z, u1, seg[0], r(), 0.09);
      fb.quad(a, b2, c2, d2);
    }
  }
  return { trunk: tb.build(H, 2.4), foliage: fb.build(H, 2.4), H, R: H * 0.5 };
}

/** Low aromatic scrub: sage, thyme, thorny burnet — the batha ground layer. */
function buildShrub(seed, detail, kind) {
  const r = rng(seed);
  const fb = new Builder();
  const H = kind === 'broom' ? 1.3 + r() * 0.9 : 0.55 + r() * 0.55;
  const rect = slotRect(kind === 'broom' ? 'broom' : 'sage');
  const W = kind === 'broom' ? H * 0.55 : H * 1.35;
  addPuff(fb, r, 0, H * (kind === 'broom' ? 0.52 : 0.42), 0,
    W * 0.5, H * (kind === 'broom' ? 0.46 : 0.34), W * 0.5,
    detail ? (kind === 'broom' ? 16 : 18) : 4, rect,
    detail ? W * 0.50 : W * 1.5, detail ? H * 0.62 : H * 1.5,
    { pitch: kind === 'broom' ? 0.20 : 0.48, flutter: 0.055, shell: 0.24 });
  return { trunk: null, foliage: fb.build(H, 1.35), H, R: W * 0.6 };
}

/** Dry thistle — golden, spiky, everywhere on the stubble margins by August. */
function buildThistle(seed, detail) {
  const r = rng(seed);
  const fb = new Builder();
  const H = 0.55 + r() * 0.65;
  const rect = slotRect('thistle');
  const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3(), n = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n2 = detail ? 3 : 2;
  for (let i = 0; i < n2; i++) {
    const az = i * (Math.PI / n2) + r() * 0.4;
    right.set(Math.cos(az), 0, Math.sin(az));
    n.set(-Math.sin(az), 0.5, Math.cos(az)).normalize();
    p.set(0, 0, 0);
    addCard(fb, p, up, right, H * 0.85, H, rect, n, r(), 0.10);
  }
  return { trunk: null, foliage: fb.build(H, 1.4), H, R: H * 0.55 };
}

/** Grass / wheat-stubble tuft: crossed blade cards, deliberately cheap. */
function buildTuft(seed, kind, big) {
  const r = rng(seed);
  const fb = new Builder();
  const H = (kind === 'wheat' ? 0.20 + r() * 0.16 : 0.17 + r() * 0.15) * (big ? 2.0 : 1);
  const rect = slotRect(kind === 'wheat' ? 'wheat' : (r() > 0.5 ? 'grassDry' : 'grass'));
  const up = new THREE.Vector3(), right = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  const cards = big ? 2 : 3;
  for (let i = 0; i < cards; i++) {
    const az = i * (Math.PI / cards) + r() * 0.5;
    right.set(Math.cos(az), 0, Math.sin(az));
    n.set(-Math.sin(az), 0.65, Math.cos(az)).normalize();
    const tilt = (r() - 0.5) * 0.28;
    up.set(Math.cos(az) * tilt, 1, Math.sin(az) * tilt).normalize();
    p.set((r() - 0.5) * H * 0.25, -0.02, (r() - 0.5) * H * 0.25);
    addCard(fb, p, up, right, H * (1.05 + r() * 0.3), H * (0.85 + r() * 0.35), rect, n, r(), 0.12);
  }
  return { trunk: null, foliage: fb.build(H, 1.15), H, R: H * 0.8 };
}

/** Prickly pear (sabra): real pad geometry, because the silhouette is the whole point. */
function buildPrickly(seed) {
  const r = rng(seed);
  const b = new Builder();
  const H = 1.3 + r() * 1.1;
  const pad = (cx, cy, cz, w, h, az, tilt) => {
    const N = 12, th = w * 0.075;
    const ca = Math.cos(az), sa = Math.sin(az);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const put = (lx, ly, lz, nx, ny, nz, u, v) => {
      // local (lx: across pad, ly: up pad, lz: through pad) -> world
      const y2 = ly * ct - lz * st, z2 = ly * st + lz * ct;
      const wx = lx * ca - z2 * sa, wz = lx * sa + z2 * ca;
      const ny2 = ny * ct - nz * st, nz2 = ny * st + nz * ct;
      const nx2 = nx * ca - nz2 * sa, nz3 = nx * sa + nz2 * ca;
      return b.v(cx + wx, cy + y2, cz + wz, nx2, ny2, nz3, u, v, 0, 0);
    };
    for (const side of [1, -1]) {
      const centre = put(0, 0, side * th, 0, 0, side, 0.5, 0.5);
      const ring = [];
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * TAU;
        const ex = Math.cos(a) * w * 0.5, ey = Math.sin(a) * h * 0.5 + h * 0.5;
        ring.push(put(ex, ey, side * th * 0.30,
          Math.cos(a) * 0.55, Math.sin(a) * 0.35, side * 0.78,
          0.5 + Math.cos(a) * 0.46, 0.5 + Math.sin(a) * 0.46));
      }
      for (let i = 0; i < N; i++) {
        if (side > 0) b.i.push(centre, ring[i], ring[i + 1]);
        else b.i.push(centre, ring[i + 1], ring[i]);
      }
    }
  };
  const base = 4 + ((r() * 4) | 0);
  for (let i = 0; i < base; i++) {
    const az = i * GOLDEN + r() * 0.5;
    const w = 0.42 + r() * 0.22, h = w * (1.25 + r() * 0.4);
    const cx = Math.cos(az) * (0.10 + r() * 0.28), cz = Math.sin(az) * (0.10 + r() * 0.28);
    pad(cx, 0.02, cz, w, h, az + 0.4, (r() - 0.5) * 0.5);
    const kids = 1 + ((r() * 2.4) | 0);
    for (let k = 0; k < kids; k++) {
      const w2 = w * (0.72 + r() * 0.25), h2 = w2 * (1.25 + r() * 0.4);
      const dx = (r() - 0.5) * w * 0.6;
      pad(cx + dx, h * 0.9 + 0.02, cz + (r() - 0.5) * w * 0.3, w2, h2, az + 0.4 + (r() - 0.5) * 1.4,
        (r() - 0.5) * 0.7);
      if (r() > 0.55) {
        pad(cx + dx * 1.4, h * 0.9 + h2 * 0.85, cz, w2 * 0.8, h2 * 0.8, az + (r() - 0.5) * 2.0, (r() - 0.5) * 0.8);
      }
    }
  }
  return { trunk: null, foliage: null, cactus: b.build(H, 1.5), H, R: 0.95 };
}

/** Trellised vine: gnarled stump, cordon along the row, and a hedge of leaf cards. */
function buildVine(seed, detail) {
  const r = rng(seed);
  const tb = new Builder(), fb = new Builder();
  const H = 1.5;
  const pts = [], rad = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    pts.push([Math.sin(t * 4 + seed) * 0.05, t * 0.62, Math.cos(t * 3 + seed) * 0.04]);
    rad.push(lerp(0.075, 0.045, t));
  }
  addTube(tb, pts, rad, detail ? 5 : 3, 0, 0.8);
  if (detail) {
    for (const s of [-1, 1]) {
      const cp = [], cr = [];
      for (let i = 0; i <= 2; i++) {
        const t = i / 2;
        cp.push([s * t * 1.05, 0.62 + t * 0.06, 0]);
        cr.push(lerp(0.045, 0.022, t));
      }
      addTube(tb, cp, cr, 4, r(), 0.7);
    }
  }
  const rect = slotRect('vine');
  const n = detail ? 46 : 9;
  const up = new THREE.Vector3(), right = new THREE.Vector3(), nn = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const x = (r() - 0.5) * 2.15;
    const y = 0.58 + Math.pow(r(), 0.75) * 0.92;
    const side = r() > 0.5 ? 1 : -1;
    const z = side * (0.06 + r() * 0.24);
    nn.set(0, 0.4, side).normalize();
    up.set((r() - 0.5) * 0.5, 1, side * 0.45).normalize();
    right.set(1, 0, (r() - 0.5) * 0.5).normalize();
    const s = detail ? 0.30 + r() * 0.16 : 0.85 + r() * 0.4;
    p.set(x, y - s * 0.45, z);
    addCard(fb, p, up, right, s * 1.1, s, rect, nn, r(), 0.10,
      clamp(0.55 + (y - 0.58) * 0.55 + Math.abs(z) * 0.9, 0.5, 1));
  }
  return { trunk: tb.build(H, 1.2), foliage: fb.build(H, 1.2), H, R: 1.3 };
}

/** Trellis post with its wires — one instance every third vine along a row. */
function buildPost(seed) {
  const b = new Builder();
  const H = 1.95;
  const box = (x0, y0, z0, x1, y1, z1, u0, v0, u1, v1) => {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
               [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 1, 2, 3, 0, 0, -1], [5, 4, 7, 6, 0, 0, 1], [4, 0, 3, 7, -1, 0, 0],
               [1, 5, 6, 2, 1, 0, 0], [3, 2, 6, 7, 0, 1, 0], [4, 5, 1, 0, 0, -1, 0]];
    for (const f of F) {
      const vs = [];
      for (let k = 0; k < 4; k++) {
        const p = P[f[k]];
        vs.push(b.v(p[0], p[1], p[2], f[4], f[5], f[6],
          k === 0 || k === 3 ? u0 : u1, k < 2 ? v0 : v1, 0, 0));
      }
      b.quad(vs[0], vs[1], vs[2], vs[3]);
    }
  };
  const w = 0.055;
  box(-w, 0, -w, w, H, w, 0.05, 0.05, 0.35, 0.95);
  for (const y of [0.78, 1.20, 1.60]) {
    box(-3.35, y, -0.006, 3.35, y + 0.012, 0.006, 0.42, 0.42, 0.52, 0.44);
  }
  void seed;
  return { trunk: b.build(H, 1.0), foliage: null, H, R: 3.4 };
}

/** Far-field stand impostor: two crossed elevations plus a plan view for the aerial shot. */
function buildStand(seed, kind) {
  const b = new Builder();
  const r = rng(seed);
  const H = 15 + r() * 4;
  const W = H * 1.55;
  const rect = kind === 'pine' ? STAND_RECT.pine : STAND_RECT.oak;
  // A single quad in the XY plane, pivoted on its bottom edge. The material billboards it
  // in the vertex shader, so it faces the camera from the seat and lies over toward it from
  // the air — one draw, always full-face, and it never shows an edge-on sliver.
  const hw = W * 0.5;
  const v = (x, y, u, vv, ao) => b.v(x, y, 0, 0, 1, 0, u, vv, r(), 0.02, ao);
  b.quad(v(-hw, 0, rect[0], rect[1], 0.72), v(hw, 0, rect[2], rect[1], 0.72),
         v(hw, H, rect[2], rect[3], 1.0), v(-hw, H, rect[0], rect[3], 1.0));
  return { trunk: null, foliage: b.build(H, 2.4), H, R: W * 0.6 };
}

/* ============================================================ world rasters === */

const CLS = { NONE: 0, BARREN: 1, GRASS: 2, CROP: 3, SHRUB: 4, FOREST: 5, FARM: 6, ORCHARD: 7, URBAN: 8 };

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function pathTo(ctx, f, k, o) {
  for (const path of f.paths || []) {
    if (!path || path.length < 2) continue;
    ctx.moveTo(path[0][0] * k + o, path[0][1] * k + o);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0] * k + o, path[i][1] * k + o);
    if (f.poly) ctx.closePath();
  }
}

/** Land-cover / land-use class per texel, resolved by priority (later draws win). */
function buildCoverMap(world, size) {
  const out = new Uint8Array(size * size);
  const cv = makeCanvas(size, size);
  if (!cv) return out;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  const k = size / world.extent, o = size * 0.5;
  const paint = (features, accept, id) => {
    ctx.fillStyle = `rgb(${id * 28},0,0)`;
    for (const f of features || []) {
      if (!f.poly || !accept(f)) continue;
      ctx.beginPath(); pathTo(ctx, f, k, o); ctx.fill();
    }
  };
  const lc = world.landcover || [], lu = world.landuse || [];
  paint(lc, f => f.sub === 'barren', CLS.BARREN);
  paint(lc, f => f.sub === 'grass', CLS.GRASS);
  paint(lc, f => f.sub === 'crop', CLS.CROP);
  paint(lc, f => f.sub === 'shrub', CLS.SHRUB);
  paint(lu, f => f.cls === 'farmland' || f.cls === 'meadow' || f.cls === 'allotments', CLS.FARM);
  paint(lc, f => f.sub === 'forest', CLS.FOREST);
  paint(lu, f => f.cls === 'orchard' || f.cls === 'vineyard' || f.cls === 'farmyard', CLS.ORCHARD);
  paint(lc, f => f.sub === 'urban', CLS.URBAN);
  paint(lu, f => f.cls === 'residential' || f.cls === 'cemetery' || f.cls === 'pitch', CLS.URBAN);
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0, n = size * size; i < n; i++) out[i] = Math.round(d[i * 4] / 28);
  return out;
}

const ROAD_W = { secondary: 7.5, residential: 6.0, track: 4.5, path: 1.8, footway: 1.5, service: 5.0 };

/**
 * Exclusion map. 255 = nothing grows (carriageway, building footprint, stream bed);
 * 128 = verge, where only the low ground layer is allowed.
 */
function buildBlockMap(world, size, opts) {
  const out = new Uint8Array(size * size);
  const cv = makeCanvas(size, size);
  if (!cv) return out;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  const k = size / world.extent, o = size * 0.5;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const stroke = (features, wf, shade) => {
    ctx.strokeStyle = shade;
    for (const f of features || []) {
      ctx.lineWidth = Math.max(1, wf(f) * k);
      ctx.beginPath(); pathTo(ctx, f, k, o); ctx.stroke();
    }
  };
  const treeClear = opts.roadClear ?? 3.2;
  // verge first, then the hard block on top
  stroke(world.roads, f => (f.width || ROAD_W[f.cls] || ROAD_W[f.sub] || 4) + treeClear * 2, '#808080');
  stroke(world.water, () => 6, '#808080');
  ctx.fillStyle = '#808080';
  for (const b of world.buildings || []) {
    ctx.beginPath();
    for (const ring of b.rings || []) {
      if (!ring || ring.length < 3) continue;
      ctx.moveTo(ring[0][0] * k + o, ring[0][1] * k + o);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] * k + o, ring[i][1] * k + o);
      ctx.closePath();
    }
    ctx.fill();
    ctx.lineWidth = Math.max(1, (opts.buildingClear ?? 3.0) * 2 * k);
    ctx.strokeStyle = '#808080'; ctx.stroke();
  }
  stroke(world.roads, f => (f.width || ROAD_W[f.cls] || ROAD_W[f.sub] || 4) + 1.2, '#ffffff');
  ctx.fillStyle = '#ffffff';
  for (const b of world.buildings || []) {
    ctx.beginPath();
    for (const ring of b.rings || []) {
      if (!ring || ring.length < 3) continue;
      ctx.moveTo(ring[0][0] * k + o, ring[0][1] * k + o);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] * k + o, ring[i][1] * k + o);
      ctx.closePath();
    }
    ctx.fill();
  }
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0, n = size * size; i < n; i++) out[i] = d[i * 4];
  return out;
}

/* --------------------------------------------------------- polygon helpers ---- */

function polyArea(paths) {
  let A = 0;
  for (const p of paths) for (let i = 0, l = p.length; i < l; i++) {
    const a = p[i], b = p[(i + 1) % l];
    A += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(A * 0.5);
}

function pointInPoly(paths, x, z) {
  let inside = false;
  for (const p of paths) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Principal axis of a polygon's outline — orchard rows follow the field, not the compass. */
function principalAxis(paths) {
  let cx = 0, cz = 0, n = 0;
  for (const p of paths) for (const v of p) { cx += v[0]; cz += v[1]; n++; }
  if (!n) return { cx: 0, cz: 0, ang: 0 };
  cx /= n; cz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of paths) for (const v of p) {
    const dx = v[0] - cx, dz = v[1] - cz;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  return { cx, cz, ang: 0.5 * Math.atan2(2 * sxz, sxx - szz) };
}

/* ================================================================= system ==== */

const NEAR_TREE = 82;     // metres: full-mesh radius for trees at quality 1
const MID_TREE = 330;     // metres: card-cluster radius
const STAND_MIN = 300;    // metres: where the far-field stand impostors take over
const STAND_MAX = 1500;

export function createVegetation(engine, world, opts = {}) {
  try {
    return build(engine, world, opts);
  } catch (e) {
    console.error('[vegetation] disabled after an error:', e);
    const group = new THREE.Group();
    group.name = 'vegetation';
    engine?.scene?.add(group);
    return { group, update() {}, setQuality() {}, stats: () => ({ error: String(e && e.message || e) }) };
  }
}

function build(engine, world, opts) {
  const quality = clamp(opts.quality ?? 1, 0.15, 1.5);
  const group = new THREE.Group();
  group.name = 'vegetation';
  group.matrixAutoUpdate = false;

  /* ---- art ------------------------------------------------------------------ */
  const wind = createWindUniforms({ direction: opts.windDir ?? 2.05, strength: opts.wind ?? 1.0 });
  const atlas = buildFoliageAtlas(quality < 0.5 ? 256 : 384);
  const stands = buildStandSheet(quality < 0.5 ? 192 : 256);
  const barks = {
    pine:    buildBarkTexture('plated', [148, 116, 92], 256, 3),
    cypress: buildBarkTexture('fibrous', [122, 96, 74], 256, 7),
    olive:   buildBarkTexture('fluted', [176, 170, 152], 256, 11),
    oak:     buildBarkTexture('fibrous', [124, 116, 100], 256, 17),
    almond:  buildBarkTexture('fibrous', [150, 140, 124], 256, 23),
    palm:    buildBarkTexture('ringed', [148, 122, 88], 256, 29),
    wood:    buildBarkTexture('fibrous', [140, 116, 84], 128, 31),
  };
  const cactusTex = buildCactusTexture(192, 55);
  if (!atlas || !stands) throw new Error('no 2D canvas available for foliage art');

  const foliage = (name, o) => createFoliageMaterial(atlas, wind, { name: 'veg-' + name, ...o });
  const mats = {
    pine:      foliage('pine', { color: 0x9fba86, bend: 0.30, flutter: 1.0, translucency: 0.5, roughness: 0.9 }),
    pine2:     foliage('pine2', { color: 0xb4c898, bend: 0.34, flutter: 1.1, translucency: 0.6, roughness: 0.9 }),
    cypress:   foliage('cypress', { color: 0x8fae7c, bend: 0.16, flutter: 0.6, translucency: 0.35 }),
    oak:       foliage('oak', { color: 0xa8bf8c, bend: 0.24, flutter: 1.1, translucency: 0.6 }),
    terebinth: foliage('terebinth', { color: 0xc4d0a0, bend: 0.26, flutter: 1.2, translucency: 0.72 }),
    olive:     foliage('olive', { color: 0xc2c8b4, bend: 0.22, flutter: 1.3, translucency: 0.8, roughness: 0.8 }),
    almond:    foliage('almond', { color: 0xbcc894, bend: 0.26, flutter: 1.3, translucency: 0.75 }),
    palm:      foliage('palm', { color: 0xb0c088, bend: 0.20, flutter: 1.5, translucency: 0.8 }),
    shrub:     foliage('shrub', { color: 0xc0c4a4, bend: 0.14, flutter: 1.0, translucency: 0.5 }),
    broom:     foliage('broom', { color: 0xb6c493, bend: 0.22, flutter: 1.4, translucency: 0.7 }),
    thistle:   foliage('thistle', { color: 0xd6cca8, bend: 0.16, flutter: 1.1, translucency: 0.85 }),
    grass:     foliage('grass', { color: 0xd8c894, bend: 0.24, flutter: 1.6, translucency: 0.95, gustScale: 0.055, alphaTest: 0.30 }),
    wheat:     foliage('wheat', { color: 0xdcc894, bend: 0.26, flutter: 1.5, translucency: 0.95, gustScale: 0.055, alphaTest: 0.30 }),
    vine:      foliage('vine', { color: 0x9fbc7a, bend: 0.10, flutter: 1.2, translucency: 0.7 }),
    stand:     createFoliageMaterial(stands, wind, { name: 'veg-stand', color: 0xa4b892, bend: 0.06, flutter: 0.15, translucency: 0.30, alphaTest: 0.42, billboard: true }),
  };
  const barkMats = {
    pine:    createBarkMaterial(barks.pine, wind, { name: 'bark-pine', color: 0xd8c0a4, bend: 0.16 }),
    cypress: createBarkMaterial(barks.cypress, wind, { name: 'bark-cypress', color: 0xc0a68c, bend: 0.08 }),
    olive:   createBarkMaterial(barks.olive, wind, { name: 'bark-olive', color: 0xd6d2c4, bend: 0.10 }),
    oak:     createBarkMaterial(barks.oak, wind, { name: 'bark-oak', color: 0xbdb4a4, bend: 0.12 }),
    almond:  createBarkMaterial(barks.almond, wind, { name: 'bark-almond', color: 0xc8bcac, bend: 0.14 }),
    palm:    createBarkMaterial(barks.palm, wind, { name: 'bark-palm', color: 0xc2a684, bend: 0.10 }),
    wood:    createBarkMaterial(barks.wood, wind, { name: 'bark-wood', color: 0xb49478, bend: 0.02 }),
  };
  const cactusMat = createCactusMaterial(cactusTex, wind);

  /* ---- species table --------------------------------------------------------- */
  // Each species owns two LOD slots; slot 0 is the near mesh, slot 1 the card cluster.
  const species = {};
  const VARIANTS = 1;

  function defSpecies(name, cfg) {
    const s = {
      name, tint: cfg.tint || null, shadow: cfg.shadow !== false,
      r0: cfg.r0 ?? NEAR_TREE, r1: cfg.r1 ?? MID_TREE, radius: 1, lods: [],
    };
    for (let l = 0; l < cfg.lodMax.length; l++) {
      const max = Math.max(4, Math.round(cfg.lodMax[l] * (0.35 + 0.65 * quality)));
      const mat = new Float32Array(max * 16);
      const col = new Float32Array(max * 3);
      const matAttr = new THREE.InstancedBufferAttribute(mat, 16);
      const colAttr = new THREE.InstancedBufferAttribute(col, 3);
      matAttr.setUsage(THREE.DynamicDrawUsage); colAttr.setUsage(THREE.DynamicDrawUsage);
      const meshes = [];
      const parts = cfg.build(l === 0 ? 1 : 0);
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, max);
        im.instanceMatrix = matAttr;
        im.instanceColor = colAttr;
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = !!(cfg.shadow !== false && l === 0);
        im.receiveShadow = true;
        im.name = `veg-${name}-lod${l}-${part.tag}`;
        if (part.mat.userData.depthMaterial) im.customDepthMaterial = part.mat.userData.depthMaterial;
        group.add(im);
        meshes.push(im);
      }
      s.radius = Math.max(s.radius, parts.radius || 1);
      s.lods.push({ max, mat, col, matAttr, colAttr, meshes, n: 0 });
    }
    species[name] = s;
    return s;
  }

  /** Build `VARIANTS` merged variants of a species and pack them into a single geometry set. */
  function variantParts(maker, seed, detail, matFol, matBark, tag) {
    // merge the variants into one geometry so a species is a single draw call per LOD; the
    // per-instance look then comes from scale, yaw and instance colour.
    const fols = [], trunks = [];
    let R = 1;
    for (let v = 0; v < VARIANTS; v++) {
      const t = maker(seed + v * 997, detail);
      if (t.foliage) fols.push(t.foliage);
      if (t.trunk) trunks.push(t.trunk);
      R = Math.max(R, t.R || 1, (t.H || 1) * 0.5);
    }
    const parts = [];
    const pick = arr => arr[0];   // one representative variant per species per LOD
    if (trunks.length && matBark) parts.push({ geo: pick(trunks), mat: matBark, tag: tag + '-bark' });
    if (fols.length) parts.push({ geo: pick(fols), mat: matFol, tag: tag + '-leaf' });
    parts.radius = R;
    for (let i = 1; i < trunks.length; i++) trunks[i].dispose();
    for (let i = 1; i < fols.length; i++) fols[i].dispose();
    return parts;
  }

  const T = (maker, matFol, matBark) => d => variantParts(maker, 1000 + maker.name.length * 37, d, matFol, matBark, 't');

  defSpecies('pine', { lodMax: [340, 1100], build: d => variantParts(buildPine, 1400, d, mats.pine, barkMats.pine, 'pine') });
  defSpecies('pine2', { lodMax: [300, 1000], build: d => variantParts(buildPine, 3187, d, mats.pine2, barkMats.pine, 'pine2') });
  defSpecies('cypress', { lodMax: [300, 900], build: T(buildCypress, mats.cypress, barkMats.cypress) });
  defSpecies('oak', { lodMax: [260, 800], build: d => variantParts(buildOak, 2200, d, mats.oak, barkMats.oak, 'oak') });
  defSpecies('terebinth', { lodMax: [200, 600], build: T(buildTerebinth, mats.terebinth, barkMats.oak) });
  defSpecies('olive', { lodMax: [520, 1600], build: T(buildOlive, mats.olive, barkMats.olive) });
  defSpecies('almond', { lodMax: [240, 700], build: T(buildAlmond, mats.almond, barkMats.almond) });
  defSpecies('palm', { lodMax: [40, 110], build: T(buildPalm, mats.palm, barkMats.palm) });
  defSpecies('oakBush', {
    lodMax: [420, 700], r0: 70, r1: 170,
    build: d => variantParts((s, dd) => buildOak(s, dd, true), 3300, d, mats.oak, barkMats.oak, 'bush'),
  });
  defSpecies('shrub', {
    lodMax: [1500, 2200], r0: 62, r1: 150, shadow: false,
    build: d => variantParts((s, dd) => buildShrub(s, dd, 'sage'), 4400, d, mats.shrub, null, 'sage'),
  });
  defSpecies('broom', {
    lodMax: [520, 800], r0: 62, r1: 150, shadow: false,
    build: d => variantParts((s, dd) => buildShrub(s, dd, 'broom'), 5500, d, mats.broom, null, 'broom'),
  });
  defSpecies('thistle', {
    lodMax: [1400, 1800], r0: 48, r1: 120, shadow: false,
    build: d => variantParts(buildThistle, 6600, d, mats.thistle, null, 'thistle'),
  });
  defSpecies('grass', {
    lodMax: [8000, 4200], r0: 34, r1: 78, shadow: false,
    build: d => variantParts((s) => buildTuft(s, 'grass', d === 0), 7700, d, mats.grass, null, 'grass'),
  });
  defSpecies('wheat', {
    lodMax: [8000, 4200], r0: 34, r1: 78, shadow: false,
    build: d => variantParts((s) => buildTuft(s, 'wheat', d === 0), 8800, d, mats.wheat, null, 'wheat'),
  });
  defSpecies('vine', {
    lodMax: [900, 1400], r0: 55, r1: 190,
    build: d => variantParts(buildVine, 9900, d, mats.vine, barkMats.wood, 'vine'),
  });
  defSpecies('post', {
    lodMax: [260, 420], r0: 55, r1: 190,
    build: d => variantParts(buildPost, 10100, d, null, barkMats.wood, 'post'),
  });
  defSpecies('prickly', {
    lodMax: [280, 0], r0: 90, r1: 90,
    build: () => {
      const p = buildPrickly(12100);
      const parts = [{ geo: p.cactus, mat: cactusMat, tag: 'pad' }];
      parts.radius = p.R;
      return parts;
    },
  });
  defSpecies('standPine', {
    lodMax: [0, 5200], r0: 0, r1: STAND_MAX, shadow: false,
    build: d => variantParts((s) => buildStand(s, 'pine'), 13100, d, mats.stand, null, 'stand'),
  });
  defSpecies('standOak', {
    lodMax: [0, 2600], r0: 0, r1: STAND_MAX, shadow: false,
    build: d => variantParts((s) => buildStand(s, 'oak'), 14100, d, mats.stand, null, 'stand'),
  });

  /* ---- rasters ---------------------------------------------------------------- */
  const COV = opts.coverSize ?? 1024, BLK = opts.blockSize ?? 1536;
  const cover = buildCoverMap(world, COV);
  const block = buildBlockMap(world, BLK, opts);
  const half = world.extent * 0.5;
  const covK = COV / world.extent, blkK = BLK / world.extent;

  function coverAt(x, z) {
    const i = ((x + half) * covK) | 0, j = ((z + half) * covK) | 0;
    if (i < 0 || j < 0 || i >= COV || j >= COV) return CLS.NONE;
    return cover[j * COV + i];
  }
  /**
   * Overture polygon boundaries are surveyor-straight; a real forest edge is not. Jittering
   * the class lookup by a few metres per cell feathers every boundary into a broken margin
   * without any extra data.
   */
  function coverNear(x, z, i, j, amp) {
    return coverAt(x + (hash2i(i, j, 911) - 0.5) * amp, z + (hash2i(i, j, 1723) - 0.5) * amp);
  }
  function blockAt(x, z) {
    const i = ((x + half) * blkK) | 0, j = ((z + half) * blkK) | 0;
    if (i < 0 || j < 0 || i >= BLK || j >= BLK) return 255;
    return block[j * BLK + i];
  }

  /* ---- planted rows: orchards, vineyards, windbreaks --------------------------- */
  // Static, deterministic, and aligned to each field's own principal axis.
  const planted = [];      // { sp, x, z, y, yaw, s, tint }
  const plantedCount = {};
  const sites = [];        // { kind, x, z, n } — where each field was planted, for camera work

  function plantRows(f, kind, seed) {
    const ax = principalAxis(f.paths);
    const r = rng(seed);
    const spec = {
      olive:    { sp: 'olive', du: 8.0, dv: 7.0, jit: 0.9, s: [0.85, 1.2] },
      almond:   { sp: 'almond', du: 6.2, dv: 5.6, jit: 0.8, s: [0.85, 1.2] },
      vineyard: { sp: 'vine', du: 2.2, dv: 3.0, jit: 0.10, s: [0.9, 1.1] },
    }[kind];
    if (!spec) return;
    let bbx0 = Infinity, bbx1 = -Infinity, bbz0 = Infinity, bbz1 = -Infinity;
    for (const p of f.paths) for (const v of p) {
      bbx0 = Math.min(bbx0, v[0]); bbx1 = Math.max(bbx1, v[0]);
      bbz0 = Math.min(bbz0, v[1]); bbz1 = Math.max(bbz1, v[1]);
    }
    const rad = Math.hypot(bbx1 - bbx0, bbz1 - bbz0) * 0.5 + 4;
    const ca = Math.cos(ax.ang), sa = Math.sin(ax.ang);
    const rowYaw = -ax.ang;
    let n = 0;
    for (let v = -rad; v <= rad; v += spec.dv) {
      for (let u = -rad; u <= rad; u += spec.du) {
        const ju = (r() - 0.5) * spec.jit, jv = (r() - 0.5) * spec.jit * 0.4;
        const x = ax.cx + (u + ju) * ca - (v + jv) * sa;
        const z = ax.cz + (u + ju) * sa + (v + jv) * ca;
        if (!world.inBounds(x, z) || !pointInPoly(f.paths, x, z)) continue;
        if (blockAt(x, z) > 60) continue;
        if (world.slopeAt(x, z) > 0.55) continue;
        planted.push({ sp: spec.sp, x, z, yaw: kind === 'vineyard' ? rowYaw : r() * TAU,
          s: lerp(spec.s[0], spec.s[1], r()), tint: r() });
        n++;
        if (kind === 'vineyard' && n % 3 === 1) {
          planted.push({ sp: 'post', x, z, yaw: rowYaw, s: 1, tint: 0.5 });
        }
        if (planted.length > 26000) return;
      }
    }
    plantedCount[kind] = (plantedCount[kind] || 0) + n;
    if (n > 6) sites.push({ kind, x: +ax.cx.toFixed(1), z: +ax.cz.toFixed(1), yaw: +rowYaw.toFixed(3), n });
  }

  /** A line of cypress along the longest edge of a field — the classic windbreak. */
  function plantWindbreak(f, seed) {
    const r = rng(seed);
    let best = null, bestLen = 0;
    for (const p of f.paths) {
      for (let i = 0; i < p.length - 1; i++) {
        const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
        if (L > bestLen) { bestLen = L; best = [p[i], p[i + 1]]; }
      }
    }
    if (!best || bestLen < 34) return 0;
    const dx = (best[1][0] - best[0][0]) / bestLen, dz = (best[1][1] - best[0][1]) / bestLen;
    // shove the line a couple of metres inside the field
    const nx = -dz * 2.4, nz = dx * 2.4;
    let n = 0;
    for (let t = 3; t < bestLen - 3; t += 3.4 + r() * 0.5) {
      const x = best[0][0] + dx * t + nx, z = best[0][1] + dz * t + nz;
      if (!world.inBounds(x, z) || blockAt(x, z) > 60) continue;
      planted.push({ sp: 'cypress', x, z, yaw: r() * TAU, s: 0.82 + r() * 0.4, tint: r() });
      n++;
    }
    plantedCount.windbreak = (plantedCount.windbreak || 0) + n;
    return n;
  }

  {
    const lu = world.landuse || [];
    let idx = 0;
    for (const f of lu) {
      if (!f.poly || !f.paths?.length) continue;
      idx++;
      const A = polyArea(f.paths);
      const cen = principalAxis(f.paths);
      if (Math.hypot(cen.cx, cen.cz) > (opts.plantRadius ?? 1250)) continue;
      const pick = hash2i(idx * 13, idx * 7, 999);
      if (f.cls === 'orchard') {
        plantRows(f, pick > 0.34 ? 'olive' : 'almond', 4000 + idx);
        plantWindbreak(f, 5000 + idx);
      } else if (f.cls === 'farmland' && A < 21000) {
        // small fields around the moshav are the ones actually under trees or vines
        const kind = pick < 0.34 ? 'vineyard' : pick < 0.70 ? 'olive' : 'almond';
        plantRows(f, kind, 4000 + idx);
        if (pick > 0.45) plantWindbreak(f, 5000 + idx);
      } else if (f.cls === 'farmland' && A < 110000 && pick > 0.72) {
        plantRows(f, 'olive', 4000 + idx);
        plantWindbreak(f, 5000 + idx);
      } else if (f.cls === 'farmyard') {
        plantWindbreak(f, 5000 + idx);
        // a couple of date palms by the farmyard gate
        const rr = rng(6000 + idx);
        for (let i = 0; i < 2; i++) {
          const x = cen.cx + (rr() - 0.5) * 26, z = cen.cz + (rr() - 0.5) * 26;
          if (world.inBounds(x, z) && blockAt(x, z) < 60)
            planted.push({ sp: 'palm', x, z, yaw: rr() * TAU, s: 0.85 + rr() * 0.4, tint: rr() });
        }
      }
    }
  }
  for (const p of planted) p.y = world.heightAt(p.x, p.z);

  /* ---- natural scatter --------------------------------------------------------- */
  // Grid A: trees. Grid B: bushes. Grid C: the ground layer. Grid D: far-field stands.
  const TREE_MIX = {
    [CLS.FOREST]: [['pine', 0.40], ['pine2', 0.29], ['oak', 0.13], ['terebinth', 0.08], ['cypress', 0.03], ['olive', 0.02], ['pine', 1]],
    [CLS.SHRUB]:  [['oak', 0.30], ['terebinth', 0.22], ['pine', 0.16], ['pine2', 0.14], ['olive', 0.10], ['cypress', 0.08]],
    [CLS.GRASS]:  [['oak', 0.30], ['pine', 0.14], ['pine2', 0.12], ['terebinth', 0.16], ['olive', 0.20], ['cypress', 0.08]],
    [CLS.BARREN]: [['pine', 0.2], ['pine2', 0.2], ['oak', 0.6]],
    [CLS.CROP]:   [['olive', 0.6], ['almond', 0.4]],
    [CLS.FARM]:   [['olive', 0.5], ['almond', 0.3], ['cypress', 0.2]],
    [CLS.ORCHARD]:[['olive', 0.7], ['almond', 0.3]],
  };
  const TREE_DENS = {
    [CLS.FOREST]: 0.93, [CLS.SHRUB]: 0.15, [CLS.GRASS]: 0.030, [CLS.CROP]: 0.006,
    [CLS.BARREN]: 0.020, [CLS.FARM]: 0.006, [CLS.ORCHARD]: 0.0, [CLS.URBAN]: 0.0, [CLS.NONE]: 0.012,
  };
  const BUSH_MIX = {
    [CLS.FOREST]: [['shrub', 0.52], ['oakBush', 0.22], ['broom', 0.16], ['thistle', 0.10]],
    [CLS.SHRUB]:  [['shrub', 0.38], ['oakBush', 0.26], ['broom', 0.16], ['thistle', 0.14], ['prickly', 0.06]],
    [CLS.GRASS]:  [['thistle', 0.46], ['shrub', 0.30], ['broom', 0.12], ['oakBush', 0.08], ['prickly', 0.04]],
    [CLS.BARREN]: [['thistle', 0.48], ['shrub', 0.40], ['prickly', 0.12]],
    [CLS.CROP]:   [['thistle', 0.82], ['shrub', 0.18]],
    [CLS.FARM]:   [['thistle', 0.80], ['shrub', 0.20]],
    [CLS.ORCHARD]:[['thistle', 0.7], ['shrub', 0.3]],
    [CLS.NONE]:   [['thistle', 0.6], ['shrub', 0.4]],
  };
  const BUSH_DENS = {
    [CLS.FOREST]: 0.30, [CLS.SHRUB]: 0.70, [CLS.GRASS]: 0.16, [CLS.CROP]: 0.030,
    [CLS.BARREN]: 0.14, [CLS.FARM]: 0.022, [CLS.ORCHARD]: 0.05, [CLS.URBAN]: 0.0, [CLS.NONE]: 0.05,
  };
  const GROUND_DENS = {
    [CLS.FOREST]: 0.34, [CLS.SHRUB]: 0.52, [CLS.GRASS]: 0.86, [CLS.CROP]: 0.92,
    [CLS.BARREN]: 0.16, [CLS.FARM]: 0.90, [CLS.ORCHARD]: 0.62, [CLS.URBAN]: 0.18, [CLS.NONE]: 0.42,
  };

  function pickFrom(list, u) {
    let acc = 0;
    for (const [name, w] of list) { acc += w; if (u <= acc) return name; }
    return list[list.length - 1][0];
  }

  /* ---- instance packing --------------------------------------------------------- */
  const state = {
    quality, lodScale: 1, lastCam: new THREE.Vector3(1e9, 1e9, 1e9),
    lastQuat: new THREE.Quaternion(9, 9, 9, 9), frame: 0, dirty: true,
    counts: {}, packMs: 0,
  };
  const planes = [];
  for (let i = 0; i < 6; i++) planes.push(new THREE.Plane());
  const _frustum = new THREE.Frustum();
  const _pm = new THREE.Matrix4();

  function visible(x, y, z, rad) {
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -rad) return false;
    }
    return true;
  }

  const tintCol = new THREE.Color();
  function emit(sp, lod, x, y, z, yaw, sx, sy, sz, tint, lean) {
    const S = species[sp];
    if (!S) return;
    const L = S.lods[lod];
    if (!L || L.n >= L.max) return;
    const o = L.n * 16, m = L.mat;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
    if (lean) {
      m[o + 4] = lean[0] * sy; m[o + 5] = lean[1] * sy; m[o + 6] = lean[2] * sy; m[o + 7] = 0;
    } else {
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    }
    m[o + 8] = s * sz; m[o + 9] = 0; m[o + 10] = c * sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const co = L.n * 3;
    // late-summer colour drift: drier and paler toward the yellow end
    const t = tint;
    tintCol.setRGB(0.86 + t * 0.30, 0.90 + t * 0.20 - 0.04, 0.80 + t * 0.24);
    L.col[co] = tintCol.r; L.col[co + 1] = tintCol.g; L.col[co + 2] = tintCol.b;
    L.n++;
  }

  const TREE_CELL = 7.0, BUSH_CELL = 3.4, GROUND_CELL = 1.25, STAND_CELL = 19.0;

  function scatterGrid(cell, radius, camX, camZ, fn, seed) {
    const i0 = Math.floor((camX - radius) / cell), i1 = Math.ceil((camX + radius) / cell);
    const j0 = Math.floor((camZ - radius) / cell), j1 = Math.ceil((camZ + radius) / cell);
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const hx = hash2i(i, j, seed), hz = hash2i(i, j, seed + 1013);
        const x = (i + hx) * cell, z = (j + hz) * cell;
        const dx = x - camX, dz = z - camZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        fn(i, j, x, z, Math.sqrt(d2));
      }
    }
  }

  function repack() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const k in species) for (const L of species[k].lods) L.n = 0;

    const cam = engine.camera;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    for (let i = 0; i < 6; i++) planes[i].copy(_frustum.planes[i]);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const q = state.lodScale;

    // --- trees -----------------------------------------------------------------
    const treeR = MID_TREE * q;
    scatterGrid(TREE_CELL, treeR, cx, cz, (i, j, x, z, d) => {
      const cls = coverNear(x, z, i, j, 16);
      const dens = TREE_DENS[cls] ?? 0;
      if (dens <= 0) return;
      if (hash2i(i, j, 5011) > dens) return;
      if (blockAt(x, z) > 60) return;
      const slope = world.slopeAt(x, z);
      if (slope > 0.62) return;
      const y = world.heightAt(x, z);
      const lod = d < NEAR_TREE * q ? 0 : 1;
      const mix = TREE_MIX[cls] || TREE_MIX[CLS.SHRUB];
      const sp = pickFrom(mix, hash2i(i, j, 6079));
      const S = species[sp];
      const sc = 0.72 + hash2i(i, j, 7013) * 0.62;
      if (!visible(x, y + S.radius, z, S.radius * sc * 1.6)) return;
      emit(sp, lod, x, y - 0.18, z, hash2i(i, j, 8017) * TAU,
        sc * (0.92 + hash2i(i, j, 9007) * 0.16), sc, sc * (0.92 + hash2i(i, j, 9209) * 0.16),
        hash2i(i, j, 6101));
    }, 3001);

    // --- bushes ----------------------------------------------------------------
    const bushR = 165 * q;
    scatterGrid(BUSH_CELL, bushR, cx, cz, (i, j, x, z, d) => {
      const cls = coverNear(x, z, i, j, 12);
      const dens = BUSH_DENS[cls] ?? 0;
      if (dens <= 0) return;
      if (hash2i(i, j, 4013) > dens) return;
      const bl = blockAt(x, z);
      if (bl > 200) return;
      const mix = BUSH_MIX[cls] || BUSH_MIX[CLS.NONE];
      let sp = pickFrom(mix, hash2i(i, j, 4211));
      if (bl > 60) sp = 'thistle';                            // road verge: only weeds
      const S = species[sp];
      if (d > S.r1 * q) return;
      const y = world.heightAt(x, z);
      const sc = 0.7 + hash2i(i, j, 4409) * 0.8;
      if (!visible(x, y + S.radius, z, S.radius * sc * 1.7)) return;
      const lod = d < S.r0 * q || sp === 'prickly' ? 0 : 1;
      const lx = (hash2i(i, j, 4507) - 0.5) * 0.22, lz = (hash2i(i, j, 4517) - 0.5) * 0.22;
      emit(sp, lod, x, y - 0.05, z, hash2i(i, j, 4703) * TAU, sc, sc, sc,
        hash2i(i, j, 4801), [lx, Math.sqrt(Math.max(0.2, 1 - lx * lx - lz * lz)), lz]);
    }, 2003);

    // --- ground layer ------------------------------------------------------------
    const gNear = species.grass.r0 * q, gFar = species.grass.r1 * q;
    scatterGrid(GROUND_CELL, gFar, cx, cz, (i, j, x, z, d) => {
      const cls = coverNear(x, z, i, j, 8);
      const dens = GROUND_DENS[cls] ?? 0;
      if (dens <= 0) return;
      const coarse = ((i * 3 + j * 7) & 3) === 0;
      const lod = d < gNear ? 0 : 1;
      if (lod === 1 && !coarse) return;              // thin out with distance, same cells
      if (hash2i(i, j, 2011) > dens) return;
      if (blockAt(x, z) > 200) return;
      const sp = (cls === CLS.CROP || cls === CLS.FARM) ? 'wheat' : 'grass';
      const y = world.heightAt(x, z);
      if (!visible(x, y + 0.3, z, 1.2)) return;
      const sc = 0.72 + hash2i(i, j, 2213) * 0.72;
      const lx = (hash2i(i, j, 2311) - 0.5) * 0.30, lz = (hash2i(i, j, 2411) - 0.5) * 0.30;
      emit(sp, lod, x, y - 0.03, z, hash2i(i, j, 2503) * TAU, sc, sc, sc,
        hash2i(i, j, 2609), [lx, Math.sqrt(Math.max(0.2, 1 - lx * lx - lz * lz)), lz]);
    }, 1009);

    // --- far-field stands ---------------------------------------------------------
    const standFar = STAND_MAX * Math.min(1, 0.5 + q * 0.5);
    scatterGrid(STAND_CELL, standFar, cx, cz, (i, j, x, z, d) => {
      if (d < STAND_MIN * q) return;
      const cls = coverNear(x, z, i, j, 24);
      if (cls !== CLS.FOREST && cls !== CLS.SHRUB) return;
      if (hash2i(i, j, 8101) > (cls === CLS.FOREST ? 1.0 : 0.42)) return;
      const y = world.heightAt(x, z);
      // uniform scale only: the billboard basis is world-aligned, so anisotropy would shear it
      const sc = (cls === CLS.FOREST ? 0.85 : 0.62) + hash2i(i, j, 8209) * 0.42;
      if (!visible(x, y + 14 * sc, z, 24 * sc)) return;
      emit(cls === CLS.FOREST ? 'standPine' : 'standOak', 1, x, y - 1.6, z,
        0, sc, sc, sc, hash2i(i, j, 8521));
    }, 7001);

    // --- planted rows ---------------------------------------------------------------
    for (const p of planted) {
      const S = species[p.sp];
      if (!S) continue;
      const dx = p.x - cx, dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > S.r1 * q) continue;
      if (!visible(p.x, p.y + S.radius, p.z, S.radius * p.s * 1.7)) continue;
      const lod = d < S.r0 * q ? 0 : 1;
      emit(p.sp, lod, p.x, p.y - 0.12, p.z, p.yaw, p.s, p.s, p.s, p.tint);
    }

    // --- upload ----------------------------------------------------------------------
    const counts = state.counts;
    for (const k in species) {
      const S = species[k];
      let tot = 0;
      for (const L of S.lods) {
        tot += L.n;
        L.matAttr.needsUpdate = true;
        L.colAttr.needsUpdate = true;
        for (const m of L.meshes) m.count = L.n;
      }
      counts[k] = tot;
    }
    void cy;
    state.packMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  /* ---- frame loop ------------------------------------------------------------------ */
  const _q = new THREE.Quaternion();
  let lastElapsed = -1;

  const system = {
    update(dt, elapsed) {
      if (elapsed === lastElapsed) return;            // safe to call twice per frame
      lastElapsed = elapsed;
      wind.uTime.value = elapsed ?? (wind.uTime.value + (dt || 0.016));
      const lg = engine.lighting;
      if (lg?.sun) {
        wind.uSunDir.value.copy(lg.sun.position).normalize();
        wind.uSunColor.value.copy(lg.sun.color).multiplyScalar(Math.min(2.2, lg.sun.intensity) * 0.55);
      }
      const cam = engine.camera;
      cam.getWorldQuaternion(_q);
      const moved = cam.position.distanceToSquared(state.lastCam) > 36;
      const turned = Math.abs(_q.dot(state.lastQuat)) < 0.9993;
      state.frame++;
      if (state.dirty || moved || turned || (state.frame % 45) === 0) {
        state.lastCam.copy(cam.position);
        state.lastQuat.copy(_q);
        state.dirty = false;
        repack();
      }
    },
  };
  engine.scene.add(group);
  engine.add(system);
  // pack once immediately so the very first rendered frame is already dressed
  engine.camera.updateMatrixWorld(true);
  engine.camera.updateProjectionMatrix();
  repack();

  return {
    group,
    materials: mats,
    update: system.update,
    setQuality(t) {
      state.quality = clamp(t, 0.1, 1.5);
      state.lodScale = clamp(0.35 + state.quality * 0.75, 0.3, 1.35);
      state.dirty = true;
    },
    setWind(strength, direction) {
      if (strength != null) wind.uWindStrength.value = strength;
      if (direction != null) wind.uWindDir.value.set(Math.cos(direction), Math.sin(direction));
    },
    sites,
    stats() {
      const out = { planted: planted.length, packMs: +state.packMs.toFixed(2), draws: 0 };
      let live = 0;
      for (const k in species) {
        out[k] = state.counts[k] || 0;
        live += out[k];
        for (const L of species[k].lods) if (L.n) out.draws += L.meshes.length;
      }
      out.instances = live;
      out.rows = { ...plantedCount };
      return out;
    },
    dispose() {
      group.traverse(o => { if (o.isMesh) o.geometry?.dispose(); });
      engine.scene.remove(group);
    },
  };
}
