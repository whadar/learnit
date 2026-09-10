/**
 * Headless behaviour test for the cast: rig, poses, IK, wheels, determinism.
 * No renderer, no DOM — exercises the same code paths the game uses.
 *   node tools/sim/characters.mjs
 */
import * as THREE from 'three';
import { createRoster, createRacer } from '../../src/characters/roster.js';
import { createCat, CAT_SPECS } from '../../src/characters/cat.js';
import { createKart, KART_SPECS, LIVERIES } from '../../src/characters/kart.js';

const R2D = 180 / Math.PI;
const fmt = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : String(v));
const line = (k, v) => console.log('  ' + k.padEnd(34) + v);
let FAILS = 0;
function check(name, ok, detail) {
  if (!ok) FAILS++;
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

/* ------------------------------------------------------------------ roster */
console.log('\n== roster ==');
const roster = createRoster();
line('drivers', roster.length);
const uniq = (f) => new Set(roster.map(f)).size;
line('fur patterns', uniq(r => r.cat.pattern) + '  ' + [...new Set(roster.map(r => r.cat.pattern))].join(','));
line('ear shapes', uniq(r => r.cat.ear) + '  ' + [...new Set(roster.map(r => r.cat.ear))].join(','));
line('headgear', uniq(r => r.cat.gear) + '  ' + [...new Set(roster.map(r => r.cat.gear))].join(','));
line('kart bodies', uniq(r => r.kartId) + '  ' + [...new Set(roster.map(r => r.kartId))].join(','));
line('liveries', uniq(r => r.livery) + '  ' + [...new Set(roster.map(r => r.livery))].join(','));
line('eye colours', uniq(r => r.cat.eye));
line('race numbers', roster.map(r => r.number).join(','));
check('>= 8 drivers', roster.length >= 8, roster.length + ' drivers');
check('>= 8 distinct fur patterns/colours', uniq(r => r.cat.base) >= 8);
check('>= 4 kart bodies', uniq(r => r.kartId) >= 4);
check('>= 4 liveries', uniq(r => r.livery) >= 4);
check('unique race numbers', uniq(r => r.number) === roster.length);
const statKeys = ['speed', 'accel', 'weight', 'handling', 'drift', 'offroad'];
const statSpread = statKeys.map(k => {
  const v = roster.map(r => r.stats[k]);
  return `${k} ${Math.min(...v)}-${Math.max(...v)}`;
}).join('  ');
line('stat ranges', statSpread);
check('stats vary per driver', new Set(roster.map(r => statKeys.map(k => r.stats[k]).join('/'))).size === roster.length);

/* ------------------------------------------------------- geometry / budget */
console.log('\n== geometry budget (per racer) ==');
function count(obj) {
  let meshes = 0, tris = 0;
  obj.updateMatrixWorld(true);
  obj.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { meshes, tris: Math.round(tris) };
}
for (const d of ['high', 'med', 'low']) {
  const r = createRacer('mitzi', { detail: d });
  const a = count(r.object3D);
  line('detail ' + d, `${a.meshes} meshes, ${a.tris} tris  (headless: fur shells omitted)`);
  r.dispose();
}

/* ------------------------------------------------- wheels sit on the ground */
console.log('\n== karts: wheels on y=0, steering, suspension ==');
const box = new THREE.Box3();
for (const k of Object.keys(KART_SPECS)) {
  const kart = createKart(k, { livery: 'citrus', number: 7 });
  kart.object3D.updateMatrixWorld(true);
  let lowest = 1e9, worst = 0;
  for (const w of kart.wheels) {
    box.setFromObject(w.object3D);
    lowest = Math.min(lowest, box.min.y);
    worst = Math.max(worst, Math.abs(box.min.y));
  }
  // body must clear the ground
  box.setFromObject(kart.chassis);
  const clearance = box.min.y;
  check(`${k}: wheels touch y=0`, worst < 0.004, `lowest wheel y = ${fmt(lowest, 4)} m`);
  check(`${k}: chassis clears ground`, clearance > 0.02, `clearance ${fmt(clearance, 3)} m`);

  // steering + rolling
  kart.update(0.016, {});
  const before = kart.wheels[0].spin.rotation.x;
  for (let i = 0; i < 60; i++) kart.update(1 / 60, { speed: 20, steer: 0 });
  const rolled = kart.wheels[0].spin.rotation.x - before;
  const expect = 20 / kart.wheels[0].radius;
  check(`${k}: wheel roll rate`, Math.abs(rolled - expect) / expect < 0.06,
    `${fmt(rolled, 1)} rad/s vs expected ${fmt(expect, 1)} (r=${fmt(kart.wheels[0].radius, 3)})`);
  for (let i = 0; i < 60; i++) kart.update(1 / 60, { speed: 20, steer: 1 });
  const fr = kart.wheels.find(w => w.front);
  line(`${k}: front steer @ full lock`, fmt(-fr.object3D.parent.rotation.y * R2D, 1) + ' deg');
  line(`${k}: body roll @ full lock`, fmt(kart.chassis.rotation.z * R2D, 2) + ' deg');
  for (let i = 0; i < 40; i++) kart.update(1 / 60, { speed: 20, steer: 0, airborne: true });
  line(`${k}: suspension droop (air)`, fmt((kart.chassis.position.y) * 1000, 1) + ' mm');
  kart.dispose();
}

/* --------------------------------------------------- hands stay on the rim */
console.log('\n== driver IK: paws on the wheel rim ==');
{
  const racer = createRacer('mitzi', { detail: 'low' });
  const kart = racer.kart, cat = racer.cat;
  const hubC = new THREE.Vector3(...kart.hub.center);
  const tilt = kart.hub.tilt, RAD = kart.hub.radius;
  const axA = new THREE.Vector3(1, 0, 0);
  const axB = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
  const errs = [];
  for (const steer of [-1, -0.5, 0, 0.5, 1]) {
    for (let i = 0; i < 90; i++) racer.update(1 / 60, { speed: 14, steer });
    racer.object3D.updateMatrixWorld(true);
    for (const side of [-1, 1]) {
      const hand = side < 0 ? cat.bones.handL : cat.bones.handR;
      const sh = side < 0 ? cat.bones.shoulderL : cat.bones.shoulderR;
      const p = hand.getWorldPosition(new THREE.Vector3());
      const spos = sh.getWorldPosition(new THREE.Vector3());
      const reach = p.distanceTo(spos);
      kart.chassis.worldToLocal(p);
      const d = p.clone().sub(hubC);
      const a = d.dot(axA), b = d.dot(axB);
      const radial = Math.hypot(a, b);
      const nrm = d.dot(new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt)));
      errs.push({ steer, side, off: Math.hypot(radial - RAD, nrm), radial, nrm, reach });
    }
  }
  for (const e of errs) line(`steer ${fmt(e.steer, 1)} side ${e.side > 0 ? 'R' : 'L'}`,
    `rim offset ${fmt(e.off * 1000, 1)} mm (radial ${fmt(e.radial * 1000, 0)} vs ${fmt(RAD * 1000, 0)}, normal ${fmt(e.nrm * 1000, 0)}), arm reach ${fmt(e.reach * 1000, 0)}/335 mm`);
  const worstErr = Math.max(...errs.map(e => e.off));
  const spread = worstErr - Math.min(...errs.map(e => e.off));
  line('rim-offset spread', fmt(spread * 1000, 1) + ' mm');
  check('paws follow the rim (spread < 25 mm)', spread < 0.025, `spread ${fmt(spread * 1000, 1)} mm`);
  check('arms never fully extended', Math.max(...errs.map(e => e.reach)) < 0.325, `max reach ${fmt(Math.max(...errs.map(e => e.reach)) * 1000, 0)} mm`);
  check('paws within 15 mm of the rim at all steering angles', worstErr < 0.015, `worst ${fmt(worstErr * 1000, 1)} mm`);
  // the steering wheel really turns with the input
  for (let i = 0; i < 60; i++) racer.update(1 / 60, { speed: 14, steer: 1 });
  const right = kart.steeringWheel.rotation.z;
  for (let i = 0; i < 60; i++) racer.update(1 / 60, { speed: 14, steer: -1 });
  const left = kart.steeringWheel.rotation.z;
  check('steering wheel sweeps both ways', Math.abs(right - left) > 1.2,
    `${fmt(right * R2D, 0)} deg .. ${fmt(left * R2D, 0)} deg`);
  racer.dispose();
}

/* ------------------------------------------------------------- animation */
console.log('\n== animation ranges (6 s scripted drive @60 Hz) ==');
{
  const racer = createRacer('tamar', { detail: 'low' });
  const cat = racer.cat, B = cat.bones;
  const track = {};
  const rec = (k, v) => {
    const t = track[k] || (track[k] = { min: 1e9, max: -1e9 });
    t.min = Math.min(t.min, v); t.max = Math.max(t.max, v);
  };
  let blinks = 0, wasBlink = false;
  let flinchStart = -1, flinchEnd = -1;
  const dt = 1 / 60;
  for (let i = 0; i < 360; i++) {
    const t = i * dt;
    const st = { speedMax: 26 };
    if (t < 1.0) { st.speed = t * 18; st.steer = 0; }
    else if (t < 2.2) { st.speed = 22; st.steer = Math.sin((t - 1) * 3) * 0.9; }
    else if (t < 3.4) { st.speed = 24; st.steer = -0.85; st.drift = -1; st.boosting = t > 3.0; }
    else if (t < 3.6) { st.speed = 6; st.hit = true; }
    else if (t < 4.6) { st.speed = 8; }
    else { st.speed = 1; st.finished = true; st.place = 1; }
    racer.update(dt, st);
    rec('root roll (deg)', cat.object3D.rotation.z * R2D);
    rec('spine pitch (deg)', B.spine.rotation.x * R2D);
    rec('head yaw (deg)', B.head.rotation.y * R2D);
    rec('head pitch (deg)', B.head.rotation.x * R2D);
    rec('ear-L pitch (deg)', B.earL.rotation.x * R2D);
    rec('tail base pitch (deg)', B.tail[0].rotation.x * R2D);
    rec('tail tip yaw (deg)', B.tail[4].rotation.y * R2D);
    rec('lid-upper (deg)', cat.eyes[0].lidUp.rotation.x * R2D);
    rec('jaw (deg)', B.jaw.rotation.x * R2D);
    rec('tuck weight', cat.state.tuck);
    rec('flinch weight', cat.state.flinch);
    rec('cheer weight', cat.state.cheer);
    const b = cat.state.blink > 0.5;
    if (b && !wasBlink) blinks++;
    wasBlink = b;
    if (cat.state.flinch > 0.9 && flinchStart < 0) flinchStart = t;
    if (flinchStart >= 0 && flinchEnd < 0 && cat.state.flinch <= 0.001) flinchEnd = t;
  }
  for (const k of Object.keys(track)) line(k, `${fmt(track[k].min)} .. ${fmt(track[k].max)}`);
  line('blinks in 6 s', blinks);
  line('flinch recovery', fmt(flinchEnd - flinchStart) + ' s');
  check('body leans into corners', track['root roll (deg)'].max - track['root roll (deg)'].min > 3);
  check('head looks into the corner', track['head yaw (deg)'].max - track['head yaw (deg)'].min > 15);
  check('ears react (>=20 deg range)', track['ear-L pitch (deg)'].max - track['ear-L pitch (deg)'].min > 20);
  check('tail sweeps (>=15 deg range)', track['tail tip yaw (deg)'].max - track['tail tip yaw (deg)'].min > 15);
  check('tuck engages at speed', track['tuck weight'].max > 0.5);
  check('flinch fires and recovers < 1.2 s', flinchEnd > 0 && flinchEnd - flinchStart < 1.2);
  check('cheer engages on win', track['cheer weight'].max > 0.85);
  check('eyes blink at least once', blinks >= 1);
  racer.dispose();
}

/* -------------------------------------------------------------- determinism */
console.log('\n== determinism ==');
{
  const hashOf = () => {
    const racer = createRacer('yaffa', { detail: 'low' });
    for (let i = 0; i < 240; i++) racer.update(1 / 60, { speed: 12 + i * 0.05, steer: Math.sin(i * 0.05), drift: i > 120 ? 1 : 0 });
    let h = 0;
    racer.object3D.updateMatrixWorld(true);
    racer.object3D.traverse(o => { h = (h * 31 + Math.round((o.position.x + o.rotation.y + o.scale.z) * 1e6)) | 0; });
    racer.dispose();
    return h;
  };
  const a = hashOf(), b = hashOf();
  check('two identical runs match', a === b, `${a} vs ${b}`);
}

console.log(FAILS ? `\n${FAILS} CHECK(S) FAILED\n` : '\nall checks passed\n');
process.exit(FAILS ? 1 : 0);
