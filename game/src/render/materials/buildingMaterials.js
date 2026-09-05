/**
 * Procedural material set for the Amikam village architecture.
 *
 * Everything here is generated in-repo from the shared noise helpers: white/cream plaster,
 * Jerusalem-stone ashlar cladding, red-orange clay pantiles, and the aluminium slats of an
 * Israeli rolling shutter (trís). Each surface ships a colour map (sRGB), a tangent-space
 * normal map and a roughness map baked from the same height field, so the shading detail and
 * the silhouette detail agree.
 *
 * Textures are authored to a known world size (`worldSize` on each material's userData) so the
 * geometry builder can emit UVs in metres and get consistent tiling on every wall in the
 * village.
 */
import * as THREE from 'three';
import { fbmField, heightToNormal, hash2i } from './noise.js';
import { clamp, lerp, smoothstep, rng } from '../../core/mathx.js';

/* --------------------------------------------------------------------- plumbing ---- */

function tex(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function normalTex(height, size, strength) {
  const d = new Uint8Array(size * size * 4);
  heightToNormal(height, size, strength, (i, x, y, z) => {
    d[i * 4] = (x * 0.5 + 0.5) * 255;
    d[i * 4 + 1] = (y * 0.5 + 0.5) * 255;
    d[i * 4 + 2] = (z * 0.5 + 0.5) * 255;
    d[i * 4 + 3] = 255;
  });
  return tex(d, size, false);
}

/** Pack roughness into G (three reads roughnessMap.g) and metalness into B. */
function ormTex(size, rough, metal) {
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = 255;
    d[i * 4 + 1] = clamp(rough[i], 0, 1) * 255;
    d[i * 4 + 2] = metal ? clamp(metal[i], 0, 1) * 255 : 0;
    d[i * 4 + 3] = 255;
  }
  return tex(d, size, false);
}

/* ------------------------------------------------------------------- plaster ------ */
/** Hand-floated cement stucco: broad trowel mottle over a fine sand grain. 4 m across. */
function plasterMaps(size) {
  const mott = fbmField(size, { octaves: 5, period: 4, seed: 11 });
  const trowel = fbmField(size, { octaves: 3, period: 9, gain: 0.55, seed: 57 });
  const grain = fbmField(size, { octaves: 4, period: 46, seed: 23 });
  const fine = fbmField(size, { octaves: 3, period: 150, seed: 31 });
  const col = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const rgh = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const m = mott[i] - 0.5, t = trowel[i] - 0.5, g = grain[i] - 0.5, f = fine[i] - 0.5;
    h[i] = f * 0.62 + g * 0.42 + t * 0.16;
    // patchy staining: old lime wash over cement render
    const stain = smoothstep(0.52, 0.80, mott[i]) * 0.085;
    const v = 1 + m * 0.070 + t * 0.055 + g * 0.030 - stain;
    col[i * 4] = clamp(241 * v, 0, 255);
    col[i * 4 + 1] = clamp(230 * (v - stain * 0.30), 0, 255);
    col[i * 4 + 2] = clamp(202 * (v - stain * 0.85), 0, 255);
    col[i * 4 + 3] = 255;
    rgh[i] = clamp(0.83 + m * 0.10 + g * 0.05, 0.45, 0.99);
  }
  return { map: tex(col, size, true), normalMap: normalTex(h, size, 1.35), roughnessMap: ormTex(size, rgh) };
}

/* --------------------------------------------------------------- jerusalem stone -- */
/**
 * Ashlar cladding, four courses over 2 m. Stones are laid to random widths per course with a
 * staggered offset, chiselled ("tobzeh") faces and a deep recessed joint — the bevel is what
 * makes a stone wall read as stone at 40 m instead of as a beige rectangle.
 */
function stoneMaps(size) {
  const rows = 5, rowH = size / rows, joint = 4.0;
  const rand = rng(4242);
  const courses = [];
  for (let r = 0; r < rows; r++) {
    const n = 4 + (rand() < 0.45 ? 0 : 1);
    const w = [];
    let tot = 0;
    for (let k = 0; k < n; k++) { const ww = 0.64 + rand() * 0.72; w.push(ww); tot += ww; }
    const bs = [0];
    let acc = 0;
    for (let k = 0; k < n; k++) { acc += w[k] / tot * size; bs.push(acc); }
    courses.push({ bs, off: rand() * size, n });
  }
  const chisel = fbmField(size, { octaves: 4, period: 60, seed: 71 });
  const coarse = fbmField(size, { octaves: 3, period: 14, seed: 83 });
  const grime = fbmField(size, { octaves: 4, period: 6, seed: 97 });
  const col = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const rgh = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = Math.min(rows - 1, Math.floor(y / rowH));
    const c = courses[row];
    const yy = y - row * rowH;
    const dyEdge = Math.min(yy, rowH - yy);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xx = (x + c.off) % size;
      let s = 0;
      while (s < c.n && xx >= c.bs[s + 1]) s++;
      const x0 = c.bs[s], x1 = c.bs[Math.min(s + 1, c.n)];
      const dxEdge = Math.min(xx - x0, x1 - xx);
      const d = Math.min(dxEdge, dyEdge);
      const face = smoothstep(joint * 0.35, joint + 5.5, d);      // bevelled edge into the joint
      const fx = clamp((xx - x0) / Math.max(1, x1 - x0), 0, 1);
      const fy = clamp(yy / rowH, 0, 1);
      const bulge = Math.sin(Math.PI * fx) * Math.sin(Math.PI * fy);
      const ch = (chisel[i] - 0.5) * 2;
      h[i] = face * (0.72 + bulge * 0.24 + ch * 0.20 * face) - (1 - face) * 0.10;
      // per-stone colour: warm limestone, some blocks pinker, some greyer
      const sid = hash2i(s + 1, row + 1, 909);
      const sid2 = hash2i(s + 3, row + 7, 313);
      const warm = 0.94 + sid * 0.14;
      const grey = sid2 * 0.5;
      let r = 241 * warm - grey * 10 + ch * 14 + (coarse[i] - 0.5) * 17;
      let g = 204 * warm - grey * 12 + ch * 12 + (coarse[i] - 0.5) * 14;
      let b = 134 * warm + grey * 26 + ch * 10 + (coarse[i] - 0.5) * 11;
      const gm = smoothstep(0.52, 0.85, grime[i]) * 0.16;         // weather staining
      r *= 1 - gm * 1.05; g *= 1 - gm; b *= 1 - gm * 0.8;
      const jm = 1 - face;                                        // mortar joint: cool grey, in shade
      r = lerp(r, 128, jm * 0.92); g = lerp(g, 114, jm * 0.92); b = lerp(b, 92, jm * 0.92);
      const ao = lerp(0.66, 1, face);
      col[i * 4] = clamp(r * ao, 0, 255);
      col[i * 4 + 1] = clamp(g * ao, 0, 255);
      col[i * 4 + 2] = clamp(b * ao, 0, 255);
      col[i * 4 + 3] = 255;
      rgh[i] = clamp(lerp(0.94, 0.74 + ch * 0.09, face), 0.4, 1);
    }
  }
  return { map: tex(col, size, true), normalMap: normalTex(h, size, 2.3), roughnessMap: ormTex(size, rgh) };
}

/* -------------------------------------------------------------------- pantiles ---- */
/**
 * Red clay pantiles ("rief marseille"), 6 columns x 5 courses over 2 m. Each tile is a flat
 * pan with a barrel roll down its right edge and a raised lap at its head; per-tile hue jitter
 * and lichen keep 552 roofs from looking silkscreened.
 */
function pantileMaps(size) {
  const COLS = 6, ROWS = 5;
  const lichen = fbmField(size, { octaves: 4, period: 7, seed: 131 });
  const grit = fbmField(size, { octaves: 3, period: 90, seed: 149 });
  const wear = fbmField(size, { octaves: 4, period: 3, seed: 163 });
  const col = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const rgh = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    // v grows up the slope; course index and fraction within the course
    const rr = v * ROWS, ri = Math.floor(rr), rf = rr - ri;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const cc = u * COLS, ci = Math.floor(cc), cf = cc - ci;
      const jit = hash2i(ci, ri, 17);
      const jit2 = hash2i(ci, ri, 991);
      // --- height ---------------------------------------------------------------
      let hh = 0.30 + jit * 0.05;
      if (cf > 0.60) {                                   // barrel roll on the right edge
        const t = (cf - 0.60) / 0.40;
        hh += Math.pow(Math.sin(Math.PI * t), 0.72) * 0.78;
      } else {                                           // shallow pan, dished
        const t = cf / 0.60;
        hh -= Math.sin(Math.PI * t) * 0.10;
      }
      const seam = smoothstep(0.055, 0.0, Math.min(cf, 1 - cf)) * 0.52;   // dark groove between tiles
      hh -= seam;
      const lap = smoothstep(0.13, 0.0, rf);             // head lap of the tile above
      hh += lap * 0.42;
      hh -= smoothstep(0.13, 0.22, rf) * smoothstep(0.34, 0.21, rf) * 0.40;  // shadow line under the lap
      hh += (grit[i] - 0.5) * 0.10;
      h[i] = hh;
      // --- colour ---------------------------------------------------------------
      const hue = jit2;
      let r = lerp(217, 163, hue) + (jit - 0.5) * 42;
      let g = lerp(104, 68, hue) + (jit - 0.5) * 24;
      let b = lerp(64, 44, hue) + (jit - 0.5) * 18;
      const sun = clamp(0.44 + hh * 0.74, 0.24, 1.24);   // baked curvature shading
      r *= sun; g *= sun; b *= sun;
      const lm = smoothstep(0.60, 0.86, lichen[i] * 0.72 + wear[i] * 0.36);
      r = lerp(r, 150, lm * 0.55); g = lerp(g, 149, lm * 0.55); b = lerp(b, 128, lm * 0.55);
      const dirt = smoothstep(0.13, 0.0, rf) * 0.34;     // grime collects in the lap
      r *= 1 - dirt; g *= 1 - dirt * 0.92; b *= 1 - dirt * 0.85;
      col[i * 4] = clamp(r, 0, 255);
      col[i * 4 + 1] = clamp(g, 0, 255);
      col[i * 4 + 2] = clamp(b, 0, 255);
      col[i * 4 + 3] = 255;
      rgh[i] = clamp(0.80 - hh * 0.14 + lm * 0.10 + (grit[i] - 0.5) * 0.08, 0.42, 0.98);
    }
  }
  return { map: tex(col, size, true), normalMap: normalTex(h, size, 2.9), roughnessMap: ormTex(size, rgh) };
}

/* --------------------------------------------------------------------- shutters --- */
/** Rolling-shutter slats (trisim): 16 aluminium slats per metre-square tile. */
function shutterMaps(size) {
  const SLATS = 16;
  const grain = fbmField(size, { octaves: 3, period: 70, seed: 211 });
  const col = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const rgh = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const s = (y / size) * SLATS, sf = s - Math.floor(s);
    // slat profile: flat face, rolled lower lip, deep shadow gap at the joint
    let hh = 0.55 + Math.sin(Math.PI * clamp((sf - 0.08) / 0.92, 0, 1)) * 0.32;
    hh -= smoothstep(0.10, 0.0, sf) * 0.85;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      h[i] = hh + (grain[i] - 0.5) * 0.05;
      const shade = clamp(0.58 + hh * 0.46, 0, 1.15);
      const gap = smoothstep(0.085, 0.0, sf);
      let r = 214 * shade, g = 210 * shade, b = 199 * shade;
      r = lerp(r, 38, gap); g = lerp(g, 36, gap); b = lerp(b, 34, gap);
      col[i * 4] = clamp(r, 0, 255); col[i * 4 + 1] = clamp(g, 0, 255);
      col[i * 4 + 2] = clamp(b, 0, 255); col[i * 4 + 3] = 255;
      rgh[i] = clamp(0.48 + gap * 0.4 + (grain[i] - 0.5) * 0.1, 0.2, 0.95);
    }
  }
  return { map: tex(col, size, true), normalMap: normalTex(h, size, 3.4), roughnessMap: ormTex(size, rgh) };
}

/* ----------------------------------------------------------------------- public --- */

let _cache = null;

export function buildBuildingTextures(size = 512) {
  if (_cache) return _cache;
  _cache = {
    plaster: plasterMaps(size),
    stone: stoneMaps(size),
    tile: pantileMaps(size),
    shutter: shutterMaps(Math.min(size, 256)),
  };
  return _cache;
}

/**
 * The five merged-geometry materials plus the instanced-prop material. Every one takes vertex
 * colours, which is how a single merged mesh still gives 552 buildings their own plaster tint,
 * roof hue and shaded soffits.
 */
export function createBuildingMaterials(opts = {}) {
  const t = buildBuildingTextures(opts.textureSize ?? 512);

  const plaster = new THREE.MeshStandardMaterial({
    name: 'bld-plaster', ...t.plaster, vertexColors: true,
    roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });
  plaster.userData.worldSize = 4.0;

  const stone = new THREE.MeshStandardMaterial({
    name: 'bld-stone', ...t.stone, vertexColors: true,
    roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.15, 1.15),
  });
  stone.userData.worldSize = 2.0;

  const tile = new THREE.MeshStandardMaterial({
    name: 'bld-tile', ...t.tile, vertexColors: true,
    roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  tile.userData.worldSize = 2.0;

  const shutter = new THREE.MeshStandardMaterial({
    name: 'bld-shutter', ...t.shutter, vertexColors: true,
    roughness: 1.0, metalness: 0.25,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  shutter.userData.worldSize = 1.0;

  // Interior-dark window glass. Kept opaque: the sky reflection off a low-roughness surface
  // plus a near-black base reads exactly like a shaded room, and costs no sorting.
  const glass = new THREE.MeshStandardMaterial({
    name: 'bld-glass', color: 0x51707f, vertexColors: true,
    roughness: 0.13, metalness: 0.0, envMapIntensity: 2.6,
  });

  // Painted metal / galvanised steel for solar heaters, tanks, A/C, railings.
  const metal = new THREE.MeshStandardMaterial({
    name: 'bld-metal', vertexColors: true, roughness: 0.42, metalness: 0.55, envMapIntensity: 1.1,
  });

  // Greenhouse polythene: thin, milky, lit from both sides.
  const sheeting = new THREE.MeshStandardMaterial({
    name: 'bld-sheeting', color: 0xe8f2ea, vertexColors: true,
    roughness: 0.34, metalness: 0.0, transparent: true, opacity: 0.44,
    side: THREE.DoubleSide, envMapIntensity: 1.5, depthWrite: false,
  });

  // Vine canopy over pergolas.
  const foliage = new THREE.MeshStandardMaterial({
    name: 'bld-vine', vertexColors: true, roughness: 0.86, metalness: 0.0,
    side: THREE.DoubleSide,
  });

  // Distant LOD: same plaster surface, no window geometry, tinted per building.
  const farSurface = new THREE.MeshStandardMaterial({
    name: 'bld-far', map: t.plaster.map, normalMap: t.plaster.normalMap, vertexColors: true,
    roughness: 0.88, metalness: 0.0, normalScale: new THREE.Vector2(0.4, 0.4),
  });
  farSurface.userData.worldSize = 4.0;
  const farRoof = new THREE.MeshStandardMaterial({
    name: 'bld-far-roof', map: t.tile.map, normalMap: t.tile.normalMap, vertexColors: true,
    roughness: 0.85, metalness: 0.0, normalScale: new THREE.Vector2(0.5, 0.5),
  });
  farRoof.userData.worldSize = 2.0;

  return { plaster, stone, tile, shutter, glass, metal, sheeting, foliage, farSurface, farRoof };
}
