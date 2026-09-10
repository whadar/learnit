export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Frame-rate independent approach: pulls `a` toward `b` at rate `k` over `dt`. */
export const damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);
export const wrapPi = a => { const t = Math.PI * 2; a = (a + Math.PI) % t; return (a < 0 ? a + t : a) - Math.PI; };
export const TAU = Math.PI * 2;

/** Deterministic PRNG. Nothing in this game may call Math.random(): a race has to replay. */
export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
