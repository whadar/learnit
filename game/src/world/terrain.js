import * as THREE from 'three';
/** Baseline terrain mesh built directly from the real heightfield. Replaced by the LOD/splat version. */
export function createTerrain(engine, world) {
  const seg = 512, size = world.extent;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, world.heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9a8f6a, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  engine.scene.add(mesh);
  return { mesh, geometry: geo, material: mat };
}
