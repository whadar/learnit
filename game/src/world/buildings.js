import * as THREE from 'three';
import { rng } from '../core/mathx.js';
/** Extrudes the real Overture footprints. Baseline: flat-roofed boxes on the terrain. */
export function createBuildings(engine, world) {
  const group = new THREE.Group();
  const rand = rng(1337);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8cfbd, roughness: 0.85 });
  for (const b of world.buildings) {
    const ring = b.rings?.[0]; if (!ring || ring.length < 4) continue;
    const shape = new THREE.Shape();
    ring.forEach(([x, z], i) => i ? shape.lineTo(x, z) : shape.moveTo(x, z));
    const levels = b.lv || (b.cls === 'greenhouse' ? 1 : 1 + (rand() < 0.35 ? 1 : 0));
    const h = b.h || levels * 3.2 + 0.6;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    let cx = 0, cz = 0;
    for (const [x, z] of ring) { cx += x; cz += z; }
    cx /= ring.length; cz /= ring.length;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = world.heightAt(cx, cz);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  engine.scene.add(group);
  return { group };
}
