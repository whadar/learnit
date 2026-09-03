/**
 * Dogpatch, extruded from its own footprints.
 *
 * Overture carries a real height for 5,329 of the 5,527 buildings in the box, so the massing is
 * not invented: each footprint is extruded to the height the data gives it. That matters more
 * than it sounds — the previous build clamped every building to 9 m and flattened a quarter of
 * the neighbourhood, including a 91 m tower rendered as a shed.
 *
 * Materials are the neighbourhood's: red brick, corrugated industrial panel, painted clapboard
 * and concrete, with flat roofs almost everywhere. No pantiles, no plaster, no stone.
 */
import * as THREE from 'three';
import { clamp, rng } from '../core/math.js';

const WALL = [
  { name: 'brick',    col: 0x8c4a35, rough: 0.94 },
  { name: 'brick2',   col: 0x9b5a42, rough: 0.94 },
  { name: 'panel',    col: 0x9aa1a8, rough: 0.72 },
  { name: 'panel2',   col: 0x7c858d, rough: 0.72 },
  { name: 'concrete', col: 0xa8a49c, rough: 0.95 },
  { name: 'board',    col: 0xc9c3b4, rough: 0.88 },
  { name: 'board2',   col: 0x6f7f86, rough: 0.88 },
];
const ROOF = { col: 0x4a4d51, rough: 0.97 };

/** Signed area of a ring; also tells us the winding. */
function area(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function createBuildings(world, track, opts = {}) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const rand = rng(opts.seed ?? 1234);
  const shadows = opts.shadows !== false;
  const near = opts.near ?? 620;                 // full detail this close to the circuit
  const far = opts.far ?? 1500;

  // bucket geometry by material so the whole neighbourhood is a handful of draws
  const buckets = WALL.map(() => ({ pos: [], nrm: [], idx: [], n: 0 }));
  const roof = { pos: [], nrm: [], idx: [], n: 0 };

  const push = (b, x, y, z, nx, ny, nz) => { b.pos.push(x, y, z); b.nrm.push(nx, ny, nz); return b.n++; };

  for (const bld of world.buildings) {
    const ring = bld.rings?.[0];
    if (!ring || ring.length < 4) continue;

    // distance to the circuit decides whether it is drawn at all
    let d = Infinity;
    for (let i = 0; i < ring.length; i += 3) {
      const n = track.nearest({ x: ring[i][0], z: ring[i][1] });
      d = Math.min(d, Math.hypot(ring[i][0] - track.points[n.i][0], ring[i][1] - track.points[n.i][1]));
    }
    if (d > far) continue;
    const a = Math.abs(area(ring));
    if (a < (d > near ? 260 : 34)) continue;      // skip sheds far away, keep them close

    const h = clamp(bld.h > 0 ? bld.h : (bld.lv ? bld.lv * 3.3 : 7 + rand() * 4), 2.6, 95);
    const wi = (rand() * WALL.length) | 0;
    const B = buckets[wi];

    // ground the footprint at its lowest corner so nothing floats on a slope
    let gy = Infinity;
    for (const p of ring) gy = Math.min(gy, world.heightAt(p[0], p[1]));
    const top = gy + h;

    const cw = area(ring) > 0 ? 1 : -1;
    const start = B.n;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const p = ring[i], q = ring[i + 1];
      const ex = q[0] - p[0], ez = q[1] - p[1];
      const L = Math.hypot(ex, ez) || 1;
      const nx = (ez / L) * cw, nz = (-ex / L) * cw;
      const v = B.n;
      push(B, p[0], gy, p[1], nx, 0, nz);
      push(B, q[0], gy, q[1], nx, 0, nz);
      push(B, p[0], top, p[1], nx, 0, nz);
      push(B, q[0], top, q[1], nx, 0, nz);
      B.idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
    void start;

    // flat roof: fan from the centroid, which is enough for convex-ish city footprints
    let cx = 0, cz = 0, k = 0;
    for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cz += ring[i][1]; k++; }
    cx /= k; cz /= k;
    const c = push(roof, cx, top, cz, 0, 1, 0);
    for (let i = 0; i < ring.length - 1; i++) {
      const p = ring[i], q = ring[i + 1];
      const a1 = push(roof, p[0], top, p[1], 0, 1, 0);
      const b1 = push(roof, q[0], top, q[1], 0, 1, 0);
      if (cw > 0) roof.idx.push(c, a1, b1); else roof.idx.push(c, b1, a1);
    }
  }

  const finish = (b, mat, name) => {
    if (!b.n) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name; m.castShadow = shadows; m.receiveShadow = shadows;
    group.add(m);
  };
  WALL.forEach((w, i) => finish(buckets[i],
    new THREE.MeshStandardMaterial({ color: w.col, roughness: w.rough, metalness: 0 }), 'bld:' + w.name));
  finish(roof, new THREE.MeshStandardMaterial({ color: ROOF.col, roughness: ROOF.rough }), 'bld:roof');

  return { object3D: group, count: group.children.length,
    dispose() { group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); } };
}
