/**
 * The ground.
 *
 * One chunked mesh over the heightfield, coloured by a vertex ramp rather than a splat map and
 * six procedural surface layers. Dogpatch is reclaimed industrial waterfront: flat grey fill,
 * the Bay to the east, Potrero Hill rising in the west. That is three colours and a slope test,
 * not a texture pipeline — and it is the honest amount of machinery for what the place is.
 */
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/math.js';

const CHUNK = 24;                       // grid posts per chunk edge
const SEA = 0.4;                        // metres; below this is Bay

// Concrete, worn asphalt, dry grass on the verges, and the Bay.
const C = {
  fill:   [0.53, 0.54, 0.55],
  dust:   [0.60, 0.59, 0.55],
  grass:  [0.42, 0.46, 0.34],
  rock:   [0.44, 0.45, 0.48],
  water:  [0.16, 0.26, 0.33],
};

export function createTerrain(world, opts = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const res = world.res, step = world.step, half = world.half;
  const lo = world.terrain.min, hi = world.terrain.max;

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0, flatShading: false,
  });
  mat.name = 'terrain';

  const nAcross = Math.ceil((res - 1) / CHUNK);
  for (let cz = 0; cz < nAcross; cz++) {
    for (let cx = 0; cx < nAcross; cx++) {
      const i0 = cx * CHUNK, j0 = cz * CHUNK;
      const iN = Math.min(CHUNK, res - 1 - i0), jN = Math.min(CHUNK, res - 1 - j0);
      if (iN <= 0 || jN <= 0) continue;
      const g = buildChunk(world, i0, j0, iN, jN, step, half, lo, hi);
      const m = new THREE.Mesh(g, mat);
      m.name = `terrain-${cx}-${cz}`;
      m.receiveShadow = opts.shadows !== false;
      group.add(m);
    }
  }
  return { object3D: group, material: mat,
    dispose() { group.traverse(o => o.geometry?.dispose()); mat.dispose(); } };
}

function buildChunk(world, i0, j0, iN, jN, step, half, lo, hi) {
  const w = iN + 1, h = jN + 1;
  const pos = new Float32Array(w * h * 3);
  const col = new Float32Array(w * h * 3);
  const nrm = new Float32Array(w * h * 3);
  const idx = [];
  const n = { x: 0, y: 1, z: 0 };

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gi = i0 + i, gj = j0 + j;
      const x = -half + gi * step, z = -half + gj * step;
      const y = world.grid(gi, gj);
      const k = (j * w + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;

      world.normalAt(x, z, n);
      nrm[k] = n.x; nrm[k + 1] = n.y; nrm[k + 2] = n.z;

      // Colour by height and slope. Below sea level is Bay; the flats are concrete-grey fill;
      // the hill greens on shallow ground and greys where it steepens.
      const slope = 1 - clamp01(n.y);
      const t = clamp01((y - lo) / Math.max(1, hi - lo));
      let c;
      if (y < SEA) c = C.water;
      else {
        const up = smoothstep(0.08, 0.42, t);                 // flats -> hill
        const base = mix(C.fill, C.dust, smoothstep(0.0, 0.18, t));
        const hill = mix(C.grass, C.rock, smoothstep(0.10, 0.42, slope));
        c = mix(base, hill, up);
      }
      // gentle deterministic mottling so a big flat plane is not one dead value
      const v = 0.94 + 0.12 * fract(Math.sin(gi * 12.9898 + gj * 78.233) * 43758.5453);
      // Vertex colours are read as LINEAR while these are authored the way you would pick them
      // in a colour picker, i.e. sRGB. Handing 0.53 straight over renders it near-white; the
      // ground came back looking like snow. Convert once, here.
      col[k] = srgb(c[0] * v); col[k + 1] = srgb(c[1] * v); col[k + 2] = srgb(c[2] * v);
    }
  }
  for (let j = 0; j < jN; j++) {
    for (let i = 0; i < iN; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const srgb = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const fract = v => v - Math.floor(v);
