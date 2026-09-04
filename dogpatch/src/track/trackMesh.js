/**
 * The circuit, as geometry: road ribbon, kerbs, painted markings, start line, barriers.
 *
 * All of it is one strip builder walking the centreline, which is why this is short. The road
 * sits a few centimetres above the terrain and writes depth normally; the paint sits on top of
 * the road with a polygon offset so it never z-fights.
 */
import * as THREE from 'three';
import { clamp01, rng } from '../core/math.js';

const RAISE = 0.06;                 // road above the drape, metres
const SHOULDER = 3.0;               // concrete shoulder each side

/**
 * Walk the centreline building a triangle strip between two lateral offsets.
 *
 * The index order matters and is not arbitrary. Each row pushes the `from` vertex then the `to`
 * vertex, so winding them (p, p+2, p+1) gives triangles whose normal points DOWN: with the
 * default FrontSide material the whole ribbon is back-face culled and the circuit vanishes —
 * road, shoulder, edge lines and kerbs all at once, leaving bare terrain where the street should
 * be. It shipped that way once and read as a kart race across a sandy field.
 */
function strip(track, from, to, opts = {}) {
  const N = track.count, ds = track.ds, lift = opts.lift ?? RAISE;
  const pos = [], uv = [], idx = [];
  const every = opts.every ?? 1;
  let row = 0;
  for (let i = 0; i <= N; i += every) {
    const s = (i % N) * ds;
    const m = track.sample(s);
    const a = from(m, s), b = to(m, s);
    if (a === null || b === null) continue;
    pos.push(m.pos.x + m.normal.x * a, m.pos.y + lift, m.pos.z + m.normal.z * a);
    pos.push(m.pos.x + m.normal.x * b, m.pos.y + lift, m.pos.z + m.normal.z * b);
    uv.push(0, s / (opts.vScale ?? 4), 1, s / (opts.vScale ?? 4));
    row++;
  }
  for (let r = 0; r < row - 1; r++) {
    const p = r * 2;
    idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
  }
  if (!row) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function paint(color, offset = -4) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0 });
  m.polygonOffset = true; m.polygonOffsetFactor = offset; m.polygonOffsetUnits = offset;
  return m;
}

export function createTrackMesh(track, world, opts = {}) {
  const group = new THREE.Group();
  group.name = 'circuit';
  const shadows = opts.shadows !== false;
  const rand = rng(99);
  const add = (g, mat, name, order = 0) => {
    if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.name = name; m.receiveShadow = shadows; m.renderOrder = order;
    group.add(m); return m;
  };

  /* ---- shoulder: city concrete, not a gravel run-off ----------------------------------
   * Worth stating because the last build got it wrong for weeks: the strip beside a street
   * circuit is pavement. Authoring it as sun-bleached grit gives you a sandy verge down a San
   * Francisco street, and no amount of tinting the TERRAIN fixes it, because this is not the
   * terrain — it is the circuit's own mesh. */
  add(strip(track, m => -m.width * 0.5 - SHOULDER, m => m.width * 0.5 + SHOULDER, { lift: RAISE - 0.03 }),
      new THREE.MeshStandardMaterial({ color: 0x8d9095, roughness: 0.95 }), 'circuit:shoulder', 0);

  /* ---- the road ---- */
  add(strip(track, m => -m.width * 0.5, m => m.width * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.88 }), 'circuit:road', 1);

  /* ---- edge lines ---- */
  const white = paint(0xe9e9e4);
  for (const side of [-1, 1]) {
    add(strip(track, m => side * (m.width * 0.5 - 0.55), m => side * (m.width * 0.5 - 0.25), { lift: RAISE + 0.01 }),
        white, 'circuit:edge', 2);
  }

  /* ---- dashed centreline: a real street has one, and it reads as a street ---- */
  {
    const pos = [], idx = [];
    let v = 0;
    for (let s = 0; s < track.length; s += 9) {
      const a = track.sample(s), b = track.sample(s + 4.5);
      for (const [m, w] of [[a, 0.16], [b, 0.16]]) {
        pos.push(m.pos.x - m.normal.x * w, m.pos.y + RAISE + 0.012, m.pos.z - m.normal.z * w);
        pos.push(m.pos.x + m.normal.x * w, m.pos.y + RAISE + 0.012, m.pos.z + m.normal.z * w);
      }
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); v += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    add(g, paint(0xd8d3c2, -5), 'circuit:centreline', 3);
  }

  /* ---- kerbs on the corners only, where a kerb means something ---- */
  {
    const red = paint(0xc0392b, -3), pale = paint(0xeeeae0, -3);
    for (const side of [-1, 1]) {
      const pos = [[], []], idx = [[], []], v = [0, 0];
      for (let s = 0; s < track.length; s += 1.6) {
        const k = track.curvatureAt(s);
        if (Math.abs(k) < 0.010) continue;
        if (Math.sign(k) !== side) continue;                 // outside of the corner only
        const m = track.sample(s), m2 = track.sample(s + 1.6);
        const b = (Math.floor(s / 1.6) & 1) ? 0 : 1;
        const inner = m.width * 0.5, outer = inner + 0.85;
        for (const q of [m, m2]) {
          pos[b].push(q.pos.x + q.normal.x * side * inner, q.pos.y + RAISE + 0.02, q.pos.z + q.normal.z * side * inner);
          pos[b].push(q.pos.x + q.normal.x * side * outer, q.pos.y + RAISE + 0.06, q.pos.z + q.normal.z * side * outer);
        }
        idx[b].push(v[b], v[b] + 1, v[b] + 2, v[b] + 1, v[b] + 3, v[b] + 2); v[b] += 4;
      }
      for (const b of [0, 1]) {
        if (!pos[b].length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos[b], 3));
        g.setIndex(idx[b]); g.computeVertexNormals(); g.computeBoundingSphere();
        add(g, b ? red : pale, 'circuit:kerb', 4);
      }
    }
  }

  /* ---- start/finish: chequer band across the road ---- */
  {
    const m0 = track.sample(0), n = 16, w = m0.width;
    const geo = new THREE.PlaneGeometry(w, 2.4, n, 1);
    const cols = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const cell = Math.floor((p.getX(i) + w / 2) / (w / n));
      const dark = ((cell + (p.getY(i) > 0 ? 0 : 1)) & 1) === 0;
      cols.push(dark ? 0.08 : 0.92, dark ? 0.08 : 0.92, dark ? 0.09 : 0.90);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const mesh = new THREE.Mesh(geo, paint(0xffffff, -6));
    mesh.material.vertexColors = true;
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(m0.tangent.x, m0.tangent.z);
    mesh.position.set(m0.pos.x, m0.pos.y + RAISE + 0.015, m0.pos.z);
    mesh.name = 'circuit:startline'; mesh.renderOrder = 5;
    group.add(mesh);
  }

  /* ---- barriers: a low concrete wall on the outside of every corner ---- */
  {
    const wall = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.9 });
    const box = new THREE.BoxGeometry(1, 0.85, 2.6);
    const slots = [];
    for (let s = 0; s < track.length; s += 2.6) {
      const k = track.curvatureAt(s);
      if (Math.abs(k) < 0.008) continue;
      const side = -Math.sign(k);                            // outside of the bend
      const m = track.sample(s);
      slots.push([m.pos.x + m.normal.x * side * (m.width * 0.5 + SHOULDER - 0.4),
                  m.pos.y + 0.42,
                  m.pos.z + m.normal.z * side * (m.width * 0.5 + SHOULDER - 0.4),
                  Math.atan2(m.tangent.x, m.tangent.z)]);
    }
    const inst = new THREE.InstancedMesh(box, wall, slots.length);
    inst.name = 'circuit:barrier';
    inst.castShadow = shadows; inst.receiveShadow = shadows;
    const o = new THREE.Object3D();
    slots.forEach(([x, y, z, yaw], i) => {
      o.position.set(x, y + (rand() - 0.5) * 0.02, z);
      o.rotation.set(0, yaw, 0);
      o.scale.set(0.42, 1, 1);
      o.updateMatrix(); inst.setMatrixAt(i, o.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  void world; void clamp01;
  return { object3D: group, dispose() { group.traverse(o => { o.geometry?.dispose?.(); }); } };
}
