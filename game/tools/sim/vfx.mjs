/**
 * Headless VFX simulation — no WebGL, no canvas.
 *
 * Drives the particle system through a scripted lap (accelerate, drift through three charge
 * tiers, release the mini-turbo, run off onto the farm dirt, ford the wadi, take an item hit)
 * and prints hard numbers: emission rates per surface, spark tier colours, pool pressure,
 * decal spacing and lifetime, and CPU-mirrored particle trajectories.
 *
 *   node tools/sim/vfx.mjs
 */
import * as THREE from 'three';
import { createVFX, evalParticle, ParticleBatch } from '../../src/render/particles.js';
import { PRESETS, SURFACE_FX, TIERS, buildSpriteAtlas, buildDecalAtlas } from '../../src/render/vfxLibrary.js';

/* ------------------------------------------------------------- fake engine ---- */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9dc0dc, 90, 520);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 4000);
camera.position.set(0, 3, 10);
scene.add(camera);
const systems = [];
const engine = {
  scene, camera, frame: 0,
  renderer: { getDrawingBufferSize: (v) => v.set(1280, 720) },
  add(s) { systems.push(s); return s; },
};

/** Rolling limestone ridge, close enough to Amikam for a physics-free rig test. */
const world = {
  heightAt(x, z) { return 120 + Math.sin(x * 0.012) * 6 + Math.cos(z * 0.009) * 4; },
  normalAt(x, z, out = {}) {
    const e = 1;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const l = Math.hypot(-hx, 2 * e, -hz);
    out.x = -hx / l; out.y = 2 * e / l; out.z = -hz / l;
    return out;
  },
};

const fmt = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : String(v));
const hdr = (s) => console.log('\n\x1b[1m' + s + '\x1b[0m\n' + '-'.repeat(s.length));

/* --------------------------------------------------------------- atlas art ---- */
hdr('atlas');
const sa = buildSpriteAtlas({ cell: 64 });
const da = buildDecalAtlas({ cell: 64 });
{
  const d = sa.texture.image.data;
  let nonzero = 0, sum = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) nonzero++; sum += d[i]; }
  console.log(`sprite atlas   ${sa.texture.image.width}x${sa.texture.image.height}  cells=${sa.names.length}  ` +
    `coverage=${fmt(100 * nonzero / (d.length / 4), 1)}%  mean alpha=${fmt(sum / (d.length / 4), 1)}`);
  // per-sprite ink so an empty cell can never slip through unnoticed
  const cell = sa.cell, W = sa.texture.image.width;
  const ink = sa.names.map((n, i) => {
    const cx = (i % sa.cols) * cell, cy = Math.floor(i / sa.cols) * cell;
    let s = 0;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) s += d[((cy + y) * W + cx + x) * 4 + 3];
    return [n, s / (cell * cell * 255)];
  });
  console.log('  ink: ' + ink.map(([n, v]) => `${n}=${fmt(v * 100, 1)}%`).join('  '));
  const empty = ink.filter(([, v]) => v < 0.004);
  console.log(empty.length ? `  \x1b[31mEMPTY CELLS: ${empty.map(e => e[0]).join(',')}\x1b[0m` : '  all cells carry ink OK');
  const dd = da.texture.image.data;
  const dink = da.names.map((n, i) => {
    const cell2 = da.cell, W2 = da.texture.image.width;
    const cx = (i % da.cols) * cell2, cy = Math.floor(i / da.cols) * cell2;
    let s = 0;
    for (let y = 0; y < cell2; y++) for (let x = 0; x < cell2; x++) s += dd[((cy + y) * W2 + cx + x) * 4 + 3];
    return `${n}=${fmt(100 * s / (cell2 * cell2 * 255), 1)}%`;
  });
  console.log('  decal ink: ' + dink.join('  '));
}

/* ------------------------------------------------------------ system boot ---- */
const vfx = createVFX(engine, world, { seed: 4242, quality: 1, soft: false, ambience: true });
console.log(`\nbatches: alpha cap=${vfx.batches.alpha.capacity}  add cap=${vfx.batches.add.capacity}  ` +
  `decals cap=${vfx.decals.capacity}  ambient layers=${vfx.ambience.layers.length} ` +
  `(${vfx.ambience.layers.map(l => l.mesh.name + ':' + l.mesh.geometry.instanceCount).join(', ')})`);

/* ------------------------------------------------------------- kart driver ---- */
const kart = {
  position: new THREE.Vector3(0, world.heightAt(0, 0) + 0.4, 0),
  quaternion: new THREE.Quaternion(),
  velocity: new THREE.Vector3(0, 0, 0),
  speed: 0, drifting: false, driftTier: 0, driftCharge: 0,
  boosting: false, grounded: true, surface: 'tarmac',
};
const rig = vfx.attach(kart, { seed: 3 });

const DT = 1 / 60;
let t = 0;
function step(n, mutate) {
  for (let i = 0; i < n; i++) {
    t += DT;
    mutate?.(t, i);
    const yaw = Math.atan2(kart.velocity.x, kart.velocity.z);
    kart.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), kart.heading ?? yaw);
    kart.position.addScaledVector(kart.velocity, DT);
    kart.position.y = world.heightAt(kart.position.x, kart.position.z) + 0.4;
    kart.speed = kart.velocity.length();
    engine.frame++;
    vfx.update(DT, t);
  }
}

/* Phase 1 — straight-line tarmac at 25 m/s: baseline emission (should be near zero). */
hdr('phase 1: tarmac cruise, no slip (2 s)');
kart.heading = 0;
kart.velocity.set(0, 0, 25);
let before = vfx.stats().emitted;
step(120);
let s1 = vfx.stats();
console.log(`speed=${fmt(kart.speed)} m/s  slip=${fmt(rig.state.slip, 3)}  ` +
  `emitted=${s1.emitted - before} (${fmt((s1.emitted - before) / 2, 1)}/s)  alive alpha=${s1.alpha.alive} add=${s1.add.alive}`);
console.log(`decals stamped=${s1.decals.stamped}  (expect ~0: a clean line leaves no rubber)`);

/* Phase 2 — drift: slip ramps, charge climbs blue -> orange -> purple. */
hdr('phase 2: drift through all three charge tiers');
const tierSamples = [];
for (let tier = 1; tier <= 3; tier++) {
  kart.drifting = true; kart.driftTier = tier; kart.driftCharge = tier * 0.33;
  // 22 deg of body slip: the velocity vector points away from the heading
  kart.heading = 0;
  kart.velocity.set(Math.sin(0.38) * 24, 0, Math.cos(0.38) * 24);
  const b = vfx.stats(), addBefore = vfx.batches.add.used, cursorBefore = vfx.batches.add.cursor;
  const dBefore = vfx.decals.stats().stamped;
  step(60);
  const a = vfx.stats();
  const dAfter = vfx.decals.stats().stamped;
  // read back the colour of the newest *spark* in the additive batch (skip the flare cores)
  const bat = vfx.batches.add, STR = 28, SPARK = 3;
  let idx = (bat.cursor - 1 + bat.capacity) % bat.capacity;
  for (let k = 0; k < bat.capacity; k++) {
    const j = (bat.cursor - 1 - k + bat.capacity * 2) % bat.capacity;
    if (bat.data[j * STR + 23] === SPARK) { idx = j; break; }
  }
  const col = [bat.data[idx * STR + 12], bat.data[idx * STR + 13], bat.data[idx * STR + 14]];
  tierSamples.push({ tier, col });
  console.log(`tier ${tier} (${TIERS[tier].name.padEnd(6)}) slip=${fmt(rig.state.slip, 3)}  ` +
    `emitted=${a.emitted - b.emitted}/s  sparkRGB=[${col.map(v => fmt(v, 2)).join(', ')}]  ` +
    `expect=[${TIERS[tier].glow.map(v => fmt(v, 2)).join(', ')}]  tyreMarks=+${dAfter - dBefore}`);
}
console.log(`tier colours distinct: ${new Set(tierSamples.map(s => s.col.join(','))).size === 3 ? 'yes' : 'NO'}`);
console.log(`tier-up pops: ${rig.events.tierUps}`);

/* Phase 3 — release: the mini-turbo fires. */
hdr('phase 3: drift release -> mini-turbo boost');
const b3 = vfx.stats();
kart.drifting = false; kart.boosting = true;
kart.velocity.set(0, 0, 30);
step(1);
const burst = vfx.stats().emitted - b3.emitted;
step(59);
const s3 = vfx.stats();
console.log(`release burst = ${burst} particles in one frame  boosts=${rig.events.boosts}`);
console.log(`boost second: emitted=${s3.emitted - b3.emitted}  trail intensity=${fmt(rig.trail.material.uniforms.uIntensity.value, 2)}  ` +
  `trail pts=${rig.trail.points.length}  speedLines=${fmt(vfx.speedLines.intensity, 2)}`);
kart.boosting = false;
step(60);
console.log(`after boost: speedLines decays to ${fmt(vfx.speedLines.intensity, 2)}, trail ${fmt(rig.trail.material.uniforms.uIntensity.value, 2)}`);

/* Phase 4 — per-surface emission survey at a constant 20 m/s and 0.35 slip. */
hdr('phase 4: surface survey (1 s each @ 20 m/s, slip 0.35)');
kart.drifting = false; kart.driftTier = 0; kart.boosting = false;
kart.velocity.set(Math.sin(0.36) * 20, 0, Math.cos(0.36) * 20);
console.log('surface      particles/s   chips/s   decals/s   palette');
for (const surf of ['tarmac', 'dirt_track', 'gravel', 'grass', 'crop', 'soil', 'sand', 'water']) {
  kart.surface = surf;
  const b = vfx.stats(), db = vfx.decals.stats().stamped;
  const alphaBefore = vfx.batches.alpha.data.slice();
  step(60);
  const a = vfx.stats(), da2 = vfx.decals.stats().stamped;
  const fx = SURFACE_FX[surf];
  console.log(`${surf.padEnd(12)} ${String(a.emitted - b.emitted).padStart(10)} ` +
    `${String(Math.round(fx.chips * 26 * (20 / 26) * 0.75)).padStart(9)} ${String(da2 - db).padStart(10)}   ` +
    `${fx.sprite}/${fx.a.map(v => Math.round(v * 255)).join(',')}`);
  void alphaBefore;
}

/* Phase 5 — impacts. */
hdr('phase 5: impacts and item hits');
for (const kind of ['impact', 'explosion', 'spinOut', 'railSparks', 'splash']) {
  const b = vfx.stats();
  vfx.emit(kind, { pos: kart.position, dir: new THREE.Vector3(0, 1, 0) });
  const a = vfx.stats();
  console.log(`${kind.padEnd(12)} -> ${a.emitted - b.emitted} particles`);
}
step(30);

/* Phase 6 — pool pressure: hammer the ring buffer past capacity. */
hdr('phase 6: pool pressure');
const cap = vfx.batches.alpha.capacity;
const before6 = vfx.batches.alpha.used;
for (let i = 0; i < 400; i++) vfx.emit('driftSmoke', { pos: kart.position, count: 12 });
const s6 = vfx.stats();
console.log(`emitted 4800 smoke into a ${cap}-slot ring: used=${s6.alpha.used} alive=${s6.alpha.alive} ` +
  `(never exceeds capacity: ${s6.alpha.used <= cap && s6.alpha.alive <= cap ? 'OK' : 'FAIL'})`);
console.log(`instanceCount=${vfx.batches.alpha.geometry.instanceCount}  buffer floats=${vfx.batches.alpha.data.length}`);

/* Phase 7 — trajectory checks against the CPU mirror of the vertex shader. */
hdr('phase 7: particle trajectories (CPU mirror of the vertex shader)');
function traj(presetName, over = {}) {
  const P = { ...PRESETS[presetName], ...over };
  const p = {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: (P.speed[0] + P.speed[1]) / 2, vz: 0,
    life: (P.life[0] + P.life[1]) / 2, drag: P.drag, grav: P.grav,
    turbA: P.turb[0], turbF: P.turb[1], size0: P.size[0], size1: P.size[1],
    alpha: P.alpha, fadeIn: P.fadeIn ?? 0.05, seed: 0.37,
  };
  let peak = -Infinity, peakT = 0;
  for (let i = 0; i <= 40; i++) {
    const age = p.life * i / 40;
    const e = evalParticle(p, age);
    if (e.y > peak) { peak = e.y; peakT = age; }
  }
  const end = evalParticle(p, p.life * 0.999);
  return { life: p.life, peak, peakT, endY: end.y, endSize: end.size, halfAlpha: p.alpha * 0.5 };
}
for (const n of ['driftSmoke', 'dust', 'gravelChip', 'driftSpark', 'splash', 'boostFlame', 'leafDrift']) {
  const r = traj(n);
  console.log(`${n.padEnd(12)} life=${fmt(r.life)}s  rise=${fmt(r.peak)}m @${fmt(r.peakT)}s  ` +
    `end y=${fmt(r.endY)}m  end size=${fmt(r.endSize)}m`);
}

/* Phase 8 — decal geometry: spacing, orientation, lifetime. */
hdr('phase 8: tyre-mark trail geometry');
{
  const d = vfx.decals;
  d.clear();
  const p = new THREE.Vector3(0, world.heightAt(0, 0), 0);
  const dir = new THREE.Vector3(0, 0, 1);
  const stamps = [];
  const base = d.stats().stamped;
  for (let i = 0; i < 120; i++) {
    p.z += 0.25;                                  // 15 m/s at 60 Hz
    p.y = world.heightAt(p.x, p.z);
    const idx = d.trail(1, p, dir, { kind: 'tyre', width: 0.34, alpha: 0.8, life: 14 });
    if (idx >= 0) stamps.push(idx);
    d.update(DT, t + i * DT);
  }
  const st = d.stats();
  const laid = st.stamped - base;
  console.log(`drove 30 m -> ${laid} segments (${fmt(30 / Math.max(laid, 1))} m apart), ` +
    `alive=${st.alive}, capacity=${st.capacity}`);
  console.log(`segment quad: half-length=${fmt(0.42 / 2)} m, half-width=${fmt(0.17)} m, ` +
    `lifted ${fmt(0.045, 3)} m above ground, fade starts at 45% of a 14 s life (=${fmt(14 * 0.45, 1)} s)`);
  d.breakTrail(1);
  const s = d.stats().stamped;
  d.trail(1, p, dir, {});
  console.log(`breakTrail then resume: ${d.stats().stamped - s} new segments on the first frame (expect 0 — no bridge quad)`);
}

/* Phase 9 — quality scaling. */
hdr('phase 9: quality scaling');
for (const qv of [1, 0.6, 0.3, 0.1]) {
  vfx.setQuality(qv);
  const b = vfx.stats();
  kart.surface = 'dirt_track'; kart.drifting = true; kart.driftTier = 2;
  step(60);
  const a = vfx.stats();
  console.log(`quality=${fmt(qv, 2)}  emitted/s=${a.emitted - b.emitted}  ` +
    `ambient instances=${vfx.ambience.layers.reduce((n, l) => n + l.mesh.geometry.instanceCount, 0)}  ` +
    `speedline instances=${vfx.speedLines.mesh.geometry.instanceCount}  decals visible=${vfx.decals.mesh.visible}`);
}

hdr('summary');
const fin = vfx.stats();
console.log(`total emitted=${fin.emitted} bursts=${fin.bursts} sim time=${fmt(t)}s`);
console.log(`draw calls for all of the above: 2 particle batches + 1 decal batch + ` +
  `${vfx.ambience.layers.length} ambient layers + 1 trail + 2 screen = ` +
  `${2 + 1 + vfx.ambience.layers.length + 1 + 2}`);
console.log('scene children:', scene.children.map(c => c.name || c.type).join(', '));
