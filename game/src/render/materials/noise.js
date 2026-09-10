/**
 * Shared deterministic noise — GLSL source chunks plus a fast CPU field generator used to
 * author tileable procedural textures at load time.
 *
 * Other modules may import this read-only. Everything here is deterministic: the same seed
 * always produces the same field, so screenshots are reproducible between review rounds.
 *
 * GLSL side: all symbols are prefixed `kn_` so including the chunk twice (or alongside another
 * agent's helpers) cannot collide. Include with `noiseChunk()` in a shader's global scope.
 */

/* ------------------------------------------------------------------ GLSL ---- */

/** 32-bit-ish integer hashes and cheap float hashes. */
export const GLSL_HASH = /* glsl */`
float kn_hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float kn_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2  kn_hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float kn_hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3  kn_hash33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
`;

/** Quintic-interpolated value noise in 2D and 3D, plus a 2D gradient noise. */
export const GLSL_VALUE_NOISE = /* glsl */`
float kn_noise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = kn_hash12(i), b = kn_hash12(i + vec2(1.0, 0.0));
  float c = kn_hash12(i + vec2(0.0, 1.0)), d = kn_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float kn_noise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = kn_hash13(i), n100 = kn_hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = kn_hash13(i + vec3(0.0, 1.0, 0.0)), n110 = kn_hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = kn_hash13(i + vec3(0.0, 0.0, 1.0)), n101 = kn_hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = kn_hash13(i + vec3(0.0, 1.0, 1.0)), n111 = kn_hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
/** Gradient (perlin-ish) noise, signed, roughly [-1,1]. */
float kn_gnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = kn_hash22(i) * 2.0 - 1.0, gb = kn_hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = kn_hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, gd = kn_hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float a = dot(ga, f), b = dot(gb, f - vec2(1.0, 0.0));
  float c = dot(gc, f - vec2(0.0, 1.0)), d = dot(gd, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
`;

/** Fractal sums built on the value noise above. */
export const GLSL_FBM = /* glsl */`
float kn_fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * kn_noise2(p); n += a; p *= 2.02; a *= 0.5; }
  return s / max(n, 1e-4);
}
float kn_fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * kn_noise3(p); n += a; p *= 2.02; a *= 0.5; }
  return s / max(n, 1e-4);
}
/** Ridged fractal — good for rock strata and eroded gullies. */
float kn_ridge2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break;
    float v = 1.0 - abs(kn_noise2(p) * 2.0 - 1.0); s += a * v * v; n += a; p *= 2.03; a *= 0.5; }
  return s / max(n, 1e-4);
}
/** Cellular F1 distance in [0,1] — pebbles, scree, cracked plates. */
float kn_worley2(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + kn_hash22(ip + o) - fp;
    d = min(d, dot(r, r));
  }
  return clamp(sqrt(d), 0.0, 1.0);
}
`;

/** Everything, in dependency order. Paste into a shader's global scope. */
export function noiseChunk() { return GLSL_HASH + GLSL_VALUE_NOISE + GLSL_FBM; }

/* ------------------------------------------------------------------- JS ---- */

const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
export { smoother as smootherstep };

/** Deterministic 2D integer hash -> [0,1). */
export function hash2i(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1274126177);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * Add one tileable value-noise octave into `out`. The lattice wraps at `period` cells across
 * the tile, which is what makes the result seamless. Weights are precomputed per axis, so the
 * inner loop is a handful of multiplies — fast enough to author 1024 px textures at load.
 */
function addOctave(out, size, period, seed, amp, ridged) {
  const p = Math.max(1, period | 0);
  const g = new Float32Array(p * p);
  for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) g[j * p + i] = hash2i(i, j, seed);
  const i0 = new Int32Array(size), i1 = new Int32Array(size), wt = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const f = i * p / size, fi = Math.floor(f);
    wt[i] = smoother(f - fi);
    i0[i] = ((fi % p) + p) % p;
    i1[i] = (i0[i] + 1) % p;
  }
  for (let y = 0; y < size; y++) {
    const r0 = i0[y] * p, r1 = i1[y] * p, wy = wt[y], row = y * size;
    for (let x = 0; x < size; x++) {
      const a = g[r0 + i0[x]], b = g[r0 + i1[x]], c = g[r1 + i0[x]], d = g[r1 + i1[x]], wx = wt[x];
      let v = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
      if (ridged) { v = 1 - Math.abs(v * 2 - 1); v *= v; }
      out[row + x] += v * amp;
    }
  }
}

/** Seamless fBm field, `size` x `size`, values in ~[0,1]. */
export function fbmField(size, { octaves = 5, period = 4, gain = 0.5, lacunarity = 2, seed = 1, ridged = false } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, per = period;
  for (let o = 0; o < octaves; o++) {
    addOctave(out, size, Math.round(per), (seed + o * 7919) | 0, amp, ridged);
    total += amp; amp *= gain; per *= lacunarity;
    if (per > size * 0.75) break;
  }
  const inv = 1 / Math.max(total, 1e-6);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Seamless cellular noise. Returns F1/F2 distances (cell-relative) and a per-cell id in [0,1). */
export function worleyField(size, cells, seed = 1, jitter = 0.85) {
  const c = Math.max(1, cells | 0);
  const px = new Float32Array(c * c), py = new Float32Array(c * c), pid = new Float32Array(c * c);
  for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) {
    const k = j * c + i;
    px[k] = i + 0.5 + (hash2i(i, j, seed) - 0.5) * jitter;
    py[k] = j + 0.5 + (hash2i(i, j, seed + 501) - 0.5) * jitter;
    pid[k] = hash2i(i, j, seed + 977);
  }
  const f1 = new Float32Array(size * size), f2 = new Float32Array(size * size), id = new Float32Array(size * size);
  const s = c / size;
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) * s, cy = Math.floor(fy);
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) * s, cx = Math.floor(fx);
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox, gy = cy + oy;
        const wx = ((gx % c) + c) % c, wy2 = ((gy % c) + c) % c, k = wy2 * c + wx;
        const dx = px[k] + (gx - wx) - fx, dy = py[k] + (gy - wy2) - fy;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; best = pid[k]; } else if (d < d2) { d2 = d; }
      }
      const k2 = y * size + x;
      f1[k2] = Math.min(1, Math.sqrt(d1)); f2[k2] = Math.min(1, Math.sqrt(d2)); id[k2] = best;
    }
  }
  return { f1, f2, id };
}

/** Separable wrapping box blur (two passes approximate a gaussian well enough for AO). */
export function boxBlurWrap(src, size, radius, passes = 2) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const r = Math.max(1, radius | 0), n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {           // horizontal
      const row = y * size; let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + ((k % size) + size) % size];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum / n;
        sum -= a[row + ((x - r) % size + size) % size];
        sum += a[row + ((x + r + 1) % size + size) % size];
      }
    }
    for (let x = 0; x < size; x++) {           // vertical
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[(((k % size) + size) % size) * size + x];
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum / n;
        sum -= b[(((y - r) % size + size) % size) * size + x];
        sum += b[(((y + r + 1) % size + size) % size) * size + x];
      }
    }
  }
  return a;
}

/** Sobel a height field into a tangent-space normal. Writes xy into `dst` at `stride` offsets. */
export function heightToNormal(height, size, strength, write) {
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = at(x - 1, y), r = at(x + 1, y), d = at(x, y - 1), u = at(x, y + 1);
      const dl = at(x - 1, y - 1), dr = at(x + 1, y - 1), ul = at(x - 1, y + 1), ur = at(x + 1, y + 1);
      const gx = (dr + 2 * r + ur) - (dl + 2 * l + ul);
      const gy = (ul + 2 * u + ur) - (dl + 2 * d + dr);
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      write(y * size + x, nx * inv, ny * inv, nz * inv);
    }
  }
}

/** Sample a field with wrapping bilinear interpolation at normalised uv. */
export function sampleField(field, size, u, v) {
  const fx = u * size - 0.5, fy = v * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), sx = fx - x0, sy = fy - y0;
  const w = (x, y) => field[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
