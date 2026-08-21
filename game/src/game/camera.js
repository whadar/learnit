/**
 * Kat Racing — the race camera.
 *
 * One rig, five modes:
 *
 *   chase    spring-damped follow behind the player's kart. FOV opens with speed and boost,
 *            the rig leans and swings *into* a drift so you can see the apex you are sliding
 *            towards, hops compress and landings kick, and holding look-back swings it round
 *            the nose without losing the spring.
 *   intro    a three-shot cinematic fly-through of the village that lands behind the grid.
 *   results  slow orbit of the winner.
 *   fixed    a static pos/look/fov (the screenshot harness's cinematic plates).
 *   photo    free flight — WASD/arrows + look, for review agents and screenshots.
 *
 *   import { createCamera } from './game/camera.js';
 *   const cam = createCamera(engine, world, { track });
 *   cam.setTarget(race.player.vehicle);
 *   cam.update(dt, { phase: race.state.phase, phaseTime: race.state.phaseTime });
 *
 * The rig owns `engine.camera` and writes position/quaternion/fov every frame; nothing else
 * should touch the camera while a mode other than 'fixed' is active.
 */
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep, wrapPi } from '../core/mathx.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export const DEFAULTS = {
  /* chase geometry, metres */
  back: 6.30,             // distance behind the kart at rest
  backSpeed: 1.35,        // extra distance at top speed
  backBoost: 0.55,        // … and while boosting (the kart pulls away from the lens)
  height: 2.32,
  heightSpeed: 0.24,
  lookAhead: 8.5,
  lookHeight: 1.15,
  /* responsiveness */
  posFreq: 2.55,          // Hz of the position spring
  posDamping: 1.02,       // 1 = critically damped
  lookLambda: 8.5,        // exponential follow for the aim point
  yawLambda: 6.2,         // how fast the rig's heading catches the kart's
  yawLambdaDrift: 9.5,
  /* field of view */
  fov: 62,
  fovSpeed: 13.0,         // + degrees at top speed
  fovBoost: 8.5,          // + degrees at full boost
  fovAir: 3.0,
  fovLambda: 4.2,
  /* drift */
  driftYaw: 0.20,         // rad the rig turns INTO the corner at tier 0 …
  driftYawTier: 0.075,    // … plus this per mini-turbo tier
  driftSide: 1.35,        // metres the rig swings to the outside of the slide
  driftRoll: 0.055,       // rad of camera roll into the slide
  /* air / landing */
  airHeight: 1.30,
  airBack: 1.10,
  landKick: 0.42,
  hopLambda: 12.0,
  /* misc */
  lookBackTime: 0.16,     // seconds to swing round when look-back is held
  speedRef: 25.0,         // m/s that counts as "top speed" for the curves
  shakeDecay: 3.4,
  groundClear: 1.25,      // never film from inside the hillside
  near: 0.28, far: 6000,
};

/* ------------------------------------------------------------------ springs -- */

/** Critically-damped-ish vector spring, substepped so a 100 ms frame cannot explode it. */
function springStep(pos, vel, target, freq, damping, dt) {
  const steps = Math.min(6, Math.max(1, Math.ceil(dt / (1 / 90))));
  const h = dt / steps;
  const w = 2 * Math.PI * freq;
  const k = w * w, c = 2 * w * damping;
  for (let i = 0; i < steps; i++) {
    vel.x += ((target.x - pos.x) * k - vel.x * c) * h;
    vel.y += ((target.y - pos.y) * k - vel.y * c) * h;
    vel.z += ((target.z - pos.z) * k - vel.z * c) * h;
    pos.x += vel.x * h; pos.y += vel.y * h; pos.z += vel.z * h;
  }
}

/* ================================================================== factory == */

/**
 * @param {import('../core/engine.js').Engine} engine
 * @param {object} world  WorldData (used only to keep the lens above the ground)
 * @param {object} [opts] { track, ...DEFAULTS }
 */
export function createCamera(engine, world, opts = {}) {
  const O = Object.assign({}, DEFAULTS, opts);
  const camera = engine.camera;
  camera.near = O.near; camera.far = O.far;
  camera.fov = O.fov;
  camera.updateProjectionMatrix();

  let track = opts.track || null;
  let target = null;                     // a createVehicle() handle
  let mode = 'chase';

  /* ---- live rig state ---- */
  const pos = V(), posVel = V(), look = V(), desired = V(), aim = V();
  const up = V(0, 1, 0);
  const st = {
    yaw: 0, fov: O.fov, roll: 0, drift: 0, driftDir: 0, air: 0, hop: 0,
    speed: 0, boost: 0, lookBack: 0, shake: 0, shakeT: 0, first: true,
    height: 0, side: 0,
  };
  let elapsed = 0;

  /* ---- scratch ---- */
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const tmp = V(), tmp2 = V();

  /* ---- fixed-plate + photo state ---- */
  const fixed = { pos: [0, 40, 0], look: [0, 0, 0], fov: 55 };
  const photo = { pos: V(0, 40, 0), yaw: 0, pitch: -0.35, fov: 52, speed: 26 };

  /* ------------------------------------------------------------ helpers ---- */
  const groundY = (x, z) => {
    if (!world || !world.heightAt) return -Infinity;
    if (world.inBounds && !world.inBounds(x, z)) return -Infinity;
    return world.heightAt(x, z);
  };

  /** Lift `p` so the lens never ends up inside a hillside, sampling the sight line too. */
  function clearGround(p, aimPt) {
    let gy = groundY(p.x, p.z);
    if (aimPt) {
      for (let i = 1; i <= 4; i++) {
        const f = i / 5;
        const g = groundY(lerp(p.x, aimPt.x, f), lerp(p.z, aimPt.z, f)) - f * 0.35;
        if (g > gy) gy = g;
      }
    }
    if (Number.isFinite(gy) && p.y < gy + O.groundClear) p.y = gy + O.groundClear;
  }

  function applyLook(p, at, fov, roll = 0) {
    camera.position.copy(p);
    m.lookAt(p, at, up);
    q.setFromRotationMatrix(m);
    if (roll) {
      tmp.set(0, 0, 1).applyQuaternion(q);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(tmp, -roll));
    }
    camera.quaternion.copy(q);
    if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(true);
  }

  /* ------------------------------------------------------------- chase ----- */
  function chase(dt, ctx) {
    const v = target;
    if (!v) return;
    const s = v.state;
    const tf = v.getTransform ? v.getTransform() : null;
    const fwd = tf ? tf.forward : { x: Math.sin(s.yaw), y: 0, z: Math.cos(s.yaw) };

    const spdN = clamp(s.speed / O.speedRef, 0, 1.4);
    const boost = clamp(s.boost && s.boost.time > 0 ? 1 : 0, 0, 1);
    st.speed = damp(st.speed, spdN, 5, dt);
    st.boost = damp(st.boost, boost, boost > st.boost ? 12 : 3.2, dt);
    st.air = damp(st.air, s.grounded ? 0 : 1, s.grounded ? 5 : 9, dt);

    /* drift: which way, and how hard */
    const dActive = !!(s.drift && s.drift.active);
    const dir = dActive ? (s.drift.dir || 0) : 0;
    if (dir) st.driftDir = dir;
    const tier = s.drift ? (s.drift.tier || 0) : 0;
    st.drift = damp(st.drift, dActive ? 1 : 0, dActive ? 6.5 : 4.0, dt);

    /* look-back swings the whole rig round the nose */
    const wantBack = (ctx && ctx.lookBack != null ? ctx.lookBack : (s.look || 0)) < -0.5
      || (ctx && ctx.lookBack === true);
    st.lookBack = damp(st.lookBack, wantBack ? 1 : 0, 1 / Math.max(O.lookBackTime, 0.02), dt);

    /* --- heading: lag the kart, then lead INTO the corner while sliding --- */
    const kartYaw = Math.atan2(fwd.x, fwd.z);
    // While drifting the chassis points *away* from the direction of travel; following the
    // chassis would aim the lens at the outside of the corner. Following the velocity and then
    // leading it by the drift direction is what puts the apex in the middle of frame.
    let travelYaw = kartYaw;
    if (s.speed > 3.5) {
      const vy = Math.atan2(s.vel.x, s.vel.z);
      travelYaw = kartYaw + wrapPi(vy - kartYaw) * clamp(st.drift * 0.85 + 0.15, 0, 1);
    }
    const lead = st.driftDir * (O.driftYaw + O.driftYawTier * tier) * st.drift;
    const wantYaw = travelYaw + lead + Math.PI * st.lookBack;
    if (st.first) st.yaw = wantYaw;
    else {
      const lam = lerp(O.yawLambda, O.yawLambdaDrift, st.drift) * (1 + st.lookBack * 2.4);
      st.yaw += wrapPi(wantYaw - st.yaw) * clamp(1 - Math.exp(-lam * dt), 0, 1);
    }

    const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw);
    const dirX = sy, dirZ = cy;                    // rig forward on the ground plane
    const rgtX = cy, rgtZ = -sy;                   // rig right

    /* --- distances --- */
    const back = O.back + O.backSpeed * st.speed + O.backBoost * st.boost + O.airBack * st.air;
    const hgt = O.height + O.heightSpeed * st.speed + O.airHeight * st.air;
    const side = -st.driftDir * O.driftSide * st.drift * (1 - st.lookBack);
    st.side = damp(st.side, side, 7, dt);
    st.hop = damp(st.hop, 0, O.hopLambda, dt);
    if (s.landImpact > 0.05) st.hop = Math.max(st.hop, -clamp(s.landImpact, 0, 1) * O.landKick);

    desired.set(
      s.pos.x - dirX * back + rgtX * st.side,
      s.pos.y + hgt + st.hop,
      s.pos.z - dirZ * back + rgtZ * st.side,
    );

    /* --- aim point: ahead of the kart, biased into the corner --- */
    const ahead = O.lookAhead * (0.72 + 0.42 * st.speed);
    aim.set(
      s.pos.x + dirX * ahead * (1 - 2 * st.lookBack) + rgtX * st.side * 0.4,
      s.pos.y + O.lookHeight + st.air * 0.5,
      s.pos.z + dirZ * ahead * (1 - 2 * st.lookBack) + rgtZ * st.side * 0.4,
    );

    if (st.first) { pos.copy(desired); look.copy(aim); posVel.set(0, 0, 0); st.first = false; }
    else {
      springStep(pos, posVel, desired, O.posFreq * (1 + st.boost * 0.25), O.posDamping, dt);
      look.lerp(aim, clamp(1 - Math.exp(-O.lookLambda * dt), 0, 1));
    }
    clearGround(pos, look);

    /* --- fov + roll + shake --- */
    const wantFov = O.fov + O.fovSpeed * st.speed * st.speed + O.fovBoost * st.boost + O.fovAir * st.air;
    st.fov = damp(st.fov, wantFov, O.fovLambda, dt);
    const wantRoll = st.driftDir * O.driftRoll * st.drift + (s.roll || 0) * 0.18;
    st.roll = damp(st.roll, wantRoll, 6, dt);

    const impact = Math.max(s.wallImpact || 0, s.bumpImpact || 0, (s.landImpact || 0) * 0.6);
    if (impact > 0.08) st.shake = Math.min(1, Math.max(st.shake, impact * 0.55));
    st.shake = Math.max(0, st.shake - dt * O.shakeDecay);
    st.shakeT += dt;
    let px = pos.x, py = pos.y, pz = pos.z;
    if (st.shake > 0.002) {
      const a = st.shake * st.shake * 0.34;
      px += Math.sin(st.shakeT * 47.3) * a;
      py += Math.sin(st.shakeT * 39.1 + 1.7) * a * 0.8;
      pz += Math.sin(st.shakeT * 53.7 + 3.1) * a;
    }
    tmp2.set(px, py, pz);
    applyLook(tmp2, look, st.fov, st.roll);
  }

  /* ------------------------------------------------------------- intro ----- */
  /**
   * Three shots over the real village, cut on time, all of them ending pointed at the grid:
   *   0.00–0.38  high crane over the rooftops, drifting west down Rehov Rakefet
   *   0.38–0.72  low tracking pass along the start straight, kerb height
   *   0.72–1.00  crane down and settle into the chase position behind pole
   * `t` is seconds; `duration` the whole fly-through.
   */
  function introPose(t, duration = 7.0) {
    const k = clamp(t / Math.max(duration, 0.01), 0, 1);
    const startS = track ? (track.startS || 0) : 0;
    const len = track ? track.length : 1000;
    const sample = s => {
      if (!track) return { pos: V(0, 0, 0), tangent: V(0, 0, 1), normal: V(1, 0, 0) };
      try { return track.sample(((s % len) + len) % len); } catch (e) { return { pos: V(), tangent: V(0, 0, 1), normal: V(1, 0, 0) }; }
    };
    let p, at, fov;
    if (k < 0.38) {
      const u = smoothstep(0, 1, k / 0.38);
      const a = sample(startS + lerp(150, 40, u));
      const b = sample(startS + lerp(60, -6, u));
      p = V(a.pos.x + a.normal.x * lerp(52, 20, u), a.pos.y + lerp(64, 30, u), a.pos.z + a.normal.z * lerp(52, 20, u));
      at = V(b.pos.x, b.pos.y + 2, b.pos.z);
      fov = lerp(58, 50, u);
    } else if (k < 0.72) {
      const u = smoothstep(0, 1, (k - 0.38) / 0.34);
      const a = sample(startS + lerp(84, 12, u));
      const b = sample(startS + lerp(30, -14, u));
      p = V(a.pos.x + a.normal.x * lerp(-9.5, -6.0, u), a.pos.y + lerp(1.9, 2.6, u), a.pos.z + a.normal.z * lerp(-9.5, -6.0, u));
      at = V(b.pos.x, b.pos.y + 1.1, b.pos.z);
      fov = lerp(46, 54, u);
    } else {
      const u = smoothstep(0, 1, (k - 0.72) / 0.28);
      const a = sample(startS - lerp(34, 15.5, u));
      const b = sample(startS - lerp(4, 0, u) + 14);
      p = V(a.pos.x + a.normal.x * lerp(9, 0.4, u), a.pos.y + lerp(11.5, 3.1, u), a.pos.z + a.normal.z * lerp(9, 0.4, u));
      at = V(b.pos.x, b.pos.y + 1.25, b.pos.z);
      fov = lerp(52, 60, u);
    }
    clearGround(p, at);
    return { pos: p, look: at, fov };
  }

  function intro(dt, ctx) {
    const pose = introPose(ctx?.phaseTime ?? elapsed, ctx?.introTime ?? 7.0);
    // ease the rig onto the cut instead of teleporting: a small spring keeps the cuts snappy
    // but stops the very first frame of each shot from being a hard pop in the composite.
    if (st.first) { pos.copy(pose.pos); look.copy(pose.look); st.fov = pose.fov; st.first = false; }
    else {
      const jump = pos.distanceTo(pose.pos) > 22;      // a deliberate cut: take it whole
      if (jump) { pos.copy(pose.pos); look.copy(pose.look); posVel.set(0, 0, 0); }
      else {
        pos.lerp(pose.pos, clamp(1 - Math.exp(-16 * dt), 0, 1));
        look.lerp(pose.look, clamp(1 - Math.exp(-12 * dt), 0, 1));
      }
      st.fov = damp(st.fov, pose.fov, 8, dt);
    }
    applyLook(pos, look, st.fov, 0);
  }

  /* ----------------------------------------------------------- results ---- */
  function results(dt, ctx) {
    const v = ctx?.winner || target;
    const p = v ? (v.state ? v.state.pos : v) : { x: 0, y: 0, z: 0 };
    const a = (ctx?.phaseTime ?? elapsed) * 0.42 + 1.1;
    const r = 9.4;
    tmp.set(p.x + Math.cos(a) * r, p.y + 3.9, p.z + Math.sin(a) * r);
    tmp2.set(p.x, p.y + 1.15, p.z);
    clearGround(tmp, tmp2);
    pos.lerp(tmp, clamp(1 - Math.exp(-9 * dt), 0, 1));
    look.lerp(tmp2, clamp(1 - Math.exp(-9 * dt), 0, 1));
    st.fov = damp(st.fov, 47, 5, dt);
    applyLook(pos, look, st.fov, 0);
  }

  /* ------------------------------------------------------------- photo ---- */
  function photoUpdate(dt, ctx) {
    const inp = ctx?.photoInput || null;
    if (inp) {
      const boost = inp.fast ? 3.2 : 1;
      photo.yaw -= (inp.yaw || 0) * dt * 1.9;
      photo.pitch = clamp(photo.pitch - (inp.pitch || 0) * dt * 1.4, -1.45, 1.45);
      const cp = Math.cos(photo.pitch);
      const f = V(Math.sin(photo.yaw) * cp, Math.sin(photo.pitch), Math.cos(photo.yaw) * cp);
      const r = V(Math.cos(photo.yaw), 0, -Math.sin(photo.yaw));
      const sp = photo.speed * boost * dt;
      photo.pos.addScaledVector(f, (inp.forward || 0) * sp);
      photo.pos.addScaledVector(r, (inp.right || 0) * sp);
      photo.pos.y += (inp.up || 0) * sp;
      if (inp.fov) photo.fov = clamp(photo.fov + inp.fov * dt * 24, 18, 100);
    }
    const cp = Math.cos(photo.pitch);
    tmp.set(Math.sin(photo.yaw) * cp, Math.sin(photo.pitch), Math.cos(photo.yaw) * cp);
    tmp2.copy(photo.pos).add(tmp);
    applyLook(photo.pos, tmp2, photo.fov, 0);
    pos.copy(photo.pos); look.copy(tmp2); st.fov = photo.fov;
  }

  /* ------------------------------------------------------------- fixed ---- */
  function fixedUpdate() {
    tmp.set(fixed.pos[0], fixed.pos[1], fixed.pos[2]);
    tmp2.set(fixed.look[0], fixed.look[1], fixed.look[2]);
    pos.copy(tmp); look.copy(tmp2); st.fov = fixed.fov ?? 55;
    applyLook(tmp, tmp2, st.fov, 0);
  }

  /* -------------------------------------------------------------- api ----- */
  function update(dt, ctx = {}) {
    dt = clamp(dt || 0, 1 / 480, 0.1);
    elapsed += dt;
    switch (mode) {
      case 'intro': intro(dt, ctx); break;
      case 'results': results(dt, ctx); break;
      case 'photo': photoUpdate(dt, ctx); break;
      case 'fixed': fixedUpdate(); break;
      default: chase(dt, ctx); break;
    }
    return api;
  }

  const api = {
    camera, state: st,
    get mode() { return mode; },
    get position() { return camera.position; },
    setMode(m, { snap = false } = {}) {
      if (m === mode) return api;
      mode = m;
      if (snap) st.first = true;
      if (m === 'photo') {
        photo.pos.copy(camera.position);
        const d = new THREE.Vector3(); camera.getWorldDirection(d);
        photo.yaw = Math.atan2(d.x, d.z);
        photo.pitch = Math.asin(clamp(d.y, -1, 1));
        photo.fov = camera.fov;
      }
      return api;
    },
    setTarget(v) { if (v !== target) { target = v; st.first = true; } return api; },
    get target() { return target; },
    setTrack(t) { track = t; return api; },
    setFixed(p, l, f) { fixed.pos = p; fixed.look = l; fixed.fov = f ?? fixed.fov; mode = 'fixed'; fixedUpdate(); return api; },
    /** Jump the rig to where it wants to be, killing the spring (used after a teleport). */
    snap() { st.first = true; return api; },
    addShake(a) { st.shake = clamp(Math.max(st.shake, a), 0, 1); return api; },
    setLookBack(v) { st.lookBack = v ? 1 : 0; return api; },
    introPose,
    update,
    photoRig: photo,
    /** The rig's own pos/look/fov, for the harness's view dumps. */
    pose() { return { pos: [camera.position.x, camera.position.y, camera.position.z], look: [look.x, look.y, look.z], fov: camera.fov }; },
  };
  return api;
}

export default createCamera;
