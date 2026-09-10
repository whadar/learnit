export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export const wrapPi = a => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; };
/** Deterministic PRNG (mulberry32) — keeps procedural content stable across runs. */
export function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ r >>> 15, r | 1); r ^= r + Math.imul(r ^ r >>> 7, r | 61); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
}
