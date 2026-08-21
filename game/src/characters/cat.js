/**
 * Kat Racing — procedural cat drivers.
 *
 * Everything here is generated in code: geometry, fur textures, eyes, whiskers.
 * A cat is a nested THREE.Bone rig (real hierarchy, so poses blend smoothly) with
 * merged, chunky Nintendo-ish proportions: big head, small body, huge readable
 * silhouette. Fur is a shell/fin technique over a sheen-based physical material.
 *
 *   import { createCat, CAT_SPECS } from './cat.js';
 *   const cat = createCat('mitzi', { detail: 'high' });
 *   scene.add(cat.object3D);
 *   cat.update(dt, { speed, steer, drift, airborne, boosting, hit, place });
 */
import * as THREE from 'three';
import { rng } from '../core/mathx.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const TAU = Math.PI * 2;
const DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/* ------------------------------------------------------------------ colours */
const hex2rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------------------------------------- tileable noise */
function noiseGrid(seed, W) {
  const R = rng(seed);
  const g = new Float32Array(W * W);
  for (let i = 0; i < g.length; i++) g[i] = R();
  const at = (x, y) => g[(((y % W) + W) % W) * W + (((x % W) + W) % W)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    const t = a + (b - a) * sx;
    return t + ((c + (d - c) * sx) - t) * sy;
  };
}
function makeFbm(seed) {
  const n8 = noiseGrid(seed + 11, 8), n16 = noiseGrid(seed + 29, 16), n32 = noiseGrid(seed + 71, 32);
  const n64 = noiseGrid(seed + 131, 64), n96 = noiseGrid(seed + 197, 96);
  return {
    lo: (u, v) => n8(u * 8, v * 8),
    fbm: (u, v) => 0.55 * n8(u * 8, v * 8) + 0.3 * n16(u * 16, v * 16) + 0.15 * n32(u * 32, v * 32),
    hi: (u, v) => n32(u * 32, v * 32),
    // vertical hair streaks: many cells around, few along -> elongated strands
    strand: (u, v) => 0.3 * n64(u * 64, v * 34) + 0.7 * n96(u * 96, v * 76),
  };
}

/* -------------------------------------------------------------- cat specs */
/** ear: pointed | round | fold | tuft | notch | curl   gear: helmet | cap | goggles | bandana | visor */
export const CAT_SPECS = {
  mitzi:  { name: 'Mitzi',  pattern: 'tabby',  base: 0x9a7550, dark: 0x53381f, belly: 0xe6d3b3, nose: 0xd98d92, eye: 0x8fd14f, ear: 'pointed', gear: 'helmet',  suit: [0xe2542a, 0xf7e0b6], num: 7,  seed: 101 },
  shuki:  { name: 'Shuki',  pattern: 'tuxedo', base: 0x24242a, dark: 0x101014, belly: 0xf4f1e6, nose: 0xe4a0a8, eye: 0xf2c531, ear: 'round',   gear: 'goggles', suit: [0x1b2f6b, 0xf3f1e8], num: 3,  seed: 202 },
  yaffa:  { name: 'Yaffa',  pattern: 'calico', base: 0xf3ece0, dark: 0x2c2118, belly: 0xfbf7ef, nose: 0xdf9096, eye: 0x39a4c9, ear: 'notch',   gear: 'bandana', suit: [0x3f8f4a, 0xf6e3a1], num: 12, seed: 303 },
  kobi:   { name: 'Kobi',   pattern: 'ginger', base: 0xd8823a, dark: 0xa2521c, belly: 0xf6ddb6, nose: 0xdc8a7e, eye: 0x59b24a, ear: 'tuft',    gear: 'cap',     suit: [0xe8a21f, 0x2c4a2a], num: 5,  seed: 404 },
  layla:  { name: 'Layla',  pattern: 'solid',  base: 0x1e1c22, dark: 0x0e0d11, belly: 0x322f38, nose: 0x4b4048, eye: 0xe6b422, ear: 'pointed', gear: 'helmet',  suit: [0x5c2c74, 0xe8c25a], num: 9,  seed: 505 },
  shelly: { name: 'Shelly', pattern: 'white',  base: 0xf6f2e8, dark: 0xd8cfbe, belly: 0xfffdf7, nose: 0xefa9ae, eye: 0x4fa9e0, ear: 'round',   gear: 'visor',   suit: [0x2e9fc4, 0xffffff], num: 1,  seed: 606 },
  dror:   { name: 'Dror',   pattern: 'point',  base: 0xcdcbd2, dark: 0x4a4c58, belly: 0xeceaf1, nose: 0x9b8f96, eye: 0x63c8d6, ear: 'fold',    gear: 'cap',     suit: [0x39424f, 0xd9e2e6], num: 8,  seed: 707 },
  tamar:  { name: 'Tamar',  pattern: 'point',  base: 0xe8d9bc, dark: 0x4a2f24, belly: 0xf6ecd8, nose: 0x8d5f52, eye: 0x4f9fe0, ear: 'pointed', gear: 'bandana', suit: [0x8f2f46, 0xf0d9a6], num: 4,  seed: 808 },
  boaz:   { name: 'Boaz',   pattern: 'tabby',  base: 0x7d8288, dark: 0x3b4046, belly: 0xd2d6d8, nose: 0x9d7f83, eye: 0xc9a227, ear: 'notch',   gear: 'helmet',  suit: [0x2f5f4a, 0xe0b23c], num: 22, seed: 909 },
  nofar:  { name: 'Nofar',  pattern: 'bicolor', base: 0xf1e6d6, dark: 0xc98a55, belly: 0xfaf4ea, nose: 0xe3969b, eye: 0x77c98a, ear: 'curl',    gear: 'goggles', suit: [0xd8577b, 0xf6ead2], num: 6,  seed: 1010 },
};

/* --------------------------------------------------------- fur pattern bake */
function patternFn(spec) {
  const N = makeFbm(spec.seed);
  const base = hex2rgb(spec.base), dark = hex2rgb(spec.dark), belly = hex2rgb(spec.belly);
  const white = [246, 242, 233];
  const R = rng(spec.seed + 7);
  const blobs = [];
  for (let i = 0; i < 10; i++) blobs.push([R(), R(), 0.08 + R() * 0.16, R() < 0.5 ? 0 : 1]);
  const blobAt = (u, v, which) => {
    let m = 0;
    for (const b of blobs) {
      if (b[3] !== which) continue;
      let du = Math.abs(u - b[0]); du = Math.min(du, 1 - du);
      const dv = (v - b[1]) * 0.75;
      const d = Math.sqrt(du * du + dv * dv);
      m = Math.max(m, 1 - smoothstep(b[2] * 0.55, b[2], d));
    }
    return m;
  };

  return (part, u, v) => {
    const front = 0.5 + 0.5 * Math.cos((u - 0.5) * TAU);
    const warp = N.fbm(u, v) - 0.5;
    let c = base.slice();
    const isLimb = part === 'arm' || part === 'leg' || part === 'tail';
    const p = spec.pattern;

    if (p === 'tabby' || p === 'ginger') {
      const f = part === 'tail' ? 11 : part === 'head' ? 7 : 9;
      const s = Math.sin((v * f + warp * 1.5 + (part === 'head' ? 0.5 : 0)) * Math.PI);
      let m = 1 - smoothstep(0.06, 0.42, Math.abs(s));
      if (part === 'head') m *= smoothstep(0.42, 0.62, v) * (0.45 + 0.55 * front);
      if (part === 'muzzle') m = 0;
      const amt = p === 'ginger' ? 0.55 : 0.9;
      c = mix3(c, dark, m * amt);
      if (part === 'arm' || part === 'leg') c = mix3(c, white, smoothstep(0.3, 0.02, v) * 0.85);
    } else if (p === 'tuxedo') {
      c = base.slice();
      let w = 0;
      if (part === 'body') w = smoothstep(0.72, 0.34, v) * smoothstep(0.25, 0.6, front + warp * 0.25);
      if (part === 'head') w = Math.pow(front, 3.0) * smoothstep(0.62, 0.28, v) * 1.2 + smoothstep(0.2, 0.0, v);
      if (part === 'muzzle') w = 1;
      if (part === 'arm' || part === 'leg') w = smoothstep(0.42, 0.05, v);
      if (part === 'tail') w = smoothstep(0.12, 0.0, v) * 0.8;
      c = mix3(c, white, clamp(w, 0, 1));
    } else if (p === 'calico') {
      c = white.slice();
      const g = [216, 138, 60];
      c = mix3(c, g, blobAt(u, v, 0) * 0.95);
      c = mix3(c, dark, blobAt(u, v, 1) * 0.95);
      if (part === 'muzzle') c = white.slice();
      if (part === 'tail') { c = mix3(white, g, smoothstep(0.1, 0.45, v)); c = mix3(c, dark, smoothstep(0.55, 0.85, v) * 0.8); }
      if (part === 'ear') c = mix3(white, dark, smoothstep(0.1, 0.5, v) * (u < 0.5 ? 1 : 0.15));
    } else if (p === 'point') {
      c = base.slice();
      let m = 0;
      if (part === 'head') m = Math.pow(front, 2.2) * smoothstep(0.7, 0.2, v) * 1.15;
      if (part === 'muzzle') m = 0.95;
      if (part === 'ear') m = 0.9;
      if (part === 'tail') m = smoothstep(0.05, 0.7, v);
      if (part === 'arm' || part === 'leg') m = smoothstep(0.45, 0.05, v) * 0.85;
      if (part === 'body') m = 0.06;
      c = mix3(c, dark, clamp(m + warp * 0.08, 0, 1));
    } else if (p === 'bicolor') {
      c = base.slice();
      let m = blobAt(u, v, 0) * 0.9 + blobAt(u, v, 1) * 0.5;
      if (part === 'ear') m = 0.85;
      if (part === 'tail') m = smoothstep(0.15, 0.5, v);
      if (part === 'muzzle') m = 0;
      c = mix3(c, dark, clamp(m, 0, 1));
    } else { // solid / white
      c = mix3(c, dark, (0.5 - front) * 0.12 + warp * 0.08);
      if (part === 'ear') c = mix3(c, dark, 0.12);
    }

    // universal light mask: face, chest, chin — the thing that makes a cat face read
    if (p !== 'tuxedo' && p !== 'calico') {
      let m = 0;
      if (part === 'head') m = Math.pow(front, 1.4) * smoothstep(0.62, 0.10, v);
      else if (part === 'body') m = Math.pow(front, 0.9) * smoothstep(0.58, 0.12, v);
      else if (part === 'muzzle') m = 0.9;
      c = mix3(c, belly, clamp(m, 0, 1) * 0.88);
    }
    if (part === 'ear') {
      // ear: base fur with a slightly darker rim; the pink inner is separate geometry
      c = mix3(base, c, 0.30);
      c = mix3(c, dark, smoothstep(0.78, 1.0, v) * 0.12);
    }

    if (isLimb) c = mix3(c, [0, 0, 0], 0.04);
    if (part === 'muzzle') c = mix3(c, [246, 239, 226], 0.55);
    // fur micro-shading: strand streaks + soft mottling
    const strand = 0.945 + 0.11 * N.strand(u, v);
    const mott = 0.965 + 0.07 * N.lo(u, v);
    const k = strand * mott;
    return [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)];
  };
}

const TEX_CACHE = new Map();
function furTexture(spec, part, size) {
  if (!DOM) return null;
  const key = spec.name + ':' + part + ':' + size;
  if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
  const f = patternFn(spec);
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const v = 1 - (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const c = f(part, u, v);
      const i = (y * size + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  TEX_CACHE.set(key, t);
  return t;
}

/** Shared fur strand normal map (hair pointing "down" the part in V). */
let FUR_NRM = null;
function furNormal() {
  if (!DOM) return null;
  if (FUR_NRM) return FUR_NRM;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const N = makeFbm(4242);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    // elongated strands: high frequency across, low along
    const s = N.hi(u * 4, v * 0.6);
    h[y * S + x] = s * s;
  }
  const img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const hx = h[y * S + (x + 1) % S] - h[y * S + (x + S - 1) % S];
    const hy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
    const nx = -hx * 2.2, ny = -hy * 2.2, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  FUR_NRM = new THREE.CanvasTexture(cv);
  FUR_NRM.colorSpace = THREE.NoColorSpace;
  FUR_NRM.wrapS = FUR_NRM.wrapT = THREE.RepeatWrapping;
  return FUR_NRM;
}

/** Shared shell alpha: soft-tipped strand cross-sections; alphaTest erodes them per layer. */
let SHELL_TEX = null;
function shellAlpha() {
  if (!DOM) return null;
  if (SHELL_TEX) return SHELL_TEX;
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
  const R = rng(9137);
  for (let i = 0; i < 1500; i++) {
    const x = R() * S, y = R() * S;
    const peak = 0.42 + Math.pow(R(), 0.7) * 0.58;      // strand length distribution
    const r = 2.1 + R() * 1.5;
    for (let wx = -1; wx <= 1; wx++) {
      for (let wy = -1; wy <= 1; wy++) {
        const px = x + wx * S, py = y + wy * S;
        if (px < -8 || px > S + 8 || py < -8 || py > S + 8) continue;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        const c0 = Math.round(peak * 255);
        g.addColorStop(0, `rgb(${c0},${c0},${c0})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
      }
    }
  }
  SHELL_TEX = new THREE.CanvasTexture(cv);
  SHELL_TEX.colorSpace = THREE.NoColorSpace;
  SHELL_TEX.wrapS = SHELL_TEX.wrapT = THREE.RepeatWrapping;
  return SHELL_TEX;
}

/* ------------------------------------------------------------ eye textures */
const EYE_CACHE = new Map();
function eyeTexture(colorHex, slit) {
  if (!DOM) return null;
  const key = colorHex + ':' + slit;
  if (EYE_CACHE.has(key)) return EYE_CACHE.get(key);
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const c = hex2rgb(colorHex);
  ctx.fillStyle = '#f2efe6'; ctx.fillRect(0, 0, S, S);      // sclera
  // iris fills most of the front face; the front of the sphere is at u=0.5
  const cx = S * 0.5, cy = S * 0.5, rr = S * 0.40;
  const grd = ctx.createRadialGradient(cx, cy - rr * 0.25, rr * 0.15, cx, cy, rr);
  grd.addColorStop(0, `rgb(${Math.min(255, c[0] * 1.35 | 0)},${Math.min(255, c[1] * 1.35 | 0)},${Math.min(255, c[2] * 1.35 | 0)})`);
  grd.addColorStop(0.62, `rgb(${c[0]},${c[1]},${c[2]})`);
  grd.addColorStop(1, `rgb(${c[0] * 0.45 | 0},${c[1] * 0.45 | 0},${c[2] * 0.45 | 0})`);
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.fill();
  // iris fibres
  ctx.globalAlpha = 0.22; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.1;
  for (let i = 0; i < 44; i++) {
    const a = i / 44 * TAU;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rr * 0.3, cy + Math.sin(a) * rr * 0.3);
    ctx.lineTo(cx + Math.cos(a) * rr * 0.92, cy + Math.sin(a) * rr * 0.92);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // limbal ring
  ctx.strokeStyle = 'rgba(28,22,16,0.45)'; ctx.lineWidth = S * 0.030;
  ctx.beginPath(); ctx.arc(cx, cy, rr * 0.97, 0, TAU); ctx.stroke();
  // pupil
  ctx.fillStyle = '#08070a'; ctx.beginPath();
  if (slit) ctx.ellipse(cx, cy, rr * 0.17, rr * 0.72, 0, 0, TAU);
  else ctx.ellipse(cx, cy, rr * 0.40, rr * 0.46, 0, 0, TAU);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  EYE_CACHE.set(key, t);
  return t;
}

/* --------------------------------------------------------------- utilities */
/** Rewrite UVs cylindrically from local position: u=0.5 at +Z (front), v=0 bottom → 1 top. */
function cylUV(geo, opts = {}) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const y0 = opts.y0 ?? bb.min.y, y1 = opts.y1 ?? bb.max.y;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u = Math.atan2(x, z) / TAU + 0.5;
    uv[i * 2] = u;
    uv[i * 2 + 1] = (y - y0) / Math.max(1e-5, y1 - y0);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
/** Planar UV in XY (for extruded ear shapes). */
function planarUV(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox, pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const sx = Math.max(1e-5, bb.max.x - bb.min.x), sy = Math.max(1e-5, bb.max.y - bb.min.y);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / sx;
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / sy;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
function bone(name, x, y, z) { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); return b; }

/* ------------------------------------------------------------- geometry kit */
function mergeGeos(list) {
  // minimal, dependency-free merge (position/normal/uv, non-indexed)
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of parts) {
    const p = g.attributes.position, nn = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      if (nn) { nor[(o + i) * 3] = nn.getX(i); nor[(o + i) * 3 + 1] = nn.getY(i); nor[(o + i) * 3 + 2] = nn.getZ(i); }
      if (u) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
    }
    o += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function xform(geo, { pos, rot, scale, quat } = {}) {
  const m = new THREE.Matrix4();
  const q = quat || new THREE.Quaternion().setFromEuler(new THREE.Euler(rot?.[0] || 0, rot?.[1] || 0, rot?.[2] || 0));
  m.compose(new THREE.Vector3(pos?.[0] || 0, pos?.[1] || 0, pos?.[2] || 0), q,
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1));
  geo.applyMatrix4(m);
  return geo;
}
function lathe(profile, seg = 22) {
  const pts = profile.map(p => new THREE.Vector2(Math.max(p[0], 0.0006), p[1]));
  return new THREE.LatheGeometry(pts, seg);
}
/**
 * Ears are the whole silhouette read. From the chase camera all you get of a driver is the
 * dome clearing the seat back, and at the R1 size the ears barely broke that dome's outline —
 * so the grid read as "pale blobs in the seats". Scaled up 22%: still Nintendo-proportioned,
 * but unmistakably a cat from 40 m.
 */
function earShape(kind) {
  const s = new THREE.Shape();
  const K = 1.22;
  const w = (kind === 'round' ? 0.118 : 0.104) * K;
  const h = (kind === 'round' ? 0.118 : kind === 'tuft' ? 0.165 : 0.148) * K;
  s.moveTo(-w, 0);
  if (kind === 'round') {
    s.bezierCurveTo(-w * 1.15, h * 0.55, -w * 0.62, h, 0, h);
    s.bezierCurveTo(w * 0.62, h, w * 1.15, h * 0.55, w, 0);
  } else if (kind === 'notch') {
    s.bezierCurveTo(-w * 1.05, h * 0.5, -w * 0.5, h * 0.92, -w * 0.06, h);
    s.lineTo(w * 0.10, h * 0.70); s.lineTo(w * 0.30, h * 0.86);
    s.bezierCurveTo(w * 0.75, h * 0.55, w * 1.02, h * 0.3, w, 0);
  } else {
    s.bezierCurveTo(-w * 1.02, h * 0.52, -w * 0.42, h * 0.9, 0, h);
    s.bezierCurveTo(w * 0.42, h * 0.9, w * 1.02, h * 0.52, w, 0);
  }
  s.lineTo(-w, 0);
  return s;
}
function extrudeShape(shape, depth, bevel = 0.006) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 10,
  });
  g.translate(0, 0, -depth * 0.5);
  return g;
}
function numberTexture(n, fg = '#1b1b20', bg = '#f4f1e6') {
  if (!DOM) return null;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, S, S);
  c.fillStyle = bg; c.beginPath(); c.arc(S / 2, S / 2, S * 0.44, 0, TAU); c.fill();
  c.lineWidth = S * 0.05; c.strokeStyle = fg; c.stroke();
  c.fillStyle = fg; c.font = `bold ${S * 0.56}px Helvetica, Arial, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(n), S / 2, S / 2 + S * 0.03);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* --------------------------------------------------------------- materials */
/**
 * Value lift for dark coats. A black cat under ACES in a seat that is also dark reads as a
 * hole; multiplying the albedo up (Color components may exceed 1 — it is a linear multiplier)
 * keeps Layla and Shuki black *looking* while giving them enough separation to be seen.
 */
function furLift(spec) {
  const [r, g, b] = hex2rgb(spec.base);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return clamp(1 + (0.46 - lum) * 1.5, 1, 1.85);
}
function furMaterial(spec, part, size, extra = {}) {
  const { nrep = [5, 5], ...rest } = extra;
  const map = furTexture(spec, part, size);
  const base = furNormal();
  let nrm = null;
  if (base) { nrm = base.clone(); nrm.needsUpdate = true; nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.repeat.set(nrep[0], nrep[1]); }
  const k = furLift(spec);
  return new THREE.MeshPhysicalMaterial({
    color: map ? new THREE.Color(k, k, k) : new THREE.Color(spec.base).multiplyScalar(k),
    map, normalMap: nrm,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.80, metalness: 0.0,
    sheen: 1.0, sheenRoughness: 0.30,
    sheenColor: new THREE.Color(0xfff0dc),
    ...rest,
  });
}

/* ------------------------------------------------------------------- build */
const TORSO_PROFILE = [
  [0.020, -0.235], [0.100, -0.228], [0.152, -0.185], [0.180, -0.115], [0.191, -0.030],
  [0.188, 0.035], [0.170, 0.090], [0.138, 0.135], [0.086, 0.168], [0.020, 0.180],
];

function shellMesh(geo, spec, part, texSize, count, gap, rep) {
  const out = [];
  if (!count || !DOM) return out;
  const src = geo.attributes.position, nrm = geo.attributes.normal;
  const map = furTexture(spec, part, texSize);
  const alpha = shellAlpha();
  for (let s = 1; s <= count; s++) {
    const g = geo.clone();
    const p = g.attributes.position;
    const d = gap * s;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, src.getX(i) + nrm.getX(i) * d, src.getY(i) + nrm.getY(i) * d, src.getZ(i) + nrm.getZ(i) * d);
    }
    p.needsUpdate = true;
    const t = s / count;
    const am = alpha ? alpha.clone() : null;
    if (am) { am.needsUpdate = true; am.wrapS = am.wrapT = THREE.RepeatWrapping; am.repeat.set(rep[0], rep[1]); }
    const m = new THREE.MeshStandardMaterial({
      map, alphaMap: am, alphaTest: 0.10 + t * 0.72,
      color: new THREE.Color().setScalar((0.93 + 0.13 * t) * furLift(spec)),
      roughness: 0.95, metalness: 0, side: THREE.FrontSide, depthWrite: true,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = s;
    mesh.castShadow = false; mesh.receiveShadow = false;
    out.push(mesh);
  }
  return out;
}

export function createCat(id, opts = {}) {
  const spec = Object.assign({ id }, CAT_SPECS[id] || CAT_SPECS.mitzi, opts.spec || {});
  const detail = opts.detail || 'high';
  const shells = opts.shells ?? (detail === 'high' ? 6 : detail === 'med' ? 3 : 0);
  const tex = detail === 'low' ? 96 : detail === 'med' ? 160 : 256;
  const seg = detail === 'high' ? 1 : 0.72;
  const fine = detail !== 'low';                                   // draw-call budget for far LOD                       // geometry density scale
  const shadows = opts.shadows !== false;
  const R = rng(spec.seed | 0);

  const root = new THREE.Group(); root.name = 'cat:' + spec.id;
  // Nintendo proportions: the driver has to clear the seat back and the roll hoop or the kart
  // reads as driverless from the chase camera (review R1 — the grid looked like empty chassis).
  // Scaling the whole rig also scales the arms, so the IK still reaches the steering rim.
  root.scale.setScalar(opts.scale ?? 1.26);
  const rig = new THREE.Group(); rig.name = 'rig'; root.add(rig);

  /* ---- bones */
  const B = {};
  B.hips = bone('hips', 0, 0.10, -0.015); rig.add(B.hips);
  B.spine = bone('spine', 0, 0.10, 0.005); B.hips.add(B.spine);
  B.chest = bone('chest', 0, 0.13, 0.010); B.spine.add(B.chest);
  B.neck = bone('neck', 0, 0.155, 0.020); B.chest.add(B.neck);
  B.head = bone('head', 0, 0.125, 0.012); B.neck.add(B.head);
  B.shoulderL = bone('shoulderL', -0.150, 0.045, 0.020); B.chest.add(B.shoulderL);
  B.shoulderR = bone('shoulderR', 0.150, 0.045, 0.020); B.chest.add(B.shoulderR);
  B.elbowL = bone('elbowL', 0, -0.175, 0); B.shoulderL.add(B.elbowL);
  B.elbowR = bone('elbowR', 0, -0.175, 0); B.shoulderR.add(B.elbowR);
  B.handL = bone('handL', 0, -0.160, 0); B.elbowL.add(B.handL);
  B.handR = bone('handR', 0, -0.160, 0); B.elbowR.add(B.handR);
  B.tail = [];
  let tparent = B.hips;
  for (let i = 0; i < 5; i++) { const b = bone('tail' + i, 0, i === 0 ? 0.02 : 0.115, i === 0 ? -0.155 : 0); tparent.add(b); B.tail.push(b); tparent = b; }
  B.thighL = bone('thighL', -0.105, -0.055, 0.035); B.hips.add(B.thighL);
  B.thighR = bone('thighR', 0.105, -0.055, 0.035); B.hips.add(B.thighR);
  B.shinL = bone('shinL', 0, -0.10, 0.02); B.thighL.add(B.shinL);
  B.shinR = bone('shinR', 0, -0.10, 0.02); B.thighR.add(B.shinR);
  B.earL = bone('earL', 0, 0, 0); B.head.add(B.earL);
  B.earR = bone('earR', 0, 0, 0); B.head.add(B.earR);
  B.muzzle = bone('muzzle', 0, -0.052, 0.150); B.head.add(B.muzzle);
  B.jaw = bone('jaw', 0, -0.02, 0.02); B.muzzle.add(B.jaw);

  /* ---- materials */
  const M = {};
  M.head = furMaterial(spec, 'head', tex, { nrep: [4, 4] });
  M.body = furMaterial(spec, 'body', tex, { nrep: [5, 5] });
  M.muzzle = furMaterial(spec, 'muzzle', 96, { nrep: [3, 3] });
  M.ear = furMaterial(spec, 'ear', 96, { nrep: [2, 3], side: THREE.DoubleSide });
  M.limb = furMaterial(spec, 'arm', 96, { nrep: [2, 5] });
  M.tail = furMaterial(spec, 'tail', 96, { nrep: [2, 8] });
  M.suit = new THREE.MeshPhysicalMaterial({
    color: spec.suit[0], roughness: 0.58, metalness: 0.0, clearcoat: 0.25, clearcoatRoughness: 0.5,
    emissive: new THREE.Color(spec.suit[0]).multiplyScalar(0.14), emissiveIntensity: 1.0,
    envMapIntensity: 1.2,
  });
  M.trim = new THREE.MeshPhysicalMaterial({ color: spec.suit[1], roughness: 0.66, metalness: 0.0, clearcoat: 0.08 });
  // The helmet is the driver's identity badge at 40 m — lacquered, at full chroma, with a
  // touch of self-colour emissive so it still reads on the shaded side of the seat.
  M.gear = new THREE.MeshPhysicalMaterial({
    color: spec.suit[0], roughness: 0.16, metalness: 0.05,
    clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.8,
    emissive: new THREE.Color(spec.suit[0]).multiplyScalar(0.20), emissiveIntensity: 1.0,
  });
  M.chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.18, metalness: 1.0 });
  M.glass = new THREE.MeshPhysicalMaterial({ color: 0x2a3d52, roughness: 0.05, metalness: 0.0, clearcoat: 1, transparent: true, opacity: 0.55 });
  M.pink = new THREE.MeshPhysicalMaterial({ color: spec.nose, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.25 });
  M.sclera = new THREE.MeshPhysicalMaterial({ color: 0xf7f4ec, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.03 });
  M.iris = new THREE.MeshPhysicalMaterial({ map: eyeTexture(spec.eye, spec.pattern !== 'point'), color: eyeTexture(spec.eye, true) ? 0xffffff : new THREE.Color(spec.eye), roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02 });
  M.hi = new THREE.MeshBasicMaterial({ color: 0xffffff });
  M.dark = new THREE.MeshStandardMaterial({ color: 0x17161c, roughness: 0.6 });
  M.whisker = new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.35, metalness: 0.0 });
  if (opts.env) { M.chrome.envMap = opts.env; M.gear.envMap = opts.env; M.glass.envMap = opts.env; M.suit.envMap = opts.env; }

  const add = (parent, geo, mat, cast = shadows) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = false;
    parent.add(m); return m;
  };

  /* ---- torso */
  const torsoGeo = cylUV(lathe(TORSO_PROFILE, Math.round(24 * seg) + 4));
  const torso = add(B.chest, torsoGeo, M.body);
  const bodyShells = shellMesh(torsoGeo, spec, 'body', tex, Math.min(shells, 4), 0.0040, [20, 13]);
  for (const s of bodyShells) B.chest.add(s);

  // rump
  const rumpGeo = cylUV(xform(new THREE.SphereGeometry(0.155, Math.round(18 * seg) + 6, Math.round(12 * seg) + 4), { pos: [0, -0.03, -0.045], scale: [1.0, 0.85, 1.05] }));
  add(B.hips, rumpGeo, M.body);

  // racing suit shell (lower torso) + collar + stripes
  const suitProfile = TORSO_PROFILE.filter(p => p[1] <= 0.095).map(p => [p[0] * 1.045 + 0.004, p[1] * 1.005]);
  suitProfile.push([suitProfile[suitProfile.length - 1][0] * 0.97, 0.10]);
  const suitGeo = cylUV(lathe(suitProfile, Math.round(24 * seg) + 4));
  add(B.chest, suitGeo, M.suit);
  add(B.chest, xform(new THREE.TorusGeometry(0.152, 0.020, 8, Math.round(20 * seg) + 6), { pos: [0, 0.085, 0], rot: [Math.PI / 2, 0, 0] }), M.trim);
  add(B.chest, xform(new THREE.TorusGeometry(0.191, 0.011, 6, Math.round(20 * seg) + 6), { pos: [0, -0.055, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 1, 0.55] }), M.trim);
  // chest number, hugging the torso
  if (DOM) {
    const nGeo = new THREE.CylinderGeometry(0.216, 0.212, 0.125, 14, 1, true, -0.36, 0.72);
    const nMat = new THREE.MeshStandardMaterial({ map: numberTexture(spec.num, '#1b1b20', '#f4f1e6'), transparent: true, alphaTest: 0.35, roughness: 0.5, side: THREE.DoubleSide });
    add(B.chest, xform(nGeo, { pos: [0, 0.028, 0] }), nMat, false);
  }

  /* ---- head */
  const headGeo = mergeGeos([
    xform(new THREE.SphereGeometry(0.198, Math.round(28 * seg) + 6, Math.round(20 * seg) + 4), { scale: [1.05, 0.96, 1.0] }),
    xform(new THREE.SphereGeometry(0.082, Math.round(14 * seg) + 4, Math.round(10 * seg) + 3), { pos: [-0.118, -0.048, 0.118], scale: [0.95, 0.9, 1.0] }),
    xform(new THREE.SphereGeometry(0.082, Math.round(14 * seg) + 4, Math.round(10 * seg) + 3), { pos: [0.118, -0.048, 0.118], scale: [0.95, 0.9, 1.0] }),
  ]);
  headGeo.computeVertexNormals();
  cylUV(headGeo);
  const head = add(B.head, headGeo, M.head);
  const headShells = shellMesh(headGeo, spec, 'head', tex, shells, 0.0034, [26, 17]);
  for (const s of headShells) B.head.add(s);

  // muzzle: whisker pads + snout bridge + chin
  const muzGeo = mergeGeos([
    xform(new THREE.SphereGeometry(0.046, Math.round(14 * seg) + 5, Math.round(10 * seg) + 4), { pos: [-0.031, -0.006, 0.014], scale: [1.02, 0.86, 0.98] }),
    xform(new THREE.SphereGeometry(0.046, Math.round(14 * seg) + 5, Math.round(10 * seg) + 4), { pos: [0.031, -0.006, 0.014], scale: [1.02, 0.86, 0.98] }),
    xform(new THREE.SphereGeometry(0.042, Math.round(12 * seg) + 4, Math.round(9 * seg) + 3), { pos: [0, 0.022, 0.008], scale: [1.15, 0.82, 1.0] }),
    xform(new THREE.SphereGeometry(0.038, Math.round(12 * seg) + 4, Math.round(9 * seg) + 3), { pos: [0, -0.042, -0.004], scale: [1.05, 0.9, 0.95] }),
  ]);
  muzGeo.computeVertexNormals();
  cylUV(muzGeo);
  add(B.muzzle, muzGeo, M.muzzle);
  // nose: rounded triangle
  {
    const ns = new THREE.Shape();
    const w = 0.022, h = 0.017;
    ns.moveTo(-w, h * 0.7);
    ns.quadraticCurveTo(-w * 1.15, h * 1.35, 0, h * 1.25);
    ns.quadraticCurveTo(w * 1.15, h * 1.35, w, h * 0.7);
    ns.quadraticCurveTo(w * 0.75, -h * 0.35, 0, -h * 1.25);
    ns.quadraticCurveTo(-w * 0.75, -h * 0.35, -w, h * 0.7);
    add(B.muzzle, xform(extrudeShape(ns, 0.016, 0.004), { pos: [0, 0.034, 0.050], rot: [-0.02, 0, 0], scale: [0.92, 0.92, 1] }), M.pink, false);
  }
  // mouth: philtrum + two arcs, plus an openable cavity for cheering
  if (fine) {
    add(B.jaw, xform(new THREE.BoxGeometry(0.006, 0.020, 0.006), { pos: [0, 0.002, 0.062] }), M.dark, false);
    for (const s of [-1, 1]) {
      add(B.jaw, xform(new THREE.TorusGeometry(0.020, 0.0040, 5, 10, Math.PI * 0.95), { pos: [s * 0.019, -0.008, 0.056], rot: [0.30, 0, Math.PI + s * 0.10] }), M.dark, false);
    }
  }
  const mouthOpen = add(fine ? B.jaw : B.jaw, xform(new THREE.SphereGeometry(0.030, 12, 8), { scale: [1.0, 0.85, 0.6] }), M.dark, false);
  mouthOpen.position.set(0, -0.016, 0.040);
  mouthOpen.scale.setScalar(0.01);
  const tongue = add(B.jaw, xform(new THREE.SphereGeometry(0.016, 10, 7), { scale: [1.1, 0.55, 1.0] }), M.pink, false);
  tongue.position.set(0, -0.024, 0.052);
  tongue.scale.setScalar(0.01);
  // whiskers: muzzle set + brow set
  if (fine) {
    const muz = [], brow = [];
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const len = 0.205 - i * 0.016 + R() * 0.02;
        const g = new THREE.CylinderGeometry(0.0013, 0.0052, len, 4, 1);
        g.translate(0, len * 0.5, 0);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.30 + i * 0.05, 0, s * (1.18 + i * 0.17)));
        muz.push(xform(g, { pos: [s * 0.064, 0.006 - i * 0.014, 0.030], quat: q }));
      }
      for (let i = 0; i < 2; i++) {
        const len = 0.115;
        const g = new THREE.CylinderGeometry(0.0012, 0.0042, len, 4, 1);
        g.translate(0, len * 0.5, 0);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.60 - i * 0.14, 0, s * (0.60 + i * 0.24)));
        brow.push(xform(g, { pos: [s * 0.090, 0.094, 0.140], quat: q }));
      }
    }
    add(B.muzzle, mergeGeos(muz), M.whisker, false).name = 'whiskers';
    add(B.head, mergeGeos(brow), M.whisker, false).name = 'browWhiskers';
  }

  /* ---- ears */
  const earKind = spec.ear;
  const earOut = spec.gear === 'helmet' ? 0.022 : 0;
  for (const s of [-1, 1]) {
    const b = s < 0 ? B.earL : B.earR;
    b.position.set(s * (0.096 + earOut), 0.146 + (earOut ? 0.010 : 0), -0.004);
    const baseTilt = earKind === 'fold' ? 0.80 : earKind === 'curl' ? -0.45 : -0.06;
    b.rotation.set(baseTilt, s * 0.34, s * (earKind === 'round' ? 0.36 : 0.30));
    b.userData.rest = b.rotation.clone();
    const shape = earShape(earKind);
    const outer = planarUV(extrudeShape(shape, 0.024, 0.005));
    add(b, outer, M.ear);
    const inner = planarUV(extrudeShape(shape, 0.010, 0.004));
    add(b, xform(inner, { pos: [0, 0.008, 0.015], scale: [0.74, 0.78, 1] }), M.pink, false);
    if (earKind === 'tuft' && fine) {
      for (let i = 0; i < 3; i++) {
        const g = new THREE.CylinderGeometry(0.0012, 0.006, 0.055, 4);
        g.translate(0, 0.028, 0);
        add(b, xform(g, { pos: [(i - 1) * 0.018, 0.155, 0], rot: [0, 0, (i - 1) * 0.30 + s * 0.1] }), M.whisker, false);
      }
    }
    if (earOut) add(B.head, xform(new THREE.TorusGeometry(0.052, 0.012, 6, 14), { pos: [s * 0.112, 0.128, -0.012], rot: [0.1, 0, s * 0.26] }), M.gear, false);
  }

  /* ---- eyes */
  const eyes = [];
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.083, 0.040, 0.126);
    g.rotation.set(-0.06, s * 0.30, 0);
    B.head.add(g);
    const r = 0.055;
    add(g, new THREE.SphereGeometry(r, 16, 12), M.sclera, false);
    const irisG = new THREE.SphereGeometry(r * 1.012, 20, 12, 0, TAU, 0, 0.86);
    irisG.rotateX(Math.PI / 2);
    planarUV(irisG);
    add(g, irisG, M.iris, false);
    const h1 = add(g, new THREE.SphereGeometry(r * 0.26, 8, 6), M.hi, false);
    // (second highlight and brow are fine-detail only)
    h1.position.set(s * -0.012 - 0.006, 0.021, r * 0.95);
    if (fine) {
      const h2 = add(g, new THREE.SphereGeometry(r * 0.11, 6, 5), M.hi, false);
      h2.position.set(0.014, -0.020, r * 0.96);
    }
    const lidUp = new THREE.Group(); g.add(lidUp);
    const lidGeo = new THREE.SphereGeometry(r * 1.10, 16, 9, 0, TAU, 0, 1.30);
    add(lidUp, lidGeo.clone(), M.head, false);
    const lidDn = new THREE.Group(); g.add(lidDn);
    const lidGeo2 = lidGeo.clone(); lidGeo2.rotateX(Math.PI);
    add(lidDn, lidGeo2, M.head, false);
    lidUp.rotation.x = -0.95; lidDn.rotation.x = 0.95;
    // brow
    const brow = add(g, xform(new THREE.SphereGeometry(0.030, 8, 6), { rot: [0, 0, s * -0.18], scale: [1.5, 0.34, 0.5] }), M.head, false);
    brow.position.set(0, 0.068, r * 0.62);
    eyes.push({ g, lidUp, lidDn, brow, side: s });
  }

  /* ---- headgear */
  const gear = new THREE.Group(); B.head.add(gear);
  let helmetShell = null;
  if (spec.gear === 'helmet') {
    const hg = new THREE.Group();
    helmetShell = hg;
    hg.position.set(0, 0.030, -0.016);
    hg.rotation.x = 0.16;
    gear.add(hg);
    const RAD = 0.212, TH = 1.12, GAP = 0.42;
    for (const p0 of [GAP, Math.PI + GAP]) {           // two shells, ear slots at the sides
      const sh = new THREE.SphereGeometry(RAD, Math.round(18 * seg) + 6, Math.round(14 * seg) + 4,
        p0, Math.PI - GAP * 2, 0, TH);
      add(hg, xform(sh, { scale: [1.02, 1.02, 1.03] }), M.gear);
    }
    const ry = RAD * Math.cos(TH) * 1.02, rr = RAD * Math.sin(TH) * 1.02;
    add(hg, xform(new THREE.TorusGeometry(rr, 0.016, 6, 26), { pos: [0, ry, 0], rot: [Math.PI / 2, 0, 0] }), M.trim, false);
    // centre stripe + peak
    const stripe = new THREE.SphereGeometry(RAD * 1.035, 16, 14, Math.PI / 2 - 0.16, 0.32, 0, TH * 0.92);
    add(hg, stripe, M.trim, false);
    const peak = new THREE.CylinderGeometry(rr * 1.06, rr * 1.06, 0.016, 16, 1, false, Math.PI - 0.72, 1.44);
    add(hg, xform(peak, { pos: [0, ry + 0.020, 0.022], rot: [-0.34, 0, 0], scale: [1, 1, 1.18] }), M.trim, false);
  } else if (spec.gear === 'cap') {
    const shell = new THREE.SphereGeometry(0.198, 20, 12, 0, TAU, 0, 0.78);
    add(gear, xform(shell, { pos: [0, 0.020, -0.030], scale: [1.03, 0.92, 1.0] }), M.gear);
    add(gear, xform(new THREE.CylinderGeometry(0.19, 0.19, 0.012, 14, 1, false, Math.PI - 0.85, 1.7), { pos: [0, 0.118, 0.055], rot: [-0.22, 0, 0], scale: [1, 1, 1.25] }), M.trim, false);
    add(gear, xform(new THREE.SphereGeometry(0.020, 8, 6), { pos: [0, 0.192, -0.025] }), M.trim, false);
  } else if (spec.gear === 'goggles') {
    const strap = new THREE.TorusGeometry(0.196, 0.017, 8, 24);
    add(gear, xform(strap, { pos: [0, 0.075, -0.010], rot: [1.30, 0, 0], scale: [1.03, 1.0, 1] }), M.gear, false);
    for (const s of [-1, 1]) {
      add(gear, xform(new THREE.CylinderGeometry(0.055, 0.050, 0.035, 14), { pos: [s * 0.083, 0.108, 0.128], rot: [1.28, 0, 0] }), M.gear, false);
      add(gear, xform(new THREE.CylinderGeometry(0.046, 0.046, 0.006, 14), { pos: [s * 0.083, 0.113, 0.146], rot: [1.28, 0, 0] }), M.glass, false);
    }
  } else if (spec.gear === 'bandana') {
    const shell = new THREE.SphereGeometry(0.200, 20, 12, 0, TAU, 0, 0.92);
    add(gear, xform(shell, { pos: [0, 0.010, -0.045], scale: [1.03, 0.88, 1.0] }), M.gear);
    add(gear, xform(new THREE.SphereGeometry(0.038, 8, 6), { pos: [-0.150, 0.055, -0.135], scale: [1, 0.8, 1] }), M.gear, false);
    for (let i = 0; i < 2; i++) {
      add(gear, xform(new THREE.ConeGeometry(0.030, 0.16, 6), { pos: [-0.190 - i * 0.030, -0.015 - i * 0.045, -0.185 - i * 0.02], rot: [0.3, 0, 1.9 + i * 0.35], scale: [1, 1, 0.45] }), M.gear, false);
    }
  } else { // visor
    add(gear, xform(new THREE.TorusGeometry(0.196, 0.016, 8, 22), { pos: [0, 0.088, -0.012], rot: [1.35, 0, 0], scale: [1.03, 1, 1] }), M.gear, false);
    const v = new THREE.CylinderGeometry(0.185, 0.185, 0.085, 18, 1, true, Math.PI - 0.85, 1.7);
    add(gear, xform(v, { pos: [0, 0.075, 0.008], rot: [-0.10, 0, 0], scale: [1, 1, 1.03] }), M.glass, false);
  }

  // Racing number across the back of the head. The chase camera looks at the back of the
  // driver for the entire race and there was nothing there but a bare dome, which is most of
  // why the R1 critics read the grid as "pale blobs in the seats". Same identity badge MK8
  // paints on its helmets. Modelled as a spherical patch cut from the SAME sphere as whatever
  // it sits on (the helmet shell, otherwise the head itself) and pushed out 1.5%, so it hugs
  // the surface instead of floating or clipping.
  if (DOM) {
    const helm = spec.gear === 'helmet';
    // radius, non-uniform scale and parent of the surface the badge lies on
    const bR = helm ? 0.212 : 0.198;
    const bS = helm ? [1.02, 1.02, 1.03] : [1.05, 0.96, 1.00];
    const bParent = helm ? helmetShell : B.head;
    const yLocal = helm ? 0.012 : 0.030;                 // below a cap brim, above the collar
    const thetaC = Math.acos(clamp(yLocal / bR, -1, 1));
    const hp = 0.40, ht = 0.38;
    const bg = new THREE.SphereGeometry(bR, 14, 10, -Math.PI / 2 - hp, hp * 2, thetaC - ht, ht * 2);
    const bm = new THREE.MeshStandardMaterial({
      map: numberTexture(spec.num, helm ? '#1b1b20' : '#f4f1e6', helm ? '#f4f1e6' : '#2b2b32'),
      transparent: true, alphaTest: 0.35, roughness: 0.32, metalness: 0.0, side: THREE.DoubleSide,
    });
    add(bParent, xform(bg, { scale: [bS[0] * 1.015, bS[1] * 1.015, bS[2] * 1.015] }), bm, false);
  }

  /* ---- arms */
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = s < 0 ? B.shoulderL : B.shoulderR;
    const el = s < 0 ? B.elbowL : B.elbowR;
    const hd = s < 0 ? B.handL : B.handR;
    const upG = new THREE.CapsuleGeometry(0.062, 0.125, 4, Math.round(12 * seg) + 4);
    add(sh, xform(upG, { pos: [0, -0.086, 0] }), M.suit);
    if (fine) add(sh, xform(new THREE.SphereGeometry(0.070, 12, 9), { pos: [0, 0.005, 0] }), M.suit, false);
    const foG = new THREE.CapsuleGeometry(0.052, 0.110, 4, Math.round(12 * seg) + 4);
    add(el, xform(foG, { pos: [0, -0.078, 0] }), M.limb);
    if (fine) add(el, xform(new THREE.TorusGeometry(0.056, 0.014, 6, 14), { pos: [0, -0.138, 0], rot: [Math.PI / 2, 0, 0] }), M.trim, false);
    // paw
    const paw = mergeGeos([
      xform(new THREE.SphereGeometry(0.052, 12, 9), { scale: [1.0, 1.15, 0.95] }),
      xform(new THREE.SphereGeometry(0.021, 8, 6), { pos: [s * 0.026, -0.030, 0.030] }),
      xform(new THREE.SphereGeometry(0.021, 8, 6), { pos: [-s * 0.004, -0.034, 0.034] }),
      xform(new THREE.SphereGeometry(0.019, 8, 6), { pos: [-s * 0.030, -0.028, 0.026] }),
    ]);
    paw.computeVertexNormals();
    add(hd, xform(paw, { pos: [0, -0.014, 0.006] }), M.trim);
    hd.rotation.x = -0.55;
    arms.push({ sh, el, hd, side: s });
  }

  /* ---- legs */
  for (const s of [-1, 1]) {
    const th = s < 0 ? B.thighL : B.thighR;
    const sn = s < 0 ? B.shinL : B.shinR;
    th.rotation.x = -0.95;
    sn.rotation.x = 0.75;
    add(th, xform(new THREE.CapsuleGeometry(0.070, 0.085, 4, 10), { pos: [0, -0.055, 0] }), M.suit);
    add(sn, xform(new THREE.CapsuleGeometry(0.050, 0.075, 4, 10), { pos: [0, -0.052, 0] }), M.suit, false);
    const foot = mergeGeos([
      xform(new THREE.SphereGeometry(0.058, 10, 8), { scale: [0.95, 0.75, 1.5] }),
      xform(new THREE.SphereGeometry(0.030, 8, 6), { pos: [0, -0.005, 0.070], scale: [1.1, 0.7, 0.9] }),
    ]);
    foot.computeVertexNormals();
    if (fine) add(sn, xform(foot, { pos: [0, -0.100, 0.030] }), M.trim, false);
  }

  /* ---- tail */
  for (let i = 0; i < B.tail.length; i++) {
    const r0 = 0.062 - i * 0.006, r1 = 0.058 - i * 0.007;
    const g = cylUV(xform(new THREE.CylinderGeometry(r1, r0, 0.125, Math.round(12 * seg) + 4, 1), { pos: [0, 0.060, 0] }), { y0: 0, y1: 0.125 });
    // scale v so the pattern runs along the whole tail
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, (i + uv.getY(k)) / B.tail.length);
    add(B.tail[i], g, M.tail, shadows && i < 2);
    if (i === B.tail.length - 1) add(B.tail[i], xform(new THREE.SphereGeometry(0.050, 10, 8), { pos: [0, 0.118, 0], scale: [1, 1.25, 1] }), M.tail, false);
    else if (fine) add(B.tail[i], xform(new THREE.SphereGeometry(0.058 - i * 0.006, 10, 8), { pos: [0, 0.120, 0] }), M.tail, false);
  }
  B.tail[0].rotation.set(-0.55, 0, 0);
  for (let i = 1; i < B.tail.length; i++) B.tail[i].rotation.set(0.22, 0, 0);
  for (const b of B.tail) b.userData.rest = b.rotation.clone();

  /* ---- rest pose */
  const REST = {};
  for (const k of ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'thighL', 'thighR', 'shinL', 'shinR', 'earL', 'earR', 'muzzle', 'jaw']) {
    REST[k] = B[k].rotation.clone();
  }
  const chestBase = torso.scale.clone();

  /* ---- runtime state */
  const grip = Object.assign({ center: [0, 0.315, 0.335], radius: 0.118, tilt: 0.60, angL: 2.55, angR: 0.60, maxTurn: 1.0 }, opts.grip || {});
  const S = {
    t: R() * 10, speed: 0, steer: 0, drift: 0, air: 0, boost: 0, tuck: 0, flinch: 0,
    cheer: 0, slump: 0, blink: 0, nextBlink: 1.2 + R() * 3, lookYaw: 0, lookPitch: 0, prevHit: false,
  };
  const phase = R() * TAU;
  let poseOverride = null;
  const _tv = new THREE.Vector3();
  const gripFrame = () => ((opts.gripParent && root.parent) ? root.parent : rig);

  function update(dt, st = {}) {
    dt = clamp(dt || 0, 0, 0.1);
    S.t += dt;
    const t = S.t;
    const vmax = st.speedMax || 26;
    const spN = clamp((st.speed || 0) / vmax, 0, 1.25);
    S.speed = damp(S.speed, spN, 6, dt);
    S.steer = damp(S.steer, clamp(st.steer || 0, -1, 1), 9, dt);
    S.drift = damp(S.drift, clamp(st.drift || 0, -1, 1), 7, dt);
    S.air = damp(S.air, st.airborne ? 1 : 0, 9, dt);
    S.boost = damp(S.boost, st.boosting ? 1 : 0, 8, dt);

    S.flinch = Math.max(0, S.flinch - dt * 1.9);
    const hit = !!st.hit;
    if (hit && !S.prevHit) S.flinch = 1;
    S.prevHit = hit;

    let cheerT = 0, slumpT = 0;
    if (st.finished || st.place != null) {
      const pl = st.place || 99;
      if (st.finished !== false) { cheerT = pl <= 3 ? 1 : 0; slumpT = pl > 3 ? 1 : 0; }
    }
    if (poseOverride) {
      if (poseOverride.name === 'cheer') cheerT = poseOverride.w;
      else if (poseOverride.name === 'slump') slumpT = poseOverride.w;
      else if (poseOverride.name === 'flinch') S.flinch = Math.max(S.flinch, poseOverride.w);
    }
    S.cheer = damp(S.cheer, cheerT, 5, dt);
    S.slump = damp(S.slump, slumpT, 4, dt);

    let tuckT = smoothstep(0.5, 0.95, S.speed) * 0.8 + S.boost * 0.5;
    if (poseOverride && poseOverride.name === 'tuck') tuckT = Math.max(tuckT, poseOverride.w);
    S.tuck = damp(S.tuck, clamp(tuckT - S.cheer, 0, 1), 4, dt);

    const st_ = S.steer, dr = S.drift, tuck = S.tuck, fl = S.flinch, ch = S.cheer, sl = S.slump;
    const breath = Math.sin(t * (1.9 + S.speed * 2.4) + phase);
    const shake = Math.sin(t * 42) * fl * fl;

    /* torso chain */
    B.hips.rotation.set(REST.hips.x + sl * 0.10, REST.hips.y + st_ * 0.06, REST.hips.z - st_ * 0.10 - dr * 0.06);
    B.spine.rotation.set(REST.spine.x + tuck * 0.20 + sl * 0.16 - ch * 0.10 + breath * 0.012 - fl * 0.14,
      REST.spine.y + st_ * 0.10, REST.spine.z - st_ * 0.13 - dr * 0.10);
    B.chest.rotation.set(REST.chest.x + tuck * 0.26 + sl * 0.24 - ch * 0.20 + breath * 0.016 - fl * 0.18,
      REST.chest.y + st_ * 0.10, REST.chest.z - st_ * 0.14 - dr * 0.10);
    torso.scale.set(chestBase.x * (1 + breath * 0.014), chestBase.y * (1 - breath * 0.010), chestBase.z * (1 + breath * 0.016));
    B.neck.rotation.set(REST.neck.x - tuck * 0.10 + sl * 0.22 - ch * 0.16, REST.neck.y + st_ * 0.06, REST.neck.z - st_ * 0.05);
    root.position.y = (opts.seatY || 0) + Math.abs(breath) * 0.004 + ch * Math.abs(Math.sin(t * 7)) * 0.030 - sl * 0.020 - S.air * 0.010;
    root.rotation.z = -st_ * 0.05 * S.speed - dr * 0.04;

    /* head: look-at + attitude */
    let ly = 0, lp = 0;
    if (st.look) {
      const p = B.head.parent;
      p.updateMatrixWorld(true);
      _tv.copy(st.look); p.worldToLocal(_tv).sub(B.head.position);
      ly = clamp(Math.atan2(_tv.x, _tv.z), -0.75, 0.75);
      lp = clamp(-Math.atan2(_tv.y, Math.hypot(_tv.x, _tv.z)), -0.45, 0.45);
    } else if (st.lookYaw != null || st.lookPitch != null) {
      ly = clamp(st.lookYaw || 0, -0.75, 0.75); lp = clamp(st.lookPitch || 0, -0.45, 0.45);
    } else {
      ly = st_ * 0.42; lp = 0;
    }
    S.lookYaw = damp(S.lookYaw, ly, 6, dt);
    S.lookPitch = damp(S.lookPitch, lp, 6, dt);
    B.head.rotation.set(REST.head.x + S.lookPitch + tuck * 0.10 + sl * 0.30 - ch * 0.34 - S.air * 0.06 + shake * 0.05,
      REST.head.y + S.lookYaw + shake * 0.10, REST.head.z - st_ * 0.10 + shake * 0.04);

    /* ears */
    const flick = Math.pow(Math.max(0, Math.sin(t * 0.9 + phase)), 24);
    for (const s of [-1, 1]) {
      const b = s < 0 ? B.earL : B.earR;
      const rest = b.userData.rest;
      const back = S.speed * 0.50 + tuck * 0.25 + fl * 0.85 + sl * 0.55 - ch * 0.22;
      const splay = Math.abs(dr) * 0.45 * (dr * s > 0 ? 1.25 : 0.6) + S.air * 0.15;
      b.rotation.set(rest.x + back + flick * 0.35 * (s > 0 ? 1 : 0.4) + Math.sin(t * 5.3 + s) * 0.02 * S.speed,
        rest.y + s * splay * 0.4 - S.lookYaw * 0.12,
        rest.z + s * (splay + fl * 0.35 - ch * 0.18) + Math.sin(t * 4.1 + s * 2) * 0.015);
    }

    /* eyes: blink, squint, look */
    if (st.noBlink) { S.blink = 0; S.nextBlink = 2.5; }
    else {
      S.nextBlink -= dt;
      if (S.nextBlink <= 0) { S.blink = 1; S.nextBlink = 2.0 + R() * 3.6; }
      if (S.blink > 0) S.blink = Math.max(0, S.blink - dt * 7.5);
    }
    const blinkV = Math.sin(clamp(S.blink, 0, 1) * Math.PI);
    const closeU = clamp(Math.max(blinkV, tuck * 0.28, fl * 0.55, sl * 0.42, ch * 0.30), 0, 1);
    const closeD = clamp(Math.max(blinkV * 0.35, ch * 0.55, fl * 0.35), 0, 1);
    for (const e of eyes) {
      e.lidUp.rotation.x = lerp(-0.95, 0.55, closeU);
      e.lidDn.rotation.x = lerp(0.95, 0.30, closeD);
      e.g.rotation.y = e.side * 0.30 + S.lookYaw * 0.35;
      e.g.rotation.x = -0.06 + S.lookPitch * 0.30;
      e.brow.position.y = 0.072 + ch * 0.014 - fl * 0.010;
      e.brow.rotation.z = e.side * -0.18 + (fl * 0.35 - ch * 0.18) * -e.side;
    }
    B.jaw.rotation.x = REST.jaw.x + ch * 0.42 + fl * 0.30 + S.speed * 0.05;
    const mo = clamp(ch * 1.0 + fl * 0.55 + S.speed * 0.12, 0.01, 1);
    mouthOpen.scale.set(mo, mo, mo);
    tongue.scale.set(mo * 0.95, mo * 0.95, mo * 0.95);
    B.muzzle.rotation.x = REST.muzzle.x - ch * 0.05;

    /* tail */
    const tw = 3.0 + S.speed * 6.0;
    for (let i = 0; i < B.tail.length; i++) {
      const b = B.tail[i], rest = b.userData.rest;
      const wave = Math.sin(t * tw - i * 0.85 + phase) * (0.05 + S.speed * 0.10 + Math.abs(dr) * 0.10);
      const up = ch * (i === 0 ? -1.05 : -0.12) + S.air * (i === 0 ? -0.35 : -0.05) - S.speed * (i === 0 ? 0.15 : 0.03);
      const down = sl * (i === 0 ? 0.55 : 0.10) + fl * (i === 0 ? 0.30 : 0.08);
      b.rotation.set(rest.x + up + down + wave * 0.5,
        rest.y + dr * (0.30 - i * 0.03) + wave * 0.6,
        rest.z + wave);
    }

    /* legs sink slightly under braking / air */
    B.thighL.rotation.x = REST.thighL.x - S.air * 0.14 + sl * 0.10;
    B.thighR.rotation.x = REST.thighR.x - S.air * 0.14 + sl * 0.10;

    /* arms */
    if (opts.noGrip) {
      const sway = Math.sin(t * 1.7 + phase) * 0.05;
      for (const arm of arms) {
        arm.sh.rotation.set(-0.55 + sway + ch * -0.9 + sl * 0.25 - fl * 0.2, 0, arm.side * (0.42 + Math.abs(dr) * 0.2));
        arm.sh.quaternion.setFromEuler(arm.sh.rotation);
        arm.el.rotation.set(0.95 - ch * 0.55 + sway * 0.5, 0, 0);
      }
    } else if (grip) {
      const turn = -S.steer * grip.maxTurn;
      const ct = Math.cos(grip.tilt), stl = Math.sin(grip.tilt);
      root.updateMatrixWorld(true);
      for (const arm of arms) {
        const ang = (arm.side < 0 ? grip.angL : grip.angR) + turn;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        _tv.set(grip.center[0] + ca * grip.radius,
          grip.center[1] + sa * grip.radius * ct + ch * 0.34 - sl * 0.06,
          grip.center[2] - sa * grip.radius * stl - tuck * 0.03);
        if (ch > 0.02) { _tv.x += arm.side * ch * 0.16; _tv.y += ch * 0.30; _tv.z -= ch * 0.10; }
        if (fl > 0.02) { _tv.y -= fl * 0.02; }
        gripFrame().localToWorld(_tv);
        B.chest.worldToLocal(_tv);
        solveArm(arm.sh, arm.el, 0.175, 0.160, _tv, arm.side);
      }
    }
  }

  const api = {
    id: spec.id, spec, object3D: root, rig, bones: B, materials: M, eyes, arms,
    state: S,
    setPose(name, w = 1) { poseOverride = name ? { name, w: clamp(w, 0, 1) } : null; },
    setGrip(g) { Object.assign(grip, g); },
    setDetail() { /* reserved */ },
    update,
    dispose() {
      root.traverse(o => { if (o.isMesh) { o.geometry.dispose?.(); } });
      for (const k in M) M[k].dispose?.();
    },
  };
  update(0.016, {});
  return api;
}

/* ------------------------------------------------------------------- IK */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _m1 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _ax = new THREE.Vector3(1, 0, 0);
function solveArm(shoulder, elbow, a, b, targetLocal, poleSign) {
  const d = _v1.copy(targetLocal).sub(shoulder.position);
  const c = d.length();
  if (c < 1e-4) return;
  const cc = clamp(c, Math.abs(a - b) + 1e-3, (a + b) * 0.998);
  d.multiplyScalar(1 / c);
  const Y = _v2.copy(d).negate();
  const pole = _v3.set(poleSign * 0.8, -0.15, -0.58).normalize();
  const Z = _v4.copy(pole).addScaledVector(Y, -pole.dot(Y));
  if (Z.lengthSq() < 1e-8) Z.set(0, 0, 1);
  Z.normalize();
  const X = _v5.crossVectors(Y, Z).normalize();
  _m1.makeBasis(X, Y, Z);
  _q1.setFromRotationMatrix(_m1);
  const alpha = Math.acos(clamp((a * a + cc * cc - b * b) / (2 * a * cc), -1, 1));
  const beta = Math.acos(clamp((a * a + b * b - cc * cc) / (2 * a * b), -1, 1));
  _q2.setFromAxisAngle(_ax, -alpha);
  shoulder.quaternion.copy(_q1).multiply(_q2);
  elbow.rotation.set(Math.PI - beta, 0, 0);
}

export default { createCat, CAT_SPECS };
