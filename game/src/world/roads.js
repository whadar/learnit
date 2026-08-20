/**
 * The road network of Moshav Amikam — every way in `world.roads` turned into a draped,
 * cambered ribbon with a procedurally authored surface.
 *
 * Each class gets its own material, built once at load into a cross-section texture: the U
 * axis runs *across* the road (clamped), so painted lines, tyre-polished wheel paths, ruts
 * and the ragged asphalt/gravel edge sit at exact metric positions instead of being noise
 * that happens to look like markings. V repeats every `vMetres` along the way.
 *
 *   secondary / tertiary  proper asphalt, white centre line + edge lines, patches, cracks
 *   residential           narrower village asphalt, no markings, heavily patched
 *   track                 pale limestone farm track, two wheel ruts, grass centre strip
 *   path / footway        packed earth footpath
 *
 *   const roads = createRoads(engine, world);          // whole network
 *   const roads = createRoads(engine, world, { track });  // ...minus what the circuit covers
 */
import * as THREE from 'three';
import { clamp, lerp, rng } from '../core/mathx.js';
import { hash2i } from '../render/materials/noise.js';

/* ================================================================= noise ==== */

const smooth5 = t => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise that tiles every (px, py) lattice cells. */
function vnoise(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth5(x - xi), fy = smooth5(y - yi);
  const wx = a => ((a % px) + px) % px, wy = a => ((a % py) + py) % py;
  const a = hash2i(wx(xi), wy(yi), seed), b = hash2i(wx(xi + 1), wy(yi), seed);
  const c = hash2i(wx(xi), wy(yi + 1), seed), d = hash2i(wx(xi + 1), wy(yi + 1), seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
function fbm(x, y, px, py, seed, oct = 4, gain = 0.5) {
  let s = 0, n = 0, a = 1, fx = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * fx, y * fx, Math.max(1, Math.round(px * fx)), Math.max(1, Math.round(py * fx)), seed + i * 131);
    n += a; a *= gain; fx *= 2;
  }
  return s / n;
}
/** Ridged fbm — the thin bright ridges make convincing crack networks. */
function ridged(x, y, px, py, seed, oct = 3) {
  let s = 0, n = 0, a = 1, f = 1;
  for (let i = 0; i < oct; i++) {
    const v = vnoise(x * f, y * f, Math.max(1, Math.round(px * f)), Math.max(1, Math.round(py * f)), seed + i * 977);
    s += a * (1 - Math.abs(v * 2 - 1)); n += a; a *= 0.55; f *= 2.1;
  }
  return s / n;
}

/* =============================================================== textures === */

function canvasTex(w, h, srgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const img = c.getContext('2d').createImageData(w, h);
  return { c, img, d: img.data, put() { this.c.getContext('2d').putImageData(this.img, 0, 0); }, srgb };
}
function toTexture(cv, srgb, aniso = 8) {
  cv.put();
  const t = new THREE.CanvasTexture(cv.c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Author one road cross-section.
 *
 * @param {object} p
 *   total     full ribbon width in metres (asphalt + shoulders) that U spans
 *   road      width of the hard surface in metres
 *   vMetres   metres of road per texture repeat along V
 *   kind      'asphalt' | 'dirt' | 'path' | 'race'
 *   centre    null | 'solid' | 'dash'   painted centre line
 *   edge      boolean                   painted edge lines
 */
export function buildRoadTextures(p) {
  const W = p.W || 192, H = p.H || 1024;
  const seed = p.seed | 0;
  const alb = canvasTex(W, H, true), nrm = canvasTex(W, H, false), rgh = canvasTex(W, H, false);
  const hgt = new Float32Array(W * H);
  const rn = new Float32Array(W * H);          // roughness
  const cr = new Float32Array(W * H), cg = new Float32Array(W * H), cb = new Float32Array(W * H);

  const half = p.total * 0.5, roadHalf = p.road * 0.5;
  const mx = p.total / W, my = p.vMetres / H;   // metres per texel

  // palette
  const dirtKind = p.kind === 'dirt' || p.kind === 'path';
  const base = p.kind === 'path' ? [0.40, 0.335, 0.245]
    : dirtKind ? [0.575, 0.515, 0.405]
      : [0.108, 0.106, 0.104];
  const shoulderCol = dirtKind ? [0.50, 0.455, 0.335] : [0.415, 0.375, 0.285];

  // a few random asphalt repairs, and the odd oil stain
  const polish = p.polish || (dirtKind
    ? [{ at: p.road * 0.27, w: 0.34 }]
    : [{ at: p.road * 0.265, w: 0.46 }]);
  const R = rng(seed * 7919 + 13);
  const patches = [];
  if (!dirtKind) for (let i = 0; i < 4; i++) {
    patches.push({ v: R() * p.vMetres, len: 1.4 + R() * 3.4, u: (R() - 0.5) * p.road * 0.75,
      wid: 1.0 + R() * 2.6, tone: 0.72 + R() * 0.5, seed: (R() * 1e6) | 0 });
  }
  const stains = [];
  if (!dirtKind) for (let i = 0; i < 6; i++) stains.push({ v: R() * p.vMetres, u: (R() - 0.5) * p.road * 0.4, r: 0.25 + R() * 0.6 });

  for (let j = 0; j < H; j++) {
    const V = j * my;                            // metres along
    for (let i = 0; i < W; i++) {
      const U = (i + 0.5) * mx - half;           // metres across, 0 = centreline
      const k = j * W + i;
      const au = Math.abs(U);

      // --- ragged hard-surface edge ---------------------------------------
      const wobble = (fbm(au * 0.9, V * 0.55, 8, 24, seed + 41, 3) - 0.5) * 0.55
        + (fbm(au * 4.0, V * 3.1, 16, 64, seed + 87, 2) - 0.5) * 0.18;
      const edgeAt = roadHalf + wobble;
      const onRoad = clamp((edgeAt - au) / 0.28 + 0.5, 0, 1);

      // --- base surface ----------------------------------------------------
      let r = base[0], g = base[1], b = base[2], rough = dirtKind ? 0.92 : 0.74, h = 0;

      if (dirtKind) {
        const dust = fbm(U * 0.85, V * 0.85, 12, 24, seed + 3, 5);
        const grit = fbm(U * 9.0, V * 9.0, 48, 128, seed + 19, 3);
        const tone = 0.80 + dust * 0.42 + (grit - 0.5) * 0.20;
        r *= tone; g *= tone * 0.99; b *= tone * 0.95;
        h = dust * 0.5 + grit * 0.35;
        // two compacted wheel ruts
        let rut = 0;
        for (const bd of polish) rut = Math.max(rut, Math.exp(-((au - bd.at) ** 2) / (2 * bd.w * bd.w)) * (bd.k ?? 1));
        r = lerp(r, r * 0.80, rut); g = lerp(g, g * 0.79, rut); b = lerp(b, b * 0.80, rut);
        rough -= rut * 0.16; h -= rut * 0.75;
        // grass / weed strip down the middle of a farm track
        if (p.kind === 'dirt') {
          const cen = Math.exp(-(U * U) / (2 * 0.52 * 0.52));
          const tuft = fbm(U * 7.0, V * 7.0, 40, 96, seed + 61, 3);
          const gr = clamp(cen * (tuft * 1.7 - 0.32), 0, 1);
          r = lerp(r, 0.255 + tuft * 0.10, gr); g = lerp(g, 0.275 + tuft * 0.13, gr); b = lerp(b, 0.118 + tuft * 0.05, gr);
          rough = lerp(rough, 0.97, gr); h += gr * 1.5;
        }
        // loose stones
        const st = vnoise(U * 6.2, V * 6.2, 34, 96, seed + 909);
        if (st > 0.90) { const q = (st - 0.90) * 10; r += q * 0.20; g += q * 0.19; b += q * 0.17; h += q * 1.3; }
      } else {
        // asphalt: fine aggregate + a coarse macro variation
        const agg = fbm(U * 26, V * 26, 96, 256, seed + 5, 3, 0.62);
        const macro = fbm(U * 0.6, V * 0.6, 6, 16, seed + 71, 4);
        const tone = 0.80 + macro * 0.50 + (agg - 0.5) * 0.42;
        r *= tone; g *= tone; b *= tone * 1.02;
        h = agg * 1.5 + macro * 0.5;
        rough = 0.66 + (agg - 0.5) * 0.22 + macro * 0.10;

        // tyre-polished wheel paths — the darkest, smoothest part of any road
        let pol = 0;
        for (const bd of polish) pol = Math.max(pol, Math.exp(-((au - bd.at) ** 2) / (2 * bd.w * bd.w)) * (bd.k ?? 1));
        r = lerp(r, r * 0.80, pol); g = lerp(g, g * 0.80, pol); b = lerp(b, b * 0.82, pol);
        rough -= pol * 0.26; h -= pol * 0.35;

        // repair patches with a seam around them
        for (const pa of patches) {
          let dv = Math.abs(V - pa.v); dv = Math.min(dv, p.vMetres - dv);
          const inV = clamp((pa.len - dv) / 0.22, 0, 1);
          const inU = clamp((pa.wid - Math.abs(U - pa.u)) / 0.22, 0, 1);
          const m = inU * inV;
          if (m <= 0) continue;
          const pt = pa.tone * (0.9 + fbm(U * 3, V * 3, 12, 32, pa.seed, 3) * 0.25);
          r = lerp(r, base[0] * pt, m); g = lerp(g, base[1] * pt, m); b = lerp(b, base[2] * pt, m);
          rough = lerp(rough, 0.80, m);
          const seam = m * (1 - m) * 4;
          r -= seam * 0.03; g -= seam * 0.03; b -= seam * 0.03; h -= seam * 0.9;
        }
        // crack network
        const cx = ridged(U * 1.5, V * 1.5, 10, 26, seed + 211, 3);
        const crack = clamp((cx - 0.80) * 7, 0, 1) * clamp(0.35 + macro, 0, 1);
        r = lerp(r, 0.052, crack); g = lerp(g, 0.050, crack); b = lerp(b, 0.050, crack);
        h -= crack * 2.2; rough = lerp(rough, 0.86, crack);
        // oil marks
        for (const s of stains) {
          let dv = Math.abs(V - s.v); dv = Math.min(dv, p.vMetres - dv);
          const d = Math.hypot((U - s.u) * 1.6, dv);
          const m = clamp(1 - d / s.r, 0, 1) ** 1.6 * 0.55;
          r = lerp(r, r * 0.55, m); g = lerp(g, g * 0.55, m); b = lerp(b, b * 0.58, m);
          rough = lerp(rough, 0.30, m);
        }
      }

      // --- shoulder / verge -------------------------------------------------
      if (onRoad < 1) {
        const gv = fbm(U * 1.7, V * 1.7, 14, 34, seed + 303, 4);
        const st = vnoise(U * 8, V * 8, 44, 110, seed + 707);
        let sr = shoulderCol[0] * (0.78 + gv * 0.5), sg = shoulderCol[1] * (0.78 + gv * 0.5), sb = shoulderCol[2] * (0.76 + gv * 0.5);
        // dry grass creeping in from the verge
        const dry = clamp((au - roadHalf - 0.35) / Math.max(0.35, half - roadHalf), 0, 1) * (0.35 + gv * 0.8);
        sr = lerp(sr, 0.435, dry * 0.75); sg = lerp(sg, 0.400, dry * 0.75); sb = lerp(sb, 0.205, dry * 0.75);
        if (st > 0.88) { const q = (st - 0.88) * 8; sr += q * 0.16; sg += q * 0.15; sb += q * 0.13; }
        const m = 1 - onRoad;
        r = lerp(r, sr, m); g = lerp(g, sg, m); b = lerp(b, sb, m);
        rough = lerp(rough, 0.95, m);
        h = lerp(h - 1.4, gv * 2.2 + (st > 0.88 ? 2 : 0), m);
      }

      // --- paint -------------------------------------------------------------
      if (p.centre || p.edge) {
        const wear = fbm(U * 2.2, V * 1.1, 12, 20, seed + 555, 4);
        const paint = (dist, wide, dash) => {
          let a = clamp((wide - dist) / 0.05 + 0.5, 0, 1);
          if (a <= 0) return 0;
          if (dash) {
            const ph = (V % dash.period) / dash.period;
            if (ph > dash.duty) return 0;
            a *= clamp(Math.min(ph, dash.duty - ph) / 0.04, 0, 1);
          }
          return a * clamp(1.35 - wear * 1.25, 0, 1);
        };
        let pa = 0;
        if (p.centre === 'solid') pa = Math.max(pa, paint(au, 0.055, null));
        else if (p.centre === 'dash') pa = Math.max(pa, paint(au, 0.055, { period: 9, duty: 3 }));
        else if (p.centre === 'double') pa = Math.max(pa, paint(Math.abs(au - 0.12), 0.055, null));
        if (p.edge) pa = Math.max(pa, paint(Math.abs(au - (roadHalf - 0.32)), 0.05, null) * onRoad);
        if (pa > 0) {
          pa *= onRoad;
          const pc = p.paintCol || [0.86, 0.845, 0.80];
          r = lerp(r, pc[0], pa); g = lerp(g, pc[1], pa); b = lerp(b, pc[2], pa);
          rough = lerp(rough, 0.52, pa); h += pa * 0.5;
        }
      }

      cr[k] = r; cg[k] = g; cb[k] = b; rn[k] = clamp(rough, 0.06, 1); hgt[k] = h;
    }
  }

  // --- pack ---------------------------------------------------------------
  const enc = v => Math.round(clamp(Math.pow(clamp(v, 0, 1), 1 / 2.2), 0, 1) * 255);
  for (let k = 0; k < W * H; k++) {
    alb.d[k * 4] = enc(cr[k]); alb.d[k * 4 + 1] = enc(cg[k]); alb.d[k * 4 + 2] = enc(cb[k]); alb.d[k * 4 + 3] = 255;
    const rv = Math.round(clamp(rn[k], 0, 1) * 255);
    rgh.d[k * 4] = rv; rgh.d[k * 4 + 1] = rv; rgh.d[k * 4 + 2] = rv; rgh.d[k * 4 + 3] = 255;
  }
  const at = (x, yy) => hgt[(((yy % H) + H) % H) * W + clamp(x, 0, W - 1)];
  const str = (p.normalStrength ?? 1) * 0.5;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const gx = (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
    const gy = (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
    let nx = -gx * str, ny = -gy * str, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    const k = (j * W + i) * 4;
    nrm.d[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    nrm.d[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    nrm.d[k + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
    nrm.d[k + 3] = 255;
  }
  return { map: toTexture(alb, true), normalMap: toTexture(nrm, false), roughnessMap: toTexture(rgh, false) };
}

/**
 * Standard material for a road ribbon. A tiny world-space macro variation is injected so the
 * V repeat does not read as a stamped pattern from the air.
 */
export function createRoadMaterial(tex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
    roughness: 1, metalness: 0, color: 0xffffff,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1.0, opts.normalScale ?? 1.0),
    polygonOffset: true, polygonOffsetFactor: opts.offsetFactor ?? -2, polygonOffsetUnits: opts.offsetUnits ?? -4,
    side: THREE.FrontSide, dithering: true,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoadW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvRoadW = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoadW;
float rdH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float rdN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(rdH(i), rdH(i+vec2(1,0)), f.x), mix(rdH(i+vec2(0,1)), rdH(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{ float m = rdN(vRoadW.xz * 0.035) * 0.62 + rdN(vRoadW.xz * 0.14) * 0.38;
  diffuseColor.rgb *= 0.80 + 0.42 * m; }`);
  };
  return m;
}

/* =============================================================== geometry === */

/** Smooth a draped height profile with a window of about `metres` (open polyline). */
function smoothProfile(y, step, metres, blend) {
  const n = y.length, R = Math.max(1, Math.round(metres / step / 2));
  const raw = Float64Array.from(y);
  let a = Float64Array.from(y), b = new Float64Array(n);
  const passes = 3;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, wt = 0;
      for (let d = -R; d <= R; d++) {
        const k = clamp(i + d, 0, n - 1), w = 1 - Math.abs(d) / (R + 1);
        sum += a[k] * w; wt += w;
      }
      b[i] = sum / wt;
    }
    const t = a; a = b; b = t;
  }
  for (let i = 0; i < n; i++) y[i] = lerp(a[i], raw[i], blend);
  return y;
}

/**
 * Resample a polyline at a fixed step and compute mitred left-normals at every station.
 * Mitres are clamped so a hairpin cannot fold the ribbon inside out.
 */
export function stations(path, step, closed = false) {
  const src = [];
  for (const p of path) {
    const x = p[0] ?? p.x, z = p[1] ?? p.z;
    if (!src.length || Math.hypot(x - src[src.length - 1][0], z - src[src.length - 1][1]) > 1e-3) src.push([x, z]);
  }
  if (src.length < 2) return null;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
  }
  if (!closed) out.push(src[src.length - 1].slice());
  const N = out.length;
  const st = [];
  let s = 0;
  for (let i = 0; i < N; i++) {
    const prev = out[closed ? (i - 1 + N) % N : Math.max(0, i - 1)];
    const next = out[closed ? (i + 1) % N : Math.min(N - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    let l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // mitre factor from the actual turn between the two adjacent segments
    let m = 1;
    {
      let ax = out[i][0] - prev[0], az = out[i][1] - prev[1];
      let bx = next[0] - out[i][0], bz = next[1] - out[i][1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      ax /= la; az /= la; bx /= lb; bz /= lb;
      const c = clamp(ax * bx + az * bz, -1, 1);
      m = clamp(1 / Math.max(0.35, Math.sqrt(Math.max(1e-4, (1 + c) * 0.5))), 1, 2.2);
    }
    if (i > 0) s += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    st.push({ x: out[i][0], z: out[i][1], tx: dx, tz: dz, nx: dz, nz: -dx, mitre: m, s });
  }
  return st;
}

/**
 * Build one ribbon.
 *
 * @param {object} o
 *   path       [[x,z],...]
 *   width      hard surface width (m)
 *   shoulder   verge width each side (m); the texture covers width + 2*shoulder
 *   crown      centreline camber rise (m)
 *   world      for draping
 *   vMetres    texture repeat along the way
 *   bankAt(s)  optional cross-slope in radians (positive lifts the LEFT side)
 *   yAt(s)     optional explicit centreline height (used by the circuit)
 */
export function buildRibbon(o) {
  const step = o.step ?? 3.0;
  const st = stations(o.path, step, o.closed);
  if (!st || st.length < 2) return null;
  const N = st.length;
  const w = o.width, sh = o.shoulder ?? 1.2, half = w * 0.5, outer = half + sh;
  const skirt = o.skirt ?? 0.9;

  // centreline height
  const yc = new Float64Array(N);
  if (o.yAt) for (let i = 0; i < N; i++) yc[i] = o.yAt(st[i].s, i);
  else {
    for (let i = 0; i < N; i++) yc[i] = o.world.heightAt(st[i].x, st[i].z);
    smoothProfile(yc, step, o.profile ?? 22, o.rawBlend ?? 0.25);
  }

  // cross-section offsets: skirt, shoulder, edge, quarter, centre, ... mirrored
  const lanes = [-(outer + skirt), -outer, -half, -half * 0.5, 0, half * 0.5, half, outer, outer + skirt];
  const L = lanes.length;
  const pos = new Float32Array(N * L * 3);
  const nor = new Float32Array(N * L * 3);
  const uv = new Float32Array(N * L * 2);
  const total = (outer) * 2;

  const crownH = o.crown ?? 0.09;
  for (let i = 0; i < N; i++) {
    const s = st[i], bank = o.bankAt ? o.bankAt(s.s, i) : 0;
    const tb = Math.tan(bank);
    for (let k = 0; k < L; k++) {
      const u = lanes[k], au = Math.abs(u);
      const x = s.x + s.nx * u, z = s.z + s.nz * u;
      let y = yc[i] + tb * u;
      if (au <= half) y += crownH * (1 - (au / half) ** 2);
      else {
        const th = o.world.heightAt(x, z);
        if (au <= outer) {
          const t = (au - half) / sh;
          y = lerp(y - 0.035, clamp(th, y - 3.6, y + 3.2), t * t * (3 - 2 * t));
        } else {
          y = clamp(th, y - 6, y + 6) - skirt * 0.55;
        }
      }
      const k3 = (i * L + k) * 3;
      pos[k3] = x; pos[k3 + 1] = y; pos[k3 + 2] = z;
      const k2 = (i * L + k) * 2;
      uv[k2] = clamp((u + outer) / total, 0, 1);
      uv[k2 + 1] = s.s / o.vMetres;
    }
  }
  // normals from the grid
  const gi = (i, k) => (clamp(i, 0, N - 1) * L + clamp(k, 0, L - 1)) * 3;
  for (let i = 0; i < N; i++) for (let k = 0; k < L; k++) {
    const a = gi(i - 1, k), b = gi(i + 1, k), c = gi(i, k - 1), d = gi(i, k + 1);
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    const o3 = (i * L + k) * 3;
    nor[o3] = nx / l; nor[o3 + 1] = ny / l; nor[o3 + 2] = nz / l;
  }
  const segs = o.closed ? N : N - 1;
  const Idx = N * L > 65000 ? Uint32Array : Uint16Array;
  const idx = new Idx(segs * (L - 1) * 6);
  let t = 0;
  for (let i = 0; i < segs; i++) {
    const i2 = o.closed ? (i + 1) % N : i + 1;
    for (let k = 0; k < L - 1; k++) {
      const a = i * L + k, b = a + 1, c = i2 * L + k, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return { geometry: g, stations: st, y: yc, lanes };
}

/** Concatenate geometries that share an attribute layout (position/normal/uv + index). */
export function mergeGeoms(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = nv > 65000 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array, ix = g.index.array;
    pos.set(p, vo * 3); nor.set(n, vo * 3); uv.set(u, vo * 2);
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += g.attributes.position.count; io += ix.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/* ================================================================ classes === */

/** Per-class ribbon spec. `w` is hard surface width; `sh` the verge. */
export const ROAD_CLASSES = {
  motorway:     { key: 'major', w: 11.0, sh: 2.2 },
  trunk:        { key: 'major', w: 9.5,  sh: 2.0 },
  primary:      { key: 'major', w: 8.5,  sh: 1.8 },
  secondary:    { key: 'major', w: 7.4,  sh: 1.7 },
  tertiary:     { key: 'major', w: 6.6,  sh: 1.6 },
  residential:  { key: 'minor', w: 5.4,  sh: 1.5 },
  living_street:{ key: 'minor', w: 5.0,  sh: 1.4 },
  unclassified: { key: 'minor', w: 5.0,  sh: 1.4 },
  service:      { key: 'minor', w: 4.0,  sh: 1.2 },
  cycleway:     { key: 'path',  w: 2.2,  sh: 0.9 },
  track:        { key: 'track', w: 3.4,  sh: 1.5 },
  unknown:      { key: 'track', w: 3.0,  sh: 1.4 },
  path:         { key: 'path',  w: 1.5,  sh: 0.8 },
  footway:      { key: 'path',  w: 1.4,  sh: 0.8 },
  steps:        { key: 'path',  w: 1.4,  sh: 0.8 },
};

const CLASS_TEX = {
  major: { kind: 'asphalt', centre: 'dash', edge: true,  vMetres: 26, seed: 101, normalStrength: 1.15 },
  minor: { kind: 'asphalt', centre: null,   edge: false, vMetres: 22, seed: 202, normalStrength: 1.25 },
  track: { kind: 'dirt',    centre: null,   edge: false, vMetres: 20, seed: 303, normalStrength: 1.45 },
  path:  { kind: 'path',    centre: null,   edge: false, vMetres: 12, seed: 404, normalStrength: 1.5 },
};

/* =============================================================== factory ==== */

/**
 * Build the whole road network as four merged meshes (one draw call per surface class).
 * Pass `opts.track` to suppress the ways the race circuit already covers.
 */
export function createRoads(engine, world, opts = {}) {
  const o = Object.assign({ shadows: true, step: 3.2, maskRadius: 1.0 }, opts);
  const group = new THREE.Group();
  group.name = 'roads';
  const mats = {}, buckets = { major: [], minor: [], track: [], path: [] };

  const trk = o.track;
  const covered = (x, z, w) => {
    if (!trk || typeof trk.nearest !== 'function') return false;
    let n = null;
    try { n = trk.nearest({ x, y: 0, z }); } catch (e) { return false; }
    if (!n) return false;
    return Math.abs(n.lateral) < (n.width || 12) * 0.5 * o.maskRadius + w * 0.4;
  };

  for (const road of (world.roads || [])) {
    if (road.poly) continue;
    const spec = ROAD_CLASSES[road.cls] || ROAD_CLASSES[road.sub] || null;
    if (!spec) continue;
    for (const path of (road.paths || [])) {
      if (!path || path.length < 2) continue;
      // split the way where the circuit covers it, so village streets do not z-fight the track
      const runs = [];
      let cur = [];
      for (const p of path) {
        if (covered(p[0], p[1], spec.w)) { if (cur.length > 1) runs.push(cur); cur = []; }
        else cur.push(p);
      }
      if (cur.length > 1) runs.push(cur);
      for (const run of runs) {
        let len = 0;
        for (let i = 1; i < run.length; i++) len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
        if (len < 5) continue;
        const r = buildRibbon({
          path: run, width: spec.w, shoulder: spec.sh, world,
          vMetres: CLASS_TEX[spec.key].vMetres, step: o.step,
          crown: spec.key === 'path' ? 0.02 : 0.075,
          profile: spec.key === 'path' ? 9 : 20, rawBlend: spec.key === 'path' ? 0.5 : 0.28,
          skirt: 0.8,
        });
        if (r) buckets[spec.key].push(r.geometry);
      }
    }
  }

  for (const key of Object.keys(buckets)) {
    if (!buckets[key].length) continue;
    const cfg = CLASS_TEX[key], spec = Object.values(ROAD_CLASSES).find(s => s.key === key);
    const tex = buildRoadTextures({
      total: spec.w + spec.sh * 2, road: spec.w, vMetres: cfg.vMetres, kind: cfg.kind,
      centre: cfg.centre, edge: cfg.edge, seed: cfg.seed, normalStrength: cfg.normalStrength,
      W: key === 'path' ? 96 : 160, H: key === 'path' ? 512 : 1024,
    });
    const mat = mats[key] = createRoadMaterial(tex, { normalScale: key === 'track' ? 1.2 : 0.95 });
    const g = mergeGeoms(buckets[key]);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'roads:' + key;
    mesh.receiveShadow = o.shadows;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    for (const gg of buckets[key]) gg.dispose?.();
  }

  engine.scene.add(group);
  const api = {
    group, materials: mats,
    dispose() {
      group.traverse(n => { n.geometry?.dispose?.(); });
      engine.scene.remove(group);
    },
  };
  engine.add(api);
  return api;
}

export default createRoads;
