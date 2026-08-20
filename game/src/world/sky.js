import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
/** Sky dome + sun. Baseline atmospheric scattering; replaced by the full sky/atmosphere system. */
export function createSky(engine, world, opts = {}) {
  const sky = new Sky(); sky.scale.setScalar(20000); engine.scene.add(sky);
  const u = sky.material.uniforms;
  u.turbidity.value = 4.5; u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
  const elev = opts.elevation ?? 34, azim = opts.azimuth ?? 122;
  const phi = THREE.MathUtils.degToRad(90 - elev), theta = THREE.MathUtils.degToRad(azim);
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  u.sunPosition.value.copy(sunPos);

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.4);
  sun.position.copy(sunPos).multiplyScalar(1200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -300; c.right = 300; c.top = 300; c.bottom = -300; c.near = 1; c.far = 3000;
  engine.scene.add(sun); engine.scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0xb09a6d, 0.75);
  engine.scene.add(hemi);
  return { sky, sun, hemi, sunPos };
}
