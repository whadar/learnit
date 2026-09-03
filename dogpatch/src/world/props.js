/**
 * Trackside dressing: street trees, lamp posts, hoardings and the start gantry.
 *
 * Monterey pine, not Italian cypress — the narrow columnar form reads as Tuscany wherever you
 * plant it. Everything here is instanced or merged; nothing is a per-object draw call.
 *
 * The sponsor boards are INVENTED. Dogpatch really is full of robotics and AI shops, and the
 * map data even names some of them, but a hoarding claims a company paid to sponsor this race,
 * and that would be a claim about a real firm that is not true.
 */
import * as THREE from 'three';
import { rng, TAU } from '../core/math.js';

const BOARDS = [
  ['DOGPATCH ROBOTICS', 'AUTONOMY LAB · 22ND ST', '#123b6e', '#eef3fb'],
  ['PIER 70 COMPUTE', 'GPU CLUSTER · BY THE HOUR', '#1d3d33', '#e8f3ec'],
  ['ILLINOIS INFERENCE', 'MODELS SERVED FRESH', '#5c1f2a', '#f7e9ec'],
  ['THIRD STREET SILICON', 'WAFER · TAPE-OUT · SHIP', '#3a2c5e', '#efeaf7'],
  ['BAYFRONT DRYDOCK', 'PLATE · WELD · FORGE', '#4a3418', '#f6efdf'],
];

function boardTexture(top, sub, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 512, 128);
  x.fillStyle = 'rgba(255,255,255,.10)'; x.fillRect(0, 0, 512, 8);
  x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(0, 120, 512, 8);
  x.fillStyle = fg; x.textAlign = 'center';
  x.font = '900 42px Overpass, sans-serif';
  x.fillText(top, 256, 62);
  x.font = '600 20px "Overpass Mono", monospace';
  x.globalAlpha = 0.82;
  x.fillText(sub, 256, 94);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createProps(world, track, opts = {}) {
  const group = new THREE.Group();
  group.name = 'props';
  const rand = rng(opts.seed ?? 606);
  const shadows = opts.shadows !== false;
  const canDraw = typeof document !== 'undefined';

  /* ---- street trees: trunk + two crown blobs, instanced ---- */
  {
    const slots = [];
    for (let s = 0; s < track.length; s += 17) {
      for (const side of [-1, 1]) {
        if (rand() < 0.45) continue;
        const m = track.sample(s + rand() * 6);
        const off = side * (m.width * 0.5 + 4.6 + rand() * 1.6);
        const x = m.pos.x + m.normal.x * off, z = m.pos.z + m.normal.z * off;
        const n = track.nearest({ x, z });
        if (n.onTrack) continue;
        slots.push([x, world.heightAt(x, z), z, 0.8 + rand() * 0.5, rand() * TAU]);
      }
    }
    const trunk = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6);
    const crown = new THREE.SphereGeometry(1.5, 7, 5);
    const bark = new THREE.MeshStandardMaterial({ color: 0x584636, roughness: 0.96 });
    const leaf = new THREE.MeshStandardMaterial({ color: 0x3f5f3a, roughness: 0.9, flatShading: true });
    const ti = new THREE.InstancedMesh(trunk, bark, slots.length);
    const ci = new THREE.InstancedMesh(crown, leaf, slots.length * 2);
    ti.name = 'props:trunks'; ci.name = 'props:crowns';
    ti.castShadow = ci.castShadow = shadows; ci.receiveShadow = shadows;
    const o = new THREE.Object3D();
    slots.forEach(([x, y, z, sc, yaw], i) => {
      o.position.set(x, y + 1.6 * sc, z); o.rotation.set(0, yaw, 0); o.scale.setScalar(sc);
      o.updateMatrix(); ti.setMatrixAt(i, o.matrix);
      for (const [k, dy, ds] of [[0, 3.4, 1.0], [1, 4.5, 0.72]]) {
        o.position.set(x + (rand() - 0.5) * 0.5, y + dy * sc, z + (rand() - 0.5) * 0.5);
        o.scale.setScalar(sc * ds); o.updateMatrix();
        ci.setMatrixAt(i * 2 + k, o.matrix);
      }
    });
    ti.instanceMatrix.needsUpdate = ci.instanceMatrix.needsUpdate = true;
    group.add(ti, ci);
  }

  /* ---- lamp posts ---- */
  {
    const slots = [];
    for (let s = 0; s < track.length; s += 42) {
      const side = (Math.floor(s / 42) % 2) ? 1 : -1;
      const m = track.sample(s);
      const off = side * (m.width * 0.5 + 2.6);
      const x = m.pos.x + m.normal.x * off, z = m.pos.z + m.normal.z * off;
      slots.push([x, world.heightAt(x, z), z, Math.atan2(m.tangent.x, m.tangent.z)]);
    }
    const post = new THREE.CylinderGeometry(0.09, 0.13, 6.4, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4c5157, roughness: 0.7, metalness: 0.35 });
    const inst = new THREE.InstancedMesh(post, mat, slots.length);
    inst.name = 'props:lamps'; inst.castShadow = shadows;
    const o = new THREE.Object3D();
    slots.forEach(([x, y, z], i) => { o.position.set(x, y + 3.2, z); o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.updateMatrix(); inst.setMatrixAt(i, o.matrix); });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  /* ---- sponsor hoardings along the straights ---- */
  if (canDraw) {
    const geo = new THREE.PlaneGeometry(7.2, 1.8);
    let n = 0;
    for (let s = 20; s < track.length; s += 63) {
      const k = Math.abs(track.curvatureAt(s));
      if (k > 0.006) continue;                        // straights only
      const b = BOARDS[n++ % BOARDS.length];
      const m = track.sample(s);
      const side = (n % 2) ? 1 : -1;
      const off = side * (m.width * 0.5 + 3.4);
      const x = m.pos.x + m.normal.x * off, z = m.pos.z + m.normal.z * off;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: boardTexture(b[0], b[1], b[2], b[3]), roughness: 0.85, side: THREE.DoubleSide }));
      mesh.position.set(x, world.heightAt(x, z) + 1.5, z);
      mesh.rotation.y = Math.atan2(m.tangent.x, m.tangent.z) + (side > 0 ? Math.PI : 0);
      mesh.castShadow = shadows;
      mesh.name = 'props:board';
      group.add(mesh);
    }
  }

  /* ---- start gantry ---- */
  if (canDraw) {
    const m = track.sample(0);
    const yaw = Math.atan2(m.tangent.x, m.tangent.z);
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2f3a4c, roughness: 0.6, metalness: 0.4 });
    const w = m.width + 7;
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.4, 0.5), steel);
      leg.position.set(m.normal.x * side * w * 0.5, 3.7, m.normal.z * side * w * 0.5);
      leg.castShadow = shadows; g.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 1.9, 0.55), new THREE.MeshStandardMaterial({
      map: boardTexture('DOGPATCH WATERFRONT', 'SAN FRANCISCO · CALIFORNIA', '#10357a', '#ffffff'),
      roughness: 0.7 }));
    beam.position.set(0, 7.0, 0); beam.castShadow = shadows;
    g.add(beam);
    g.position.set(m.pos.x, m.pos.y, m.pos.z);
    g.rotation.y = yaw;
    g.name = 'props:gantry';
    group.add(g);
  }

  return { object3D: group, dispose() { group.traverse(o => { o.geometry?.dispose?.(); }); } };
}
