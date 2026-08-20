/**
 * Ground for the Amikam Village Circuit.
 *
 * The 3072 m heightfield is cut into a grid of chunks, each rebuilt at one of six resolutions
 * depending on how far it is from the camera (0.75 m triangles under the karts, 24 m out at the
 * horizon) with a downward skirt so LOD cracks never show sky. Normals are evaluated
 * analytically from the heightfield rather than from face normals, so shading stays smooth
 * across LOD changes.
 *
 * On top of that sits the splatted limestone / terra-rossa / stubble material
 * (`src/render/materials/terrainMaterial.js`) and a deterministic scatter of limestone boulders
 * and dry-stone terrace ledges — the signature of a Ramot Menashe hillside.
 *
 *   const terrain = createTerrain(engine, world, { quality: 1 });
 *   terrain.update(dt);        // also registered with the engine, safe to call twice
 *   terrain.setQuality(0.5);
 */
import * as THREE from 'three';
import { rng, clamp } from '../core/mathx.js';
import { hash2i } from '../render/materials/noise.js';
import { buildTerrainTextures, createTerrainMaterial, createStoneMaterial } from '../render/materials/terrainMaterial.js';

// 32 x 32 chunks of 96 m. LOD 0 is 0.75 m triangles; keeping the chunks small means the
// dense ring hugs the kart instead of spending 130k triangles on a 192 m tile.
const LOD_SEGS = [128, 64, 32, 16, 8, 4];
const LOD_DIST = [62, 145, 310, 680, 1400, Infinity];

/* ------------------------------------------------------------------ geometry ---- */

/** One chunk of heightfield, `seg` quads across, with a skirt hanging `skirt` metres down. */
function buildChunkGeometry(world, x0, z0, size, seg, skirt) {
  const n = seg + 1, st = size / seg;
  const grid = n * n, nv = grid + 4 * n;
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const d = Math.max(world.step, st * 0.5);
  let minY = Infinity, maxY = -Infinity;

  for (let j = 0; j < n; j++) {
    const z = z0 + j * st;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * st;
      const y = world.heightAt(x, z);
      const k = (j * n + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      // analytic smooth normal from central differences on the heightfield
      const hl = world.heightAt(x - d, z), hr = world.heightAt(x + d, z);
      const hd = world.heightAt(x, z - d), hu = world.heightAt(x, z + d);
      let nx = hl - hr, ny = 2 * d, nz = hd - hu;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nrm[k] = nx * inv; nrm[k + 1] = ny * inv; nrm[k + 2] = nz * inv;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Skirt rings: duplicate each border vertex, pushed straight down.
  const edges = [];
  for (let i = 0; i < n; i++) edges.push(i);                       // j = 0
  for (let i = 0; i < n; i++) edges.push((n - 1) * n + i);         // j = seg
  for (let j = 0; j < n; j++) edges.push(j * n);                   // i = 0
  for (let j = 0; j < n; j++) edges.push(j * n + (n - 1));         // i = seg
  for (let e = 0; e < edges.length; e++) {
    const src = edges[e] * 3, dst = (grid + e) * 3;
    pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - skirt; pos[dst + 2] = pos[src + 2];
    nrm[dst] = nrm[src]; nrm[dst + 1] = nrm[src + 1]; nrm[dst + 2] = nrm[src + 2];
  }

  const triCount = seg * seg * 2 + 4 * seg * 2;
  const Idx = nv > 65535 ? Uint32Array : Uint16Array;
  const idx = new Idx(triCount * 3);
  let t = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i, b = a + 1, c = a + n, e = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = e;
    }
  }
  const strip = (base, get, flip) => {
    for (let i = 0; i < seg; i++) {
      const a = get(i), b = get(i + 1), c = base + i, e = base + i + 1;
      if (flip) { idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = e; }
      else { idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = e; idx[t++] = c; }
    }
  };
  strip(grid, i => i, false);                              // north edge (j = 0)
  strip(grid + n, i => (n - 1) * n + i, true);             // south edge
  strip(grid + 2 * n, j => j * n, true);                   // west edge
  strip(grid + 3 * n, j => j * n + (n - 1), false);        // east edge

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const cx = x0 + size * 0.5, cz = z0 + size * 0.5, cy = (minY - skirt + maxY) * 0.5;
  const r = Math.hypot(size * 0.5, size * 0.5, (maxY - minY + skirt) * 0.5) * 1.02;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(x0, minY - skirt, z0), new THREE.Vector3(x0 + size, maxY, z0 + size));
  return geo;
}

/** Skirted ring that carries the ground out to the haze so the map edge is never a cliff. */
function buildApron(world, material) {
  const half = world.extent * 0.5, inner = half - 1, outer = 9000, seg = 160;
  const rings = 5;
  const pos = [], nrm = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings, rad = inner + (outer - inner) * (t * t);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      let x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      let y;
      if (r === 0) {
        y = world.heightAt(clamp(x, -half + 2, half - 2), clamp(z, -half + 2, half - 2));
      } else {
        const edge = world.heightAt(clamp(Math.cos(a) * inner, -half + 2, half - 2),
          clamp(Math.sin(a) * inner, -half + 2, half - 2));
        y = edge - 6 - 90 * t * t;
      }
      pos.push(x, y, z); nrm.push(0, 1, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'terrain-apron';
  return mesh;
}

/* ------------------------------------------------------------------- scatter ---- */

function makeBoulderGeometry(seed, roughness = 0.34) {
  const geo = new THREE.IcosahedronGeometry(1, 1);   // non-indexed: duplicates share positions
  const p = geo.attributes.position;
  const r = rng(seed);
  const table = new Float32Array(64);
  for (let i = 0; i < 64; i++) table[i] = r();
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // hash on the (quantised) direction so duplicated vertices move identically
    const key = (Math.round(v.x * 7) * 73856093) ^ (Math.round(v.y * 7) * 19349663) ^ (Math.round(v.z * 7) * 83492791);
    const n = table[Math.abs(key) % 64];
    const s = 1 + (n - 0.5) * 2 * roughness;
    v.multiplyScalar(s);
    v.y *= 0.72 + table[Math.abs(key >> 3) % 64] * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A short run of stacked dry-stone blocks — one terrace ledge, merged into a single geometry. */
function makeTerraceGeometry(seed) {
  const r = rng(seed);
  const parts = [];
  const rows = 3 + ((r() * 2) | 0);
  let y = 0;
  for (let row = 0; row < rows; row++) {
    const hRow = 0.30 + r() * 0.17;
    let x = -3.0;
    while (x < 3.0) {
      const w = 0.48 + r() * 0.68, dpt = 0.62 + r() * 0.34;
      const g = new THREE.BoxGeometry(w * 0.94, hRow * 0.92, dpt);
      g.translate(x + w * 0.5, y + hRow * 0.5, (r() - 0.5) * 0.12);
      g.rotateY((r() - 0.5) * 0.06);
      parts.push(g);
      x += w;
    }
    y += hRow * (0.86 + r() * 0.1);
  }
  const geo = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  return geo;
}

/** Minimal position/normal/uv geometry merge (avoids pulling in the examples utils). */
function mergeGeometries(list) {
  let vc = 0, ic = 0;
  for (const g of list) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nrm = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nrm.set(n.array, vo * 3);
    if (t) uv.set(t.array, vo * 2);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; }
    else { for (let i = 0; i < p.count; i++) idx[io++] = i + vo; }
    vo += p.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

/** Bucket instance transforms into spatial cells so the renderer can frustum-cull them. */
function emitInstanced(group, geo, material, xf, cell, name) {
  const buckets = new Map();
  const v = new THREE.Vector3();
  for (const m of xf) {
    v.setFromMatrixPosition(m);
    const key = `${Math.floor(v.x / cell)},${Math.floor(v.z / cell)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = []);
    b.push(m);
  }
  let n = 0;
  for (const [key, list] of buckets) {
    const im = new THREE.InstancedMesh(geo, material, list.length);
    for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.frustumCulled = true;
    im.computeBoundingSphere();
    im.name = `${name}-${key}`;
    group.add(im);
    n++;
  }
  return n;
}

/**
 * Deterministic ground detail: boulders on broken ground, terrace ledges strung along the
 * contours of moderate slopes. Both are instanced and sunk into the surface.
 */
function buildScatter(world, material, opts) {
  const group = new THREE.Group();
  group.name = 'terrain-detail';
  const radius = opts.scatterRadius ?? 1150;
  const n = new THREE.Vector3();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  const eu = new THREE.Euler();

  // --- boulders -----------------------------------------------------------------------
  const variants = 3;
  const rockGeo = [];
  for (let v = 0; v < variants; v++) rockGeo.push(makeBoulderGeometry(9001 + v * 37, 0.3 + v * 0.06));
  const rockXf = [[], [], []];
  const step = opts.rockStep ?? 21;
  const rr = rng(60101);
  for (let z = -radius; z <= radius; z += step) {
    for (let x = -radius; x <= radius; x += step) {
      const a = rr(), b = rr(), c = rr(), d = rr(), e = rr(), f = rr();
      const px = x + (a - 0.5) * step * 0.95, pz = z + (b - 0.5) * step * 0.95;
      if (!world.inBounds(px, pz)) continue;
      world.normalAt(px, pz, n);
      const slope = 1 - n.y;
      // Stones come in fields, not evenly: a coarse deterministic patch mask decides where
      // the ground is stony at all, then slope decides how thickly.
      const patch = hash2i(Math.floor(px / 70), Math.floor(pz / 70), 5150);
      const p = (0.03 + slope * 4.4) * (0.35 + patch * 2.2);
      if (c > Math.min(0.7, p)) continue;
      const s = 0.34 + d * d * d * 2.6 + slope * 2.6;
      const y = world.heightAt(px, pz) - s * (0.30 + e * 0.22);
      eu.set((f - 0.5) * 0.5, e * Math.PI * 2, (c - 0.5) * 0.5);
      q.setFromEuler(eu);
      sc.set(s * (0.8 + a * 0.5), s * (0.55 + b * 0.4), s * (0.8 + c * 0.5));
      pv.set(px, y, pz);
      rockXf[((a * variants) | 0) % variants].push(new THREE.Matrix4().compose(pv, q, sc));
    }
  }
  const cell = opts.scatterCell ?? 384;
  for (let v = 0; v < variants; v++) {
    if (rockXf[v].length) emitInstanced(group, rockGeo[v], material, rockXf[v], cell, 'boulders' + v);
  }

  // --- dry-stone terrace ledges --------------------------------------------------------
  // Terraces are *chains*: a seed on a moderate slope, then a walk along the contour placing
  // one ledge run after another, so the hillside gets long stepped lines rather than confetti.
  const terGeo = [makeTerraceGeometry(4242), makeTerraceGeometry(8484)];
  const terXf = [[], []];
  const seedStep = opts.terraceSeedStep ?? 105;
  const tr = rng(70207);
  const inBand = (x, z) => {
    if (!world.inBounds(x, z)) return 0;
    world.normalAt(x, z, n);
    const sl = Math.acos(clamp(n.y, -1, 1));
    return (sl > 0.145 && sl < 0.50) ? sl : 0;
  };
  for (let z = -radius; z <= radius; z += seedStep) {
    for (let x = -radius; x <= radius; x += seedStep) {
      const a = tr(), b = tr(), c = tr(), d = tr(), e = tr();
      if (c > 0.62) continue;
      let px = x + (a - 0.5) * seedStep * 0.9, pz = z + (b - 0.5) * seedStep * 0.9;
      if (!inBand(px, pz)) continue;
      const runs = 5 + ((d * 10) | 0);
      const s = 0.9 + e * 0.45;
      const len = 6 * s;
      let dirX = 0, dirZ = 0;
      for (let k = 0; k < runs; k++) {
        if (!inBand(px, pz)) break;
        const dl = Math.hypot(n.x, n.z) || 1e-4;
        let cxd = -n.z / dl, czd = n.x / dl;
        if (k > 0 && (cxd * dirX + czd * dirZ) < 0) { cxd = -cxd; czd = -czd; }
        dirX = cxd; dirZ = czd;
        const ang = Math.atan2(-czd, cxd);
        const y = Math.min(
          world.heightAt(px - cxd * len * 0.5, pz - czd * len * 0.5),
          world.heightAt(px + cxd * len * 0.5, pz + czd * len * 0.5),
          world.heightAt(px, pz)) - 0.14;
        q.setFromEuler(eu.set(0, ang, 0));
        sc.set(s, s * (0.85 + tr() * 0.55), s);
        pv.set(px, y, pz);
        terXf[(k + ((d * 2) | 0)) % 2].push(new THREE.Matrix4().compose(pv, q, sc));
        px += cxd * len * 0.97; pz += czd * len * 0.97;
      }
    }
  }
  for (let v = 0; v < 2; v++) {
    if (terXf[v].length) emitInstanced(group, terGeo[v], material, terXf[v], cell, 'terraces' + v);
  }

  group.userData.counts = { boulders: rockXf.reduce((a, b) => a + b.length, 0), terraces: terXf[0].length + terXf[1].length };
  return group;
}

/* -------------------------------------------------------------------- system ---- */

/** Fallback if anything above fails — a plain heightfield plane, so nobody else is blocked. */
function fallbackTerrain(engine, world) {
  const seg = 256, size = world.extent;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, world.heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x9a8f6a, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  engine.scene.add(mesh);
  return { mesh, group: mesh, geometry: geo, material, update() {}, setQuality() {}, dispose() {} };
}

/**
 * @param {import('../core/engine.js').Engine} engine
 * @param {import('./worldData.js').WorldData} world
 * @param {object} [opts]
 * @returns {{group:THREE.Group, mesh:THREE.Group, material:THREE.Material,
 *            update:(dt:number)=>void, setQuality:(t:number)=>void, dispose:()=>void}}
 */
export function createTerrain(engine, world, opts = {}) {
  try {
    return buildTerrain(engine, world, opts);
  } catch (e) {
    console.error('[terrain] falling back to the simple plane:', e);
    return fallbackTerrain(engine, world);
  }
}

function buildTerrain(engine, world, opts) {
  const quality = opts.quality ?? 1;
  const tex = buildTerrainTextures(world, {
    texSize: opts.texSize ?? (quality < 0.5 ? 512 : 1024),
    splatSize: opts.splatSize ?? 1024,
    infoSize: opts.infoSize ?? 512,
    seed: opts.seed ?? 4711,
  });
  const material = createTerrainMaterial(world, tex, { quality });
  const stoneMat = createStoneMaterial(tex.stone, tex.texSize);

  const group = new THREE.Group();
  group.name = 'terrain';
  group.matrixAutoUpdate = false;
  engine.scene.add(group);

  const CH = opts.chunks ?? 32;
  const size = world.extent / CH, half = world.extent * 0.5;
  const maxLod = LOD_SEGS.length - 1;
  const chunks = [];
  for (let j = 0; j < CH; j++) {
    for (let i = 0; i < CH; i++) {
      const mesh = new THREE.Mesh(undefined, material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.name = `terrain-chunk-${i}-${j}`;
      group.add(mesh);
      chunks.push({ i, j, x0: -half + i * size, z0: -half + j * size, mesh, lod: -1, dist: 0 });
    }
  }

  if (opts.apron !== false) group.add(buildApron(world, material));

  let detail = null;
  if (opts.scatter !== false) {
    detail = buildScatter(world, stoneMat, opts);
    group.add(detail);
  }

  const state = {
    quality,
    lodBias: 1,
    lastCam: new THREE.Vector3(1e9, 1e9, 1e9),
    built: 0,
  };

  function pickLod(c, camPos) {
    // distance from the camera to the chunk's footprint (XZ box), which keeps the LOD ring
    // centred on the kart rather than on chunk centres
    const dx = Math.max(c.x0 - camPos.x, 0, camPos.x - (c.x0 + size));
    const dz = Math.max(c.z0 - camPos.z, 0, camPos.z - (c.z0 + size));
    const d = Math.hypot(dx, dz);
    c.dist = d;
    for (let l = 0; l < LOD_SEGS.length; l++) {
      let t = LOD_DIST[l] * state.lodBias;
      if (l === c.lod) t *= 1.25;                      // hysteresis: stay put a little longer
      if (d < t) return l;
    }
    return maxLod;
  }

  function rebuild(c, lod) {
    const seg = LOD_SEGS[lod];
    const skirt = Math.min(Math.max(2.5, (size / seg) * 1.8), 11);   // enough to hide LOD cracks, short enough not to ring the map edge
    const geo = buildChunkGeometry(world, c.x0, c.z0, size, seg, skirt);
    c.mesh.geometry?.dispose();
    c.mesh.geometry = geo;
    c.mesh.visible = true;
    c.lod = lod;
    state.built++;
  }

  const camPos = new THREE.Vector3();
  const pending = [];

  function update() {
    const cam = engine.camera;
    cam.getWorldPosition(camPos);
    const jumped = camPos.distanceTo(state.lastCam) > 60;
    state.lastCam.copy(camPos);

    pending.length = 0;
    for (const c of chunks) {
      const l = pickLod(c, camPos);
      if (l !== c.lod) pending.push(c, l);
    }
    if (!pending.length) return;

    // Cheap coarse chunks first when the camera teleports, so a view change settles in one frame.
    const budget = (jumped || state.built === 0) ? 900 : 8;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const order = [];
    for (let i = 0; i < pending.length; i += 2) order.push([pending[i], pending[i + 1]]);
    order.sort((a, b) => a[0].dist - b[0].dist);
    for (const [c, l] of order) {
      rebuild(c, l);
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - t0 > budget) break;
    }
  }

  update();                       // first pass so the ground exists before the first frame
  engine.add({ update });

  function setQuality(t) {
    const q = clamp(t, 0, 1);
    state.quality = q;
    state.lodBias = 0.45 + q * 0.75;
    material.userData.uniforms.kQuality.value = q;
    const det = material.userData.uniforms.kDetail.value;
    det.set(6 * q, 20 + 22 * q, 30 + 20 * q, 90 + 150 * q);
    for (const c of chunks) c.lod = -1;
    state.lastCam.set(1e9, 1e9, 1e9);      // treat it as a teleport so the ring rebuilds at once
    update();
  }

  function dispose() {
    for (const c of chunks) c.mesh.geometry?.dispose();
    material.dispose(); stoneMat.dispose();
    for (const t of [tex.alb, tex.nra, tex.splat, tex.info, tex.macro]) t.dispose();
    engine.scene.remove(group);
  }

  return {
    group, mesh: group, material, stoneMaterial: stoneMat, chunks, textures: tex, detail,
    update, setQuality, dispose,
    heightAt: (x, z) => world.heightAt(x, z),
    stats: () => ({ chunks: chunks.length, built: state.built, ...(detail?.userData.counts || {}) }),
  };
}
