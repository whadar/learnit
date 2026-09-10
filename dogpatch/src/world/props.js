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
import { LEGS } from '../track/streets.js';
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

/**
 * A San Francisco mast-arm street blade.
 *
 * MUTCD green with white lettering and a white border, and — the detail that dates it — MIXED
 * CASE. San Francisco adopted the federal manual in 2009 and has been replacing signs with
 * mixed-case retroreflective faces since about 2012, so "22nd Street" is right and "22ND STREET"
 * is a sign that should have been swapped out a decade ago.
 */
function bladeTexture(name) {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#00703c'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#f2f4f1'; x.lineWidth = 6;
  x.strokeRect(9, 9, W - 18, H - 18);
  x.fillStyle = '#f7f9f6';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  // shrink to fit rather than overflow: "Tennessee Street" is a lot wider than "20th Street"
  let px = 62;
  do { x.font = `600 ${px}px Overpass, "Helvetica Neue", Arial, sans-serif`; px -= 2; }
  while (px > 26 && x.measureText(name).width > W - 60);
  x.fillText(name, W / 2, H / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
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
      // A plane's front face looks down its local +Z, so rotating by the track heading points the
      // printed side DOWN the road, away from oncoming traffic — with DoubleSide on you then read
      // the back of the board and every sponsor name comes out mirrored. Turn it to face oncoming
      // traffic, then cant it slightly toward the road so it is readable on approach.
      mesh.rotation.y = Math.atan2(m.tangent.x, m.tangent.z) + Math.PI - side * 0.3;
      mesh.castShadow = shadows;
      mesh.name = 'props:board';
      group.add(mesh);
    }
  }

  /* ---- street name signs on signal mast arms -------------------------------------------
   * One at the entry to each named leg of the circuit. The names are not decoration: they are
   * derived in tools/streets.mjs by matching the circuit against the named roadways in the
   * Overture extract, so the lap really does read Illinois -> 20th -> Indiana -> 22nd ->
   * Tennessee -> 23rd, which is a real loop of Dogpatch blocks.
   *
   * The sign is placed a little BEFORE the corner and names the street being turned onto, which
   * is how you actually read one at speed. */
  if (canDraw) {
    const steel = new THREE.MeshStandardMaterial({ color: 0x4c5358, roughness: 0.55, metalness: 0.5 });
    for (const leg of LEGS) {
      const at = (leg.s - 26 + track.length) % track.length;
      const m = track.sample(at);
      const yaw = Math.atan2(m.tangent.x, m.tangent.z);
      const side = 1;                                   // kerb on the driver's right
      const reach = m.width * 0.5 + 2.2;                // arm reaches back over the roadway
      const g = new THREE.Group();

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 6.8, 8), steel);
      pole.position.set(0, 3.4, 0); pole.castShadow = shadows; g.add(pole);

      // +X, not -X: the arm has to reach OVER the roadway. Pointed the other way it hangs the
      // blade out over the pavement behind the pole, where no driver can read it.
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, reach, 8), steel);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(reach * 0.5, 6.4, 0);
      arm.castShadow = shadows; g.add(arm);

      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 0.86, 0.07),
        [steel, steel, steel, steel,
         new THREE.MeshStandardMaterial({ map: bladeTexture(leg.name), roughness: 0.42 }),
         new THREE.MeshStandardMaterial({ map: bladeTexture(leg.name), roughness: 0.42 })]);
      blade.position.set(reach * 0.72, 5.85, 0);
      blade.castShadow = shadows; g.add(blade);

      const x = m.pos.x + m.normal.x * side * (m.width * 0.5 + 1.9);
      const z = m.pos.z + m.normal.z * side * (m.width * 0.5 + 1.9);
      g.position.set(x, world.heightAt(x, z), z);
      g.rotation.y = yaw + (side > 0 ? 0 : Math.PI);
      g.name = 'props:streetsign';
      group.add(g);
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
