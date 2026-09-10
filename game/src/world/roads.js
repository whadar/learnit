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

  // 'gravel' is the *circuit's* unsealed sector: a graded, oil-darkened limestone road, not
  // the pale village farm track ('dirt'). It keeps its own palette so the racing surface is
  // always a clear value step below the Amikam hillside.
  const dirtKind = p.kind === 'dirt' || p.kind === 'path';
  const sealed = p.kind === 'asphalt' || p.kind === 'gravel';
  const chip = p.kind === 'gravel';             // tar-and-chip, coarse pale aggregate

  /* Palettes are LINEAR albedo. The scene runs a hot sun through ACES plus a warm grade, so
   * every value here comes back a long way lifted: the pale hillside (linear ~0.30) renders
   * near byte 190, which is why the road has to be authored down at 0.06-0.11 to read as a
   * road at all. These numbers were chosen from rendered frames, not from a swatch.
   *
   * HUE. The asphalt base used to be authored blue-biased (b 0.056 > r 0.053). On a surface
   * this dark that bias is not a subtlety: almost none of a shaded road pixel comes from the
   * sun, so the ambient — a saturated cyan sky IBL plus a cyan hemisphere — dominates, and a
   * blue-biased albedo on top of blue-biased fill is what turns village tarmac into water.
   * The base is now faintly WARM (r > g > b), so the albedo pulls back against the fill
   * instead of piling onto it, and the material's `envMapIntensity` (see `createRoads`) keeps
   * the cyan half of that fill down where a dusty, sun-baked road actually sits. */
  const base = p.base || (p.kind === 'path' ? [0.40, 0.335, 0.245]
    : dirtKind ? [0.575, 0.515, 0.405]
      : chip ? [0.078, 0.0735, 0.067]
        : [0.0570, 0.0543, 0.0505]);
  const shoulderCol = p.shoulder || (dirtKind ? [0.50, 0.455, 0.335]
    : chip ? [0.235, 0.215, 0.163] : [0.225, 0.203, 0.152]);

  // Wheel paths. On a sun-baked road the tyre tracks are POLISHED — they come back lighter
  // and smoother than the coarse surface either side, which is what draws the racing line.
  const polish = p.polish || (sealed
    ? [{ at: p.road * 0.265, w: 0.46 }]
    : [{ at: p.road * 0.27, w: 0.34 }]);
  const R = rng(seed * 7919 + 13);
  /* Repair patches. `tone` is a MULTIPLIER on the surface already there, so it has to stay
   * near 1: the old bright branch reached 1.64, which over a 0.05 base painted metre-wide
   * blotches two-thirds brighter than the road they sit in — read by three review rounds as
   * pale puddles mid-ribbon. A bleached patch of the same chip seal is a batch difference,
   * not a different material: a quarter of a stop either way is the whole range. */
  const patches = [];
  if (p.kind === 'asphalt') for (let i = 0; i < 5; i++) {
    patches.push({ v: R() * p.vMetres, len: 0.9 + R() * 2.1, u: (R() - 0.5) * p.road * 0.78,
      wid: 0.8 + R() * 1.7, tone: R() < 0.55 ? 0.80 + R() * 0.13 : 1.09 + R() * 0.15, seed: (R() * 1e6) | 0 });
  }
  const stains = [];
  if (sealed) for (let i = 0; i < 5; i++) stains.push({ v: R() * p.vMetres, u: (R() - 0.5) * p.road * 0.4, r: 0.25 + R() * 0.6 });
  // transverse construction joints — one of the cheapest, strongest "this is a road" cues
  const joints = [];
  if (sealed) { const n = Math.max(1, Math.round(p.vMetres / 7.5)); for (let i = 0; i < n; i++) joints.push(i * p.vMetres / n + R() * 0.6); }

  // Edge line geometry, in metres from the centreline.
  const edgeInset = p.edgeInset ?? 0.52;                    // centre of the line, in from the edge
  const edgeHalf = p.edgeHalf ?? 0.115;                     // half-width: a fat 23 cm line so it
  const edgeAtU = roadHalf - edgeInset;                     // survives mip-mapping at distance
  const dustW = p.dustWidth ?? 0.62;                        // wind-drifted dust outboard of the line

  /* Noise helpers in metres: frequency `f` is cycles per metre in BOTH axes, and the lattice
   * period is derived from it so the pattern still tiles every `vMetres`. The old code passed
   * fixed lattice counts that did not match the frequency, which is what stretched the grain
   * into the vertical smears the critics saw. */
  const NF = (U, V, f, sd, oct = 3, gain = 0.5) =>
    fbm(U * f, V * f, Math.max(1, Math.round(f * p.total)), Math.max(1, Math.round(f * p.vMetres)), sd, oct, gain);
  const VN = (U, V, f, sd) =>
    vnoise(U * f, V * f, Math.max(1, Math.round(f * p.total)), Math.max(1, Math.round(f * p.vMetres)), sd);
  const RG = (U, V, f, sd, oct = 3) =>
    ridged(U * f, V * f, Math.max(1, Math.round(f * p.total)), Math.max(1, Math.round(f * p.vMetres)), sd, oct);

  /* The highest spatial frequency this texture can actually carry, in cycles per metre.
   * Value noise needs ~2.4 texels per lattice cell before it turns to hash, and the U axis is
   * always the tighter of the two here. Every aggregate frequency below is expressed as a
   * fraction of `FMAX` so a 96-texel footpath and a 640-texel circuit both land on the
   * finest grain they can hold instead of one aliasing and the other going smooth. */
  const FMAX = Math.min(W / p.total, H / p.vMetres) / 2.4;

  for (let j = 0; j < H; j++) {
    const V = j * my;                            // metres along
    for (let i = 0; i < W; i++) {
      const U = (i + 0.5) * mx - half;           // metres across, 0 = centreline
      const k = j * W + i;
      const au = Math.abs(U);

      // --- ragged hard-surface edge ---------------------------------------
      const wobble = (NF(au, V, 0.55, seed + 41, 3) - 0.5) * 0.5
        + (NF(au, V, 2.6, seed + 87, 2) - 0.5) * 0.16;
      const edgeAt = roadHalf + wobble;
      const onRoad = clamp((edgeAt - au) / 0.26 + 0.5, 0, 1);

      // --- base surface ----------------------------------------------------
      let r = base[0], g = base[1], b = base[2], rough = sealed ? 0.74 : 0.92, h = 0;

      if (!sealed) {
        // village farm track / footpath: pale limestone, ruts, a weed strip. The loose
        // gravel gets the same treatment as the sealed aggregate — scattered stones at the
        // texture's finest usable frequency, not a soft fbm haze.
        const dust = NF(U, V, 0.85, seed + 3, 4);
        const grit = VN(U, V, FMAX, seed + 19) * 0.6 + VN(U, V, FMAX * 0.55, seed + 23) * 0.4;
        const stones = clamp((VN(U + (grit - 0.5) * 0.06, V, FMAX * 0.72, seed + 29) - 0.60) * 3.0, 0, 1);
        const tone = 0.88 + dust * 0.20 + (grit - 0.5) * 0.34;
        r *= tone; g *= tone * 0.99; b *= tone * 0.95;
        r = lerp(r, r * 1.30 + 0.030, stones * 0.8);
        g = lerp(g, g * 1.29 + 0.028, stones * 0.8);
        b = lerp(b, b * 1.26 + 0.024, stones * 0.8);
        h = dust * 0.5 + (grit - 0.5) * 1.9 + stones * 2.2;
        let rut = 0;
        for (const bd of polish) rut = Math.max(rut, Math.exp(-((au - bd.at) ** 2) / (2 * bd.w * bd.w)) * (bd.k ?? 1));
        r = lerp(r, r * 0.80, rut); g = lerp(g, g * 0.79, rut); b = lerp(b, b * 0.80, rut);
        rough -= rut * 0.16; h -= rut * 0.75;
        if (p.kind === 'dirt') {
          const cen = Math.exp(-(U * U) / (2 * 0.52 * 0.52));
          const tuft = NF(U, V, 3.5, seed + 61, 3);
          const gr = clamp(cen * (tuft * 1.7 - 0.32), 0, 1);
          r = lerp(r, 0.255 + tuft * 0.10, gr); g = lerp(g, 0.275 + tuft * 0.13, gr); b = lerp(b, 0.118 + tuft * 0.05, gr);
          rough = lerp(rough, 0.97, gr); h += gr * 1.5;
        }
        const st = VN(U, V, 3.4, seed + 909);
        if (st > 0.90) { const q = (st - 0.90) * 10; r += q * 0.20; g += q * 0.19; b += q * 0.17; h += q * 1.3; }
      } else {
        /* ---- sealed racing surface: chip-seal tarmac ------------------------------
         * A chip seal is not a tinted plane: it is a bed of 8-14 mm limestone chippings
         * rolled into black bitumen. Nearly all of the surface's read — at every distance —
         * comes from the value step between the pale stone tops and the near-black binder
         * between them, so that step is authored as high and as fine as the texture can
         * carry (see `FMAX`) rather than as the gentle 12 % tint the old surface used.
         *
         * The whole sample point is domain warped first. Warping matters: thresholding a
         * value-noise lattice straight makes *axis-aligned rectangles*, which is exactly why
         * the previous aggregate read as square blotches following the road direction rather
         * than as stones. The warp field tiles on the same lattice, so the V repeat is still
         * seamless. */
        const macro = NF(U, V, 0.30, seed + 71, 4);            // sun-bleach / age drift
        const tone = 0.90 + macro * 0.20;
        // no blue lift here: the sun-bleach of a chip seal takes the *blue* out of the
        // binder, it does not add it. (This term used to end `* 1.03` on b.)
        r *= tone; g *= tone; b *= tone * 0.985;

        const wu = (NF(U, V, 1.7, seed + 1201, 2) - 0.5) * 0.115 + (NF(U, V, 5.5, seed + 1213, 2) - 0.5) * 0.045;
        const wv = (NF(U, V, 1.7, seed + 1307, 2) - 0.5) * 0.115 + (NF(U, V, 5.5, seed + 1319, 2) - 0.5) * 0.045;
        const Uw = U + wu, Vw = V + wv;

        /* Stone fields. The FINEST field carries the aggregate — a chipping is about a
         * centimetre, and anything coarser reads as cobblestones rather than as tarmac. The
         * medium field only thins and thickens the pack and varies stone colour; the coarse
         * one just drops the occasional bigger pebble in. */
        /* `FMAX` is already the finest frequency this texture can carry (2.4 texels per
         * lattice cell). Running the *aggregate* field at 1.15 * FMAX put the stones at two
         * texels each — below a mip level, so the pack could not attenuate with distance and
         * came back as fixed-screen-size salt-and-pepper that shimmers at speed. The pack now
         * tops out at 0.62 * FMAX, i.e. about four texels a stone, which is the coarsest
         * grain that still mips honestly. */
        const fA = FMAX * 0.17, fB = FMAX * 0.33, fC = FMAX * 0.62;
        const a1 = VN(Uw, Vw, fA, seed + 401);
        const a2 = VN(Uw, Vw, fB, seed + 733);
        const a3 = VN(Uw, Vw, fC, seed + 915);
        // sand fines and binder grain filling the gaps between the stones
        const fines = VN(Uw, Vw, fC * 1.03, seed + 1471) * 0.64 + VN(Uw, Vw, fB * 0.83, seed + 1499) * 0.36;
        /* Coverage. The cut sits just under the field's own mean, so the chippings pack
         * shoulder to shoulder the way a rolled chip seal does, and the gain is steep enough
         * that the step from binder to stone survives two or three mip levels. */
        const un = a3 * 0.88 + a2 * 0.12;
        const cov = chip ? 0.468 : 0.498;
        let agg = clamp((un - cov) * 3.6, 0, 1);
        agg = agg * agg * (3 - 2 * agg);
        const pebble = clamp((a1 - 0.905) * 8, 0, 1);

        // black bitumen with its sand fines, then the stones bedded into it
        const binderK = 0.735 + (fines - 0.5) * 0.17;
        // Fresh bitumen is genuinely a touch cool, but only a touch — 1.02 on b here plus
        // 1.03 on the macro tone plus a blue-biased base stacked three blue lifts on one
        // surface. One of them, at half strength, is enough to keep the hue interest.
        r *= binderK; g *= binderK; b *= binderK * 1.01;
        const cHi = chip ? [0.0975, 0.0933, 0.0832] : [0.0870, 0.0838, 0.0778];
        // every stone reads a different value — some are freshly fractured and bright,
        // some are tar-glazed and nearly as dark as the binder. The spread is narrower than
        // it was (0.36..1.34): at four texels a stone the old range mipped down to a churn
        // of light and dark rather than to the surface's true mean.
        const stone = clamp(0.80 + a2 * 0.34 + (a3 - 0.5) * 0.16, 0.52, 1.20);
        const ak = clamp(agg * 0.90 + pebble * 0.30, 0, 1);
        r = lerp(r, cHi[0] * stone, ak);
        g = lerp(g, cHi[1] * stone, ak);
        b = lerp(b, cHi[2] * stone, ak);

        // Height is what the sobel below turns into the normal map, so the stones are given
        // real relief: a chipping stands ~4 mm proud of the binder and that shadow line is
        // most of what the eye uses to call a surface "rough" under a hard sun.
        h = agg * 0.34 + pebble * 0.34 + (fines - 0.5) * 0.46 + macro * 0.30;
        rough = (chip ? 0.885 : 0.86) + agg * 0.115 - (fines - 0.5) * 0.16;

        // tyre-polished wheel paths: lighter, smoother, and the surface's racing line.
        // The tyre polishes the STONE TOPS, not the binder in between, so the wear is
        // weighted by aggregate coverage instead of being an airbrushed band of pale grey.
        let pol = 0;
        for (const bd of polish) pol = Math.max(pol, Math.exp(-((au - bd.at) ** 2) / (2 * bd.w * bd.w)) * (bd.k ?? 1));
        pol *= 0.72 + NF(U, V, 0.22, seed + 617, 3) * 0.55;
        const wear = clamp(pol, 0, 1);
        const wk = clamp(wear * (0.34 + agg * 0.90), 0, 1);
        r = lerp(r, r * 1.62 + 0.0118, wk); g = lerp(g, g * 1.61 + 0.0114, wk); b = lerp(b, b * 1.57 + 0.0108, wk);
        rough -= wear * 0.13; h -= wear * 0.45;

        // repair patches: half are fresh dark seal, half are old bleached ones
        for (const pa of patches) {
          let dv = Math.abs(V - pa.v); dv = Math.min(dv, p.vMetres - dv);
          // a hand-cut patch is never a clean rectangle: wobble both edges
          const wb = (NF(U, V, 1.1, pa.seed + 7, 2) - 0.5) * 0.45;
          const inV = clamp((pa.len + wb - dv) / 0.22, 0, 1);
          const inU = clamp((pa.wid + wb - Math.abs(U - pa.u)) / 0.22, 0, 1);
          const m = inU * inV;
          if (m <= 0) continue;
          /* A patch is a different BATCH of the same chip seal, not a hole in it: tint what
           * is already there rather than lerping to a flat base colour, so the aggregate
           * survives inside the patch. Lerping to base is what turned patches into rounded
           * dark rectangles that read as puddles. */
          const pt = pa.tone * (0.92 + NF(U, V, 1.4, pa.seed, 3) * 0.20);
          const pm = m * 0.85, pk = lerp(1, pt, pm);
          r *= pk; g *= pk; b *= pk;
          rough = lerp(rough, 0.87, m * 0.7);
          h = lerp(h, h * 0.72 + 0.5, pm);
          const seam = m * (1 - m) * 4;
          r -= seam * 0.012; g -= seam * 0.012; b -= seam * 0.012; h -= seam * 1.4;
        }
        // transverse construction joints across the full width
        for (const jv of joints) {
          let dv = Math.abs(V - jv); dv = Math.min(dv, p.vMetres - dv);
          const wob = (NF(U, V, 0.9, seed + 313, 2) - 0.5) * 0.10;
          const m = clamp(1 - Math.abs(dv + wob) / 0.075, 0, 1);
          if (m <= 0) continue;
          r = lerp(r, r * 0.72, m); g = lerp(g, g * 0.72, m); b = lerp(b, b * 0.74, m);
          h -= m * 1.4; rough = lerp(rough, 0.86, m);
        }
        // crack network
        const cx = RG(U, V, 0.85, seed + 211, 3);
        const crack = clamp((cx - 0.855) * 8, 0, 1) * clamp(0.25 + macro * 0.9, 0, 1);
        r = lerp(r, r * 0.30, crack); g = lerp(g, g * 0.30, crack); b = lerp(b, b * 0.32, crack);
        h -= crack * 2.2; rough = lerp(rough, 0.93, crack);
        // oil marks down the middle
        for (const s of stains) {
          let dv = Math.abs(V - s.v); dv = Math.min(dv, p.vMetres - dv);
          const d = Math.hypot((U - s.u) * 1.6, dv);
          const m = clamp(1 - d / s.r, 0, 1) ** 1.6 * 0.5;
          r = lerp(r, r * 0.62, m); g = lerp(g, g * 0.62, m); b = lerp(b, b * 0.66, m);
          rough = lerp(rough, 0.62, m);
        }
        // wind-drifted dust banked against the edges — warm, pale, and always OUTBOARD of
        // the painted edge line, so it never eats the contrast that makes the edge readable.
        const dz = clamp((au - (edgeAtU + edgeHalf)) / dustW, 0, 1);
        const drift = clamp(dz * dz * (0.42 + NF(U, V, 0.75, seed + 881, 3) * 0.80), 0, 0.72);
        const dcol = [0.148, 0.126, 0.086];
        r = lerp(r, dcol[0], drift); g = lerp(g, dcol[1], drift); b = lerp(b, dcol[2], drift);
        rough = lerp(rough, 0.95, drift);
      }

      // --- shoulder / verge -------------------------------------------------
      if (onRoad < 1) {
        const gv = NF(U, V, 1.0, seed + 303, 4);
        const st = VN(U, V, 3.0, seed + 707);
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
        const worn = NF(U, V, 0.55, seed + 555, 4);
        const paint = (dist, wide, dash) => {
          let a = clamp((wide - dist) / 0.045 + 0.5, 0, 1);
          if (a <= 0) return 0;
          if (dash) {
            const ph = (V % dash.period) / dash.period;
            if (ph > dash.duty) return 0;
            a *= clamp(Math.min(ph, dash.duty - ph) / 0.04, 0, 1);
          }
          // scuffed, but never below half strength: a line that fades out is a line the
          // player cannot use to find the edge of the road.
          return a * clamp(1.45 - worn * 0.95, 0.45, 1);
        };
        let pa = 0;
        if (p.centre === 'solid') pa = Math.max(pa, paint(au, 0.085, null));
        else if (p.centre === 'dash') pa = Math.max(pa, paint(au, 0.085, { period: p.vMetres / Math.max(1, Math.round(p.vMetres / 8)), duty: 0.42 }));
        else if (p.centre === 'double') pa = Math.max(pa, paint(Math.abs(au - 0.16), 0.075, null));
        if (p.edge) pa = Math.max(pa, paint(Math.abs(au - edgeAtU), edgeHalf, null) * onRoad);
        if (pa > 0) {
          pa *= onRoad;
          const pc = p.paintCol || [0.60, 0.585, 0.545];
          r = lerp(r, pc[0], pa); g = lerp(g, pc[1], pa); b = lerp(b, pc[2], pa);
          rough = lerp(rough, 0.66, pa);
          // Paint fills the voids between the chippings. Leaving the aggregate relief under
          // a marking gave every line a rash of sky-blue facets where the strong normal map
          // tipped the white paint towards the sky.
          h = lerp(h, h * 0.22 + 0.45, pa);
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
    // A dusty, sun-baked road takes almost nothing from the sky. Left at 1.0 the IBL sheen
    // washed the ribbon out to sand at grazing angles, which is what made the surface albedo
    // look like it changed from frame to frame.
    envMapIntensity: opts.envMapIntensity ?? 0.45,
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
{ // De-tile without smearing: a *small* mid-frequency drift plus a fine grain. The old
  // 28 m / 0.42-amplitude term painted metre-wide dark smudges over the whole ribbon.
  float m = rdN(vRoadW.xz * 0.085) * 0.45 + rdN(vRoadW.xz * 0.34) * 0.35 + rdN(vRoadW.xz * 1.7) * 0.20;
  diffuseColor.rgb *= 0.945 + 0.115 * m; }`);
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
  // vertex colours ride along only when every input carries them
  const withCol = list.length > 0 && list.every(g => !!g.attributes.color);
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = withCol ? new Float32Array(nv * 3) : null;
  const idx = nv > 65000 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array, ix = g.index.array;
    pos.set(p, vo * 3); nor.set(n, vo * 3); uv.set(u, vo * 2);
    if (col) col.set(g.attributes.color.array, vo * 3);
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += g.attributes.position.count; io += ix.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
      W: key === 'path' ? 96 : 208, H: key === 'path' ? 512 : 1024,
    });
    /* Sky IBL, per surface class. A sealed road is authored at linear ~0.055 — an order of
     * magnitude darker than the hillside around it — so whatever the environment puts on it
     * is not a sheen, it is most of the pixel wherever the sun does not reach. The sky dome
     * here is a saturated Mediterranean cyan, and at 0.45 it was painting village asphalt
     * blue in every shadow. Tarmac is a dusty dielectric with no meaningful reflection, so it
     * gets a whisper; the pale limestone track and footpath are brighter and genuinely a
     * little more open to the sky, so they keep more. */
    const mat = mats[key] = createRoadMaterial(tex, {
      normalScale: key === 'track' ? 1.2 : 0.95,
      envMapIntensity: (key === 'major' || key === 'minor') ? 0.13 : 0.30,
    });
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
