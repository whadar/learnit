/**
 * Procedural foliage art + materials for `src/world/vegetation.js`.
 *
 * Everything here is generated in-repo at load time from deterministic noise and 2D canvas
 * drawing — there are no image assets. Two things come out of this file:
 *
 *   1. **Textures.** A leaf/needle atlas (one authored spray per species), a stand-of-trees
 *      impostor sheet for the far field, tileable bark colour+normal pairs, and a cactus
 *      pad skin. Alpha is authored separately from colour: every cell is drawn twice, once
 *      over a flat "average leaf" background (colour) and once over transparency (alpha),
 *      and the two are recombined. That gives perfectly dilated colour under the alpha mask,
 *      so mip-mapped foliage never grows the dark halo that kills cheap billboard trees.
 *
 *   2. **Materials.** `MeshStandardMaterial`s patched with a hierarchical vertex-shader wind
 *      (trunk sway -> branch bend -> leaf flutter, driven by a gust field that travels across
 *      the world along the wind direction) and a cheap back-lit translucency term so canopies
 *      glow when the sun is behind them. Foliage is alpha-*tested*, never blended, and the
 *      cards use spherical canopy normals that survive double-sided rendering.
 *
 * Shared wind uniforms are handed out by `createWindUniforms()`; every material built here
 * holds the *same* uniform objects, so one write per frame drives the whole forest.
 */
import * as THREE from 'three';
import { rng, clamp } from '../../core/mathx.js';
import { hash2i } from './noise.js';

/* ------------------------------------------------------------------ canvas ---- */

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);

/** Tileable value noise on an integer lattice of `period` cells. */
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smoother(x - xi), yf = smoother(y - yi);
  const w = (a, b) => hash2i(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = w(xi, yi), b = w(xi + 1, yi), c = w(xi, yi + 1), d = w(xi + 1, yi + 1);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

function fbm(x, y, period, seed, oct = 4, gain = 0.5) {
  let s = 0, n = 0, a = 1, p = period, sx = x, sy = y;
  for (let i = 0; i < oct; i++) { s += a * vnoise(sx, sy, p, seed + i * 131); n += a; a *= gain; p *= 2; sx *= 2; sy *= 2; }
  return s / n;
}

const css = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
/** Deterministic colour jitter around a base triplet. */
function jit(base, r, amt) {
  return css(base[0] * (1 + (r() - 0.5) * amt), base[1] * (1 + (r() - 0.5) * amt), base[2] * (1 + (r() - 0.5) * amt));
}

/* ---------------------------------------------------------------- leaf art ---- */

/**
 * One leaf, drawn with its base at the origin growing toward -Y.
 * `lobes > 0` scallops the margin (oak); `spiky` sharpens it (thistle, holly oak).
 */
function leafPath(ctx, len, wid, lobes, spiky) {
  const N = 22, amp = spiky ? 0.30 : 0.13;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const wAt = t => {
    const prof = Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.68));
    return wid * 0.5 * prof * (lobes ? 1 + amp * Math.sin(lobes * Math.PI * 2 * t) : 1);
  };
  for (let i = 1; i <= N; i++) { const t = i / N; ctx.lineTo(wAt(t), -len * t); }
  for (let i = N - 1; i >= 1; i--) { const t = i / N; ctx.lineTo(-wAt(t), -len * t); }
  ctx.closePath();
}

function drawLeaf(ctx, len, wid, fill, rib, lobes = 0, spiky = false) {
  leafPath(ctx, len, wid, lobes, spiky);
  ctx.fillStyle = fill; ctx.fill();
  if (rib) {
    ctx.beginPath(); ctx.moveTo(0, -len * 0.04); ctx.lineTo(0, -len * 0.93);
    ctx.strokeStyle = rib; ctx.lineWidth = Math.max(0.8, wid * 0.075); ctx.stroke();
  }
}

/** A woody twig: quadratic curve with a taper drawn as two strokes. */
function twig(ctx, x0, y0, x1, y1, bow, w, col) {
  const mx = (x0 + x1) * 0.5 - (y1 - y0) * bow, my = (y0 + y1) * 0.5 + (x1 - x0) * bow;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1);
  ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.stroke();
  return { mx, my };
}

/* ------------------------------------------------------- species leaf cells ---- */
// Each of these fills a square cell of side S with one authored spray, base at the
// bottom-centre. They are called twice (colour pass and alpha pass) with the same seed.

function cellPine(ctx, S, seed, sparse) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.995;
  const nodes = [];
  const stemCol = css(104, 84, 58);
  // a short woody armature: the tuft is a pom-pom of needle bundles, not a frond
  const arms = sparse ? 3 : 4;
  for (let b = 0; b < arms; b++) {
    const ang = (-Math.PI / 2) + (b - (arms - 1) / 2) * 0.44 + (r() - 0.5) * 0.18;
    const L = S * (0.40 + r() * 0.18);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.14, S * 0.013, stemCol);
    for (let k = 1; k <= 4; k++)
      nodes.push({ x: bx + (ex - bx) * (k / 4), y: by + (ey - by) * (k / 4), a: ang, s: 0.42 + k * 0.16 });
  }
  ctx.lineCap = 'round';
  // Aleppo-pine needles are paired, 6-12 cm, and radiate almost spherically from each bundle
  const dark = [64, 96, 52], mid = [96, 130, 66], lit = [148, 178, 100];
  for (const nd of nodes) {
    const count = sparse ? 26 : 40;
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const up = Math.abs(Math.sin(a));
      const L = S * (0.055 + 0.045 * r()) * (0.6 + nd.s);
      const ex = nd.x + Math.cos(a) * L, ey = nd.y + Math.sin(a) * L * 0.92 + L * 0.16;
      const g = r();
      twig(ctx, nd.x, nd.y, ex, ey, (r() - 0.5) * 0.30, S * (0.0042 + 0.0022 * g),
        jit(g > 0.80 ? lit : g > 0.34 ? mid : dark, r, 0.24 + up * 0.1));
    }
  }
}

function cellCypress(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  twig(ctx, bx, by, bx + (r() - 0.5) * S * 0.06, by - S * 0.9, 0.03, S * 0.02, css(84, 62, 44));
  const dark = [40, 66, 38], mid = [58, 92, 50], lit = [96, 128, 70];
  for (let b = 0; b < 26; b++) {
    const t = 0.05 + b / 26 * 0.93;
    const y = by - S * 0.9 * t;
    const side = b % 2 ? 1 : -1;
    const spread = S * 0.40 * Math.sin(Math.PI * Math.pow(t, 0.6)) * (0.55 + r() * 0.6);
    const ex = bx + side * spread, ey = y - S * 0.10 * (0.4 + r() * 0.8);
    twig(ctx, bx, y, ex, ey, side * 0.12, S * 0.010, css(...mid));
    const n = 13 + ((r() * 8) | 0);
    for (let i = 0; i < n; i++) {
      const t2 = i / n;
      const px = bx + (ex - bx) * t2, py = y + (ey - y) * t2;
      const rr = S * (0.017 + 0.013 * r()) * (1 - t2 * 0.35);
      ctx.beginPath();
      ctx.ellipse(px + (r() - 0.5) * S * 0.02, py + (r() - 0.5) * S * 0.02, rr, rr * 0.62,
        side * 0.5 + (r() - 0.5), 0, Math.PI * 2);
      const g = r();
      ctx.fillStyle = jit(g > 0.72 ? lit : (g > 0.32 ? mid : dark), r, 0.22);
      ctx.fill();
    }
  }
}

function cellOak(ctx, S, seed, dense) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  const stems = dense ? 5 : 3;
  const tips = [];
  for (let b = 0; b < stems; b++) {
    const ang = -Math.PI / 2 + (b - (stems - 1) / 2) * 0.42 + (r() - 0.5) * 0.16;
    const L = S * (0.50 + r() * 0.22);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.2, S * 0.014, css(92, 74, 52));
    for (let k = 1; k <= 4; k++) tips.push({ x: bx + (ex - bx) * (k / 4), y: by + (ey - by) * (k / 4), a: ang });
  }
  const n = dense ? 132 : 84;
  for (let i = 0; i < n; i++) {
    const nd = tips[(r() * tips.length) | 0];
    const a = nd.a + (r() - 0.5) * 2.6;
    const L = S * (0.058 + r() * 0.036), W = L * (0.66 + r() * 0.22);
    ctx.save();
    ctx.translate(nd.x + Math.cos(a) * S * (0.02 + r() * 0.13), nd.y + Math.sin(a) * S * (0.02 + r() * 0.13));
    ctx.rotate(a + Math.PI / 2 + (r() - 0.5) * 0.5);
    const g = r();
    drawLeaf(ctx, L, W, jit(g > 0.78 ? [104, 138, 66] : (g > 0.34 ? [62, 96, 46] : [44, 72, 38]), r, 0.22),
      'rgba(20,34,16,0.30)', 4, true);
    ctx.restore();
  }
}

function cellOlive(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  for (let b = 0; b < 9; b++) {
    const ang = -Math.PI / 2 + (b - 4) * 0.19 + (r() - 0.5) * 0.14;
    const L = S * (0.52 + r() * 0.30);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.18, S * 0.007, css(132, 124, 100));
    const pairs = 10 + ((r() * 4) | 0);
    for (let k = 1; k <= pairs; k++) {
      const t = k / (pairs + 0.4);
      const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
      for (const side of [-1, 1]) {
        const la = ang + side * (0.72 + r() * 0.34);
        const L2 = S * (0.068 + r() * 0.030), W2 = L2 * (0.26 + r() * 0.08);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(la + Math.PI / 2);
        const silver = r() > 0.62;
        drawLeaf(ctx, L2, W2,
          silver ? jit([170, 178, 152], r, 0.14) : jit([94, 116, 72], r, 0.24),
          silver ? 'rgba(150,158,132,0.6)' : 'rgba(150,162,128,0.55)', 0, false);
        ctx.restore();
      }
    }
  }
}

function cellAlmond(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  for (let b = 0; b < 6; b++) {
    const ang = -Math.PI / 2 + (b - 2.5) * 0.28 + (r() - 0.5) * 0.16;
    const L = S * (0.56 + r() * 0.30);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.2, S * 0.008, css(118, 98, 72));
    const nl = 13 + ((r() * 5) | 0);
    for (let k = 1; k <= nl; k++) {
      const t = k / (nl + 0.3);
      const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
      const side = k % 2 ? 1 : -1;
      const la = ang + side * (0.62 + r() * 0.4);
      const L2 = S * (0.10 + r() * 0.05), W2 = L2 * (0.26 + r() * 0.08);
      ctx.save(); ctx.translate(px, py); ctx.rotate(la + Math.PI / 2);
      drawLeaf(ctx, L2, W2, jit(r() > 0.7 ? [140, 164, 90] : [96, 128, 62], r, 0.22),
        'rgba(46,62,28,0.35)', 14, false);
      ctx.restore();
    }
  }
}

function cellSage(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  for (let b = 0; b < 16; b++) {
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.7;
    const L = S * (0.34 + r() * 0.48);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.3, S * 0.006, css(132, 126, 100));
    const nl = 9 + ((r() * 5) | 0);
    for (let k = 1; k <= nl; k++) {
      const t = k / (nl + 0.2);
      const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
      for (const side of [-1, 1]) {
        const la = ang + side * (0.85 + r() * 0.4);
        const L2 = S * (0.048 + r() * 0.032);
        ctx.save(); ctx.translate(px, py); ctx.rotate(la + Math.PI / 2);
        drawLeaf(ctx, L2, L2 * (0.44 + r() * 0.2), jit(r() > 0.5 ? [154, 158, 124] : [116, 128, 92], r, 0.2),
          'rgba(110,116,88,0.4)', 0, false);
        ctx.restore();
      }
    }
  }
}

/** Grape vine: big palmate leaves, some already yellowing by late August. */
function cellVine(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.995;
  for (let b = 0; b < 4; b++) {
    const ang = -Math.PI / 2 + (b - 1.5) * 0.36 + (r() - 0.5) * 0.2;
    const L = S * (0.45 + r() * 0.34);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.22, S * 0.010, css(126, 106, 72));
    const nl = 3 + ((r() * 3) | 0);
    for (let k = 1; k <= nl; k++) {
      const t = k / (nl + 0.2);
      const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
      const R0 = S * (0.13 + r() * 0.07);
      const rot = ang + Math.PI / 2 + (r() - 0.5) * 0.8;
      const g = r();
      const col = jit(g > 0.86 ? [186, 176, 90] : g > 0.4 ? [92, 128, 58] : [66, 100, 44], r, 0.2);
      ctx.save(); ctx.translate(px, py); ctx.rotate(rot);
      ctx.beginPath();
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const a = -Math.PI * 0.5 + (i / N - 0.5) * Math.PI * 1.85;
        // five shallow lobes with notches between them
        const k2 = 1 - 0.34 * Math.pow(Math.abs(Math.cos(2.5 * (a + Math.PI * 0.5))), 3.0);
        const px2 = Math.cos(a) * R0 * k2, py2 = Math.sin(a) * R0 * k2 * 0.95 - R0 * 0.1;
        i ? ctx.lineTo(px2, py2) : ctx.moveTo(px2, py2);
      }
      ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = 'rgba(38,58,24,0.32)'; ctx.lineWidth = Math.max(0.7, R0 * 0.04); ctx.stroke();
      for (let v = 0; v < 5; v++) {   // veins
        const a = -Math.PI * 0.5 + (v / 4 - 0.5) * Math.PI * 1.5;
        ctx.beginPath(); ctx.moveTo(0, -R0 * 0.05);
        ctx.lineTo(Math.cos(a) * R0 * 0.8, Math.sin(a) * R0 * 0.8 - R0 * 0.05);
        ctx.strokeStyle = 'rgba(30,52,20,0.24)'; ctx.lineWidth = Math.max(0.6, R0 * 0.035); ctx.stroke();
      }
      ctx.restore();
    }
  }
}

function cellBroom(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.99;
  ctx.lineCap = 'round';
  for (let i = 0; i < 78; i++) {
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.05;
    const L = S * (0.44 + r() * 0.5);
    const ex = bx + Math.cos(ang) * L * (0.9 + r() * 0.3), ey = by + Math.sin(ang) * L;
    twig(ctx, bx + (r() - 0.5) * S * 0.06, by, ex, ey, (r() - 0.5) * 0.18,
      S * (0.005 + r() * 0.004), jit([120, 142, 92], r, 0.3));
  }
  for (let i = 0; i < 26; i++) {   // spent creamy flowers
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.0, L = S * (0.4 + r() * 0.45);
    ctx.beginPath();
    ctx.arc(bx + Math.cos(ang) * L, by + Math.sin(ang) * L, S * 0.012 * (0.6 + r()), 0, Math.PI * 2);
    ctx.fillStyle = jit([226, 220, 190], r, 0.1); ctx.fill();
  }
}

function cellGrass(ctx, S, seed) {
  const r = rng(seed);
  const by = S * 0.995;
  ctx.lineCap = 'round';
  for (let i = 0; i < 54; i++) {
    const bx = S * (0.5 + (r() - 0.5) * 0.34);
    const lean = (r() - 0.5) * 1.35;
    const L = S * (0.42 + r() * 0.55);
    const ex = bx + Math.sin(lean) * L * 0.85, ey = by - Math.cos(lean) * L;
    const g = r();
    const col = g > 0.86 ? [126, 138, 76] : g > 0.42 ? [200, 174, 106] : [166, 140, 78];
    // taper the blade: a filled sliver rather than a stroke
    const mx = (bx + ex) * 0.5 - (ey - by) * 0.10 * Math.sign(lean || 1);
    const my = (by + ey) * 0.5;
    const w = S * (0.009 + r() * 0.008);
    ctx.beginPath();
    ctx.moveTo(bx - w, by);
    ctx.quadraticCurveTo(mx - w * 0.5, my, ex, ey);
    ctx.quadraticCurveTo(mx + w * 0.5, my, bx + w, by);
    ctx.closePath();
    ctx.fillStyle = jit(col, r, 0.22); ctx.fill();
  }
}

function cellWheat(ctx, S, seed) {
  const r = rng(seed);
  const by = S * 0.995;
  ctx.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const bx = S * (0.5 + (r() - 0.5) * 0.42);
    const lean = (r() - 0.5) * 0.5;
    const L = S * (0.60 + r() * 0.32);
    const ex = bx + Math.sin(lean) * L * 0.6, ey = by - Math.cos(lean) * L;
    twig(ctx, bx, by, ex, ey, Math.sign(lean || 1) * 0.05, S * (0.008 + r() * 0.005), jit([196, 172, 108], r, 0.18));
    // seed head
    const hL = S * (0.14 + r() * 0.06), hW = S * 0.030;
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(lean * 1.4);
    for (let k = 0; k < 9; k++) {
      const t = k / 9;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * hW * 0.55, -hL * t - hL * 0.06, hW * 0.55, hL * 0.10, side * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = jit([214, 186, 116], r, 0.16); ctx.fill();
      }
    }
    for (let k = 0; k < 8; k++) {  // awns
      const a = (k / 8 - 0.5) * 0.7;
      twig(ctx, 0, -hL * 0.9, Math.sin(a) * hL * 0.7, -hL * (1.5 + r() * 0.4), 0, S * 0.0035,
        jit([224, 204, 148], r, 0.12));
    }
    ctx.restore();
  }
}

function cellThistle(ctx, S, seed) {
  const r = rng(seed);
  const bx = S * 0.5, by = S * 0.995;
  const stemCol = [186, 172, 128];
  for (let b = 0; b < 4; b++) {
    const ang = -Math.PI / 2 + (b - 1.5) * 0.30 + (r() - 0.5) * 0.2;
    const L = S * (0.55 + r() * 0.36);
    const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
    twig(ctx, bx, by, ex, ey, (r() - 0.5) * 0.1, S * 0.014, jit(stemCol, r, 0.14));
    for (let k = 1; k <= 4; k++) {   // spiny leaves clasping the stem
      const t = k / 5;
      const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
      const side = k % 2 ? 1 : -1;
      ctx.save(); ctx.translate(px, py); ctx.rotate(ang + side * 1.0 + Math.PI / 2);
      drawLeaf(ctx, S * (0.16 + r() * 0.08), S * (0.07 + r() * 0.04),
        jit([176, 168, 124], r, 0.16), 'rgba(120,112,78,0.5)', 5, true);
      ctx.restore();
    }
    // dry seed head
    ctx.save(); ctx.translate(ex, ey);
    const R0 = S * (0.045 + r() * 0.022);
    ctx.beginPath(); ctx.ellipse(0, -R0 * 0.6, R0 * 0.85, R0, 0, 0, Math.PI * 2);
    ctx.fillStyle = jit([158, 144, 106], r, 0.14); ctx.fill();
    for (let s = 0; s < 20; s++) {
      const a = -Math.PI / 2 + (s / 20 - 0.5) * 3.1;
      twig(ctx, 0, -R0 * 0.6, Math.cos(a) * R0 * 2.0, -R0 * 0.6 + Math.sin(a) * R0 * 2.0, 0,
        S * 0.004, jit([204, 196, 158], r, 0.12));
    }
    ctx.restore();
  }
}

/** Pinnate date-palm frond: base at the left edge, tip at the right. */
function cellFrond(ctx, W, H, seed) {
  const r = rng(seed);
  const y0 = H * 0.5;
  const arc = t => y0 + H * 0.30 * t * t;             // droops toward the tip
  ctx.lineCap = 'round';
  const N = 46;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const px = W * (0.05 + t * 0.93), py = arc(t);
    const len = H * (0.40 + 0.06 * Math.sin(t * 3.1)) * (1 - Math.pow(t, 2.4)) * (0.8 + r() * 0.4);
    for (const side of [-1, 1]) {
      const a = side * (0.72 + t * 0.5) + 0.30;
      const ex = px + Math.cos(a) * len * 0.7, ey = py + Math.sin(a) * len;
      const g = r();
      const col = g > 0.84 ? [172, 168, 96] : g > 0.4 ? [104, 138, 60] : [72, 104, 44];
      ctx.beginPath();
      ctx.moveTo(px, py - H * 0.012);
      ctx.quadraticCurveTo((px + ex) * 0.5, (py + ey) * 0.5 - side * len * 0.14, ex, ey);
      ctx.quadraticCurveTo((px + ex) * 0.5, (py + ey) * 0.5 + side * len * 0.02, px, py + H * 0.012);
      ctx.closePath();
      ctx.fillStyle = jit(col, r, 0.22); ctx.fill();
    }
  }
  // rachis
  ctx.beginPath();
  ctx.moveTo(W * 0.02, y0);
  for (let i = 1; i <= 20; i++) { const t = i / 20; ctx.lineTo(W * (0.02 + t * 0.96), arc(t)); }
  ctx.strokeStyle = css(138, 122, 74); ctx.lineWidth = H * 0.030; ctx.stroke();
}

/** Flat bark card used by the mid LOD, where the trunk is only a few pixels wide. */
function cellBark(ctx, S, seed, base) {
  const r = rng(seed);
  ctx.fillStyle = css(base[0], base[1], base[2]); ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 220; i++) {
    const x = r() * S, y = r() * S, h = S * (0.08 + r() * 0.35), w = S * (0.006 + r() * 0.02);
    const d = (r() - 0.5) * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.quadraticCurveTo(x + S * 0.01, y + h * 0.5, x + S * 0.008 * d, y + h);
    ctx.strokeStyle = css(base[0] * (0.6 + d * 0.5), base[1] * (0.6 + d * 0.5), base[2] * (0.6 + d * 0.5), 0.55);
    ctx.lineWidth = w; ctx.stroke();
  }
}

/**
 * Far-field impostor: a stand of `n` crowns drawn as one card, so a distant hillside reads
 * as forest instead of a fuzz of individual billboards. `top` draws the same stand seen
 * from above, for the horizontal quad of the impostor cross.
 */
function cellStand(ctx, S, seed, kind, top) {
  const r = rng(seed);
  const pal = kind === 'pine'
    ? [[52, 76, 44], [70, 98, 54], [96, 124, 68], [36, 56, 34]]
    : [[62, 82, 46], [88, 110, 58], [118, 138, 78], [44, 62, 36]];
  const blob = (x, y, rx, ry, col, rot) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath();
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      const k = 1 + 0.30 * Math.sin(a * 3 + seed) + 0.20 * Math.sin(a * 5.3 + r());
      const px = Math.cos(a) * rx * k, py = Math.sin(a) * ry * k;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    ctx.restore();
  };
  if (top) {
    for (let i = 0; i < 16; i++) {
      const x = S * (0.08 + r() * 0.84), y = S * (0.08 + r() * 0.84);
      const R = S * (0.15 + r() * 0.11);
      blob(x, y, R, R * (0.85 + r() * 0.3), jit(pal[3], r, 0.2), r() * 6.28);
      blob(x - R * 0.12, y - R * 0.12, R * 0.82, R * 0.78, jit(pal[(1 + (r() * 3) | 0) % 3], r, 0.22), r() * 6.28);
      blob(x - R * 0.28, y - R * 0.30, R * 0.42, R * 0.38, jit(pal[2], r, 0.18), r() * 6.28);
    }
    return;
  }
  // A block of forest seen side-on: crowns packed edge to edge and carried right down to
  // the ground line, so a hillside of these reads as continuous canopy rather than confetti.
  const ground = S * 0.995;
  const trees = kind === 'pine' ? 11 : 13;
  const order = [];
  for (let i = 0; i < trees; i++)
    order.push({ x: S * (0.04 + (i + r() * 0.85) / trees * 0.93), s: 0.66 + r() * 0.46, z: r() });
  order.sort((a, b) => a.z - b.z);
  for (const t of order) {
    const H = S * (kind === 'pine' ? 0.82 : 0.70) * t.s, W = S * (kind === 'pine' ? 0.34 : 0.40) * t.s;
    const topY = ground - H;
    const shade = 0.55 + t.z * 0.75;      // trees behind sit deeper in shadow
    const tone = c => [c[0] * shade, c[1] * shade, c[2] * shade];
    ctx.beginPath();
    ctx.moveTo(t.x - W * 0.05, ground); ctx.lineTo(t.x - W * 0.030, topY + H * 0.55);
    ctx.lineTo(t.x + W * 0.030, topY + H * 0.55); ctx.lineTo(t.x + W * 0.05, ground);
    ctx.closePath(); ctx.fillStyle = css(88 * shade, 74 * shade, 58 * shade); ctx.fill();
    const puffs = kind === 'pine' ? 9 : 8;
    for (let p = 0; p < puffs; p++) {
      const a = p / puffs * Math.PI * 2 + r() * 0.9;
      const rr = W * (0.34 + r() * 0.26);
      const cx = t.x + Math.cos(a) * W * 0.44;
      const cy = topY + H * (kind === 'pine' ? 0.24 : 0.34) + Math.sin(a) * H * (kind === 'pine' ? 0.16 : 0.20);
      blob(cx, cy, rr, rr * (kind === 'pine' ? 0.76 : 0.92), jit(tone(pal[p % 4]), r, 0.22), r() * 6.28);
    }
    // sun-struck cap on the crown
    blob(t.x - W * 0.12, topY + H * (kind === 'pine' ? 0.20 : 0.28), W * 0.44,
      W * (kind === 'pine' ? 0.28 : 0.36), jit(tone(pal[2]), r, 0.16), 0);
    // scrubby skirt so the stand meets the ground instead of floating on stilts
    for (let p = 0; p < 3; p++) {
      const rr = W * (0.22 + r() * 0.18);
      blob(t.x + (r() - 0.5) * W * 1.1, ground - rr * 0.5, rr, rr * 0.72,
        jit(tone(pal[3]), r, 0.2), r() * 6.28);
    }
  }
}

/* ------------------------------------------------------------- atlas build ---- */

const COLS = 4, ROWS = 5;

/** Which cell each species draws into. Row 3 is one wide strip for the palm frond. */
export const SLOT = {
  pineA:   [0, 0], pineB: [1, 0], cypress: [2, 0], oak: [3, 0],
  olive:   [0, 1], almond: [1, 1], sage: [2, 1], broom: [3, 1],
  grass:   [0, 2], wheat: [1, 2], thistle: [2, 2], bark: [3, 2],
  frond:   [0, 3, 4],
  vine:    [0, 4], terebinth: [1, 4], pineC: [2, 4], grassDry: [3, 4],
};

/** UV rect [u0, v0, u1, v1] for a slot, inset slightly so mip levels cannot bleed. */
export function slotRect(name, inset = 0.004) {
  const s = SLOT[name];
  const cw = 1 / COLS, ch = 1 / ROWS;
  const w = (s[2] || 1) * cw;
  const u0 = s[0] * cw, v1 = 1 - s[1] * ch, v0 = v1 - ch;
  return [u0 + inset, v0 + inset, u0 + w - inset, v1 - inset];
}

function drawAtlasCells(ctx, S, background) {
  const cell = (name, fn, bg) => {
    const s = SLOT[name];
    const w = (s[2] || 1) * S, h = S;
    ctx.save();
    ctx.translate(s[0] * S, s[1] * S);
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    if (background) { ctx.fillStyle = css(bg[0], bg[1], bg[2]); ctx.fillRect(0, 0, w, h); }
    fn(ctx, w, h);
    ctx.restore();
  };
  cell('pineA',   (c, w) => cellPine(c, w, 1201), [78, 104, 58]);
  cell('pineB',   (c, w) => cellPine(c, w, 4409), [70, 96, 52]);
  cell('cypress', (c, w) => cellCypress(c, w, 7717), [48, 74, 42]);
  cell('oak',     (c, w) => cellOak(c, w, 3313, true), [58, 88, 44]);
  cell('olive',   (c, w) => cellOlive(c, w, 9091), [116, 132, 100]);
  cell('almond',  (c, w) => cellAlmond(c, w, 5155), [104, 132, 68]);
  cell('sage',    (c, w) => cellSage(c, w, 2287), [132, 140, 106]);
  cell('broom',   (c, w) => cellBroom(c, w, 6631), [126, 146, 96]);
  cell('grass',   (c, w) => cellGrass(c, w, 8123), [186, 162, 100]);
  cell('wheat',   (c, w) => cellWheat(c, w, 3467), [200, 176, 114]);
  cell('thistle', (c, w) => cellThistle(c, w, 1571), [178, 168, 124]);
  cell('bark',    (c, w) => cellBark(c, w, 9631, [126, 108, 84]), [126, 108, 84]);
  cell('frond',   (c, w, h) => cellFrond(c, w, h, 4813), [96, 124, 58]);
  cell('vine',      (c, w) => cellVine(c, w, 6199), [92, 122, 58]);
  cell('terebinth', (c, w) => cellOak(c, w, 7331, true), [96, 122, 62]);
  cell('pineC',     (c, w) => cellPine(c, w, 8447, true), [76, 100, 54]);
  cell('grassDry',  (c, w) => cellGrass(c, w, 9887), [196, 172, 108]);
}

/** Draw a sheet twice (colour over a flat backdrop, alpha over transparency) and merge. */
function bakeSheet(size, h, draw) {
  const cvC = makeCanvas(size, h), cvA = makeCanvas(size, h);
  if (!cvC || !cvA) return null;
  const cc = cvC.getContext('2d', { willReadFrequently: true });
  const ca = cvA.getContext('2d', { willReadFrequently: true });
  cc.clearRect(0, 0, size, h); ca.clearRect(0, 0, size, h);
  draw(cc, true);
  draw(ca, false);
  const dc = cc.getImageData(0, 0, size, h);
  const da = ca.getImageData(0, 0, size, h).data;
  const out = dc.data;
  for (let i = 0, n = size * h; i < n; i++) out[i * 4 + 3] = da[i * 4 + 3];
  cc.putImageData(dc, 0, 0);
  const tex = new THREE.CanvasTexture(cvC);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** The leaf atlas: one authored spray per species, alpha-tested. */
export function buildFoliageAtlas(cellPx = 384) {
  const S = cellPx;
  return bakeSheet(S * COLS, S * ROWS, (ctx, bg) => drawAtlasCells(ctx, S, bg));
}

/** 2x2 sheet: [pine stand | oak stand] over [pine canopy from above | oak canopy from above]. */
export function buildStandSheet(cellPx = 256) {
  const S = cellPx;
  return bakeSheet(S * 2, S * 2, (ctx, bg) => {
    const one = (cx, cy, kind, top, back) => {
      ctx.save(); ctx.translate(cx * S, cy * S);
      ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
      if (bg) { ctx.fillStyle = css(back[0], back[1], back[2]); ctx.fillRect(0, 0, S, S); }
      cellStand(ctx, S, kind === 'pine' ? 313 : 727, kind, top);
      ctx.restore();
    };
    one(0, 0, 'pine', false, [58, 80, 46]);
    one(1, 0, 'oak', false, [70, 92, 50]);
    one(0, 1, 'pine', true, [50, 70, 40]);
    one(1, 1, 'oak', true, [62, 84, 44]);
  });
}

export const STAND_RECT = {
  pine:    [0.002, 0.502, 0.498, 0.998],
  oak:     [0.502, 0.502, 0.998, 0.998],
  pineTop: [0.002, 0.002, 0.498, 0.498],
  oakTop:  [0.502, 0.002, 0.998, 0.498],
};

/* --------------------------------------------------------------- bark maps ---- */

function normalFromHeight(hf, size, strength) {
  const d = new Uint8Array(size * size * 4);
  const at = (x, y) => hf[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    let nx = -dx, ny = -dy, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * size + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255;
    d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

/**
 * Tileable bark. `kind`:
 *   plated  — Aleppo-pine scale plates, orange-grey
 *   fibrous — long vertical fissures (cypress, oak, almond)
 *   fluted  — olive: twisting ropey flutes with pale grey highlights
 *   ringed  — date palm leaf-base rings
 */
export function buildBarkTexture(kind, tint, size = 256, seed = 11) {
  const hf = new Float32Array(size * size);
  const col = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let h;
      if (kind === 'plated') {
        // Aleppo pine: small irregular scale plates separated by dark fissures
        const a = fbm(u * 13, v * 9, 13, seed, 4);
        const b = fbm(u * 30 + 3, v * 21 + 5, 30, seed + 77, 3);
        const plate = 1 - Math.abs(Math.sin((a * 7.5 + b * 2.4) * Math.PI));
        h = 0.34 * a + 0.20 * b + 0.46 * plate * plate;
      } else if (kind === 'fibrous') {
        const warp = fbm(u * 5, v * 3, 5, seed + 5, 3) - 0.5;
        h = fbm((u + warp * 0.06) * 44, v * 5.0, 44, seed, 4) * 0.70 + fbm(u * 96, v * 14, 96, seed + 31, 2) * 0.30;
      } else if (kind === 'fluted') {
        const twist = fbm(u * 3, v * 2.0, 3, seed + 9, 3) - 0.5;
        const flute = 0.5 + 0.5 * Math.sin((u * 16 + twist * 4.0 + v * 1.2) * Math.PI * 2);
        h = flute * 0.55 + fbm(u * 38, v * 26, 38, seed + 3, 3) * 0.45;
      } else {  // ringed
        const ring = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 11 + fbm(u * 4, v * 4, 4, seed, 2) * 3.0);
        h = ring * 0.6 + fbm(u * 18, v * 18, 18, seed + 13, 3) * 0.4;
      }
      hf[y * size + x] = h;
      const shade = 0.66 + h * 0.48;
      const g = fbm(u * 40, v * 40, 40, seed + 61, 2);
      const i = (y * size + x) * 4;
      col[i] = clamp(tint[0] * shade * (0.9 + g * 0.2), 0, 255);
      col[i + 1] = clamp(tint[1] * shade * (0.9 + g * 0.2), 0, 255);
      col[i + 2] = clamp(tint[2] * shade * (0.9 + g * 0.2), 0, 255);
      col[i + 3] = 255;
    }
  }
  const map = new THREE.DataTexture(col, size, size, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true; map.anisotropy = 4; map.needsUpdate = true;
  return { map, normalMap: normalFromHeight(hf, size, kind === 'ringed' ? 5 : 8) };
}

/** Prickly-pear pad skin: waxy blue-green with areoles and spine clusters. */
export function buildCactusTexture(size = 256, seed = 55) {
  const hf = new Float32Array(size * size);
  const col = new Uint8Array(size * size * 4);
  const spots = [];
  const r = rng(seed);
  for (let i = 0; i < 46; i++) spots.push([r(), r(), 0.014 + r() * 0.010]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let h = fbm(u * 9, v * 9, 9, seed, 3) * 0.4 + 0.4;
    let areole = 0;
    for (const s of spots) {
      const dx = Math.min(Math.abs(u - s[0]), 1 - Math.abs(u - s[0]));
      const dy = Math.min(Math.abs(v - s[1]), 1 - Math.abs(v - s[1]));
      const d = Math.hypot(dx, dy) / s[2];
      if (d < 1.6) areole = Math.max(areole, 1 - d / 1.6);
    }
    h -= areole * 0.5;
    hf[y * size + x] = h;
    const base = [126, 156, 96];
    const shade = 0.72 + h * 0.5;
    const i = (y * size + x) * 4;
    col[i] = clamp(base[0] * shade + areole * 46, 0, 255);
    col[i + 1] = clamp(base[1] * shade + areole * 26, 0, 255);
    col[i + 2] = clamp(base[2] * shade + areole * 10, 0, 255);
    col[i + 3] = 255;
  }
  const map = new THREE.DataTexture(col, size, size, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true; map.needsUpdate = true;
  return { map, normalMap: normalFromHeight(hf, size, 6) };
}

/* --------------------------------------------------------------- materials ---- */

/** The uniform bundle every vegetation material shares. Write `uTime` once per frame. */
export function createWindUniforms(opts = {}) {
  const dir = opts.direction ?? 2.16;                   // radians, world XZ
  return {
    uTime:         { value: 0 },
    uWindDir:      { value: new THREE.Vector2(Math.cos(dir), Math.sin(dir)) },
    uWindStrength: { value: opts.strength ?? 1.0 },
    uGustSpeed:    { value: opts.gustSpeed ?? 1.05 },
    uSunDir:       { value: new THREE.Vector3(0.42, 0.72, -0.55).normalize() },
    uSunColor:     { value: new THREE.Color(1.0, 0.93, 0.80) },
  };
}

const WIND_PARS = /* glsl */`
uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uGustSpeed;
uniform float uBend;
uniform float uFlutter;
uniform float uGustScale;
attribute vec4 aFol;   // x bend weight (0..1)  y phase  z flutter amplitude  w baked canopy AO
#ifdef VEG_AO
  varying float vVegAo;
#endif
#ifdef VEG_BILLBOARD
  // Base-pivoted spherical billboard: distant stands always present their full face, and
  // they lie down toward the camera when it climbs, so the aerial shot still reads as forest.
  void kvBasis(out vec3 rt, out vec3 upv, out vec3 fw) {
    vec3 org = vec3(0.0);
    #ifdef USE_INSTANCING
      org = instanceMatrix[3].xyz;
    #endif
    vec3 worg = (modelMatrix * vec4(org, 1.0)).xyz;
    vec3 d = cameraPosition - worg;
    float l = length(d);
    fw = l > 1e-4 ? d / l : vec3(0.0, 0.0, 1.0);
    vec3 r0 = cross(vec3(0.0, 1.0, 0.0), fw);
    float rl = length(r0);
    rt = rl > 1e-3 ? r0 / rl : vec3(1.0, 0.0, 0.0);
    upv = normalize(cross(fw, rt));
  }
#endif
`;

// Hierarchical wind. The gust field is a pair of travelling waves evaluated at the *instance*
// origin, so a whole tree gusts as one body and neighbouring trees lag behind each other;
// `aFol.x` then distributes that bend up the trunk and out along the branches, and `aFol.z`
// adds a much faster per-card flutter on top.
const BILLBOARD_BODY = /* glsl */`
#ifdef VEG_BILLBOARD
{
  vec3 bbR, bbU, bbF;
  kvBasis(bbR, bbU, bbF);
  transformed = bbR * position.x + bbU * position.y;
}
#endif
`;

const BILLBOARD_NORMAL = /* glsl */`
#ifdef VEG_BILLBOARD
{
  vec3 bbR, bbU, bbF;
  kvBasis(bbR, bbU, bbF);
  objectNormal = normalize(vec3(0.0, 1.0, 0.0) * 0.85 + bbF * 0.5 + bbR * (position.x * 0.05));
}
#endif
`;

const AO_BODY = /* glsl */`
#ifdef VEG_AO
  vVegAo = aFol.w;
#endif
`;

const WIND_BODY = /* glsl */`
{
  vec3 iCol0 = vec3(1.0, 0.0, 0.0);
  vec3 iOrg  = vec3(0.0);
  #ifdef USE_INSTANCING
    iCol0 = instanceMatrix[0].xyz;
    iOrg  = instanceMatrix[3].xyz;
  #endif
  float isx = max(length(iCol0), 1e-4);
  float cs =  iCol0.x / isx;
  float sn = -iCol0.z / isx;

  vec3 wo = iOrg + modelMatrix[3].xyz;
  float g1 = sin(dot(wo.xz, uWindDir) * uGustScale - uTime * uGustSpeed);
  float g2 = sin(dot(wo.xz, vec2(-uWindDir.y, uWindDir.x)) * uGustScale * 1.87 - uTime * uGustSpeed * 0.53);
  float gust = clamp(0.42 + 0.40 * g1 + 0.22 * g2, 0.0, 1.25);

  float ph = fract(sin(dot(floor(wo.xz * 4.0), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  float sway = sin(uTime * 1.31 + ph) * 0.60 + sin(uTime * 2.27 + ph * 1.7) * 0.40;

  float bend = aFol.x * uBend * uWindStrength * gust * (0.42 + 0.58 * sway);
  vec2  wl   = vec2(cs * uWindDir.x - sn * uWindDir.y, sn * uWindDir.x + cs * uWindDir.y);
  float fl   = sin(uTime * 5.6 + aFol.y * 43.0 + transformed.y * 1.7 + ph)
             * aFol.z * uFlutter * uWindStrength * (0.3 + 0.7 * gust);

  transformed.x += wl.x * bend + fl * 0.75;
  transformed.z += wl.y * bend - fl * 0.55;
  transformed.y -= abs(bend) * aFol.x * 0.20 + fl * 0.30;
}
`;

const TRANS_PARS = /* glsl */`
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uTrans;
uniform float uTransPow;
#ifdef VEG_AO
  varying float vVegAo;
#endif
`;

// Cheap subsurface: light that reaches the camera *through* the leaf. Peaks when the sun is
// directly behind the fragment and is strongest on cards turned away from the sun.
const TRANS_BODY = /* glsl */`
{
  vec3  sunV  = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  float back  = pow( clamp( -dot( geometryViewDir, sunV ), 0.0, 1.0 ), uTransPow );
  float sheen = 1.0 - 0.55 * clamp( dot( geometryNormal, sunV ), 0.0, 1.0 );
  reflectedLight.indirectDiffuse += uSunColor * ( uTrans * back * sheen ) * diffuseColor.rgb;
}
`;

/**
 * Install the wind (and optionally the translucency / no-flip normal) patch on a material.
 * Composes with any hook already present, and is idempotent.
 */
export function patchVegetationMaterial(mat, wind, opts = {}) {
  const extra = {
    uBend:     { value: opts.bend ?? 0.22 },
    uFlutter:  { value: opts.flutter ?? 1.0 },
    uGustScale:{ value: opts.gustScale ?? 0.028 },
    uTrans:    { value: opts.translucency ?? 0.0 },
    uTransPow: { value: opts.transPow ?? 3.2 },
  };
  const lit = opts.lit !== false;
  mat.defines = mat.defines || {};
  if (lit) mat.defines.VEG_AO = '';
  if (opts.billboard) mat.defines.VEG_BILLBOARD = '';
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, wind, extra);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', WIND_PARS + '\nvoid main() {')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + BILLBOARD_NORMAL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + BILLBOARD_BODY + AO_BODY + WIND_BODY);
    if (lit) {
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', TRANS_PARS + '\nvoid main() {')
        .replace('#include <color_fragment>',
          '#include <color_fragment>\n\t#ifdef VEG_AO\n\tdiffuseColor.rgb *= vVegAo;\n\t#endif');
      if (opts.sphericalNormals) {
        // Spherical canopy normals must survive DoubleSide: three flips them for back faces,
        // which would black out half of every card.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_begin>',
          '#include <normal_fragment_begin>\n\tnormal = normalize( vNormal );');
      }
      if ((opts.translucency ?? 0) > 0) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TRANS_BODY);
      }
    }
  };
  mat.userData.vegUniforms = extra;
  mat.needsUpdate = true;
  return mat;
}

/** Alpha-tested canopy material: atlas map, spherical normals, wind and back-light. */
export function createFoliageMaterial(atlas, wind, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    color: opts.color ?? 0xffffff,
    alphaTest: opts.alphaTest ?? 0.34,
    side: THREE.DoubleSide,
    roughness: opts.roughness ?? 0.88,
    metalness: 0,
    envMapIntensity: opts.envMapIntensity ?? 0.55,
    shadowSide: THREE.DoubleSide,
  });
  mat.name = opts.name || 'veg-foliage';
  patchVegetationMaterial(mat, wind, {
    bend: opts.bend ?? 0.20, flutter: opts.flutter ?? 1.0, gustScale: opts.gustScale ?? 0.028,
    translucency: opts.translucency ?? 0.55, transPow: opts.transPow ?? 3.0,
    sphericalNormals: opts.sphericalNormals !== false && !opts.billboard,
    billboard: !!opts.billboard, lit: true,
  });
  // Foliage shadows must be alpha-tested *and* windswept, or the canopy shadow detaches.
  const dm = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: mat.alphaTest, side: THREE.DoubleSide,
  });
  patchVegetationMaterial(dm, wind, {
    bend: opts.bend ?? 0.20, flutter: opts.flutter ?? 1.0, gustScale: opts.gustScale ?? 0.028,
    billboard: !!opts.billboard, lit: false,
  });
  mat.userData.depthMaterial = dm;
  return mat;
}

/** Opaque bark material for trunks and branches (they sway with the same wind field). */
export function createBarkMaterial(bark, wind, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: bark.map, normalMap: bark.normalMap,
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 0.95, metalness: 0,
    envMapIntensity: 0.35,
  });
  mat.normalScale.set(opts.normalScale ?? 1.1, opts.normalScale ?? 1.1);
  mat.name = opts.name || 'veg-bark';
  patchVegetationMaterial(mat, wind, {
    bend: opts.bend ?? 0.10, flutter: 0.0, gustScale: opts.gustScale ?? 0.028,
    translucency: 0, sphericalNormals: false, lit: true,
  });
  const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchVegetationMaterial(dm, wind, { bend: opts.bend ?? 0.10, flutter: 0.0, gustScale: opts.gustScale ?? 0.028, lit: false });
  mat.userData.depthMaterial = dm;
  return mat;
}

/** Succulent material for prickly-pear pads — waxy, slightly translucent at the rim. */
export function createCactusMaterial(tex, wind) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughness: 0.62, metalness: 0, envMapIntensity: 0.5,
  });
  mat.name = 'veg-cactus';
  patchVegetationMaterial(mat, wind, {
    bend: 0.05, flutter: 0.25, gustScale: 0.03, translucency: 0.35, transPow: 4.0,
    sphericalNormals: false, lit: true,
  });
  return mat;
}
