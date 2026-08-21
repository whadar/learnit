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
  /* Chase geometry, metres.
     The whole point of a character kart racer is the character: the driver's head, shoulders,
     paws on the wheel and lean into a corner have to be legible in every gameplay frame, or
     the game may as well ship empty karts. The old rig sat 1.00 m over the centre of mass —
     about 1.56 m over the road, which is the height of the seat back — so the seat ate the
     cat and all that cleared it was a helmet band and two ear tips. The lens now sits
     ~2.2 m up and looks *down* the road rather than along it, which is where MK8 puts it:
     the kart fills the bottom third, the driver reads against the tarmac, and you can still
     see far enough ahead to place the kart for the next corner. */
  back: 3.50,             // distance behind the kart's centre of mass at rest
  backSpeed: 0.60,        // extra distance at top speed
  backBoost: 0.45,        // … and while boosting (the kart pulls away from the lens)
  height: 1.80,           // above the CoM, which is itself ~0.56 m above the road
  heightSpeed: 0.20,
  lookAhead: 5.9,
  lookHeight: 0.20,       // aim past the driver's ears at the road, not over the scenery
  /* responsiveness */
  posFreq: 2.90,          // Hz of the position spring
  posDamping: 1.02,       // 1 = critically damped
  lookLambda: 9.0,        // exponential follow for the aim point
  yawLambda: 7.0,         // how fast the rig's heading catches the kart's
  yawLambdaDrift: 10.0,
  /* field of view */
  fov: 51,
  fovSpeed: 8.0,          // + degrees at top speed
  fovBoost: 12.0,         // + degrees at full boost — the boost punch you feel in the lens
  fovAir: 3.0,
  fovLambda: 5.4,
  /* drift */
  driftYaw: 0.19,         // rad the rig turns INTO the corner at tier 0 …
  driftYawTier: 0.070,    // … plus this per mini-turbo tier
  driftSide: 0.95,        // metres the rig swings to the outside of the slide
  driftRoll: 0.050,       // rad of camera roll into the slide
  /* air / landing */
  airHeight: 1.00,
  airBack: 0.80,
  landKick: 0.34,
  hopLambda: 12.0,
  /* rivals in the lens */
  kartClear: 4.6,         // a rival this close to the eye backs the rig off and lifts it …
  kartLift: 0.80,         // … by up to this much, instead of being sliced open by the frame
  kartBack: 1.15,
  /* item boxes in the lens — see nearProps() */
  boxClear: 7.6,          // an item box within this of the kart gets the rig out of its way
  boxFull: 3.0,           // … at full strength once it is this close
  boxLift: 2.55,          // metres the eye climbs over the row
  boxBack: 3.70,          // … and metres it drops back, so the row swings out to the edges
  boxSpan: 2.6,           // vertical half-window: only boxes on the kart's own deck count
  /* fixed cinematic plates: keeping the subject legible — see plateFov() */
  plateFill: 0.170,       // fraction of frame height a head-on subject should occupy
  plateSubjH: 1.55,       // metres of kart + driver that has to fill it
  plateFovMin: 26,        // never squeeze the lens past this
  plateNear: 8,           // subjects nearer than this are already big enough
  plateFar: 45,           // … and beyond this a plate is a landscape, not a portrait
  plateClosing: 6.0,      // m/s the field must be closing on the lens to count as head-on
  /* misc */
  lookBackTime: 0.16,     // seconds to swing round when look-back is held
  speedRef: 25.0,         // m/s that counts as "top speed" for the curves
  shakeDecay: 3.4,
  groundClear: 1.05,      // never film from inside the hillside
  near: 0.22, far: 6000,
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
    height: 0, side: 0, kartLift: 0, boxNear: 0,
  };
  let elapsed = 0;

  /* ---- scratch ---- */
  const q = new THREE.Quaternion();
  const qRoll = new THREE.Quaternion();
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

  /**
   * Ride over a rival that has climbed into the lens.
   *
   * The rig sits a bare 3.9 m behind the kart, so a rival drafting the player passes within
   * arm's length of the eye and the frame cuts it open — bodywork and half a cat pasted over
   * the HUD, which is what the review caught in villageStreet. Rather than shove the rig
   * (which fights the spring and swings the whole shot), the eye lifts over the intruder and
   * settles straight back down: a pass close enough to touch reads as a pass, not a glitch.
   */
  function rivalNear(v, dt) {
    let want = 0;
    const rivals = v && v.rivals;
    if (rivals && rivals.length) {
      for (const o of rivals) {
        const s = o && (o.state || (o.vehicle && o.vehicle.state));
        if (!s || !s.pos) continue;
        if (Math.abs(s.pos.y - pos.y) > 3.5) continue;
        const dx = s.pos.x - pos.x, dz = s.pos.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d >= O.kartClear) continue;
        const w = 1 - d / O.kartClear;
        if (w > want) want = w;
      }
    }
    st.kartLift = damp(st.kartLift, want, want > st.kartLift ? 9 : 3.5, dt);
    return st.kartLift;
  }

  /* ---- near-field props: the item-box rows ---------------------------------- */

  /**
   * Item boxes are 1.5 m cubes floating at windscreen height, and the rig rides barely 2.3 m
   * over the tarmac, so driving through a box row put two of them *inside* the near volume —
   * a metre and a half off the lens, flanking the player, filling the bottom half of the frame
   * and burying the kart behind them (review R2, itemChaos).
   *
   * Two objects at the same depth cannot be separated by moving the lens, so the rig does the
   * only thing that works: it climbs over the row and drops back off it. Higher puts the line
   * of sight to the driver's head *above* the box tops; further back drops the boxes to half
   * the subject's depth, which throws them out towards the frame edges at twice the parallax.
   * Both decay away the moment the row is behind you, so the ordinary road is filmed from the
   * ordinary place.
   *
   * Each box is measured from whichever is nearer, the kart or the lens. The kart's distance
   * is what gives the move its anticipation — the rig is already up when the row arrives
   * instead of reacting to a box that is by then filling the frame — and the lens's distance
   * is what holds it there, because the kart clears the row a good four metres before the eye
   * trailing it does. Measuring at the lens alone would also fight itself, the move it
   * triggers being the move that ends it.
   *
   * The box list is found once and cached: they are direct children of the items root, which
   * carries no transform, so `o.position` is already world space and no matrix walk is needed.
   */
  let boxCache = null, boxScan = -1e9, boxScans = 0;
  function nearProps(kart, dt) {
    if ((!boxCache || !boxCache.length) && boxScans < 6 && elapsed - boxScan > 1.5) {
      // items.js builds its boxes after the rig exists; look a few times, then give up
      // rather than walk the whole scene graph forever on a course that has none.
      boxScan = elapsed; boxScans++;
      boxCache = [];
      const scene = engine && engine.scene;
      if (scene && scene.traverse) scene.traverse(o => { if (o.name === 'itembox') boxCache.push(o); });
    }
    let want = 0;
    const list = boxCache;
    if (list) {
      const fade = Math.max(O.boxClear - O.boxFull, 0.5);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.visible === false) continue;
        const p = o.position;
        if (Math.abs(p.y - kart.y) > O.boxSpan && Math.abs(p.y - pos.y) > O.boxSpan + 2) continue;
        const kx = p.x - kart.x, kz = p.z - kart.z;
        const ex = p.x - pos.x, ez = p.z - pos.z;
        const d2 = Math.min(kx * kx + kz * kz, ex * ex + ez * ez);
        if (d2 >= O.boxClear * O.boxClear) continue;
        const w = clamp((O.boxClear - Math.sqrt(d2)) / fade, 0, 1);
        if (w > want) want = w;
      }
    }
    st.boxNear = damp(st.boxNear, want, want > st.boxNear ? 8 : 2.4, dt);
    return st.boxNear;
  }

  function applyLook(p, at, fov, roll = 0) {
    camera.position.copy(p);
    m.lookAt(p, at, up);
    q.setFromRotationMatrix(m);
    if (roll) {
      tmp.set(0, 0, 1).applyQuaternion(q);
      q.premultiply(qRoll.setFromAxisAngle(tmp, -roll));
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
    // Scale with the boost's *power* (0.18 mini-turbo … 0.37 tier-3 / pad) so a big boost
    // opens the lens visibly further than a scrappy little one.
    const boost = s.boost && s.boost.time > 0 ? clamp(s.boost.power / 0.30, 0.5, 1.3) : 0;
    st.speed = damp(st.speed, spdN, 5, dt);
    st.boost = damp(st.boost, boost, boost > st.boost ? 14 : 3.0, dt);
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
    // A rival inside the rig's own volume gets the lens out of its way first: back off and lift
    // over it, so a pass close enough to touch is a pass in frame and not a sliced-open kart
    // pasted across the HUD.
    const near = rivalNear(v, dt);
    const clutter = nearProps(s.pos, dt);
    const back = O.back + O.backSpeed * st.speed + O.backBoost * st.boost + O.airBack * st.air
      + near * O.kartBack + clutter * O.boxBack;
    const hgt = O.height + O.heightSpeed * st.speed + O.airHeight * st.air + near * O.kartLift
      + clutter * O.boxLift;
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
      // …and lands exactly on the chase rig's resting pose behind pole, so the cut to
      // gameplay at the end of the countdown is invisible: same height, boom and lens.
      const u = smoothstep(0, 1, (k - 0.72) / 0.28);
      const a = sample(startS - lerp(38, 18.4, u));
      const b = sample(startS + lerp(26, -11.6, u));
      // 2.18 m over the tarmac and a 51.5-degree lens is exactly where the chase rig rests
      // (CoM 0.56 m up + O.height 1.62), so the hand-off is a dissolve, not a jump.
      p = V(a.pos.x + a.normal.x * lerp(9, 0.25, u), a.pos.y + lerp(12.0, 2.18, u), a.pos.z + a.normal.z * lerp(9, 0.25, u));
      at = V(b.pos.x, b.pos.y + lerp(1.6, 0.84, u), b.pos.z);
      fov = lerp(50, 51.5, u);
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

  /**
   * Camera collision for a cinematic plate.
   *
   * A hand-placed plate knows the tarmac but not the ironmongery standing on it: aim a lens
   * down the start straight and it can end up inside a gantry leg, a pit-wall hoarding or a
   * tyre stack, which is exactly what the review caught under the start/finish gate. So
   * before a fixed plate is committed, the sight line is swept back from the *subject* to the
   * eye: whatever solid trackside furniture it meets first, the lens is planted just in front
   * of it. Resolved once per `setFixed()` — the pose does not move afterwards — so the ray
   * never costs a frame.
   */
  const _ray = new THREE.Raycaster();
  let blockers = null;
  function cameraBlockers() {
    if (blockers && blockers.length) return blockers;
    blockers = [];
    const scene = engine && engine.scene;
    if (!scene || !scene.traverse) return blockers;
    scene.traverse(o => {
      // trackside furniture and the pit-wall boards; never the road surface, the kerbs, the
      // paint or the karts, which a camera is entitled to look straight through.
      if (o.isMesh && typeof o.name === 'string' && o.name.startsWith('furniture:')
        && !/bunting|flags|foliage|cats/.test(o.name)) blockers.push(o);
    });
    return blockers;
  }

  const CLEAR = 0.55;               // metres of air kept between the lens and a solid
  const NEARVOL = 3.2;              // the eye's own near volume: a solid in here is a clip
  function resolveFixed(p, at) {
    clearGround(p, at);
    // a crane shot is above everything trackside; don't pay for a ray it cannot hit
    const gy = groundY(p.x, p.z);
    if (Number.isFinite(gy) && p.y > gy + 11) return p;
    const list = cameraBlockers();
    if (!list.length) return p;
    tmp.subVectors(p, at);
    const dist = tmp.length();
    if (dist < 0.4) return p;
    tmp.multiplyScalar(1 / dist);
    _ray.set(at, tmp);                       // from the subject out towards the lens
    _ray.near = 0.05; _ray.far = dist;
    let hits = null;
    try { hits = _ray.intersectObjects(list, false); } catch (e) { hits = null; }
    if (hits && hits.length) {
      // Only ironmongery *in the eye's own near volume* is a fault. A gantry leg or a
      // hoarding halfway down the sight line is composition, not a clip, and the old rule —
      // which planted the lens in front of the first hit whatever its distance — would haul
      // a plate authored 15 m past the line back under the gantry it was framing, taking the
      // subject with it. So take the first hit *inside* that volume — the face the lens has
      // buried itself behind — and step back out in front of it, never past half the shot.
      let t = -1;
      for (const h of hits) if (h.distance > dist - NEARVOL && h.distance < dist - 0.02) { t = h.distance; break; }
      if (t > 0) p.copy(at).addScaledVector(tmp, Math.max(t - CLEAR, dist * 0.55));
    }
    clearGround(p, at);
    return p;
  }

  /**
   * Keep a head-on plate's subject legible.
   *
   * A hand-placed plate carries a focal length chosen by eye, and on a plate the field is
   * *driving at* — a finish-line shot — a wide lens turns the thing the frame is about into
   * forty pixels of kart under a lot of scenery, with whatever ironmongery stands between
   * cropping the borders. So a plate the karts are closing on is treated as a portrait: the
   * lens tightens until the leader fills `plateFill` of the frame height, which both makes
   * the driver read and throws the near trackside metal outside the frame entirely.
   *
   * Plates the field is standing still on (a grid), driving away from, or nowhere near are
   * left exactly as authored — closing speed is what separates a head-on shot from a wide.
   */
  const _axis = V(), _sub = V();
  function plateFov(eye, at, fov) {
    if (!target || !target.state) return fov;
    _axis.subVectors(at, eye);
    const dist = _axis.length();
    if (dist < 0.5) return fov;
    _axis.multiplyScalar(1 / dist);                     // view axis
    const half = THREE.MathUtils.degToRad(fov) * 0.5;
    const aspect = camera.aspect || (16 / 9);
    const coneH = Math.atan(Math.tan(half) * aspect);   // ~half the frame's diagonal spread
    let best = Infinity;
    const consider = s => {
      if (!s || !s.pos || !s.vel) return;
      _sub.set(s.pos.x - eye.x, s.pos.y + 0.55 - eye.y, s.pos.z - eye.z);
      const d = _sub.length();
      if (d < O.plateNear || d > O.plateFar || d >= best) return;
      _sub.multiplyScalar(1 / d);
      if (Math.acos(clamp(_sub.dot(_axis), -1, 1)) > coneH) return;    // outside the frame
      // closing on the lens? _sub points eye -> kart, so driving at us is a negative dot
      if (-(s.vel.x * _sub.x + s.vel.y * _sub.y + s.vel.z * _sub.z) < O.plateClosing) return;
      best = d;
    };
    consider(target.state);
    const rivals = target.rivals;
    if (rivals) for (const o of rivals) consider(o && (o.state || (o.vehicle && o.vehicle.state)));
    if (!Number.isFinite(best)) return fov;
    const want = 2 * Math.atan(O.plateSubjH / (2 * best * O.plateFill)) * 180 / Math.PI;
    return clamp(Math.min(fov, want), Math.min(O.plateFovMin, fov), fov);
  }

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
    setFixed(p, l, f) {
      tmp2.set(l[0], l[1], l[2]);
      const eye = resolveFixed(V(p[0], p[1], p[2]), tmp2);
      fixed.pos = [eye.x, eye.y, eye.z];
      fixed.look = l;
      fixed.fov = plateFov(eye, tmp2, f ?? fixed.fov);
      mode = 'fixed'; fixedUpdate(); return api;
    },
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
