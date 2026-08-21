/**
 * Kat Racing — the item game.
 *
 * Fourteen Israeli-flavoured items with Mario-Kart-shaped mechanics: a homing sabra, three
 * orbiting Jaffa oranges, a shakshuka pan that trails behind you as a shield, hot-falafel
 * boosts, a hummus slick that spins whoever touches it, a pardes crate that scatters fruit,
 * a khamsin dust devil that blinds and scrambles steering, a hamsa charm for invincibility,
 * a watermelon that makes you huge, a cat-nap cloud that hunts the leader, a hoopoe rush for
 * whoever is last, and a kite for a short glide-dash. Draw odds are place-weighted, so the
 * leader gets defensive scraps and the back of the field gets comebacks.
 *
 *   import { createItemSystem } from './items.js';
 *   const items = createItemSystem(world, track, { scene: engine.scene });
 *   items.onHit(e => hud.flash(e));
 *   items.update(dt, racers);            // racers: vehicles, AI cars, or plain {pos,vel,yaw}
 *   items.giveItem(racer);               // usually done by driving into a box
 *   items.useItem(racer, backwards);
 *
 * Every racer input is read defensively (vehicle API, plain object, or Object3D) and every
 * effect is published on `items.effects(racer)` so physics / AI / HUD can consume it without
 * this module reaching into anyone else's state.
 */
import * as THREE from 'three';
import { clamp, lerp, damp, rng, wrapPi, TAU } from '../core/mathx.js';

import * as ItemMeshes from './itemMeshes.js';

/** Mesh factories are optional: the headless sim and any stripped build run without them. */
const MESHES = (ItemMeshes && typeof ItemMeshes.createItemMesh === 'function') ? ItemMeshes : null;

const DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/* ==================================================================== items */

/**
 * kind:
 *   'homing'  spline-guided missile     'shot' straight projectile that bounces off the verges
 *   'shield'  trails behind the kart    'drop' hazard laid on the track
 *   'self'    affects the holder only   'field' travelling area effect
 *   'hunter'  seeks the race leader     'rush' takes the wheel for a few seconds
 */
export const ITEMS = {
  sabra:    { id: 'sabra',    name: 'Sabra Missile',  he: 'צבר',      kind: 'homing', count: 1, color: 0x7cad4e, speed: 33, life: 9.0,  hit: 'spin',   radius: 1.9 },
  jaffa:    { id: 'jaffa',    name: 'Jaffa Orange',   he: 'תפוז',     kind: 'shot',   count: 1, color: 0xef8b1f, speed: 28, life: 7.5,  hit: 'spin',   radius: 1.5, orbit: 1 },
  jaffa3:   { id: 'jaffa3',   name: 'Triple Jaffa',   he: 'שלישיית תפוזים', kind: 'shot', count: 3, color: 0xef8b1f, speed: 28, life: 7.5, hit: 'spin', radius: 1.5, orbit: 3, fires: 'jaffa' },
  pan:      { id: 'pan',      name: 'Shakshuka Pan',  he: 'מחבת שקשוקה', kind: 'shield', count: 1, color: 0xc0341c, speed: 24, life: 6.5, hit: 'spin', radius: 1.7 },
  falafel:  { id: 'falafel',  name: 'Hot Falafel',    he: 'פלאפל',    kind: 'self',   count: 1, color: 0x87903a, boost: { dur: 1.15, power: 0.36 } },
  falafel3: { id: 'falafel3', name: 'Triple Falafel', he: 'שלישיית פלאפל', kind: 'self', count: 3, color: 0x87903a, boost: { dur: 1.15, power: 0.36 }, orbit: 3, fires: 'falafel' },
  hummus:   { id: 'hummus',   name: 'Hummus Slick',   he: 'חומוס',    kind: 'drop',   count: 1, color: 0xdcc894, life: 12,  hit: 'slip',   radius: 1.75 },
  pardes:   { id: 'pardes',   name: 'Pardes Crate',   he: 'ארגז פרדס', kind: 'drop',  count: 1, color: 0xc9a273, life: 12,  hit: 'spin',   radius: 0.95, scatter: 5 },
  khamsin:  { id: 'khamsin',  name: 'Khamsin Devil',  he: 'חמסין',    kind: 'field',  count: 1, color: 0xd9b374, speed: 24, life: 8.0,  hit: 'blind',  radius: 3.2 },
  hamsa:    { id: 'hamsa',    name: 'Hamsa Charm',    he: 'חמסה',     kind: 'self',   count: 1, color: 0x2b8ede, dur: 7.5,  boost: { dur: 7.5, power: 0.14 } },
  avatiach: { id: 'avatiach', name: 'Watermelon',     he: 'אבטיח',    kind: 'self',   count: 1, color: 0x4f8c35, dur: 8.0,  boost: { dur: 8.0, power: 0.10 } },
  catnap:   { id: 'catnap',   name: 'Cat-Nap Cloud',  he: 'ענן תנומה', kind: 'hunter', count: 1, color: 0xdfe4f4, speed: 46, life: 22,  hit: 'stall',  radius: 3.6 },
  duchifat: { id: 'duchifat', name: 'Hoopoe Rush',    he: 'דוכיפת',   kind: 'rush',   count: 1, color: 0xd8a05e, dur: 7.5,  speedMul: 1.60 },
  afifon:   { id: 'afifon',   name: 'Kite Glide',     he: 'עפיפון',   kind: 'self',   count: 1, color: 0x2f6fd0, dur: 2.2,  boost: { dur: 0.55, power: 0.46 } },
};

export const ITEM_IDS = Object.keys(ITEMS);

/**
 * Place-weighted draw table, Mario-Kart style. Eight buckets from the leader (col 0) to the
 * tail of the field (col 7); any field size is interpolated across them. The leader can only
 * ever draw the six defensive/utility items; the comeback items only exist at the back.
 */
export const ODDS = {
  jaffa:    [26, 24, 18, 12,  8,  5,  3,  2],
  pan:      [30, 24, 18, 12,  8,  6,  4,  2],
  hummus:   [24, 22, 20, 16, 12,  8,  5,  3],
  afifon:   [14, 14, 13, 12, 11, 10,  8,  6],
  sabra:    [ 6, 12, 18, 20, 18, 14, 10,  6],
  jaffa3:   [ 4,  8, 14, 16, 16, 14, 10,  6],
  falafel:  [ 0,  6, 12, 18, 20, 18, 14, 10],
  falafel3: [ 0,  0,  4, 10, 16, 20, 22, 20],
  pardes:   [ 0,  2,  6, 10, 14, 16, 16, 14],
  khamsin:  [ 0,  0,  2,  5,  9, 13, 16, 18],
  avatiach: [ 0,  0,  2,  6, 10, 14, 18, 20],
  hamsa:    [ 0,  0,  0,  2,  6, 12, 20, 28],
  catnap:   [ 0,  0,  0,  2,  6, 10, 14, 16],
  duchifat: [ 0,  0,  0,  0,  0,  4, 14, 30],
};

/** Reaction shapes. `mul` is the speed multiplier while the reaction lasts. */
export const REACTIONS = {
  spin:  { dur: 1.45, mul: 0.34, spin: true,  drops: true,  shake: 1.0 },
  slip:  { dur: 1.15, mul: 0.48, spin: true,  drops: false, shake: 0.7 },
  squash:{ dur: 2.10, mul: 0.42, squash: true, drops: true, shake: 1.0 },
  stall: { dur: 2.40, mul: 0.12, spin: true,  drops: true,  shake: 1.3 },
  blind: { dur: 3.40, mul: 0.86, blind: true, drops: false, shake: 0.4, scramble: true },
  bump:  { dur: 0.55, mul: 0.72, spin: false, drops: false, shake: 0.5 },
};

/** Probability of each item for a given 1-based place in a field of `field` racers. */
export function itemOdds(place, field = 12) {
  const f = Math.max(field, 2);
  const x = clamp((clamp(place, 1, f) - 1) / (f - 1), 0, 1) * 7;
  const i = Math.min(6, Math.floor(x)), t = x - i;
  const out = [];
  let total = 0;
  for (const id of ITEM_IDS) {
    const row = ODDS[id] || [0, 0, 0, 0, 0, 0, 0, 0];
    const w = lerp(row[i], row[i + 1], t);
    if (w > 0) { out.push({ id, w }); total += w; }
  }
  for (const o of out) o.p = o.w / (total || 1);
  return out;
}

/* ============================================================ track fallback */

function validTrack(t) {
  return !!(t && typeof t.sample === 'function' && typeof t.nearest === 'function' && t.length > 1);
}

/**
 * A closed loop over the real terrain, behind exactly the `buildTrack()` interface, so the
 * item system (and its preview and sim) keep working while src/track/track.js is being written.
 */
export function fallbackTrack(world, opts = {}) {
  const o = Object.assign({ seed: 1337, radius: 205, width: 12.5, samples: 420, laps: 3, cx: 0, cz: 0 }, opts);
  const r = rng(o.seed), N = o.samples;
  const a1 = r() * TAU, a2 = r() * TAU;
  const pts = [];
  const H = (x, z) => (world && typeof world.heightAt === 'function' ? world.heightAt(x, z) : 0) || 0;
  for (let i = 0; i < N; i++) {
    const th = i / N * TAU;
    const rad = o.radius * (1 + 0.28 * Math.sin(3 * th + a1) + 0.15 * Math.sin(5 * th + a2));
    const x = o.cx + Math.cos(th) * rad, z = o.cz + Math.sin(th) * rad * 0.9;
    pts.push({ x, y: H(x, z), z });
  }
  for (let pass = 0; pass < 26; pass++) {
    const src = pts.map(p => p.y);
    for (let i = 0; i < N; i++) pts[i].y = src[(i - 1 + N) % N] * 0.25 + src[i] * 0.5 + src[(i + 1) % N] * 0.25;
  }
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const length = cum[N];
  const idxOfS = s => {
    let t = s % length; if (t < 0) t += length;
    let lo = 0, hi = N;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    return { i: lo, f: (t - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1) };
  };
  function sample(s) {
    const { i, f } = idxOfS(s);
    const a = pts[i], b = pts[(i + 1) % N], c = pts[(i + 2) % N], p = pts[(i - 1 + N) % N];
    const pos = { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) };
    const t = { x: lerp(b.x - p.x, c.x - a.x, f), y: lerp(b.y - p.y, c.y - a.y, f), z: lerp(b.z - p.z, c.z - a.z, f) };
    const tl = Math.hypot(t.x, t.y, t.z) || 1; t.x /= tl; t.y /= tl; t.z /= tl;
    const hl = Math.hypot(t.x, t.z) || 1;
    return { pos, tangent: t, normal: { x: t.z / hl, y: 0, z: -t.x / hl }, width: o.width, banking: 0, surface: 'tarmac' };
  }
  function nearest(pos) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < N; k++) {
      const d = (pts[k].x - pos.x) ** 2 + (pts[k].z - pos.z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    const a = pts[best], b = pts[(best + 1) % N];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const t = clamp(((pos.x - a.x) * dx + (pos.z - a.z) * dz) / l2, 0, 1);
    const cx = a.x + dx * t, cz = a.z + dz * t, tl = Math.sqrt(l2);
    const lateral = (pos.x - cx) * (dz / tl) + (pos.z - cz) * (-dx / tl);
    return { s: (cum[best] + t * tl) % length, lateral, onTrack: Math.abs(lateral) <= o.width * 0.5, surface: 'tarmac' };
  }
  const startGrid = [];
  for (let i = 0; i < 12; i++) {
    const sm = sample(-Math.floor(i / 2) * 6);
    const side = (i % 2 ? 1 : -1) * 2.6;
    startGrid.push({ pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y, z: sm.pos.z + sm.normal.z * side }, rot: Math.atan2(sm.tangent.x, sm.tangent.z) });
  }
  const itemBoxes = [];
  for (let g = 0; g < 4; g++) {
    const s = (0.12 + g * 0.25) * length;
    for (let k = -1; k <= 1; k++) {
      const sm = sample(s);
      itemBoxes.push({ pos: { x: sm.pos.x + sm.normal.x * k * 3.2, y: sm.pos.y + 1.35, z: sm.pos.z + sm.normal.z * k * 3.2 }, s, lateral: k * 3.2 });
    }
  }
  const checkpoints = [];
  for (let i = 0; i < 24; i++) checkpoints.push({ s: i / 24 * length });
  return { spline: pts, length, sample, nearest, checkpoints, startGrid, boostPads: [], itemBoxes, laps: o.laps, fallback: true };
}

/* ================================================================== helpers */

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
function readVec(o, out) {
  if (!o) return null;
  if (typeof o.x === 'number') { out.x = o.x; out.y = o.y ?? 0; out.z = o.z ?? 0; return out; }
  if (Array.isArray(o) && o.length >= 3) { out.x = o[0]; out.y = o[1]; out.z = o[2]; return out; }
  return null;
}
function racerPos(racer, out) {
  return readVec(racer?.position, out) || readVec(racer?.state?.pos, out) || readVec(racer?.pos, out)
      || readVec(racer?.object3D?.position, out) || readVec(racer?.transform?.position, out) || (out.x = 0, out.y = 0, out.z = 0, out);
}
function racerVel(racer, out) {
  return readVec(racer?.velocity, out) || readVec(racer?.state?.vel, out) || readVec(racer?.vel, out) || (out.x = 0, out.y = 0, out.z = 0, out);
}
function racerYaw(racer, rec) {
  const y = racer?.state?.yaw ?? racer?.yaw;
  if (typeof y === 'number') return y;
  const q = racer?.quaternion || racer?.state?.quat || racer?.object3D?.quaternion;
  if (q && typeof q.w === 'number') {
    const siny = 2 * (q.w * q.y + q.z * q.x), cosy = 1 - 2 * (q.y * q.y + q.x * q.x);
    return Math.atan2(siny, cosy);
  }
  if (rec && (rec.vel.x || rec.vel.z)) return Math.atan2(rec.vel.x, rec.vel.z);
  return rec ? rec.yaw : 0;
}

/* ============================================================== the system */

/**
 * @param {object} world  WorldData (only heightAt is used, and only if present)
 * @param {object} track  buildTrack() result; a loop over the terrain is substituted if absent
 * @param {object} opts   { scene, seed, visuals, boxRespawn, laps, immunity }
 */
export function createItemSystem(world, track, opts = {}) {
  const O = Object.assign({
    seed: 4242,
    visuals: DOM,
    boxRespawn: 4.0,
    pickupRadius: 2.3,
    immunity: 1.3,
    rouletteTime: 0.85,
    maxProjectiles: 64,
    shieldOffset: 2.05,
    orbitRadius: 1.55,
    orbitRate: 2.1,
    scene: null,
  }, opts);

  const trk = validTrack(track) ? track : fallbackTrack(world, { seed: O.seed, ...(opts.fallbackTrack || {}) });
  const len = trk.length;
  const rand = rng(O.seed);
  const visuals = !!O.visuals && !!MESHES;

  const root = new THREE.Group();
  root.name = 'items';
  if (O.scene && visuals) O.scene.add(root);
  const boxRoot = new THREE.Group(); root.add(boxRoot);
  const projRoot = new THREE.Group(); root.add(projRoot);
  const fxRoot = new THREE.Group(); root.add(fxRoot);

  const hitCbs = [];
  const recs = new Map();               // racer -> record
  let list = [];                        // records in the order racers were passed in
  let elapsed = 0;

  const tmpA = V(), tmpB = V();
  const _s = { pos: V(), tangent: V(), normal: V(), width: 12, banking: 0, surface: 'tarmac' };
  const sample = s => { try { return trk.sample(((s % len) + len) % len); } catch (e) { return _s; } };
  const nearest = p => { try { return trk.nearest(p); } catch (e) { return { s: 0, lateral: 0, onTrack: true, surface: 'tarmac' }; } };
  const dS = (a, b) => { let d = a - b; while (d > len * 0.5) d -= len; while (d < -len * 0.5) d += len; return d; };

  /* ------------------------------------------------------- ground shadows */
  /**
   * Every airborne item carries its own ground blob.
   *
   * The cascade shadow map cannot resolve a 0.4 m orange — R2 saw three fruit "hanging in
   * space with no relationship to the surface", which is exactly what a missing contact cue
   * looks like. MK8 solves it the same way: an explicit blob under each item, growing and
   * thinning with height, so you can read a projectile's trajectory and its landing point
   * from the shadow alone. `gy` is the road surface the projectile was placed against (the
   * track spline, not raw terrain, because the road is graded), and `normalAt` tilts the blob
   * onto the camber so it does not slice into the tarmac on a banked corner.
   */
  const UPN = { x: 0, y: 1, z: 0 };
  function surfaceNormal(x, z, out) {
    if (world && typeof world.normalAt === 'function') {
      try { const n = world.normalAt(x, z, out); if (n) return n; } catch (e) { /* fall through */ }
    }
    return UPN;
  }
  const _sn = V();
  function attachShadow(p, radius) {
    if (!visuals || !MESHES.makeBlobShadow) return;
    try {
      p.shadowFx = MESHES.makeBlobShadow(radius ?? 0.34);
      fxRoot.add(p.shadowFx.object3D);
    } catch (e) { p.shadowFx = null; }
  }
  function placeShadow(p) {
    if (!p.shadowFx) return;
    const gy = p.gy ?? (p.pos.y - (p.hover ?? 0.5));
    const n = surfaceNormal(p.pos.x, p.pos.z, _sn);
    p.shadowFx.place(p.pos.x, p.pos.z, gy, Math.max(p.pos.y - gy, 0), n.x, n.y, n.z);
  }
  function dropShadow(p) {
    if (!p || !p.shadowFx) return;
    p.shadowFx.object3D.parent?.remove(p.shadowFx.object3D);
    p.shadowFx.dispose?.();
    p.shadowFx = null;
  }

  /* ---------------------------------------------------------- burst pool */
  const bursts = [];
  function burst(pos, color) {
    if (!visuals) return;
    let b = bursts.find(x => !x.active);
    if (!b) {
      if (bursts.length > 10) return;
      try { b = MESHES.createPickupBurst({ seed: 77 + bursts.length * 13 }); } catch (e) { return; }
      fxRoot.add(b.object3D);
      bursts.push(b);
    }
    b.play(pos, color);
  }

  /* --------------------------------------------------------- item boxes */
  const boxes = [];
  {
    const src = Array.isArray(trk.itemBoxes) && trk.itemBoxes.length ? trk.itemBoxes : fallbackTrack(world, { seed: O.seed }).itemBoxes;
    let i = 0;
    for (const b of src) {
      const p = b.pos || b;
      const nb = nearest(p);
      const box = {
        index: i++, pos: V(p.x, p.y ?? 0, p.z), base: V(p.x, p.y ?? 0, p.z),
        s: b.s ?? nb.s, lateral: b.lateral ?? nb.lateral,
        active: true, timer: 0, phase: rand() * TAU, mesh: null,
      };
      if (visuals) {
        try {
          // 1.32 m, not 1.5: an item box should read as roughly one kart wide, and R2 found
          // the old cube outsized the kart it was meant to sit beside.
          box.mesh = MESHES.createItemBoxMesh({ size: 1.32 });
          box.mesh.position.set(box.pos.x, box.pos.y, box.pos.z);
          boxRoot.add(box.mesh);
        } catch (e) { box.mesh = null; }
      }
      boxes.push(box);
    }
  }

  /* -------------------------------------------------------- projectiles */
  const projectiles = [];
  const hazards = [];

  function makeMesh(id, scale) {
    if (!visuals) return null;
    try {
      const m = MESHES.createItemMesh(id, { scale });
      projRoot.add(m);
      return m;
    } catch (e) { return null; }
  }
  function dropMesh(m) {
    if (!m) return;
    m.parent?.remove(m);
    m.traverse?.(o => { if (o.isMesh && o.geometry && !o.geometry.__shared) o.geometry.dispose?.(); });
  }

  function spawnProjectile(p) {
    if (projectiles.length >= O.maxProjectiles) {
      const oldest = projectiles.shift();
      killProjectile(oldest, false);
    }
    p.age = 0;
    p.dead = false;
    p.mesh = p.mesh ?? makeMesh(p.visual || p.item, p.scale);
    if (p.mesh) p.mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    if (visuals && p.trail !== false && MESHES.makeTrail) {
      try {
        p.trailFx = MESHES.makeTrail(ITEMS[p.item]?.color ?? 0xffc46b,
          { width: p.trailWidth ?? 0.45, points: p.trailPoints ?? 22 });
        if (p.trailAlpha !== undefined) p.trailFx.material.opacity = p.trailAlpha;
        fxRoot.add(p.trailFx.object3D);
      } catch (e) { p.trailFx = null; }
    }
    if (p.shadow !== false) attachShadow(p, p.shadowRadius);
    projectiles.push(p);
    return p;
  }
  function killProjectile(p, showBurst = true) {
    if (!p || p.dead) return;
    p.dead = true;
    if (showBurst) burst(p.pos, ITEMS[p.item]?.color ?? 0xffd27a);
    dropMesh(p.mesh); p.mesh = null;
    dropShadow(p);
    if (p.trailFx) { p.trailFx.object3D.parent?.remove(p.trailFx.object3D); p.trailFx.dispose?.(); p.trailFx = null; }
    const i = projectiles.indexOf(p);
    if (i >= 0) projectiles.splice(i, 1);
  }

  function spawnHazard(h) {
    h.age = 0;
    if (visuals) {
      try {
        h.mesh = h.kind === 'hummus'
          ? MESHES.makeHummusSlick(ITEMS.hummus.radius, (h.seed | 0) || 11)
          : MESHES.createItemMesh(h.visual || h.kind, { scale: h.scale });
        h.mesh.position.set(h.pos.x, h.pos.y, h.pos.z);
        fxRoot.add(h.mesh);
      } catch (e) { h.mesh = null; }
    }
    hazards.push(h);
    return h;
  }
  function killHazard(h, showBurst = true) {
    if (h.dead) return;
    h.dead = true;
    if (showBurst) burst(h.pos, ITEMS[h.item || h.kind]?.color ?? 0xdcc894);
    dropMesh(h.mesh); h.mesh = null;
    const i = hazards.indexOf(h);
    if (i >= 0) hazards.splice(i, 1);
  }

  /* -------------------------------------------------------- racer records */
  function newFx() {
    return {
      spin: 0, slip: 0, squash: 0, stall: 0, blind: 0, scramble: 0,
      invincible: 0, grow: 0, glide: 0, autopilot: 0, immune: 0,
      boostTime: 0, boostPower: 0, shield: 0, shake: 0, scale: 1, hitKind: null, spinAngle: 0,
    };
  }
  function record(racer, idx) {
    let rec = recs.get(racer);
    if (rec) { rec.index = idx; return rec; }
    rec = {
      ref: racer, index: idx,
      id: racer?.id ?? racer?.name ?? ('racer' + idx),
      pos: V(), vel: V(), yaw: 0, speed: 0,
      s: 0, lateral: 0, lap: 0, progress: 0, place: idx + 1, prevS: null,
      item: null, count: 0, pending: null, roulette: null, holdFace: null,
      fx: newFx(), orbiters: [], shieldProj: null, seed: (idx + 1) * 7919,
      hits: 0, given: 0, used: 0, history: [],
    };
    recs.set(racer, rec);
    try { racer.itemFx = rec.fx; } catch (e) { /* frozen object, fine */ }
    return rec;
  }

  function syncRacer(rec, dt) {
    const r = rec.ref;
    racerPos(r, rec.pos);
    racerVel(r, rec.vel);
    rec.speed = Math.hypot(rec.vel.x, rec.vel.z);
    rec.yaw = racerYaw(r, rec);
    const n = nearest(rec.pos);
    rec.lateral = n.lateral;
    if (rec.prevS === null) { rec.prevS = n.s; rec.progress = n.s; }
    else {
      const d = dS(n.s, rec.prevS);
      if (Math.abs(d) < len * 0.4) rec.progress += d;
      rec.prevS = n.s;
    }
    rec.s = n.s;
    rec.lap = Math.floor(rec.progress / len) + 1;
    rec.onTrack = n.onTrack;
  }

  function computePlaces() {
    const sorted = list.slice().sort((a, b) => b.progress - a.progress);
    for (let i = 0; i < sorted.length; i++) {
      const ext = sorted[i].ref?.place ?? sorted[i].ref?.state?.place;
      sorted[i].place = Number.isFinite(ext) ? ext : i + 1;
    }
  }

  /* ------------------------------------------------------------ hitting */
  function emit(e) { for (const cb of hitCbs) { try { cb(e); } catch (err) { /* listener's problem */ } } }

  /**
   * Apply a hit to a racer. Returns 'hit' | 'blocked' | 'immune'.
   * Shields (a trailing pan, orbiting fruit) are consumed first, then invincibility, then
   * immunity frames from the previous hit.
   */
  function applyHit(rec, kind, srcRec, itemId, pos, fromId) {
    if (!rec) return 'immune';
    const fx = rec.fx;
    if (fx.invincible > 0 || fx.autopilot > 0) return 'immune';
    if (fx.grow > 0 && kind !== 'squash' && kind !== 'stall') return 'immune';
    if (fx.immune > 0) return 'immune';
    if (rec.shieldProj || rec.orbiters.length) {
      // the shield eats it
      const eaten = rec.shieldProj || rec.orbiters[rec.orbiters.length - 1];
      loseShield(rec, eaten);
      fx.immune = Math.max(fx.immune, 0.35);
      emit({ type: 'block', victim: rec.ref, victimRec: rec, source: srcRec?.ref ?? null, item: itemId, from: fromId || itemId, pos: pos || rec.pos });
      return 'blocked';
    }
    const R = REACTIONS[kind] || REACTIONS.spin;
    fx.hitKind = kind;
    if (kind === 'blind') { fx.blind = Math.max(fx.blind, R.dur); fx.scramble = Math.max(fx.scramble, R.dur); }
    else if (kind === 'squash') { fx.squash = Math.max(fx.squash, R.dur); fx.scale = 0.55; }
    else if (kind === 'stall') fx.stall = Math.max(fx.stall, R.dur);
    else if (kind === 'slip') fx.slip = Math.max(fx.slip, R.dur);
    else fx.spin = Math.max(fx.spin, R.dur);
    fx.shake = Math.max(fx.shake, R.shake ?? 1);
    fx.immune = Math.max(fx.immune, O.immunity);
    rec.hits++;
    if (R.drops) dropHeld(rec);
    try { rec.ref.onItemHit?.(kind, itemId, srcRec?.ref ?? null); } catch (e) { /* optional hook */ }
    burst(pos || rec.pos, ITEMS[itemId]?.color ?? 0xffd27a);
    emit({ type: 'hit', kind, victim: rec.ref, victimRec: rec, source: srcRec?.ref ?? null, sourceRec: srcRec ?? null, item: itemId, from: fromId || itemId, pos: pos || rec.pos });
    return 'hit';
  }

  /** A spun-out racer throws away whatever it was carrying — held item and orbiters both. */
  function dropHeld(rec) {
    if (rec.item) {
      const it = rec.item;
      rec.item = null; rec.count = 0; rec.pending = null; rec.roulette = null;
      emit({ type: 'drop', victim: rec.ref, victimRec: rec, item: it });
    }
    for (const o of rec.orbiters.slice()) {
      loseShield(rec, o, true);
    }
    if (rec.shieldProj) loseShield(rec, rec.shieldProj, true);
  }

  function loseShield(rec, proj, scatter = false) {
    if (!proj) return;
    const i = rec.orbiters.indexOf(proj);
    if (i >= 0) rec.orbiters.splice(i, 1);
    if (rec.shieldProj === proj) rec.shieldProj = null;
    if (scatter && proj.item !== 'falafel' && proj.item !== 'falafel3') {
      // becomes a loose hazard rolling on the tarmac
      spawnHazard({ kind: 'orange', item: 'jaffa', pos: V(proj.pos.x, proj.pos.y, proj.pos.z), radius: 1.2, life: 8, hit: 'spin', owner: null, visual: 'jaffa', scale: 0.85, seed: (rand() * 1e6) | 0 });
    }
    killProjectile(proj, true);
  }

  /* ------------------------------------------------------------ drawing */
  function drawItem(place, field) {
    const odds = itemOdds(place, field);
    let x = rand();
    for (const o of odds) { x -= o.p; if (x <= 0) return o.id; }
    return odds.length ? odds[odds.length - 1].id : 'jaffa';
  }

  /** Start the roulette for a racer and lock in the item it will settle on. */
  function giveItem(racer, forceId = null) {
    const rec = recs.get(racer) || record(racer, list.length);
    if (rec.item || rec.pending) return null;
    const id = forceId && ITEMS[forceId] ? forceId : drawItem(rec.place, Math.max(list.length, 2));
    rec.pending = { id, t: 0, dur: O.rouletteTime };
    rec.roulette = { face: id, t: 0 };
    rec.given++;
    rec.history.push({ place: rec.place, id, t: elapsed });
    emit({ type: 'draw', victim: racer, victimRec: rec, item: id, place: rec.place });
    return id;
  }

  /* -------------------------------------------------------------- using */
  function forward(rec) {
    const sm = sample(rec.s);
    const f = { x: Math.sin(rec.yaw), z: Math.cos(rec.yaw) };
    // a projectile should follow the road, not a spun-out kart's nose
    const dot = f.x * sm.tangent.x + f.z * sm.tangent.z;
    return dot < -0.2 ? { x: -sm.tangent.x, z: -sm.tangent.z, along: -1 } : { x: sm.tangent.x, z: sm.tangent.z, along: 1 };
  }

  function useItem(racer, backwards = false) {
    const rec = recs.get(racer);
    if (!rec || !rec.item || rec.pending) return null;
    const def = ITEMS[rec.item];
    if (!def) { rec.item = null; rec.count = 0; return null; }
    const id = rec.item;
    let consumed = true;

    switch (def.kind) {
      case 'homing':    fireSabra(rec, backwards); break;
      case 'shot':      consumed = fireShot(rec, backwards, def); break;
      case 'shield':    consumed = usePan(rec, backwards); break;
      case 'drop':      dropTrap(rec, id, backwards); break;
      case 'field':     fireKhamsin(rec); break;
      case 'hunter':    fireCatnap(rec); break;
      case 'rush':      startRush(rec); break;
      case 'self':      useSelf(rec, id, def); break;
      default:          break;
    }
    if (consumed) {
      rec.count = Math.max(0, rec.count - 1);
      rec.used++;
      if (rec.count <= 0) { rec.item = null; releaseOrbiters(rec); }
      emit({ type: 'use', victim: racer, victimRec: rec, item: id, backwards: !!backwards, remaining: rec.count });
    }
    return id;
  }

  function releaseOrbiters(rec) {
    for (const o of rec.orbiters.slice()) killProjectile(o, false);
    rec.orbiters.length = 0;
  }

  function spawnAt(rec, back, lift = 0.55, dist = 1.4) {
    const f = { x: Math.sin(rec.yaw), z: Math.cos(rec.yaw) };
    const k = back ? -1 : 1;
    return V(rec.pos.x + f.x * dist * k, rec.pos.y + lift, rec.pos.z + f.z * dist * k);
  }

  function fireSabra(rec, backwards) {
    const target = nextAhead(rec);
    const start = spawnAt(rec, backwards, 0.75, 1.8);
    const n = nearest(start);
    spawnProjectile({
      item: 'sabra', kind: 'homing', owner: rec, target,
      pos: start, s: n.s, lateral: n.lateral, dir: backwards ? -1 : 1,
      speed: ITEMS.sabra.speed, life: ITEMS.sabra.life, radius: ITEMS.sabra.radius,
      hit: 'spin', hover: 0.85, scale: 1.0, trailWidth: 0.5,
    });
  }

  function fireShot(rec, backwards, def) {
    if (def.orbit && rec.orbiters.length) {
      // fire one of the orbiting fruits
      const p = rec.orbiters.pop();
      const f = forward(rec);
      p.kind = 'shot';
      p.owner = rec; p.orbiting = false;
      p.grace = 0.25;
      p.dir = backwards ? -1 : 1;
      p.speed = backwards ? def.speed * 0.35 : def.speed;
      p.life = def.life;
      const n = nearest(p.pos);
      p.s = n.s; p.lateral = n.lateral;
      p.vy = 0;
      p.item = def.fires || def.id;
      p.from = def.id;
      return true;
    }
    const start = spawnAt(rec, backwards, 0.55, 1.6);
    const n = nearest(start);
    spawnProjectile({
      item: def.fires || def.id, from: def.id, kind: 'shot', owner: rec, grace: 0.2,
      pos: start, s: n.s, lateral: n.lateral, dir: backwards ? -1 : 1,
      speed: backwards ? def.speed * 0.35 : def.speed,
      life: def.life, radius: def.radius, hit: def.hit, hover: 0.36, scale: 1.0, trailWidth: 0.34,
    });
    return true;
  }

  function usePan(rec, backwards) {
    if (!rec.shieldProj) {
      // deploy: the pan hangs behind the kart and eats one hit
      const p = spawnProjectile({
        item: 'pan', kind: 'trailing', owner: rec, pos: spawnAt(rec, true, 0.55, O.shieldOffset),
        s: rec.s, lateral: rec.lateral, life: 30, radius: ITEMS.pan.radius, hit: ITEMS.pan.hit,
        hover: 0.55, trail: false, scale: 0.9,
      });
      rec.shieldProj = p;
      return false;                            // still held: a second press throws it
    }
    const p = rec.shieldProj;
    rec.shieldProj = null;
    p.kind = 'shot';
    p.orbiting = false;
    p.grace = 0.25;
    p.dir = backwards ? -1 : 1;
    p.speed = backwards ? 6 : ITEMS.pan.speed;
    p.life = ITEMS.pan.life;
    const n = nearest(p.pos);
    p.s = n.s; p.lateral = n.lateral;
    return true;
  }

  function dropTrap(rec, id, backwards) {
    const def = ITEMS[id];
    const at = spawnAt(rec, backwards === false ? false : true, 0.06, id === 'pardes' ? 2.6 : 2.2);
    if (id === 'hummus') {
      const sm = sample(nearest(at).s);
      spawnHazard({
        kind: 'hummus', item: 'hummus', pos: V(at.x, (world?.heightAt?.(at.x, at.z) ?? sm.pos.y) + 0.02, at.z),
        radius: def.radius, life: def.life, hit: 'slip', owner: rec, seed: (rand() * 1e6) | 0,
      });
    } else if (id === 'pardes') {
      spawnHazard({
        kind: 'crate', item: 'pardes', pos: V(at.x, at.y + 0.35, at.z), radius: def.radius,
        life: def.life, hit: 'spin', owner: rec, fuse: 0.28, scatter: def.scatter, visual: 'pardes', scale: 1.0,
        seed: (rand() * 1e6) | 0,
      });
    }
  }

  function fireKhamsin(rec) {
    const start = spawnAt(rec, false, 0.0, 3.0);
    const n = nearest(start);
    const p = spawnProjectile({
      item: 'khamsin', kind: 'devil', owner: rec, grace: 0.6,
      pos: V(start.x, start.y, start.z), s: n.s, lateral: n.lateral, dir: 1,
      speed: ITEMS.khamsin.speed, life: ITEMS.khamsin.life, radius: ITEMS.khamsin.radius,
      hit: 'blind', hover: 0.0, trail: false, wander: rand() * TAU, mesh: null, pierces: true,
    });
    if (visuals) {
      try {
        p.mesh = MESHES.makeKhamsin(3.6, 1.0);
        projRoot.add(p.mesh);
      } catch (e) { p.mesh = null; }
    }
  }

  function fireCatnap(rec) {
    const start = spawnAt(rec, false, 2.2, 1.6);
    const n = nearest(start);
    spawnProjectile({
      item: 'catnap', kind: 'hunter', owner: rec, grace: 0.4,
      pos: start, s: n.s, lateral: n.lateral, dir: 1,
      speed: ITEMS.catnap.speed, life: ITEMS.catnap.life, radius: ITEMS.catnap.radius,
      hit: 'stall', hover: 3.6, scale: 1.7, trail: false, phase: 'cruise',
    });
  }

  function startRush(rec) {
    const def = ITEMS.duchifat;
    rec.fx.autopilot = def.dur;
    rec.fx.invincible = Math.max(rec.fx.invincible, def.dur);
    rec.fx.speedMul = def.speedMul;
    rec.rushBird = visuals ? makeMesh('duchifat', 1.4) : null;
    addBoost(rec, def.dur, 0.5);
  }

  function useSelf(rec, id, def) {
    if (id === 'hamsa') {
      rec.fx.invincible = Math.max(rec.fx.invincible, def.dur);
      rec.fx.charm = visuals && !rec.fx.charmMesh ? (rec.fx.charmMesh = makeMesh('hamsa', 0.9), true) : rec.fx.charm;
    } else if (id === 'avatiach') {
      rec.fx.grow = Math.max(rec.fx.grow, def.dur);
      rec.fx.scale = 1.55;
    } else if (id === 'afifon') {
      rec.fx.glide = Math.max(rec.fx.glide, def.dur);
      if (visuals && !rec.fx.kiteMesh) rec.fx.kiteMesh = makeMesh('afifon', 1.0);
    }
    if (def.boost) addBoost(rec, def.boost.dur, def.boost.power);
  }

  function addBoost(rec, dur, power) {
    const r = rec.ref;
    let taken = false;
    try { if (typeof r.addBoost === 'function') { r.addBoost(dur, power, 'item'); taken = true; } } catch (e) { taken = false; }
    rec.fx.boostTime = Math.max(rec.fx.boostTime, dur);
    rec.fx.boostPower = Math.max(rec.fx.boostPower, power);
    rec.fx.boostExternal = taken;
  }

  /** The racer immediately ahead of `rec` on the road, or null if it is already leading. */
  function nextAhead(rec) {
    let best = null, bd = Infinity;
    for (const o of list) {
      if (o === rec) continue;
      const d = o.progress - rec.progress;
      if (d > 0 && d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function leaderRec() {
    let best = null;
    for (const o of list) if (!best || o.progress > best.progress) best = o;
    return best;
  }

  /* ------------------------------------------------------------ stepping */

  function stepProjectile(p, dt) {
    p.age += dt;
    if (p.grace > 0) p.grace -= dt;
    const def = ITEMS[p.item] || {};

    if (p.kind === 'orbit') {
      const rec = p.owner;
      if (!rec) { killProjectile(p, false); return; }
      p.orbitA = (p.orbitA ?? 0) + O.orbitRate * dt;
      const a = p.orbitA + (p.slot ?? 0) * TAU / Math.max(1, p.slots ?? 3);
      const r = O.orbitRadius;
      p.pos.x = rec.pos.x + Math.sin(rec.yaw + a) * r;
      p.pos.z = rec.pos.z + Math.cos(rec.yaw + a) * r;
      p.pos.y = rec.pos.y + 0.55 + Math.sin(p.age * 3 + (p.slot ?? 0)) * 0.06;
      p.gy = sample(rec.s).pos.y;
      return;
    }

    if (p.kind === 'trailing') {
      const rec = p.owner;
      if (!rec) { killProjectile(p, false); return; }
      const f = { x: Math.sin(rec.yaw), z: Math.cos(rec.yaw) };
      const tx = rec.pos.x - f.x * O.shieldOffset, tz = rec.pos.z - f.z * O.shieldOffset;
      p.pos.x = damp(p.pos.x, tx, 12, dt);
      p.pos.z = damp(p.pos.z, tz, 12, dt);
      p.pos.y = damp(p.pos.y, rec.pos.y + 0.45, 10, dt);
      p.gy = sample(rec.s).pos.y;
      p.yaw = rec.yaw;
      return;
    }

    if (p.kind === 'homing') {
      const tgt = p.target && list.includes(p.target) ? p.target : null;
      p.s += p.speed * p.dir * dt;
      const targetLat = tgt ? tgt.lateral : p.lateral * 0.9;
      p.lateral = damp(p.lateral, clamp(targetLat, -14, 14), 2.6, dt);
      const sm = sample(p.s);
      p.pos.x = sm.pos.x + sm.normal.x * p.lateral;
      p.pos.z = sm.pos.z + sm.normal.z * p.lateral;
      p.pos.y = sm.pos.y + p.hover + Math.sin(p.age * 7) * 0.12;
      p.gy = sm.pos.y;
      p.yaw = Math.atan2(sm.tangent.x * p.dir, sm.tangent.z * p.dir);
      if (tgt) {
        const gap = dS(tgt.s, p.s) * p.dir;
        if (gap < -6 && p.age > 0.6) { p.target = null; }   // overshot: it flies on and expires
      }
      return;
    }

    if (p.kind === 'hunter') {
      const leader = leaderRec();
      p.target = leader;
      if (!leader) { killProjectile(p); return; }
      const gap = dS(leader.progress % len, p.s);
      if (p.phase === 'cruise') {
        p.s += p.speed * dt;
        p.lateral = damp(p.lateral, leader.lateral, 1.5, dt);
        const sm = sample(p.s);
        p.pos.x = sm.pos.x + sm.normal.x * p.lateral;
        p.pos.z = sm.pos.z + sm.normal.z * p.lateral;
        p.pos.y = sm.pos.y + p.hover;
        p.gy = sm.pos.y;
        const d = Math.hypot(p.pos.x - leader.pos.x, p.pos.z - leader.pos.z);
        if (d < 11 || (gap < 3 && gap > -30)) { p.phase = 'strike'; p.strikeT = 0; }
      } else {
        p.strikeT += dt;
        p.pos.x = damp(p.pos.x, leader.pos.x, 6, dt);
        p.pos.z = damp(p.pos.z, leader.pos.z, 6, dt);
        p.pos.y = damp(p.pos.y, leader.pos.y + 1.2, 3.2, dt);
        p.gy = sample(leader.s).pos.y;
        if (p.strikeT > 1.3) {
          applyHit(leader, 'stall', p.owner, 'catnap', p.pos);
          for (const o of list) {
            if (o === leader) continue;
            const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
            if (d < ITEMS.catnap.radius) applyHit(o, 'slip', p.owner, 'catnap', o.pos);
          }
          killProjectile(p);
        }
      }
      return;
    }

    if (p.kind === 'devil') {
      p.s += p.speed * dt;
      p.wander += dt * 1.6;
      p.lateral = clamp(Math.sin(p.wander) * 3.0, -4.5, 4.5);
      const sm = sample(p.s);
      p.pos.x = sm.pos.x + sm.normal.x * p.lateral;
      p.pos.z = sm.pos.z + sm.normal.z * p.lateral;
      p.pos.y = sm.pos.y;
      p.gy = sm.pos.y;
      return;
    }

    // 'shot': runs along the road and bounces off the verges
    p.s += p.speed * p.dir * dt;
    const sm = sample(p.s);
    p.lateral += (p.latVel ?? 0) * dt;
    const halfW = (sm.width ?? 12) * 0.5 - 0.4;
    if (p.lateral > halfW) { p.lateral = halfW; p.latVel = -Math.abs(p.latVel ?? 2) - 1.5; p.bounces = (p.bounces ?? 0) + 1; }
    if (p.lateral < -halfW) { p.lateral = -halfW; p.latVel = Math.abs(p.latVel ?? 2) + 1.5; p.bounces = (p.bounces ?? 0) + 1; }
    p.pos.x = sm.pos.x + sm.normal.x * p.lateral;
    p.pos.z = sm.pos.z + sm.normal.z * p.lateral;
    p.pos.y = sm.pos.y + p.hover;
    p.gy = sm.pos.y;
    p.yaw = Math.atan2(sm.tangent.x * p.dir, sm.tangent.z * p.dir);
    if ((p.bounces ?? 0) > 4) killProjectile(p);
  }

  function projectileCollide(p) {
    if (p.dead || p.kind === 'orbit') return;
    for (const rec of list) {
      if (rec === p.owner && (p.grace > 0 || p.kind === 'trailing')) continue;
      const dx = rec.pos.x - p.pos.x, dz = rec.pos.z - p.pos.z, dy = rec.pos.y - p.pos.y;
      const rr = (p.radius ?? 1.6) + 0.55;
      if (dx * dx + dz * dz > rr * rr || Math.abs(dy) > 3.5) continue;
      const res = applyHit(rec, p.hit || 'spin', p.owner, p.item, p.pos, p.from);
      if (res !== 'immune' && !p.pierces) { killProjectile(p); return; }
      if (res === 'hit' && p.pierces) rec.fx.immune = Math.max(rec.fx.immune, 0.9);
    }
  }

  function stepHazard(h, dt) {
    h.age += dt;
    if (h.fuse != null) {
      h.fuse -= dt;
      if (h.fuse <= 0) {
        // the crate bursts into a fan of rolling oranges
        const n = nearest(h.pos);
        for (let i = 0; i < (h.scatter || 5); i++) {
          const spread = (i / Math.max(1, (h.scatter || 5) - 1) - 0.5) * 2;
          const sm = sample(n.s);
          const lat = clamp(n.lateral + spread * 4.4, -8, 8);
          spawnHazard({
            kind: 'orange', item: 'jaffa', visual: 'jaffa', scale: 0.85,
            pos: V(sm.pos.x + sm.normal.x * lat, sm.pos.y + 0.32, sm.pos.z + sm.normal.z * lat),
            radius: 1.25, life: 14, hit: 'spin', from: 'pardes', owner: h.owner, s: n.s, lateral: lat,
            roll: spread * 2.2, seed: (rand() * 1e6) | 0,
          });
        }
        killHazard(h, true);
        return;
      }
    }
    if (h.kind === 'orange' && h.s != null) {
      h.s += 2.5 * dt;
      h.lateral += (h.roll || 0) * dt;
      const sm = sample(h.s);
      h.pos.x = sm.pos.x + sm.normal.x * h.lateral;
      h.pos.z = sm.pos.z + sm.normal.z * h.lateral;
      h.pos.y = sm.pos.y + 0.30;
      h.roll = (h.roll || 0) * (1 - dt * 0.8);
    }
    if (h.age > h.life) { killHazard(h, false); return; }
    if (h.kind === 'hummus') h.radius = ITEMS.hummus.radius * lerp(0.55, 1, clamp(h.age / 0.5, 0, 1)) * lerp(1, 0.6, clamp((h.age - h.life * 0.6) / (h.life * 0.4), 0, 1));
    for (const rec of list) {
      if (rec === h.owner && h.age < 0.7) continue;
      const dx = rec.pos.x - h.pos.x, dz = rec.pos.z - h.pos.z;
      const rr = h.radius + 0.6;
      if (dx * dx + dz * dz > rr * rr || Math.abs(rec.pos.y - h.pos.y) > 3.0) continue;
      const res = applyHit(rec, h.hit, h.owner, h.item, rec.pos, h.from);
      if (res !== 'immune' && h.kind !== 'hummus') { killHazard(h, true); return; }
      if (res === 'immune' && rec.fx.grow > 0 && h.kind !== 'hummus') { killHazard(h, true); return; }
    }
  }

  /** Invincible / mega racers knock other racers about on contact. */
  function contactDamage(rec) {
    const fx = rec.fx;
    const aggressive = fx.invincible > 0 || fx.grow > 0 || fx.autopilot > 0;
    if (!aggressive) return;
    const kind = fx.grow > 0 ? 'squash' : 'spin';
    for (const o of list) {
      if (o === rec) continue;
      if (o.fx.invincible > 0 || o.fx.autopilot > 0) continue;
      const dx = o.pos.x - rec.pos.x, dz = o.pos.z - rec.pos.z;
      const rr = 1.5 + (fx.grow > 0 ? 1.1 : 0);
      if (dx * dx + dz * dz > rr * rr) continue;
      applyHit(o, kind, rec, fx.grow > 0 ? 'avatiach' : (fx.autopilot > 0 ? 'duchifat' : 'hamsa'), o.pos);
    }
  }

  function stepEffects(rec, dt) {
    const fx = rec.fx;
    for (const k of ['spin', 'slip', 'squash', 'stall', 'blind', 'scramble', 'invincible', 'grow', 'glide', 'autopilot', 'immune', 'boostTime']) {
      if (fx[k] > 0) fx[k] = Math.max(0, fx[k] - dt);
    }
    if (fx.boostTime <= 0) fx.boostPower = 0;
    if (fx.spin > 0 || fx.slip > 0 || fx.stall > 0) fx.spinAngle = (fx.spinAngle + dt * (fx.stall > 0 ? 6 : 12)) % TAU;
    else fx.spinAngle = 0;
    fx.shake = damp(fx.shake, 0, 4, dt);
    const wantScale = fx.grow > 0 ? 1.55 : (fx.squash > 0 ? 0.55 : 1);
    fx.scale = damp(fx.scale, wantScale, 8, dt);
    if (fx.grow <= 0 && fx.squash <= 0 && Math.abs(fx.scale - 1) < 0.01) fx.scale = 1;
    if (fx.autopilot <= 0 && rec.rushBird) { dropMesh(rec.rushBird); rec.rushBird = null; fx.speedMul = 1; }
    if (fx.invincible <= 0 && fx.charmMesh) { dropMesh(fx.charmMesh); fx.charmMesh = null; fx.charm = false; }
    if (fx.glide <= 0 && fx.kiteMesh) { dropMesh(fx.kiteMesh); fx.kiteMesh = null; }
    if (fx.hitKind && fx.spin <= 0 && fx.slip <= 0 && fx.stall <= 0 && fx.squash <= 0 && fx.blind <= 0) fx.hitKind = null;
  }

  /** Combined longitudinal speed multiplier from every active effect. */
  function speedMultiplier(racer) {
    const rec = racer && recs.get(racer);
    if (!rec) return 1;
    const fx = rec.fx;
    let m = 1;
    if (fx.stall > 0) m = Math.min(m, REACTIONS.stall.mul);
    if (fx.spin > 0) m = Math.min(m, REACTIONS.spin.mul);
    if (fx.slip > 0) m = Math.min(m, REACTIONS.slip.mul);
    if (fx.squash > 0) m = Math.min(m, REACTIONS.squash.mul);
    if (fx.blind > 0) m *= REACTIONS.blind.mul;
    if (fx.autopilot > 0) m = Math.max(m, fx.speedMul || 1.55);
    if (fx.grow > 0) m *= 1.06;
    if (!fx.boostExternal && fx.boostTime > 0) m *= 1 + fx.boostPower;
    return m;
  }

  /* --------------------------------------------------------- roulette/HUD */
  const ROULETTE_ORDER = ITEM_IDS.slice();
  function stepRoulette(rec, dt) {
    if (!rec.pending) return;
    rec.pending.t += dt;
    const k = rec.pending.t / rec.pending.dur;
    if (k < 1) {
      const speed = lerp(22, 5, k * k);
      rec.roulette.t += dt * speed;
      rec.roulette.face = ROULETTE_ORDER[Math.floor(rec.roulette.t) % ROULETTE_ORDER.length];
    } else {
      rec.item = rec.pending.id;
      rec.count = ITEMS[rec.item]?.count ?? 1;
      rec.roulette = null;
      rec.pending = null;
      spawnOrbiters(rec);
      emit({ type: 'ready', victim: rec.ref, victimRec: rec, item: rec.item, count: rec.count });
    }
  }

  function spawnOrbiters(rec) {
    const def = ITEMS[rec.item];
    if (!def || !def.orbit || def.orbit < 2) return;
    releaseOrbiters(rec);
    for (let i = 0; i < def.orbit; i++) {
      const p = spawnProjectile({
        item: def.fires || def.id, from: def.id, kind: 'orbit', owner: rec, slot: i, slots: def.orbit,
        pos: V(rec.pos.x, rec.pos.y + 0.55, rec.pos.z), s: rec.s, lateral: rec.lateral,
        radius: def.radius ?? 1.2, hit: def.hit || 'spin', life: 999, hover: 0.55,
        // No ribbon on an orbiter. A trail is built for a projectile travelling in a straight
        // line; on a fruit swinging round the kart it degenerates into a tapering cone hanging
        // off the fruit toward the stale tail of the buffer, which is exactly what it drew when
        // this was tried. The orbit reads from the ground blob and the bloom instead.
        trail: false, shadowRadius: 0.30, scale: 0.7, orbitA: i * 0.1, grace: 999,
      });
      rec.orbiters.push(p);
    }
  }

  /* ------------------------------------------------------------- visuals */
  function boxVisual(box, dt) {
    if (!box.mesh) return;
    const m = box.mesh;
    m.visible = box.active || box.timer > O.boxRespawn * 0.72;
    const t = elapsed + box.phase;
    m.rotation.set(0.42, t * 0.9 + 0.6, 0.30);
    m.position.set(box.base.x, box.base.y + Math.sin(t * 1.6) * 0.22, box.base.z);
    const grow = box.active ? 1 : clamp((box.timer - O.boxRespawn * 0.72) / (O.boxRespawn * 0.28), 0, 1);
    m.scale.setScalar(box.active ? 1 + Math.sin(t * 3.1) * 0.03 : grow);
    const u = m.userData;
    if (u?.shellMat) {
      u.shellMat.iridescenceThicknessRange[1] = 420 + Math.sin(t * 1.1) * 300;
      u.shellMat.needsUpdate = false;
      u.shellMat.emissiveIntensity = 0.30 + Math.sin(t * 2.4) * 0.10;
    }
    if (u?.core) { u.core.rotation.y = -t * 1.9; u.core.rotation.z = t * 1.1; u.core.scale.setScalar(0.85 + Math.sin(t * 4) * 0.12); }
    if (u?.halo) u.halo.material.opacity = (box.active ? 0.38 : 0.15) + Math.sin(t * 2.7) * 0.08;
  }

  function projectileVisual(p, dt) {
    if (!p.mesh) return;
    p.mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    const u = p.mesh.userData || {};
    if (p.kind === 'devil') {
      placeShadow(p);
      if (u.shells) for (const s of u.shells) s.rotation.y += (s.userData.spin || 2) * dt;
      if (u.grit && u.gritData) {
        const m4 = new THREE.Matrix4();
        for (let i = 0; i < u.gritData.length; i++) {
          const g = u.gritData[i];
          g.a += g.sp * dt;
          m4.makeTranslation(Math.cos(g.a) * g.rad, g.y, Math.sin(g.a) * g.rad);
          u.grit.setMatrixAt(i, m4);
        }
        u.grit.instanceMatrix.needsUpdate = true;
      }
      return;
    }
    if (p.kind === 'trailing' || p.kind === 'orbit') {
      p.mesh.rotation.y = (p.yaw ?? 0) + p.age * (p.kind === 'orbit' ? 3.0 : 0.6);
      p.mesh.rotation.z = Math.sin(p.age * 2.2) * 0.10;
    } else if (p.item === 'sabra') {
      p.mesh.rotation.set(Math.sin(p.age * 9) * 0.2, (p.yaw ?? 0), p.age * 7);
    } else if (p.item === 'catnap') {
      p.mesh.rotation.y = p.age * 0.7;
      p.mesh.position.y += Math.sin(p.age * 2.4) * 0.25;
    } else {
      p.mesh.rotation.set(p.age * 6.5, (p.yaw ?? 0), p.age * 3.1);
    }
    if (p.trailFx) { p.trailFx.push(p.pos); p.trailFx.update(dt); }
    placeShadow(p);
  }

  function hazardVisual(h, dt) {
    if (!h.mesh) return;
    h.mesh.position.set(h.pos.x, h.pos.y, h.pos.z);
    if (h.kind === 'orange') h.mesh.rotation.x -= dt * 5;
    if (h.kind === 'crate') h.mesh.rotation.y += dt * 0.6;
    if (h.kind === 'hummus') {
      const fade = clamp((h.life - h.age) / 2.5, 0, 1);
      const m = h.mesh.userData?.mat;
      if (m) { m.opacity = 0.97 * fade; m.transparent = true; }
      h.mesh.scale.setScalar(clamp(h.age / 0.25, 0.2, 1));
    }
  }

  function racerVisual(rec, dt) {
    const fx = rec.fx;
    if (fx.charmMesh) {
      fx.charmMesh.visible = fx.invincible > 0;
      fx.charmMesh.position.set(rec.pos.x, rec.pos.y + 1.65 + Math.sin(elapsed * 2.4) * 0.1, rec.pos.z);
      fx.charmMesh.rotation.y = elapsed * 2.6;
      const halo = fx.charmMesh.userData?.halo;
      if (halo) halo.material.opacity = 0.4 + Math.sin(elapsed * 8) * 0.18;
    }
    if (fx.kiteMesh) {
      fx.kiteMesh.visible = fx.glide > 0;
      const f = { x: Math.sin(rec.yaw), z: Math.cos(rec.yaw) };
      fx.kiteMesh.position.set(rec.pos.x - f.x * 0.4, rec.pos.y + 2.1, rec.pos.z - f.z * 0.4);
      fx.kiteMesh.rotation.set(-0.5, rec.yaw, Math.sin(elapsed * 3) * 0.14);
    }
    if (rec.rushBird) {
      rec.rushBird.visible = fx.autopilot > 0;
      const f = { x: Math.sin(rec.yaw), z: Math.cos(rec.yaw) };
      rec.rushBird.position.set(rec.pos.x + f.x * 1.1, rec.pos.y + 1.5 + Math.sin(elapsed * 6) * 0.12, rec.pos.z + f.z * 1.1);
      rec.rushBird.rotation.set(0.12, rec.yaw, Math.sin(elapsed * 9) * 0.2);
    }
  }

  /* ---------------------------------------------------------------- update */
  function update(dt, racers) {
    dt = clamp(dt || 0, 0, 0.1);
    elapsed += dt;
    if (racers && racers.length) {
      list = racers.map((r, i) => record(r, i));
    }
    for (const rec of list) syncRacer(rec, dt);
    computePlaces();

    for (const rec of list) {
      stepRoulette(rec, dt);
      stepEffects(rec, dt);
      contactDamage(rec);
    }

    for (const b of boxes) {
      if (!b.active) {
        b.timer += dt;
        if (b.timer >= O.boxRespawn) { b.active = true; b.timer = 0; }
      } else {
        for (const rec of list) {
          const dx = rec.pos.x - b.pos.x, dz = rec.pos.z - b.pos.z, dy = rec.pos.y - b.pos.y;
          if (dx * dx + dz * dz > O.pickupRadius * O.pickupRadius || Math.abs(dy) > 3.2) continue;
          if (rec.item || rec.pending) continue;
          giveItem(rec.ref);
          b.active = false; b.timer = 0;
          burst(b.pos, 0xffd27a);
          break;
        }
      }
      boxVisual(b, dt);
    }

    for (const p of projectiles.slice()) {
      stepProjectile(p, dt);
      if (p.dead) continue;
      if (p.kind !== 'orbit' && p.kind !== 'trailing' && p.age > p.life) { killProjectile(p); continue; }
      projectileCollide(p);
      if (!p.dead) projectileVisual(p, dt);
    }
    for (const h of hazards.slice()) {
      stepHazard(h, dt);
      if (!h.dead) hazardVisual(h, dt);
    }
    for (const b of bursts) b.update(dt);
    for (const rec of list) racerVisual(rec, dt);
  }

  /* -------------------------------------------------------------- the API */
  const api = {
    object3D: root,
    track: trk,
    boxes, projectiles, hazards,
    ITEMS, ODDS,
    update,
    giveItem,
    useItem,
    /** Force a specific item into a racer's slot (debug / preview / tests). */
    setItem(racer, id) {
      const rec = recs.get(racer) || record(racer, list.length);
      rec.item = ITEMS[id] ? id : null;
      rec.count = ITEMS[id]?.count ?? 0;
      rec.pending = null; rec.roulette = null;
      if (rec.item) spawnOrbiters(rec);
      return rec.item;
    },
    onHit(cb) { hitCbs.push(cb); return () => { const i = hitCbs.indexOf(cb); if (i >= 0) hitCbs.splice(i, 1); }; },
    effects(racer) { return recs.get(racer)?.fx ?? null; },
    speedMultiplier,
    /** Steering scramble while blinded by the khamsin: feed this into the input mixer. */
    steerBias(racer) {
      const fx = recs.get(racer)?.fx;
      if (!fx || fx.scramble <= 0) return 0;
      return Math.sin(elapsed * 5.5 + (recs.get(racer)?.seed ?? 0)) * 0.55;
    },
    hud(racer) {
      const rec = recs.get(racer);
      if (!rec) return { item: null, count: 0, rouletteFace: null, spinning: false };
      return {
        item: rec.item, count: rec.count, place: rec.place,
        rouletteFace: rec.roulette?.face ?? null, spinning: !!rec.pending,
        name: rec.item ? ITEMS[rec.item].name : (rec.roulette ? ITEMS[rec.roulette.face]?.name : null),
        color: rec.item ? ITEMS[rec.item].color : (rec.roulette ? ITEMS[rec.roulette.face]?.color : 0xffffff),
        shield: !!(rec.shieldProj || rec.orbiters.length),
      };
    },
    record(racer) { return recs.get(racer) ?? null; },
    get racers() { return list; },
    odds: itemOdds,
    reset() {
      for (const p of projectiles.slice()) killProjectile(p, false);
      for (const h of hazards.slice()) killHazard(h, false);
      for (const b of boxes) { b.active = true; b.timer = 0; }
      for (const rec of recs.values()) {
        rec.item = null; rec.count = 0; rec.pending = null; rec.roulette = null;
        rec.orbiters.length = 0; rec.shieldProj = null;
        Object.assign(rec.fx, newFx());
        rec.prevS = null; rec.progress = 0; rec.hits = 0; rec.given = 0; rec.used = 0; rec.history.length = 0;
      }
      elapsed = 0;
    },
    dispose() {
      api.reset();
      root.parent?.remove(root);
      root.traverse(o => { if (o.isMesh) o.geometry?.dispose?.(); });
    },
  };
  return api;
}

export default createItemSystem;
