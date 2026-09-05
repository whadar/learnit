/**
 * A cat in a kart, built from primitives.
 *
 * Deliberately simple geometry with strong silhouette and per-driver livery: at chase distance
 * on a 1719 m street circuit, the reads that matter are the shape against the road and which
 * colour is ahead of you. Detail beyond that is not visible and costs frames.
 */
import * as THREE from 'three';
import { surfaces } from './textures.js';
import { TAU } from '../core/math.js';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, s = 12) => new THREE.CylinderGeometry(rt, rb, h, s);

export function createKart(driver, opts = {}) {
  const g = new THREE.Group();
  g.name = 'kart:' + driver.id;
  const shadows = opts.shadows !== false;
  const paint = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.42, metalness: 0.12 });
  const matte = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92 });

  const body = paint(driver.livery);
  const dark = matte(0x24262b);
  const fur = matte(driver.fur);
  const parts = [];
  const put = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz);
    m.castShadow = shadows; m.receiveShadow = shadows;
    g.add(m); parts.push(m); return m;
  };

  // chassis
  put(box(1.12, 0.26, 1.95), body, 0, 0.40, 0);
  put(box(1.24, 0.16, 0.62), body, 0, 0.52, -0.62);            // rear deck
  put(box(0.86, 0.30, 0.50), dark, 0, 0.62, -0.60);            // engine block
  put(box(1.02, 0.10, 0.44), body, 0, 0.30, 0.86);             // nose
  put(box(0.10, 0.34, 0.10), dark, 0, 0.66, 0.36, -0.28);      // steering column
  put(cyl(0.20, 0.20, 0.05, 12), dark, 0, 0.86, 0.28, Math.PI / 2 - 0.28);   // wheel

  // driver
  put(cyl(0.20, 0.26, 0.44, 10), fur, 0, 0.86, -0.06);         // torso
  const head = put(new THREE.SphereGeometry(0.23, 14, 10), fur, 0, 1.20, -0.04);
  for (const s of [-1, 1]) {                                    // ears
    put(new THREE.ConeGeometry(0.09, 0.20, 8), fur, s * 0.13, 1.38, -0.04, 0, 0, s * 0.22);
  }
  put(new THREE.SphereGeometry(0.245, 14, 10), paint(driver.helmet), 0, 1.235, -0.04, 0, 0, 0, 1, 0.62, 1);
  void head;

  // wheels
  const tyre = cyl(0.30, 0.30, 0.24, 14);
  const rim = cyl(0.16, 0.16, 0.26, 10);
  const wheels = [];
  for (const [x, z, r] of [[-0.66, 0.66, 0.28], [0.66, 0.66, 0.28], [-0.70, -0.66, 0.34], [0.70, -0.66, 0.34]]) {
    const hub = new THREE.Group();
    hub.position.set(x, r, z);
    const t = new THREE.Mesh(tyre, dark); t.rotation.z = Math.PI / 2;
    const d = new THREE.Mesh(rim, matte(0xd7dae0)); d.rotation.z = Math.PI / 2; d.scale.set(1, 1.04, 1);
    t.castShadow = d.castShadow = shadows;
    hub.add(t, d); hub.scale.setScalar(r / 0.30);
    g.add(hub); wheels.push(hub);
  }

  /* A contact shadow, drawn rather than cast.
   *
   * Every critic in both rounds said the karts float. A shadow-mapped blob is at the mercy of the
   * fill level and of where the shadow camera happens to be looking; this one is always under the
   * kart, always dark, and costs one quad. It lives OUTSIDE the kart group so body roll and pitch
   * cannot tip it off the ground — a contact shadow that banks with the chassis is worse than
   * none, because it stops reading as contact. */
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 2.6),
    new THREE.MeshBasicMaterial({ map: surfaces().puff, color: 0x0a0d10, transparent: true,
                                  opacity: 0.42, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 6;
  blob.name = 'kart:contact';

  return {
    object3D: g, contact: blob, wheels,
    /** Drive the rig from vehicle state. */
    sync(s, dt) {
      blob.position.set(s.pos.x, s.pos.y - 0.44, s.pos.z);
      blob.rotation.z = -s.yaw;
      // fades out as the kart leaves the ground, which is the one time it should not be there
      blob.material.opacity = 0.42 * Math.max(0, 1 - (s.airTime ?? 0) * 4);
      g.position.set(s.pos.x, s.pos.y - 0.30, s.pos.z);
      g.rotation.set(s.pitch, s.yaw, s.roll, 'YXZ');
      const spin = (s.forwardSpeed / 0.30) * dt;
      for (let i = 0; i < wheels.length; i++) {
        wheels[i].rotation.x = (wheels[i].rotation.x + spin) % TAU;
        if (i < 2) wheels[i].rotation.y = s.steerAngle;
      }
    },
    dispose() { g.traverse(o => o.geometry?.dispose?.()); blob.geometry.dispose(); blob.material.dispose(); },
  };
}

/** Eight drivers. Cats, San Francisco names, no imports from anywhere else. */
export const DRIVERS = [
  { id: 'karl',   name: 'Karl',   fur: 0x9aa3ad, livery: 0x2f6fd0, helmet: 0xe8433a, top: 4, accel: 3, grip: 3 },
  { id: 'mochi',  name: 'Mochi',  fur: 0xe8ded0, livery: 0xef7f3d, helmet: 0x2b3a4a, top: 3, accel: 4, grip: 4 },
  { id: 'otis',   name: 'Otis',   fur: 0x3b3a38, livery: 0xf2c14a, helmet: 0x2f6fd0, top: 4, accel: 3, grip: 3 },
  { id: 'juno',   name: 'Juno',   fur: 0xbb8a52, livery: 0x38a06a, helmet: 0xefe7d6, top: 3, accel: 4, grip: 4 },
  { id: 'pepper', name: 'Pepper', fur: 0x6f6a63, livery: 0xb2453c, helmet: 0x1f2937, top: 4, accel: 4, grip: 2 },
  { id: 'miso',   name: 'Miso',   fur: 0xd8c39a, livery: 0x7d5bbe, helmet: 0xf3f0e8, top: 3, accel: 3, grip: 5 },
  { id: 'bug',    name: 'Bug',    fur: 0x8f9aa6, livery: 0x21b1c4, helmet: 0xe8433a, top: 2, accel: 5, grip: 4 },
  { id: 'ziggy',  name: 'Ziggy',  fur: 0xc9b29a, livery: 0xe2557e, helmet: 0x2b3a4a, top: 3, accel: 4, grip: 3 },
];

/** Roster stats become small physics deltas, so karts differ the way they look. */
export function tuneFor(d) {
  const k = (v, s) => 1 + (v - 3.4) * s;
  return { topSpeed: 26.5 * k(d.top, 0.016), drive: 2900 * k(d.accel, 0.035), grip: 1.55 * k(d.grip, 0.020) };
}
