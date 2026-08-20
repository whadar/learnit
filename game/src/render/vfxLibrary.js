/**
 * VFX asset + tuning library.
 *
 * Everything the particle system draws is authored here, procedurally, as raw RGBA pixels —
 * no canvas 2D calls, no downloads — so the same code runs in the browser and in a headless
 * node simulation (tools/sim/vfx.mjs) and produces byte-identical atlases every run.
 *
 * Exports
 *   buildSpriteAtlas(opts)  -> { texture, cols, rows, names, rect(name), index(name) }
 *   buildDecalAtlas(opts)   -> same shape, for ground decals
 *   PALETTE, TIERS, tierColor(t), SURFACE_FX, surfaceFX(name), PRESETS, preset(name)
 *
 * Sprites are authored white/neutral: colour comes from the per-particle colour ramp so one
 * atlas cell serves limestone dust, tyre smoke and gunpowder alike.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ noise ---- */
/** Deterministic 2D integer hash -> [0,1). Same numbers on every machine. */
function h2(x, y, s = 0) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** Value noise with smoothstep interpolation. */
function vnoise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy, s), b = h2(ix + 1, iy, s), c = h2(ix, iy + 1, s), d = h2(ix + 1, iy + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
/** Value noise that tiles with period `p` on both axes (used for the tyre-mark strip). */
function tnoise(x, y, p, s = 0) {
  const wrap = (i) => ((i % p) + p) % p;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(wrap(ix), wrap(iy), s), b = h2(wrap(ix + 1), wrap(iy), s);
  const c = h2(wrap(ix), wrap(iy + 1), s), d = h2(wrap(ix + 1), wrap(iy + 1), s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, s = 0, oct = 4, gain = 0.5, lac = 2) {
  let f = 1, a = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, s + i * 37); norm += a; f *= lac; a *= gain; }
  return sum / norm;
}
function tfbm(x, y, p, s = 0, oct = 4, gain = 0.5) {
  let f = 1, a = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += a * tnoise(x * f, y * f, p * f, s + i * 37); norm += a; f *= 2; a *= gain; }
  return sum / norm;
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const sstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------------- sprites ---- */
/* Each sprite writes [r,g,b,a] in 0..1 for local coords u,v in 0..1 (v=0 is the TOP row of
   the cell, which is also the top of the sprite once flipped into UV space).             */

const SPRITE_FN = {
  /** Fat billowing smoke puff — the drift-smoke workhorse. */
  smoke(u, v, o) {
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const ang = Math.atan2(dy, dx);
    const lobes = 0.80 + 0.30 * fbm(Math.cos(ang) * 1.7 + 4, Math.sin(ang) * 1.7 + 4, 11, 3);
    const body = sstep(1.02, 0.12, r / lobes);
    const n = fbm(u * 5.5, v * 5.5, 3, 4);
    const n2 = fbm(u * 13, v * 13, 9, 3);
    let a = body * (0.55 + 0.85 * n) * (0.75 + 0.45 * n2);
    a = clamp01(a) * sstep(1.0, 0.86, r);
    const shade = 0.78 + 0.30 * n + 0.10 * n2;
    o[0] = shade; o[1] = shade * 0.995; o[2] = shade * 0.99; o[3] = clamp01(a);
  },
  /** Thinner, streakier smoke for wisps and heat plumes. */
  wisp(u, v, o) {
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const n = fbm(u * 3.2, v * 6.5 + 2, 21, 5, 0.55);
    const body = sstep(1.0, 0.1, r) * sstep(0.15, 0.55, n);
    o[0] = 0.9; o[1] = 0.9; o[2] = 0.92; o[3] = clamp01(body * 0.85);
  },
  /** Grainy dust cloud: softer core, dirtier edge, visible speckle. */
  dust(u, v, o) {
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const n = fbm(u * 7, v * 7, 51, 4, 0.55);
    const grain = h2(Math.floor(u * 128), Math.floor(v * 128), 7);
    const body = Math.pow(clamp01(1 - r), 1.55) * (0.45 + 0.95 * n);
    const a = clamp01(body * (0.82 + 0.30 * grain)) * sstep(1.0, 0.8, r);
    const shade = 0.85 + 0.25 * n;
    o[0] = shade; o[1] = shade * 0.985; o[2] = shade * 0.95; o[3] = a;
  },
  /** Four-point spark star with a hot core — mini-turbo charge. */
  spark(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2, r = Math.hypot(dx, dy);
    const core = Math.exp(-r * r * 26);
    const glow = Math.pow(clamp01(1 - r), 3) * 0.5;
    const ax = Math.exp(-(dy * dy) * 260) * Math.pow(clamp01(1 - Math.abs(dx)), 2.2);
    const ay = Math.exp(-(dx * dx) * 260) * Math.pow(clamp01(1 - Math.abs(dy)), 2.2);
    const dg = Math.abs(dx) + Math.abs(dy);
    const diag = Math.exp(-Math.pow(Math.abs(Math.abs(dx) - Math.abs(dy)) * 5.5, 2)) * Math.pow(clamp01(1 - dg * 0.72), 3) * 0.35;
    const a = clamp01(core + glow + (ax + ay) * 0.85 + diag);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = a * sstep(1.02, 0.9, r);
  },
  /** Soft radial flare / glow, used for boost cores, item flashes, sun motes. */
  flare(u, v, o) {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.pow(clamp01(1 - r), 2.4) * 0.85 + Math.exp(-r * r * 16) * 0.5;
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a) * sstep(1.0, 0.88, r);
  },
  /** Soft annulus: water ripple rings, ground shock rings. */
  ring(u, v, o) {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const ang = Math.atan2(v - 0.5, u - 0.5);
    const wobble = 0.03 * (fbm(Math.cos(ang) * 2.4 + 9, Math.sin(ang) * 2.4 + 9, 71, 3) - 0.5);
    const d = r - (0.80 + wobble);
    const a = Math.exp(-(d * d) / 0.0075) * (0.75 + 0.5 * fbm(Math.cos(ang) * 5 + 3, Math.sin(ang) * 5 + 3, 17, 3));
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a) * sstep(1.02, 0.94, r);
  },
  /** Hard thin shockwave ring for impacts. */
  shock(u, v, o) {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const d = r - 0.86;
    const a = Math.exp(-(d * d) / 0.0016) + Math.exp(-(d * d) / 0.02) * 0.22;
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a) * sstep(1.02, 0.97, r);
  },
  /** Irregular gravel chip / straw fleck, opaque with shading. */
  chip(u, v, o) {
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const ang = Math.atan2(dy, dx);
    const rad = 0.62 + 0.26 * fbm(Math.cos(ang) * 2.1 + 13, Math.sin(ang) * 2.1 + 13, 33, 2);
    const a = sstep(rad + 0.06, rad - 0.06, r);
    const lit = 0.62 + 0.55 * clamp01(0.5 - (dy + dx * 0.4)) + 0.18 * vnoise(u * 9, v * 9, 5);
    o[0] = lit; o[1] = lit * 0.97; o[2] = lit * 0.9; o[3] = a;
  },
  /** Teardrop flame with a white-hot base grading to a cooler tip. */
  flame(u, v, o) {
    const y = 1 - v;                             // 0 at tip (top of cell), 1 at base
    const halfW = 0.10 + 0.30 * Math.pow(y, 0.62) * (1 - 0.25 * (1 - y));
    const dx = Math.abs(u - 0.5);
    const erode = 0.72 + 0.55 * fbm(u * 6, v * 3.5 + 1, 61, 4, 0.55);
    let a = sstep(halfW * erode, halfW * 0.28, dx) * sstep(0.02, 0.20, y) * sstep(1.0, 0.86, y);
    a *= 0.55 + 0.65 * fbm(u * 9 + 3, v * 5 + 7, 63, 3);
    const hot = clamp01(Math.pow(y, 1.5) * 1.25 + Math.exp(-(dx * dx) / 0.006) * 0.5);
    o[0] = 1; o[1] = 0.42 + 0.58 * hot; o[2] = 0.12 + 0.85 * hot * hot; o[3] = clamp01(a);
  },
  /** Water droplet: elongated teardrop with a specular pip. */
  drop(u, v, o) {
    const y = 1 - v, dx = u - 0.5;
    const w = 0.11 + 0.20 * Math.pow(clamp01(y * 1.15), 0.8) * (1 - y * 0.35);
    const a = sstep(w, w * 0.3, Math.abs(dx)) * sstep(0.0, 0.14, y) * sstep(1.0, 0.72, y);
    const spec = Math.exp(-(((u - 0.44) ** 2) / 0.0018 + ((v - 0.62) ** 2) / 0.004));
    const lit = 0.72 + 0.9 * spec;
    o[0] = lit * 0.86; o[1] = lit * 0.95; o[2] = lit; o[3] = clamp01(a);
  },
  /** Leaf / olive-leaf silhouette with a midrib. */
  leaf(u, v, o) {
    const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
    const w = 0.62 * Math.sqrt(clamp01(1 - y * y));
    const inside = Math.abs(x) < w;
    const edge = sstep(w, w * 0.72, Math.abs(x));
    const rib = Math.exp(-(x * x) / 0.006) * 0.35;
    const shade = 0.62 + 0.42 * clamp01(0.5 + x * 0.7) - rib;
    o[0] = shade * 0.95; o[1] = shade; o[2] = shade * 0.72;
    o[3] = inside ? clamp01(edge) * (0.9 + 0.1 * vnoise(u * 12, v * 12, 3)) : 0;
  },
  /** Straw / dry grass blade. */
  straw(u, v, o) {
    const y = 1 - v;
    const bend = 0.18 * y * y;
    const dx = u - (0.5 - bend);
    const w = 0.055 * (1 - 0.55 * y);
    const a = sstep(w, w * 0.2, Math.abs(dx)) * sstep(0.0, 0.06, y) * sstep(1.0, 0.9, y);
    const lit = 0.75 + 0.4 * clamp01(0.5 - dx * 4);
    o[0] = lit; o[1] = lit * 0.94; o[2] = lit * 0.62; o[3] = clamp01(a);
  },
  /** Five-point cartoon star: spin-out and item hits. */
  star(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) + Math.PI / 2;
    const k = Math.cos(((ang % (Math.PI * 2 / 5)) + Math.PI * 2 / 5) % (Math.PI * 2 / 5) - Math.PI / 5);
    const rad = 0.92 * (0.42 / Math.max(k, 0.12));
    const a = sstep(Math.min(rad, 1.0) + 0.045, Math.min(rad, 1.0) - 0.045, r);
    const glow = Math.pow(clamp01(1 - r), 4) * 0.30;
    const lit = 1 - 0.16 * clamp01(r);
    o[0] = lit; o[1] = lit; o[2] = lit * 0.92; o[3] = clamp01(a + glow);
  },
  /** Horizontal speed streak, soft at both ends. */
  streak(u, v, o) {
    const dy = v - 0.5, dx = (u - 0.5) * 2;
    const a = Math.exp(-(dy * dy) / 0.0026) * Math.pow(clamp01(1 - Math.abs(dx)), 1.35);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a);
  },
  /** Tiny sun-lit mote with a faint cross-glint. */
  mote(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2, r = Math.hypot(dx, dy);
    const core = Math.exp(-r * r * 30);
    const cross = (Math.exp(-(dy * dy) * 420) + Math.exp(-(dx * dx) * 420)) * Math.pow(clamp01(1 - r), 3) * 0.22;
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(core + cross);
  },
  /** Distant circling bird: a soft "M" silhouette (alpha only, dark tint). */
  bird(u, v, o) {
    const x = (u - 0.5) * 2, y = (v - 0.52) * 2;
    const ax = Math.abs(x);
    const wing = -0.55 * Math.pow(ax, 0.85) + 0.34 * ax * ax;   // gull curve
    const d = Math.abs(y - wing);
    const thick = 0.16 * (1 - 0.55 * ax);
    const a = sstep(thick, thick * 0.25, d) * sstep(1.02, 0.86, ax);
    o[0] = 0.24; o[1] = 0.22; o[2] = 0.20; o[3] = clamp01(a);
  },
  /** Mud / grime blob for kart spatter (opaque, ragged). */
  blob(u, v, o) {
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const ang = Math.atan2(dy, dx);
    const rad = 0.55 + 0.30 * fbm(Math.cos(ang) * 2.6 + 21, Math.sin(ang) * 2.6 + 21, 41, 3);
    const n = fbm(u * 8, v * 8, 23, 3);
    const a = sstep(rad + 0.10, rad - 0.12, r) * (0.72 + 0.5 * n);
    const lit = 0.68 + 0.42 * n;
    o[0] = lit; o[1] = lit * 0.93; o[2] = lit * 0.85; o[3] = clamp01(a);
  },
};

export const SPRITES = [
  'smoke', 'wisp', 'dust', 'spark', 'flare',
  'ring', 'shock', 'chip', 'flame', 'drop',
  'leaf', 'straw', 'star', 'streak', 'mote',
  'bird', 'blob',
];
/** Sprite name -> atlas cell index (row-major, 5 columns x 4 rows). */
export const SPRITE_INDEX = Object.freeze(SPRITES.reduce((m, n, i) => (m[n] = i, m), {}));

/* ----------------------------------------------------------------- decals ---- */
const DECAL_FN = {
  /** Tyre skid strip. Tiles vertically (v) so consecutive trail quads join seamlessly. */
  tyre(u, v, o) {
    const dx = Math.abs(u - 0.5) * 2;
    const body = sstep(1.0, 0.55, dx);
    const ribs = 0.72 + 0.28 * Math.pow(Math.abs(Math.sin((u - 0.5) * Math.PI * 7)), 0.6);
    const tread = 0.78 + 0.34 * Math.pow(Math.abs(Math.sin(v * Math.PI * 12)), 0.35);
    const n = tfbm(u * 5, v * 8, 8, 5, 4, 0.55);
    const a = clamp01(body * ribs * tread * (0.55 + 0.85 * n)) * (1 - 0.25 * dx);
    o[0] = 0.16; o[1] = 0.155; o[2] = 0.16; o[3] = clamp01(a);
  },
  /** Broad scuffed patch: launch marks, spin-outs. */
  scuff(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2, r = Math.hypot(dx, dy * 0.85);
    const n = fbm(u * 4.5, v * 4.5, 91, 4, 0.55);
    const streak = 0.6 + 0.6 * fbm(u * 2.2, v * 11, 93, 3);
    const a = sstep(1.0, 0.15, r) * (0.35 + 0.9 * n) * streak;
    o[0] = 0.19; o[1] = 0.18; o[2] = 0.19; o[3] = clamp01(a * 0.9);
  },
  /** Mud / dust splat: central blob plus deterministic satellite droplets. */
  splat(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const ang = Math.atan2(dy, dx), r = Math.hypot(dx, dy);
    const rad = 0.46 + 0.20 * fbm(Math.cos(ang) * 2.8 + 5, Math.sin(ang) * 2.8 + 5, 101, 3);
    let a = sstep(rad + 0.07, rad - 0.05, r);
    for (let i = 0; i < 14; i++) {                       // satellites
      const t = h2(i, 3, 77) * Math.PI * 2, d = 0.45 + 0.5 * h2(i, 9, 78);
      const sx = Math.cos(t) * d, sy = Math.sin(t) * d, sr = 0.045 + 0.075 * h2(i, 11, 79);
      a = Math.max(a, sstep(sr, sr * 0.35, Math.hypot(dx - sx, dy - sy)));
    }
    const n = fbm(u * 9, v * 9, 103, 3);
    o[0] = 0.42; o[1] = 0.33; o[2] = 0.22; o[3] = clamp01(a * (0.7 + 0.5 * n));
  },
  /** Soot / scorch from an explosion, with radiating streaks. */
  scorch(u, v, o) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2, r = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const rays = 0.62 + 0.55 * fbm(Math.cos(ang) * 6 + 2, Math.sin(ang) * 6 + 2, 111, 3);
    const a = Math.pow(clamp01(1 - r), 1.7) * rays * (0.6 + 0.6 * fbm(u * 6, v * 6, 113, 4));
    o[0] = 0.10; o[1] = 0.09; o[2] = 0.09; o[3] = clamp01(a);
  },
};
export const DECALS = ['tyre', 'scuff', 'splat', 'scorch'];
export const DECAL_INDEX = Object.freeze(DECALS.reduce((m, n, i) => (m[n] = i, m), {}));

/* ------------------------------------------------------------ atlas build ---- */
function rasterise(names, fns, cell, cols, rows) {
  const W = cols * cell, H = rows * cell;
  const data = new Uint8Array(W * H * 4);
  const o = [0, 0, 0, 0];
  for (let n = 0; n < names.length; n++) {
    const fn = fns[names[n]];
    if (!fn) continue;
    const cx = (n % cols) * cell, cy = Math.floor(n / cols) * cell;
    for (let y = 0; y < cell; y++) {
      const v = (y + 0.5) / cell;
      for (let x = 0; x < cell; x++) {
        const u = (x + 0.5) / cell;
        o[0] = o[1] = o[2] = o[3] = 0;
        fn(u, v, o);
        // premultiplied-ish authoring: keep straight alpha, but kill colour where alpha is 0
        const a = clamp01(o[3]);
        const p = ((cy + y) * W + (cx + x)) * 4;
        data[p] = clamp01(o[0]) * 255;
        data[p + 1] = clamp01(o[1]) * 255;
        data[p + 2] = clamp01(o[2]) * 255;
        data[p + 3] = a * 255;
      }
    }
  }
  return { data, W, H };
}

function makeAtlas(names, fns, { cell, cols, rows, srgb = true, aniso = 4 }) {
  const { data, W, H } = rasterise(names, fns, cell, cols, rows);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  const inset = 0.75 / cell;                 // keep mip bleed out of neighbouring cells
  const api = {
    texture: tex, cols, rows, cell, names,
    index: (n) => Math.max(0, names.indexOf(n)),
    /** [u0, v0, du, dv] for a named cell, already inset against mip bleed. */
    rect(n) {
      const i = Math.max(0, names.indexOf(n));
      const cx = i % cols, cy = Math.floor(i / cols);
      return [cx / cols + inset, 1 - (cy + 1) / rows + inset, 1 / cols - inset * 2, 1 / rows - inset * 2];
    },
    dispose() { tex.dispose(); },
  };
  return api;
}

/** 5x4 sprite atlas (default 128 px cells -> 640x512 texture). */
export function buildSpriteAtlas({ cell = 128 } = {}) {
  return makeAtlas(SPRITES, SPRITE_FN, { cell, cols: 5, rows: 4 });
}
/** 2x2 decal atlas (default 256 px cells -> 512 px texture). */
export function buildDecalAtlas({ cell = 256 } = {}) {
  return makeAtlas(DECALS, DECAL_FN, { cell, cols: 2, rows: 2 });
}

/* ---------------------------------------------------------------- palette ---- */
/** Colours are linear-ish sRGB triples in 0..1, tuned for ACES + the Amikam midday sun. */
const C = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export const PALETTE = {
  tyreSmoke: C(0xe8e6e4), tyreSmokeDark: C(0x9a979b),
  limestone: C(0xe6d8bd), limestoneDark: C(0xb59f7d),
  soil: C(0xd8b483), soilDark: C(0x9c7346),
  grass: C(0xa8c163), grassDark: C(0x63803a),
  straw: C(0xe4cd8c), strawDark: C(0xb2934d),
  gravel: C(0xc9bda8), gravelDark: C(0x8b8071),
  water: C(0xe6f4f7), waterDark: C(0x8fc3d2),
  mud: C(0x7a5836), mudDark: C(0x4a3520),
  boostCore: C(0xfff4d2), boostFlame: C(0xff8b2e), boostSmoke: C(0xd9cec2),
  sparkBlue: C(0x86e2ff), sparkOrange: C(0xffb03a), sparkPurple: C(0xd07bff),
  ember: C(0xffd08a), white: C(0xffffff), soot: C(0x3a3536),
  pollen: C(0xf6e5a8), leafDry: C(0xc9a35a), leafGreen: C(0x9fb35a),
  heat: C(0xf2e9d8), starHit: C(0xfff2a8),
};

/** Mini-turbo charge tiers, Mario-Kart style: blue -> orange -> purple. */
export const TIERS = [
  { name: 'none', core: PALETTE.white, glow: PALETTE.white, rate: 0, size: 0 },
  { name: 'blue', core: C(0xd8f7ff), glow: PALETTE.sparkBlue, rate: 34, size: 0.34 },
  { name: 'orange', core: C(0xfff0cd), glow: PALETTE.sparkOrange, rate: 52, size: 0.42 },
  { name: 'purple', core: C(0xf4dcff), glow: PALETTE.sparkPurple, rate: 74, size: 0.52 },
];
/** Charge tier (0..3) -> { core, glow, rate, size }. Accepts fractional tiers for blends. */
export function tierColor(t) { return TIERS[Math.max(0, Math.min(3, Math.round(t || 0)))]; }

/* ------------------------------------------------------------- surface fx ---- */
/**
 * How each driving surface throws material. `rate` is particles/second at full slip and
 * ~25 m/s; the emitter scales it by speed, slip and quality.
 */
export const SURFACE_FX = {
  tarmac: { sprite: 'smoke', a: PALETTE.tyreSmoke, b: PALETTE.tyreSmokeDark, rate: 46, size: [0.55, 2.6], rise: 0.55, drag: 1.5, chips: 0, decal: 'tyre', decalAlpha: 0.85, wet: 0 },
  asphalt: { sprite: 'smoke', a: PALETTE.tyreSmoke, b: PALETTE.tyreSmokeDark, rate: 46, size: [0.55, 2.6], rise: 0.55, drag: 1.5, chips: 0, decal: 'tyre', decalAlpha: 0.85, wet: 0 },
  road: { sprite: 'smoke', a: PALETTE.tyreSmoke, b: PALETTE.tyreSmokeDark, rate: 46, size: [0.55, 2.6], rise: 0.55, drag: 1.5, chips: 0, decal: 'tyre', decalAlpha: 0.85, wet: 0 },
  concrete: { sprite: 'smoke', a: PALETTE.tyreSmoke, b: PALETTE.gravelDark, rate: 34, size: [0.5, 2.2], rise: 0.5, drag: 1.6, chips: 0.1, decal: 'tyre', decalAlpha: 0.6, wet: 0 },
  paved: { sprite: 'smoke', a: PALETTE.tyreSmoke, b: PALETTE.gravelDark, rate: 36, size: [0.5, 2.2], rise: 0.5, drag: 1.6, chips: 0.1, decal: 'tyre', decalAlpha: 0.6, wet: 0 },
  kerb: { sprite: 'dust', a: PALETTE.limestone, b: PALETTE.gravelDark, rate: 30, size: [0.4, 1.6], rise: 0.6, drag: 1.8, chips: 0.5, decal: 'scuff', decalAlpha: 0.35, wet: 0 },
  dirt_track: { sprite: 'dust', a: PALETTE.limestone, b: PALETTE.limestoneDark, rate: 88, size: [0.8, 4.2], rise: 0.85, drag: 1.05, chips: 0.5, decal: 'scuff', decalAlpha: 0.30, wet: 0 },
  dirt: { sprite: 'dust', a: PALETTE.limestone, b: PALETTE.soilDark, rate: 96, size: [0.85, 4.6], rise: 0.9, drag: 1.0, chips: 0.6, decal: 'scuff', decalAlpha: 0.30, wet: 0 },
  unpaved: { sprite: 'dust', a: PALETTE.limestone, b: PALETTE.limestoneDark, rate: 90, size: [0.8, 4.4], rise: 0.88, drag: 1.05, chips: 0.55, decal: 'scuff', decalAlpha: 0.30, wet: 0 },
  gravel: { sprite: 'dust', a: PALETTE.gravel, b: PALETTE.gravelDark, rate: 78, size: [0.7, 3.4], rise: 0.7, drag: 1.2, chips: 1.4, decal: 'scuff', decalAlpha: 0.26, wet: 0 },
  grass: { sprite: 'dust', a: PALETTE.grass, b: PALETTE.grassDark, rate: 40, size: [0.5, 2.0], rise: 0.7, drag: 1.9, chips: 1.2, chipSprite: 'leaf', decal: 'scuff', decalAlpha: 0.18, wet: 0 },
  crop: { sprite: 'dust', a: PALETTE.straw, b: PALETTE.strawDark, rate: 58, size: [0.6, 2.8], rise: 0.85, drag: 1.5, chips: 1.6, chipSprite: 'straw', decal: 'scuff', decalAlpha: 0.22, wet: 0 },
  scrub: { sprite: 'dust', a: PALETTE.straw, b: PALETTE.grassDark, rate: 50, size: [0.55, 2.4], rise: 0.75, drag: 1.7, chips: 1.1, chipSprite: 'leaf', decal: 'scuff', decalAlpha: 0.2, wet: 0 },
  forest: { sprite: 'dust', a: PALETTE.leafDry, b: PALETTE.grassDark, rate: 42, size: [0.5, 2.2], rise: 0.7, drag: 1.8, chips: 1.3, chipSprite: 'leaf', decal: 'scuff', decalAlpha: 0.2, wet: 0 },
  orchard: { sprite: 'dust', a: PALETTE.soil, b: PALETTE.soilDark, rate: 84, size: [0.75, 3.8], rise: 0.85, drag: 1.15, chips: 0.7, decal: 'scuff', decalAlpha: 0.26, wet: 0 },
  soil: { sprite: 'dust', a: PALETTE.soil, b: PALETTE.soilDark, rate: 92, size: [0.8, 4.2], rise: 0.9, drag: 1.05, chips: 0.8, decal: 'scuff', decalAlpha: 0.3, wet: 0 },
  farmyard: { sprite: 'dust', a: PALETTE.limestone, b: PALETTE.soilDark, rate: 86, size: [0.78, 4.0], rise: 0.85, drag: 1.1, chips: 0.7, decal: 'scuff', decalAlpha: 0.28, wet: 0 },
  sand: { sprite: 'dust', a: C(0xf2ddb0), b: C(0xc9a877), rate: 110, size: [0.9, 5.0], rise: 0.95, drag: 0.95, chips: 0.4, decal: 'scuff', decalAlpha: 0.24, wet: 0 },
  water: { sprite: 'drop', a: PALETTE.water, b: PALETTE.waterDark, rate: 120, size: [0.30, 1.1], rise: 1.6, drag: 0.7, chips: 0, decal: null, decalAlpha: 0, wet: 1 },
};
export function surfaceFX(name) { return SURFACE_FX[name] || SURFACE_FX.dirt; }

/* ---------------------------------------------------------------- presets ---- */
/**
 * Emitter presets. Every field is overridable per emit() call.
 *   count  particles per burst (continuous emitters pass their own)
 *   life   [min, max] seconds
 *   size   [start, end] metres (world diameter)
 *   speed  [min, max] m/s along `dir`, plus `spread` (radians) and `jitter` (m/s random)
 *   drag   1/s exponential velocity damping;  grav  m/s^2 (negative falls)
 *   turb   [amplitude m, frequency Hz] curl-ish wander baked in the vertex shader
 *   blend  'add' | 'alpha'
 */
export const PRESETS = {
  driftSmoke: { sprite: 'smoke', blend: 'alpha', count: 1, life: [0.85, 1.5], size: [0.55, 3.0], speed: [0.6, 1.8], spread: 0.55, jitter: 0.5, drag: 1.5, grav: 0.7, turb: [0.35, 0.5], alpha: 0.5, colorA: PALETTE.tyreSmoke, colorB: PALETTE.tyreSmokeDark, fadeIn: 0.12, spin: 1.4 },
  driftSpark: { sprite: 'spark', blend: 'add', count: 1, life: [0.22, 0.42], size: [0.34, 0.06], speed: [3.5, 8.0], spread: 0.85, jitter: 1.6, drag: 3.2, grav: -3.5, turb: [0.06, 3.0], alpha: 1.0, colorA: PALETTE.sparkBlue, colorB: PALETTE.white, fadeIn: 0.04, spin: 6, stretch: 0.35 },
  miniTurbo: { sprite: 'flare', blend: 'add', count: 1, life: [0.16, 0.3], size: [0.55, 0.05], speed: [1.0, 2.5], spread: 1.2, jitter: 0.8, drag: 4.0, grav: 0.6, turb: [0.04, 4.0], alpha: 0.85, colorA: PALETTE.sparkBlue, colorB: PALETTE.white, fadeIn: 0.05 },
  boostBurst: { sprite: 'flame', blend: 'add', stretch: 0.04, count: 26, life: [0.28, 0.55], size: [0.9, 2.4], speed: [6, 16], spread: 0.5, jitter: 2.5, drag: 3.6, grav: 1.6, turb: [0.2, 2.0], alpha: 0.95, colorA: PALETTE.boostCore, colorB: PALETTE.boostFlame, fadeIn: 0.05, spin: 2 },
  boostFlame: { sprite: 'flame', blend: 'add', count: 1, life: [0.14, 0.26], size: [0.5, 1.05], speed: [2.5, 6], spread: 0.28, jitter: 0.9, drag: 5.0, grav: 1.1, turb: [0.06, 3.0], alpha: 0.9, colorA: PALETTE.boostCore, colorB: PALETTE.boostFlame, fadeIn: 0.04, stretch: 0.05 },
  boostSmoke: { sprite: 'wisp', blend: 'alpha', count: 1, life: [0.5, 1.0], size: [0.5, 2.4], speed: [1.5, 4], spread: 0.5, jitter: 0.8, drag: 2.2, grav: 1.1, turb: [0.3, 0.8], alpha: 0.28, colorA: PALETTE.boostSmoke, colorB: PALETTE.tyreSmokeDark, fadeIn: 0.12, spin: 1.2 },
  ember: { sprite: 'mote', blend: 'add', count: 1, life: [0.5, 1.1], size: [0.10, 0.02], speed: [1.5, 5], spread: 1.0, jitter: 1.4, drag: 1.6, grav: 1.4, turb: [0.25, 1.6], alpha: 1.0, colorA: PALETTE.ember, colorB: PALETTE.boostFlame, fadeIn: 0.05 },

  dust: { sprite: 'dust', blend: 'alpha', count: 1, life: [1.1, 2.2], size: [0.8, 4.6], speed: [0.8, 2.6], spread: 0.7, jitter: 0.7, drag: 1.05, grav: 0.55, turb: [0.5, 0.35], alpha: 0.42, colorA: PALETTE.limestone, colorB: PALETTE.limestoneDark, fadeIn: 0.15, spin: 0.9 },
  grassKick: { sprite: 'leaf', blend: 'alpha', count: 1, life: [0.7, 1.4], size: [0.16, 0.14], speed: [3, 8], spread: 0.7, jitter: 2.2, drag: 1.6, grav: -6.5, turb: [0.2, 2.2], alpha: 1.0, colorA: PALETTE.grass, colorB: PALETTE.grassDark, fadeIn: 0.02, spin: 9 },
  strawKick: { sprite: 'straw', blend: 'alpha', count: 1, life: [0.8, 1.7], size: [0.24, 0.2], speed: [3, 9], spread: 0.8, jitter: 2.4, drag: 1.3, grav: -5.0, turb: [0.3, 1.8], alpha: 1.0, colorA: PALETTE.straw, colorB: PALETTE.strawDark, fadeIn: 0.02, spin: 8 },
  gravelChip: { sprite: 'chip', blend: 'alpha', count: 1, life: [0.6, 1.1], size: [0.09, 0.07], speed: [4, 11], spread: 0.6, jitter: 2.0, drag: 0.5, grav: -13, turb: [0.03, 1.0], alpha: 1.0, colorA: PALETTE.gravel, colorB: PALETTE.gravelDark, fadeIn: 0.0, spin: 12 },
  splash: { sprite: 'drop', blend: 'alpha', count: 18, life: [0.5, 1.0], size: [0.3, 0.16], speed: [4, 11], spread: 0.75, jitter: 2.4, drag: 0.9, grav: -11, turb: [0.05, 1.0], alpha: 0.95, colorA: PALETTE.water, colorB: PALETTE.waterDark, fadeIn: 0.0, spin: 3, stretch: 0.5 },
  splashDrop: { sprite: 'drop', blend: 'alpha', count: 1, life: [0.5, 1.0], size: [0.3, 0.16], speed: [4, 11], spread: 0.75, jitter: 2.4, drag: 0.9, grav: -11, turb: [0.05, 1.0], alpha: 0.95, colorA: PALETTE.water, colorB: PALETTE.waterDark, fadeIn: 0.0, spin: 3, stretch: 0.5 },
  splashMist: { sprite: 'smoke', blend: 'alpha', count: 6, life: [0.6, 1.2], size: [0.5, 2.2], speed: [1, 3], spread: 0.9, jitter: 0.8, drag: 1.8, grav: 0.4, turb: [0.2, 0.9], alpha: 0.30, colorA: PALETTE.water, colorB: PALETTE.waterDark, fadeIn: 0.1, spin: 1 },
  ripple: { sprite: 'ring', blend: 'alpha', count: 1, life: [1.1, 1.6], size: [0.5, 4.2], speed: [0, 0], spread: 0, jitter: 0, drag: 0, grav: 0, turb: [0, 0], alpha: 0.5, colorA: PALETTE.water, colorB: PALETTE.water, fadeIn: 0.08, flat: 1 },
  mudSpatter: { sprite: 'blob', blend: 'alpha', count: 8, life: [0.5, 0.9], size: [0.12, 0.10], speed: [2, 6], spread: 1.1, jitter: 1.8, drag: 1.2, grav: -9, turb: [0.05, 1.2], alpha: 1.0, colorA: PALETTE.mud, colorB: PALETTE.mudDark, fadeIn: 0.0, spin: 7 },

  impact: { sprite: 'flare', blend: 'add', count: 20, life: [0.22, 0.5], size: [0.7, 0.1], speed: [8, 22], spread: 1.6, jitter: 3, drag: 4.5, grav: 0.4, turb: [0.1, 2.5], alpha: 1.0, colorA: PALETTE.white, colorB: PALETTE.boostFlame, fadeIn: 0.02, stretch: 0.4 },
  impactShock: { sprite: 'shock', blend: 'add', count: 1, life: [0.30, 0.42], size: [0.6, 6.5], speed: [0, 0], spread: 0, jitter: 0, drag: 0, grav: 0, turb: [0, 0], alpha: 0.9, colorA: PALETTE.white, colorB: PALETTE.boostCore, fadeIn: 0.02 },
  starBurst: { sprite: 'star', blend: 'add', count: 12, life: [0.6, 1.0], size: [0.42, 0.18], speed: [2.5, 5.5], spread: 3.14, jitter: 1.0, drag: 2.2, grav: 1.2, turb: [0.2, 1.4], alpha: 1.0, colorA: PALETTE.starHit, colorB: PALETTE.sparkOrange, fadeIn: 0.03, spin: 5 },
  squashPuff: { sprite: 'smoke', blend: 'alpha', count: 14, life: [0.35, 0.7], size: [0.5, 2.4], speed: [3, 7], spread: 1.5, jitter: 1.2, drag: 3.2, grav: 0.3, turb: [0.2, 1.2], alpha: 0.55, colorA: PALETTE.white, colorB: PALETTE.tyreSmokeDark, fadeIn: 0.04, spin: 2.5 },
  railSpark: { sprite: 'spark', blend: 'add', count: 16, life: [0.25, 0.55], size: [0.22, 0.03], speed: [6, 16], spread: 0.6, jitter: 3.5, drag: 2.0, grav: -8, turb: [0.05, 2.0], alpha: 1.0, colorA: PALETTE.white, colorB: PALETTE.sparkOrange, fadeIn: 0.0, spin: 4, stretch: 0.6 },
  explosionSmoke: { sprite: 'smoke', blend: 'alpha', count: 16, life: [0.9, 1.8], size: [1.2, 5.5], speed: [3, 9], spread: 1.4, jitter: 2.0, drag: 2.0, grav: 1.6, turb: [0.6, 0.7], alpha: 0.6, colorA: C(0x8f8378), colorB: PALETTE.soot, fadeIn: 0.05, spin: 1.6 },
  explosionCore: { sprite: 'flame', blend: 'add', mode: 2, count: 12, life: [0.25, 0.5], size: [1.4, 3.6], speed: [4, 12], spread: 1.5, jitter: 2.5, drag: 3.5, grav: 2.5, turb: [0.2, 2.0], alpha: 1.0, colorA: PALETTE.boostCore, colorB: PALETTE.boostFlame, fadeIn: 0.02, spin: 2 },

  pollen: { sprite: 'mote', blend: 'add', count: 1, life: [3, 6], size: [0.07, 0.05], speed: [0.2, 0.8], spread: 1.2, jitter: 0.4, drag: 0.4, grav: 0.05, turb: [0.6, 0.25], alpha: 0.75, colorA: PALETTE.pollen, colorB: PALETTE.white, fadeIn: 0.25 },
  leafDrift: { sprite: 'leaf', blend: 'alpha', count: 1, life: [2.5, 4.5], size: [0.2, 0.2], speed: [1.5, 4], spread: 0.5, jitter: 0.8, drag: 0.9, grav: -0.30, turb: [1.2, 0.5], alpha: 0.95, colorA: PALETTE.leafDry, colorB: PALETTE.leafGreen, fadeIn: 0.12, spin: 3 },
};
export function preset(name) { return PRESETS[name] || null; }

export default { buildSpriteAtlas, buildDecalAtlas, PALETTE, TIERS, tierColor, SURFACE_FX, surfaceFX, PRESETS, preset };
