/**
 * Ground material for the Ramot Menashe hills.
 *
 * Six procedurally authored surface layers — dry limestone, pale calcareous (nari) soil,
 * red-brown terra rossa, sun-bleached stubble, tilled farm soil and stony scree — are packed
 * into two texture arrays and splatted across the terrain. The blend is driven by the real
 * Overture land-cover / land-use polygons (rasterised once into a splat map), by the real
 * heightfield (slope, elevation, curvature, rasterised into an info map) and by several octaves
 * of macro noise so nothing tiles visibly.
 *
 * Everything is generated in-repo: no image assets, no network. Deterministic given the seed.
 */
import * as THREE from 'three';
import { fbmField, worleyField, boxBlurWrap, heightToNormal, hash2i } from './noise.js';

/** Surface layers, in shader index order. `scale` is the world size in metres of one tile. */
export const LAYERS = [
  { key: 'rock',  scale: 8.0,  nrm: 1.25 },   // 0 dry limestone bedrock
  { key: 'pale',  scale: 5.0,  nrm: 0.75 },   // 1 pale calcareous soil
  { key: 'terra', scale: 6.0,  nrm: 0.85 },   // 2 red-brown terra rossa
  { key: 'grass', scale: 3.2,  nrm: 0.60 },   // 3 sun-bleached stubble
  { key: 'farm',  scale: 9.5,  nrm: 0.95 },   // 4 tilled farm soil
  { key: 'scree', scale: 4.2,  nrm: 1.15 },   // 5 stony scree
];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------- canvas helpers ---- */

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Rasterise 2D drawing into a seamless luminance field (drawn nine times so strokes wrap). */
function strokeField(size, draw) {
  const cv = makeCanvas(size, size);
  const out = new Float32Array(size * size);
  if (!cv) return out;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    ctx.save(); ctx.translate(ox * size, oy * size); draw(ctx, size); ctx.restore();
  }
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0, n = size * size; i < n; i++) out[i] = d[i * 4] / 255;
  return out;
}

/* ------------------------------------------------------------ layer authoring ---- */

/**
 * Author one surface layer. Returns byte buffers ready for the texture arrays:
 *   alb — RGB albedo (sRGB)
 *   nra — R,G tangent normal xy · B roughness · A cavity AO   (linear)
 * plus, when `extra` is set, standalone normal / roughness maps for the instanced stones.
 */
function generateLayer(key, S, seed, extra = false) {
  const N = S * S;
  const hgt = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const rgh = new Float32Array(N);

  // Shared noise beds. Periods are integer lattice counts so every field is seamless.
  const relief = fbmField(S, { octaves: 6, period: 5, seed, gain: 0.52 });
  const grain = fbmField(S, { octaves: 4, period: Math.max(8, S >> 4), seed: seed + 31, gain: 0.55 });
  const macro = fbmField(S, { octaves: 3, period: 2, seed: seed + 61, gain: 0.6 });

  const put = (i, r, g, b, ro, h) => { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; rgh[i] = ro; hgt[i] = h; };

  if (key === 'rock') {
    // Layered limestone: ridged strata, broken plates, dark fissures picked out with canvas 2D.
    const strata = fbmField(S, { octaves: 5, period: 4, seed: seed + 11, ridged: true });
    const plate = worleyField(S, 6, seed + 41, 0.9);
    const chip = worleyField(S, 22, seed + 53, 0.95);
    const cracks = strokeField(S, (ctx, s) => {
      const r = mulberry(seed + 7);
      ctx.strokeStyle = '#fff'; ctx.lineCap = 'round';
      for (let k = 0; k < 46; k++) {
        let x = r() * s, y = r() * s, a = r() * Math.PI * 2;
        ctx.lineWidth = 1 + r() * 2.4;
        ctx.beginPath(); ctx.moveTo(x, y);
        const segs = 5 + (r() * 7) | 0;
        for (let i = 0; i < segs; i++) {
          a += (r() - 0.5) * 1.1;
          x += Math.cos(a) * s * 0.045; y += Math.sin(a) * s * 0.045;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
    for (let i = 0; i < N; i++) {
      const seam = clamp01(1 - (plate.f2[i] - plate.f1[i]) * 5.5);     // plate boundaries
      const fis = clamp01(cracks[i] * 1.2);
      const chipEdge = clamp01(1 - chip.f1[i] * 2.6) * 0.5;
      let h = 0.46 * strata[i] + 0.24 * relief[i] + 0.18 * grain[i] + chipEdge * 0.18;
      h -= seam * 0.34 + fis * 0.4;
      const lit = clamp01(h * 1.25 + 0.1);
      const tint = macro[i];
      // Warm cream limestone; fissures go grey-brown, faces bleach out in the sun.
      let r = mix(0.455, 0.795, lit) + tint * 0.045;
      let g = mix(0.425, 0.755, lit) + tint * 0.035;
      let b = mix(0.355, 0.655, lit) + tint * 0.015;
      const dark = clamp01(seam * 0.9 + fis * 0.85);
      r = mix(r, 0.315, dark); g = mix(g, 0.295, dark); b = mix(b, 0.255, dark);
      put(i, r, g, b, 0.62 + 0.24 * grain[i] + dark * 0.12, h);
    }
  } else if (key === 'pale') {
    // Fine calcareous dust with a scatter of small pale pebbles.
    const peb = worleyField(S, 30, seed + 71, 0.95);
    const dust = fbmField(S, { octaves: 5, period: Math.max(16, S >> 3), seed: seed + 83 });
    for (let i = 0; i < N; i++) {
      const p = clamp01(1 - peb.f1[i] * 3.2);
      const stone = p * (peb.id[i] > 0.55 ? 1 : 0.25);
      let h = 0.42 * relief[i] + 0.3 * grain[i] + 0.22 * dust[i] + stone * 0.32;
      const lit = clamp01(h * 1.1 + 0.16);
      let r = mix(0.50, 0.755, lit), g = mix(0.455, 0.70, lit), b = mix(0.355, 0.565, lit);
      r = mix(r, 0.695, stone * 0.5); g = mix(g, 0.660, stone * 0.5); b = mix(b, 0.565, stone * 0.5);
      const warm = macro[i] - 0.5;
      put(i, r + warm * 0.05, g + warm * 0.035, b + warm * 0.01, 0.86 + 0.1 * dust[i] - stone * 0.18, h);
    }
  } else if (key === 'terra') {
    // Terra rossa: red clay clods, dry shrinkage cracks, a few bleached limestone chips.
    const clod = worleyField(S, 11, seed + 91, 0.9);
    const crack = worleyField(S, 7, seed + 97, 0.75);
    const chip = worleyField(S, 26, seed + 101, 1.0);
    for (let i = 0; i < N; i++) {
      const cr = clamp01(1 - (crack.f2[i] - crack.f1[i]) * 2.8);
      const cl = clamp01(1 - clod.f1[i] * 2.0);
      const st = clamp01(1 - chip.f1[i] * 3.4) * (chip.id[i] > 0.7 ? 1 : 0);
      let h = 0.30 * relief[i] + 0.32 * grain[i] + cl * 0.30 + st * 0.3 - cr * 0.26;
      const lit = clamp01(h * 1.25 + 0.12);
      let r = mix(0.290, 0.520, lit), g = mix(0.190, 0.375, lit), b = mix(0.140, 0.270, lit);
      const warm = macro[i] - 0.5;
      r += warm * 0.055; g += warm * 0.03; b += warm * 0.012;
      r = mix(r, 0.63, st * 0.8); g = mix(g, 0.60, st * 0.8); b = mix(b, 0.525, st * 0.8);
      r = mix(r, r * 0.78, cr * 0.35); g = mix(g, g * 0.78, cr * 0.35); b = mix(b, b * 0.80, cr * 0.35);
      put(i, r, g, b, 0.84 + 0.12 * grain[i] - st * 0.2, h);
    }
  } else if (key === 'grass') {
    // Cut wheat stubble over dusty soil: straw strokes plus dry tufts.
    // Cut stalks lie every which way once the combine has been through; a single dominant
    // direction here reads as brushed fur on a hillside, so the angle is fully random and the
    // stalks are short. A faint row rhythm survives in `rowPhase`.
    const blades = strokeField(S, (ctx, s) => {
      const r = mulberry(seed + 3);
      ctx.lineCap = 'butt';
      for (let k = 0; k < 6400; k++) {
        const x = r() * s, y = r() * s, a = r() * Math.PI * 2;
        const len = s * (0.005 + r() * r() * 0.016);
        ctx.strokeStyle = `rgba(255,255,255,${0.2 + r() * 0.55})`;
        ctx.lineWidth = 0.6 + r() * 1.1;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
    });
    const tuft = fbmField(S, { octaves: 4, period: 9, seed: seed + 121 });
    const dryPatch = fbmField(S, { octaves: 3, period: 4, seed: seed + 137 });
    for (let i = 0; i < N; i++) {
      const bl = clamp01(blades[i]);
      const tf = sstep(0.44, 0.78, tuft[i]);
      let h = 0.3 * relief[i] + 0.2 * grain[i] + bl * 0.4 + tf * 0.2;
      const lit = clamp01(h * 1.15 + 0.14);
      // soil showing through -> straw -> bleached highlight
      let r = mix(0.445, 0.735, lit), g = mix(0.395, 0.670, lit), b = mix(0.250, 0.435, lit);
      r = mix(r, 0.830, bl * 0.62); g = mix(g, 0.780, bl * 0.62); b = mix(b, 0.545, bl * 0.62);
      // surviving green-grey tufts in the hollows between stubble rows
      const grn = tf * (1 - bl) * sstep(0.42, 0.78, dryPatch[i]);
      r = mix(r, 0.335, grn * 0.5); g = mix(g, 0.370, grn * 0.5); b = mix(b, 0.205, grn * 0.5);
      put(i, r, g, b, 0.82 + 0.12 * grain[i], h);
    }
  } else if (key === 'farm') {
    // Ploughed field: near-parallel furrows with clods and a reddish soil cast.
    const clod = worleyField(S, 20, seed + 151, 0.95);
    const wob = fbmField(S, { octaves: 4, period: 6, seed: seed + 163 });
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const fy = (y / S) * Math.PI * 2 * 8 + (wob[i] - 0.5) * 2.4;   // 8 furrows per tile
        const fur = 0.5 + 0.5 * Math.sin(fy);
        const cl = clamp01(1 - clod.f1[i] * 2.3);
        let h = fur * 0.26 + cl * 0.30 + 0.22 * relief[i] + 0.22 * grain[i];
        const lit = clamp01(h * 1.2 + 0.08);
        // dark moist trough -> dry crest, slightly red from the terra rossa parent rock
        let r = mix(0.300, 0.545, lit), g = mix(0.200, 0.400, lit), b = mix(0.145, 0.290, lit);
        const warm = macro[i] - 0.5;
        r += warm * 0.06; g += warm * 0.03; b += warm * 0.01;
        const st = clamp01(1 - clod.f1[i] * 3.6) * (clod.id[i] > 0.82 ? 1 : 0);
        r = mix(r, 0.615, st * 0.6); g = mix(g, 0.580, st * 0.6); b = mix(b, 0.495, st * 0.6);
        put(i, r, g, b, 0.88 + 0.08 * grain[i], h);
      }
    }
  } else { // scree
    // Loose limestone chips over pale soil — the classic Israeli hillside surface.
    const big = worleyField(S, 9, seed + 181, 0.95);
    const small = worleyField(S, 21, seed + 191, 1.0);
    for (let i = 0; i < N; i++) {
      const b1 = clamp01(1 - big.f1[i] * 2.1) * (big.id[i] > 0.42 ? 1 : 0.15);
      const s1 = clamp01(1 - small.f1[i] * 2.6) * (small.id[i] > 0.3 ? 1 : 0.2);
      const stone = clamp01(b1 * 0.85 + s1 * 0.6);
      let h = 0.24 * relief[i] + 0.18 * grain[i] + b1 * 0.5 + s1 * 0.34;
      const lit = clamp01(h * 1.2 + 0.1);
      let r = mix(0.375, 0.565, lit), g = mix(0.335, 0.51, lit), b = mix(0.245, 0.395, lit);
      const chipLit = clamp01(0.35 + big.id[i] * 0.55 + small.id[i] * 0.2);
      r = mix(r, mix(0.40, 0.715, chipLit), stone * 0.72);
      g = mix(g, mix(0.375, 0.675, chipLit), stone * 0.72);
      b = mix(b, mix(0.315, 0.575, chipLit), stone * 0.72);
      put(i, r, g, b, 0.9 - stone * 0.28, h);
    }
  }

  /* Chroma trim on the two reddest layers.
   *
   * `terra` and `farm` are authored as honest terra rossa — the parent rock really is that
   * red — but they are also, between them, most of the open ground on this course, and the
   * frame sees them through a warm key light and a grade that lifts the amber family. Round 6
   * read the aerial plates as false-colour and the verge as Mars orange, which is those three
   * multiplying. The soil keeps its hue and gives up 13 % of its saturation here, at the
   * source, rather than being fought downstream where the fix would drag the pantile roofs
   * and the boost flame down with it. Ochre, not rust. */
  if (key === 'terra' || key === 'farm') {
    for (let i = 0; i < N; i++) {
      const r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = 0.87;
      col[i * 3] = l + (r - l) * k;
      col[i * 3 + 1] = l + (g - l) * k;
      col[i * 3 + 2] = l + (b - l) * k;
    }
  }

  // Cavity AO from the difference between the height and its blurred self.
  const blur = boxBlurWrap(hgt, S, Math.max(2, S >> 6), 2);
  const alb = new Uint8Array(N * 4);
  const nra = new Uint8Array(N * 4);
  const cfg = LAYERS.find(l => l.key === key) || { nrm: 1 };
  const nrmBuf = extra ? new Uint8Array(N * 4) : null;
  const armBuf = extra ? new Uint8Array(N * 4) : null;

  heightToNormal(hgt, S, 26 * cfg.nrm, (i, nx, ny) => {
    nra[i * 4] = (nx * 0.5 + 0.5) * 255;
    nra[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
  });
  if (nrmBuf) {
    // The terrain path re-projects the normal onto the surface, so it can take a very strong
    // map; a stand-alone tangent-space map on a boulder cannot — it just goes black.
    heightToNormal(hgt, S, 7, (i, nx, ny, nz) => {
      nrmBuf[i * 4] = (nx * 0.5 + 0.5) * 255;
      nrmBuf[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      nrmBuf[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      nrmBuf[i * 4 + 3] = 255;
    });
  }
  for (let i = 0; i < N; i++) {
    const ao = clamp01(0.62 + (hgt[i] - blur[i]) * 2.6);
    alb[i * 4] = clamp01(col[i * 3]) * 255;
    alb[i * 4 + 1] = clamp01(col[i * 3 + 1]) * 255;
    alb[i * 4 + 2] = clamp01(col[i * 3 + 2]) * 255;
    alb[i * 4 + 3] = 255;
    nra[i * 4 + 2] = clamp01(rgh[i]) * 255;
    nra[i * 4 + 3] = ao * 255;
    if (armBuf) { armBuf[i * 4] = ao * 255; armBuf[i * 4 + 1] = clamp01(rgh[i]) * 255; armBuf[i * 4 + 2] = 0; armBuf[i * 4 + 3] = 255; }
  }
  return { alb, nra, nrm: nrmBuf, arm: armBuf };
}

/** Local deterministic PRNG (kept here so texture authoring never touches Math.random). */
function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ r >>> 15, r | 1); r ^= r + Math.imul(r ^ r >>> 7, r | 61); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
}

/* -------------------------------------------------------------- world rasters ---- */

const FARM_CLS = new Set(['farmland', 'meadow', 'orchard', 'vineyard', 'farmyard', 'allotments', 'greenhouse_horticulture']);

/** Fill the polygons of a feature list into a canvas as white, returning the red channel. */
function rasterisePolys(size, extent, features, accept) {
  const cv = makeCanvas(size, size);
  const out = new Float32Array(size * size);
  if (!cv) return out;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
  const k = size / extent, o = size * 0.5;
  let drew = 0;
  for (const f of features) {
    const w = accept(f);
    if (!w) continue;
    ctx.beginPath();
    for (const path of f.paths || []) {
      if (!path || path.length < 2) continue;
      ctx.moveTo(path[0][0] * k + o, path[0][1] * k + o);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0] * k + o, path[i][1] * k + o);
      if (f.poly) ctx.closePath();
    }
    if (f.poly) ctx.fill();
    else { ctx.lineWidth = Math.max(1, (w === true ? 8 : w) * k); ctx.stroke(); }
    drew++;
  }
  if (!drew) return out;
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0, n = size * size; i < n; i++) out[i] = d[i * 4] / 255;
  return out;
}

/** Non-wrapping separable box blur — softens the hard polygon edges into believable margins. */
function blurField(src, size, radius) {
  const a = Float32Array.from(src), b = new Float32Array(src.length);
  const r = Math.max(1, radius | 0), n = 2 * r + 1;
  const cl = (v, m) => (v < 0 ? 0 : v > m ? m : v);
  for (let y = 0; y < size; y++) {
    const row = y * size; let s = 0;
    for (let k = -r; k <= r; k++) s += a[row + cl(k, size - 1)];
    for (let x = 0; x < size; x++) { b[row + x] = s / n; s -= a[row + cl(x - r, size - 1)]; s += a[row + cl(x + r + 1, size - 1)]; }
  }
  for (let x = 0; x < size; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += b[cl(k, size - 1) * size + x];
    for (let y = 0; y < size; y++) { a[y * size + x] = s / n; s -= b[cl(y - r, size - 1) * size + x]; s += b[cl(y + r + 1, size - 1) * size + x]; }
  }
  return a;
}

/**
 * Splat map from the real Overture polygons.
 *   R farmland / orchard   G grass & crop cover   B forest & shrub   A barren & bare rock
 */
export function buildSplatTexture(world, size = 1024) {
  const ex = world.extent;
  const lu = world.landuse || [], lc = world.landcover || [];
  const farm = rasterisePolys(size, ex, lu, f => FARM_CLS.has(f.cls) && f.poly);
  const crop = rasterisePolys(size, ex, lc, f => f.sub === 'crop' && f.poly);
  const grass = rasterisePolys(size, ex, lc, f => (f.sub === 'grass' || f.sub === 'shrub') && f.poly);
  const wood = rasterisePolys(size, ex, lc, f => f.sub === 'forest' && f.poly);
  const bare = rasterisePolys(size, ex, lc, f => f.sub === 'barren' && f.poly);

  const R = blurField(farm, size, Math.max(1, size >> 8));
  const G = blurField(grass, size, Math.max(2, size >> 7));
  const W = blurField(wood, size, Math.max(2, size >> 8));
  const B = blurField(bare, size, Math.max(2, size >> 7));
  const C = blurField(crop, size, Math.max(1, size >> 8));

  // Overture polygons overlap heavily here — a single spot is routinely tagged grass AND
  // shrub AND forest AND barren. Resolve that into a partition by priority (bare rock wins,
  // then woodland, then cultivation, then rough grazing) so the shader gets a clean signal.
  const data = new Uint8Array(size * size * 4);
  for (let i = 0, n = size * size; i < n; i++) {
    const wBare = clamp01(B[i]);
    const wWood = clamp01(W[i]) * (1 - wBare);
    const wFarm = clamp01(R[i] + C[i] * 0.8) * (1 - wBare) * (1 - wWood * 0.85);
    const wGrass = clamp01(G[i] * 0.95 + C[i] * 0.3) * (1 - wBare) * (1 - wWood) * (1 - wFarm);
    data[i * 4] = wFarm * 255;
    data[i * 4 + 1] = wGrass * 255;
    data[i * 4 + 2] = wWood * 255;
    data[i * 4 + 3] = wBare * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Terrain-derived info map: R normalised elevation, G cosine of slope, B curvature
 * (<0.5 concave hollow, >0.5 convex crest), A slow regional noise for large-scale colour drift.
 */
export function buildInfoTexture(world, size = 512) {
  const ex = world.extent, half = ex * 0.5, s = ex / size;
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -half + (j + 0.5) * s;
    for (let i = 0; i < size; i++) h[j * size + i] = world.heightAt(-half + (i + 0.5) * s, z);
  }
  const at = (i, j) => h[Math.max(0, Math.min(size - 1, j)) * size + Math.max(0, Math.min(size - 1, i))];
  // Curvature has to be measured at landform scale (~50 m). Sampled tightly it just picks up
  // DEM noise, and the shader then paints the hillside in leopard spots.
  const wide = Math.max(3, Math.round(50 / s));
  const varField = fbmField(size, { octaves: 4, period: 3, seed: 20240 });
  const curv = new Float32Array(size * size);
  const slope = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const hl = at(i - 1, j), hr = at(i + 1, j), hd = at(i, j - 1), hu = at(i, j + 1);
      const nx = hl - hr, nz = hd - hu, ny = 2 * s;
      slope[k] = ny / Math.hypot(nx, ny, nz);
      curv[k] = (at(i - wide, j) + at(i + wide, j) + at(i, j - wide) + at(i, j + wide)) * 0.25 - h[k];
    }
  }
  const curvS = blurField(curv, size, Math.max(2, Math.round(18 / s)));
  const data = new Uint8Array(size * size * 4);
  const range = Math.max(1, world.maxH - world.minH);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = clamp01((h[k] - world.minH) / range) * 255;
    data[k * 4 + 1] = clamp01(slope[k]) * 255;
    data[k * 4 + 2] = clamp01(0.5 - curvS[k] * 0.13) * 255;   // <0.5 hollow, >0.5 crest
    data[k * 4 + 3] = clamp01(varField[k]) * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Small tileable RGBA noise used for macro breakup and land-cover edge warping. */
function buildMacroTexture(size = 256) {
  const a = fbmField(size, { octaves: 5, period: 3, seed: 771 });
  const b = fbmField(size, { octaves: 5, period: 4, seed: 913 });
  const c = fbmField(size, { octaves: 6, period: 2, seed: 1337 });
  const d = fbmField(size, { octaves: 4, period: 7, seed: 2251 });
  const data = new Uint8Array(size * size * 4);
  for (let i = 0, n = size * size; i < n; i++) {
    data[i * 4] = a[i] * 255; data[i * 4 + 1] = b[i] * 255;
    data[i * 4 + 2] = c[i] * 255; data[i * 4 + 3] = d[i] * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ textures ---- */

/** Author every layer and pack them into the two array textures the shader samples. */
export function buildLayerTextures(size = 1024, seed = 4711) {
  const n = LAYERS.length, px = size * size * 4;
  const albData = new Uint8Array(px * n);
  const nraData = new Uint8Array(px * n);
  let stone = null;
  for (let i = 0; i < n; i++) {
    const L = generateLayer(LAYERS[i].key, size, seed + i * 1009, LAYERS[i].key === 'rock');
    albData.set(L.alb, px * i);
    nraData.set(L.nra, px * i);
    if (L.nrm) stone = { alb: L.alb, nrm: L.nrm, arm: L.arm };
  }
  const alb = new THREE.DataArrayTexture(albData, size, size, n);
  alb.format = THREE.RGBAFormat; alb.type = THREE.UnsignedByteType;
  alb.colorSpace = THREE.SRGBColorSpace;
  const nra = new THREE.DataArrayTexture(nraData, size, size, n);
  nra.format = THREE.RGBAFormat; nra.type = THREE.UnsignedByteType;
  nra.colorSpace = THREE.NoColorSpace;
  for (const t of [alb, nra]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 2;
    t.needsUpdate = true;
  }
  return { alb, nra, stone, size };
}

/** Matching material for the scattered limestone rocks and dry-stone terrace ledges. */
export function createStoneMaterial(stone, size) {
  if (!stone) return new THREE.MeshStandardMaterial({ color: 0xa89e8a, roughness: 0.88, metalness: 0 });
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = 2; t.needsUpdate = true;
    return t;
  };
  const map = mk(stone.alb, true), normalMap = mk(stone.nrm, false), armMap = mk(stone.arm, false);
  // No aoMap here on purpose: on objects this small a baked cavity term mostly just drags the
  // shaded faces towards black under a hard single-sun rig.
  return new THREE.MeshStandardMaterial({
    map, normalMap, roughnessMap: armMap,
    normalScale: new THREE.Vector2(0.85, 0.85), roughness: 0.88, metalness: 0,
    color: 0xffffff, dithering: true,
  });
}

/* ------------------------------------------------------------------ material ---- */

const DECLS = /* glsl */`
uniform sampler2D kSplat;
uniform sampler2D kInfo;
uniform sampler2D kMacro;
uniform highp sampler2DArray kAlb;
uniform highp sampler2DArray kNra;
uniform float kExtent;
uniform float kInvScale[6];
uniform vec4  kDetail;      // fine start, fine end, medium start, medium end
uniform float kQuality;
uniform float kNormalStr;
varying vec3 vWPos;
varying vec3 vWNrm;

vec3 kWpG; vec3 kWnG; vec3 kBwG; bool kTriG; vec2 kWarpG;
vec2 kDyx, kDyy, kDxx, kDxy, kDzx, kDzy;

void kFetch(int li, float inv, out vec4 A, out vec3 nW, out float rgh, out float ao) {
  // Every layer reads a slowly warped, per-layer-offset world position: that is what stops an
  // 8 m tile from reading as an 8 m grid on a hillside 200 m away. The warp is damped on the
  // ploughed field, where it would bend what should be straight furrows into swirls.
  float warpAmt = (li == 4) ? 0.10 : 1.0;
  vec2 wxz = kWpG.xz + kWarpG * warpAmt + vec2(float(li) * 13.7, float(li) * -21.3);
  vec2 uvY = wxz * inv;
  vec4 nY = textureGrad(kNra, vec3(uvY, float(li)), kDyx * inv, kDyy * inv);
  A = textureGrad(kAlb, vec3(uvY, float(li)), kDyx * inv, kDyy * inv);
  vec2 gy = (nY.xy * 2.0 - 1.0) * kNormalStr;
  rgh = nY.z; ao = nY.w;
  if (kTriG) {
    vec2 uvX = vec2(wxz.y, -kWpG.y) * inv;
    vec2 uvZ = vec2(wxz.x, -kWpG.y) * inv;
    vec4 aX = textureGrad(kAlb, vec3(uvX, float(li)), kDxx * inv, kDxy * inv);
    vec4 aZ = textureGrad(kAlb, vec3(uvZ, float(li)), kDzx * inv, kDzy * inv);
    vec4 nX = textureGrad(kNra, vec3(uvX, float(li)), kDxx * inv, kDxy * inv);
    vec4 nZ = textureGrad(kNra, vec3(uvZ, float(li)), kDzx * inv, kDzy * inv);
    A = A * kBwG.y + aX * kBwG.x + aZ * kBwG.z;
    rgh = rgh * kBwG.y + nX.z * kBwG.x + nZ.z * kBwG.z;
    ao = ao * kBwG.y + nX.w * kBwG.x + nZ.w * kBwG.z;
    vec2 gx = (nX.xy * 2.0 - 1.0) * kNormalStr;
    vec2 gz = (nZ.xy * 2.0 - 1.0) * kNormalStr;
    // whiteout blend of the three tangent-space normals into world space
    vec3 tX = vec3(gx + kWnG.zy, kWnG.x);
    vec3 tY = vec3(gy + kWnG.xz, kWnG.y);
    vec3 tZ = vec3(gz + kWnG.xy, kWnG.z);
    nW = normalize(tX.zyx * kBwG.x + tY.xzy * kBwG.y + tZ.xyz * kBwG.z);
  } else {
    nW = normalize(vec3(kWnG.x + gy.x, kWnG.y, kWnG.z + gy.y));
  }
}
`;

const BODY = /* glsl */`
  kWpG = vWPos;
  kWnG = normalize(vWNrm);
  vec3 kDdx = dFdx(kWpG), kDdy = dFdy(kWpG);
  kDdx *= 0.72; kDdy *= 0.72;      // mild sharpening: 2x anisotropy alone leaves the ground mushy
  kDyx = kDdx.xz;                 kDyy = kDdy.xz;
  kDxx = vec2(kDdx.z, -kDdx.y);   kDxy = vec2(kDdy.z, -kDdy.y);
  kDzx = vec2(kDdx.x, -kDdx.y);   kDzy = vec2(kDdy.x, -kDdy.y);

  vec2 kSuv = kWpG.xz / kExtent + 0.5;
  vec4 kMac  = texture2D(kMacro, kWpG.xz * 0.0021);
  vec4 kMac2 = texture2D(kMacro, kWpG.xz * 0.0195);
  vec4 kMac3 = texture2D(kMacro, kWpG.xz * 0.0072);
  vec4 kMac4 = texture2D(kMacro, kWpG.xz * 0.058);    // ~17 m: patch-scale breakup
  kWarpG = (kMac3.xy - 0.5) * 11.0 + (kMac2.zw - 0.5) * 1.6;
  vec4 kInf  = texture2D(kInfo, kSuv);
  vec4 kSp   = texture2D(kSplat, kSuv + (kMac2.xy - 0.5) * 0.0075);

  vec3 kAbsN = abs(kWnG);
  vec3 kBw = kAbsN * kAbsN; kBw *= kBw;
  kBwG = kBw / max(kBw.x + kBw.y + kBw.z, 1e-4);
  kTriG = kBwG.y < 0.90 && kQuality > 0.35;

  float kDist = length(cameraPosition - kWpG);
  // Patch-scale breakup is a near-field cue. Left on at range it turns a hillside into
  // camouflage, so it fades out over the first few hundred metres.
  float kNear = 1.0 - smoothstep(55.0, 300.0, kDist);
  float kSlope  = 1.0 - kWnG.y;
  float kSteep  = smoothstep(0.030, 0.165, kSlope + (kMac2.z - 0.5) * 0.045);
  float kReg    = 1.0 - kInf.g;
  float kHollow = smoothstep(0.495, 0.375, kInf.b);   // concave: soil and terra rossa collect
  float kCrest  = smoothstep(0.505, 0.625, kInf.b);   // convex: sun-bleached, stony, thin
  float kVar    = kInf.a;
  float kBig    = kMac.z, kFineN = kMac2.w, kMid = kMac.x;
  float kPatch  = clamp(kMac4.z + (kFineN - 0.5) * 0.42, 0.0, 1.0);
  float kPatch2 = clamp(kMac4.x + (kMac2.y - 0.5) * 0.35, 0.0, 1.0);

  float kW[6];
  // Beyond a few hundred metres the mix is driven purely by land cover, slope and curvature —
  // the noise-driven patchiness is a near-field cue and turns a distant hillside into
  // camouflage if it is left switched on.
  float kNz = kNear * 0.9;
  kW[1] = 0.62 + 0.50 * kBig + 0.26 * kCrest + 0.22 * kVar + 1.15 * kNz * smoothstep(0.50, 0.90, kPatch);
  kW[3] = kSp.g * (1.30 + 0.85 * kNz * kPatch2) + 0.45 * smoothstep(0.42, 0.84, kBig) * (1.0 - kSp.a);
  kW[4] = kSp.r * (1.85 + 0.30 * kNz * kFineN);
  kW[2] = kSp.b * (0.78 + 0.35 * kNz * kFineN) + kHollow * (0.30 + 0.30 * kNz * kFineN)
        + 0.12 * smoothstep(0.62, 0.95, 1.0 - kVar);
  kW[0] = kSteep * kSteep * 2.4 + kSp.a * 0.40 * kFineN + 0.16 * kNz * smoothstep(0.80, 0.99, kPatch) * kReg;
  kW[5] = kSp.a * (1.15 + 0.45 * kNz * kFineN) + smoothstep(0.014, 0.075, kSlope) * (0.55 + 0.40 * kNz * kFineN)
        + 0.20 * kCrest + 1.15 * kNz * smoothstep(0.50, 0.92, 1.0 - kPatch);

  float kSoft = 1.0 - 0.94 * kSteep;
  kW[1] *= kSoft; kW[3] *= kSoft * kSoft;
  kW[2] *= mix(1.0, 0.25, kSteep);
  kW[4] *= (1.0 - smoothstep(0.012, 0.075, kSlope));
  kW[5] *= mix(1.0, 0.55, kSteep);

  // Only the two strongest layers ever survive the cut below, so blending exactly two keeps
  // the shader small — which matters a lot on the software rasteriser the review runs on.
  int kI0 = 1, kI1 = 0; float kW0 = -1.0, kW1 = -1.0;
  for (int i = 0; i < 6; i++) {
    float w = kW[i];
    if (w > kW0) { kW1 = kW0; kI1 = kI0; kW0 = w; kI0 = i; }
    else if (w > kW1) { kW1 = w; kI1 = i; }
  }
  kW1 = max(kW1 - kW0 * 0.20, 0.0);          // a clearly weaker second layer drops out entirely
  float kMix = kW1 / max(kW0 + kW1, 1e-6);   // 0 .. 0.5, linear so borders stay soft
  int kDom = kI0;

  vec4 kA0, kA1; vec3 kN0, kN1; float kR0, kR1, kO0, kO1;
  kFetch(kI0, kInvScale[kI0], kA0, kN0, kR0, kO0);
  kFetch(kI1, kInvScale[kI1], kA1, kN1, kR1, kO1);
  vec3 kAlbedo = mix(kA0.rgb, kA1.rgb, kMix);
  vec3 kNormalW = normalize(mix(kN0, kN1, kMix));
  float kRough = mix(kR0, kR1, kMix);
  float kAO = mix(kO0, kO1, kMix);

  // Two frequencies of detail that fade in near the camera so close ground never looks smooth.
  float kFmed = (1.0 - smoothstep(kDetail.z, kDetail.w, kDist)) * kQuality;
  float kFfine = (1.0 - smoothstep(kDetail.x, kDetail.y, kDist)) * kQuality;
  if (kFmed > 0.01) {
    // Mid range is most of the frame from a kart, and it is where a splat map alone looks
    // like painted cardboard — so this band gets relief and cavity shading, not just colour.
    float inv = kInvScale[kDom] * 3.1;
    vec2 uv = (kWpG.xz + kWarpG * 0.35) * inv;
    vec4 dN = textureGrad(kNra, vec3(uv, float(kDom)), kDyx * inv, kDyy * inv);
    kNormalW = normalize(kNormalW + vec3(dN.x * 2.0 - 1.0, 0.0, dN.y * 2.0 - 1.0) * kFmed * 0.75);
    kAlbedo *= mix(1.0, 0.74 + dN.w * 0.44, kFmed * 0.55);
    kRough = mix(kRough, dN.z, kFmed * 0.3);
  }
  if (kFfine > 0.01) {                   // close up: micro relief and cavity shading
    float inv = kInvScale[kDom] * 10.0;
    vec2 uv = kWpG.xz * inv;             // fine grain is below the warp's wavelength anyway
    vec4 dN = textureGrad(kNra, vec3(uv, float(kDom)), kDyx * inv, kDyy * inv);
    kNormalW = normalize(kNormalW + vec3(dN.x * 2.0 - 1.0, 0.0, dN.y * 2.0 - 1.0) * kFfine * 0.55);
    kRough = mix(kRough, dN.z, kFfine * 0.35);
    kAO = mix(kAO, kAO * (0.5 + dN.w * 0.65), kFfine * 0.5);
  }

  // Large-scale colour drift, sun bleaching on crests, damp shading in the hollows.
  kAlbedo *= mix(vec3(1.0), vec3(1.10, 1.04, 0.90), (kMid - 0.5) * 0.85);
  kAlbedo *= 0.90 + 0.20 * kBig;
  kAlbedo *= mix(1.0, 0.90, kHollow * 0.7);
  kAlbedo = mix(kAlbedo, kAlbedo * vec3(1.07, 1.04, 0.96), kCrest * 0.45);
  kAlbedo = mix(kAlbedo, kAlbedo * vec3(1.04, 0.99, 0.92), smoothstep(0.55, 1.0, kInf.r) * 0.5);
  kAlbedo = mix(kAlbedo, kAlbedo * vec3(0.80, 0.82, 0.70), kSp.b * 0.55);   // shaded forest duff
  kAO = clamp(kAO * (0.82 + 0.18 * (1.0 - kHollow)), 0.25, 1.0);
  kRough = clamp(kRough * (0.94 + 0.12 * kVar), 0.30, 1.0);
`;

/**
 * Patched MeshStandardMaterial — keeps three's lighting, shadows and fog and swaps in the
 * splatted, triplanar, detail-mapped ground surface.
 */
export function createTerrainMaterial(world, tex, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0, dithering: true, fog: true,
  });
  const u = {
    kSplat: { value: tex.splat },
    kInfo: { value: tex.info },
    kMacro: { value: tex.macro },
    kAlb: { value: tex.alb },
    kNra: { value: tex.nra },
    kExtent: { value: world.extent },
    kInvScale: { value: LAYERS.map(l => 1 / l.scale) },
    kDetail: { value: new THREE.Vector4(6, 34, 40, 210) },
    kQuality: { value: opts.quality ?? 1 },
    kNormalStr: { value: opts.normalStrength ?? 1.0 },
  };
  mat.userData.uniforms = u;
  mat.customProgramCacheKey = () => 'katTerrain1';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DECLS)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + BODY)
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= kAlbedo;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * kRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(kNormalW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>',
        'reflectedLight.indirectDiffuse *= kAO;\n  reflectedLight.indirectSpecular *= mix(1.0, kAO, 0.6);');
  };
  return mat;
}

/** Author every texture the ground needs. Returns the bundle `createTerrainMaterial` expects. */
export function buildTerrainTextures(world, opts = {}) {
  const size = opts.texSize ?? 1024;
  const layers = buildLayerTextures(size, opts.seed ?? 4711);
  return {
    alb: layers.alb,
    nra: layers.nra,
    stone: layers.stone,
    texSize: layers.size,
    splat: buildSplatTexture(world, opts.splatSize ?? 1024),
    info: buildInfoTexture(world, opts.infoSize ?? 512),
    macro: buildMacroTexture(256),
  };
}
