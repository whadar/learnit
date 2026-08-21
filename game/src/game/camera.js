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
  /* fixed cinematic plates: keeping the subject legible — see plateFrame() */
  plateFill: 0.210,       // fraction of frame height a head-on subject should occupy
  plateSubjH: 1.55,       // metres of kart + driver that has to fill it
  plateFovMin: 21,        // never squeeze the lens past this
  plateNear: 8,           // subjects nearer than this are already big enough
  plateFar: 45,           // … and beyond this a plate is a landscape, not a portrait
  plateClosing: 6.0,      // m/s the field must be closing on the lens to count as head-on
  plateAimH: 0.86,        // metres above the kart's base the plate aims at (chest / driver)
  plateMate: 6.0,         // a rival within this much of the leader's depth is "nose to nose"
  plateSpread: 0.60,      // … and the pair may fill this much of the frame width
  plateDeck: 11.0,        // a plate this far over the ground is a landscape, never a portrait
  plateLambda: 7.5,       // how fast a tracking plate pans/zooms onto its subject
  plateSweepR: 1.05,      // radius of the lens volume swept back from subject to eye
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
  const fixed = {
    pos: [0, 40, 0], look: [0, 0, 0], fov: 55,
    look0: [0, 0, 0],     // the pose exactly as authored — a tracking plate never leaves it far
    fov0: 55,
    deck: false,          // deck-level plate (can become a portrait) vs a crane shot
    first: true,
  };
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
   * before a fixed plate is committed, the lens's own volume is swept back from the *subject*
   * to the eye: whatever solid trackside furniture it meets first, the lens is planted just in
   * front of it. Resolved once per `setFixed()` — the eye does not move afterwards — so the
   * sweep never costs a frame.
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

  /**
   * Sweep the lens's own volume back from the subject to the eye and report the nearest solid
   * it meets, as a distance from the subject. -1 when the run is clear.
   *
   * The old test was a single hair-thin ray down the middle of the sight line, so anything the
   * lens had buried itself in *beside* the axis — a gantry leg, a hoarding post, a tyre stack
   * a metre off the lens — read as clear air and stayed in the plate, cropping a corner of the
   * frame. A camera is not a hair: it has a near plane about a metre across, and it is that
   * volume which must be clear. So the run is swept as a cylinder of that radius — seven
   * parallel probes, the axis plus a ring around it, nearest hit wins.
   *
   * The sweep only ever answers "is the lens inside something". What the plate is *pointed at*
   * and how tight it is are plateFrame()'s job, below; between them they are what stopped the
   * finish plate filming the underside of the start gate instead of the race.
   */
  const _dir = V(), _rt = V(), _upv = V(), _org = V();
  function sweepBack(at, p) {
    const list = cameraBlockers();
    if (!list.length) return -1;
    _dir.subVectors(p, at);
    const dist = _dir.length();
    if (dist < 0.4) return -1;
    _dir.multiplyScalar(1 / dist);
    // a basis across the sight line, so the probes ring the axis instead of stringing out along it
    _rt.set(-_dir.z, 0, _dir.x);
    if (_rt.lengthSq() < 1e-8) _rt.set(1, 0, 0); else _rt.normalize();
    _upv.crossVectors(_dir, _rt).normalize();
    let best = -1;
    for (let i = 0; i < 7; i++) {
      _org.copy(at);
      if (i) {
        const a = (i - 1) * (Math.PI / 3);
        _org.addScaledVector(_rt, Math.cos(a) * O.plateSweepR)
          .addScaledVector(_upv, Math.sin(a) * O.plateSweepR);
      }
      _ray.set(_org, _dir);
      _ray.near = 0.05; _ray.far = dist;
      let hits = null;
      try { hits = _ray.intersectObjects(list, false); } catch (e) { hits = null; }
      if (!hits || !hits.length) continue;
      for (const h of hits) {
        // Only ironmongery *in the eye's own near volume* is a fault. A gantry leg or a
        // hoarding halfway down the sight line is composition, not a clip, and planting the
        // lens in front of the first hit whatever its distance would haul a plate authored
        // well past the line back under the gate it was framing, subject and all.
        if (h.distance <= dist - NEARVOL || h.distance >= dist - 0.02) continue;
        if (best < 0 || h.distance < best) best = h.distance;
        break;
      }
    }
    return best;
  }

  function resolveFixed(p, at) {
    clearGround(p, at);
    // a crane shot is above everything trackside; don't pay for a sweep it cannot hit
    const gy = groundY(p.x, p.z);
    if (Number.isFinite(gy) && p.y > gy + O.plateDeck) return p;
    const t = sweepBack(at, p);
    if (t > 0) {
      const dist = p.distanceTo(at);
      p.copy(at).addScaledVector(_dir, Math.max(t - CLEAR, dist * 0.45));
    }
    clearGround(p, at);
    return p;
  }

  /** True when a plate stands on the deck, where a kart can drive into it. */
  function deckLevel(p) {
    const gy = groundY(p.x, p.z);
    return Number.isFinite(gy) && p.y < gy + O.plateDeck;
  }

  /**
   * Which karts a fixed plate is actually a portrait *of*.
   *
   * A plate the field is driving at is a portrait; a plate it is standing still on (a grid),
   * driving away from, or nowhere near is a landscape and is left exactly as authored. The
   * window is the authored one: inside the authored cone, inside the near/far band, and
   * genuinely closing on the lens. Nearest first.
   */
  const _axis = V(), _sub = V();
  const _pool = []; for (let i = 0; i < 10; i++) _pool.push({ s: null, d: 0, player: false });
  const _cand = [];
  function plateSubjects(eye, at, fov) {
    _cand.length = 0;
    if (!target || !target.state) return _cand;
    _axis.subVectors(at, eye);
    const dist = _axis.length();
    if (dist < 0.5) return _cand;
    _axis.multiplyScalar(1 / dist);
    const half = THREE.MathUtils.degToRad(fov) * 0.5;
    const aspect = camera.aspect || (16 / 9);
    const coneH = Math.atan(Math.tan(half) * aspect);   // ~half the frame's diagonal spread
    const consider = (st2, player) => {
      if (!st2 || !st2.pos || !st2.vel || _cand.length >= _pool.length) return;
      _sub.set(st2.pos.x - eye.x, st2.pos.y + 0.55 - eye.y, st2.pos.z - eye.z);
      const d = _sub.length();
      if (d < O.plateNear || d > O.plateFar) return;
      _sub.multiplyScalar(1 / d);
      if (Math.acos(clamp(_sub.dot(_axis), -1, 1)) > coneH) return;        // outside the frame
      // closing on the lens? _sub points eye -> kart, so driving at us is a negative dot
      if (-(st2.vel.x * _sub.x + st2.vel.y * _sub.y + st2.vel.z * _sub.z) < O.plateClosing) return;
      const e = _pool[_cand.length];
      e.s = st2; e.d = d; e.player = player;
      _cand.push(e);
    };
    consider(target.state, true);
    const rivals = target.rivals;
    if (rivals) for (const o of rivals) consider(o && (o.state || (o.vehicle && o.vehicle.state)), false);
    _cand.sort((a, b) => a.d - b.d);
    return _cand;
  }

  /**
   * Point a plate at the race and size the lens to it.
   *
   * A hand-placed plate carries an aim and a focal length chosen against the *tarmac* — a
   * point on the centre line and a number of degrees — and the karts then arrive wherever the
   * lane offsets and the camber put them. On the finish plate that meant the leaders sat off
   * to one side of a wide frame at forty pixels a kart, with the bottom half of the shot dead
   * asphalt and the player, whose race it is, barely in it. So a plate the field is driving at
   * is treated as a portrait of the field: it aims at the player (the only kart the shot is
   * ever about) and, when a rival is running alongside, at the midpoint of the pair, so the
   * two of them come to the line nose to nose in the middle of frame. The lens then tightens
   * until the leader fills `plateFill` of the frame height, opening again only as far as the
   * pair needs to stay inside `plateSpread` of the width.
   *
   * Everything is anchored to the *authored* pose: the cone that decides who is in the shot is
   * the authored one, so the plate can pan onto its subject but never wander off the shot the
   * course designer framed.
   *
   * @returns {number} the fov to use — 0 when there is no subject and the plate stands as authored.
   */
  function plateFrame(eye, at, fov, outLook) {
    const c = plateSubjects(eye, at, fov);
    if (!c.length) return 0;
    let lead = c[0];
    for (let i = 0; i < c.length; i++) if (c[i].player) { lead = c[i]; break; }
    let mate = null;
    for (let i = 0; i < c.length; i++) {
      if (c[i] !== lead && Math.abs(c[i].d - lead.d) <= O.plateMate) { mate = c[i]; break; }
    }
    const a = lead.s.pos, b = mate ? mate.s.pos : a;
    outLook.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + O.plateAimH, (a.z + b.z) * 0.5);
    const d = Math.max(outLook.distanceTo(eye), 1);
    let want = 2 * Math.atan(O.plateSubjH / (2 * d * O.plateFill)) * 180 / Math.PI;
    if (mate) {
      const sep = Math.hypot(a.x - b.x, a.z - b.z) + 2.1;      // pair width + a kart of margin
      const aspect = camera.aspect || (16 / 9);
      const needH = 2 * Math.atan(sep / (2 * d * O.plateSpread));
      const needV = 2 * Math.atan(Math.tan(needH * 0.5) / aspect) * 180 / Math.PI;
      if (needV > want) want = needV;
    }
    return clamp(Math.min(fov, want), Math.min(O.plateFovMin, fov), fov);
  }

  const _look2 = V();
  function fixedUpdate(dt = 1 / 60) {
    tmp.set(fixed.pos[0], fixed.pos[1], fixed.pos[2]);
    tmp2.set(fixed.look0[0], fixed.look0[1], fixed.look0[2]);
    let wantFov = fixed.fov0;
    if (fixed.deck) {
      const fv = plateFrame(tmp, tmp2, fixed.fov0, _look2);
      if (fv > 0) { wantFov = fv; tmp2.copy(_look2); }
    }
    pos.copy(tmp);
    if (fixed.first) { look.copy(tmp2); st.fov = wantFov; fixed.first = false; }
    else {
      look.lerp(tmp2, clamp(1 - Math.exp(-O.plateLambda * dt), 0, 1));
      st.fov = damp(st.fov, wantFov, O.plateLambda, dt);
    }
    fixed.look[0] = look.x; fixed.look[1] = look.y; fixed.look[2] = look.z;
    fixed.fov = st.fov;
    applyLook(tmp, look, st.fov, 0);
  }

  /* -------------------------------------------------------------- api ----- */
  function update(dt, ctx = {}) {
    dt = clamp(dt || 0, 1 / 480, 0.1);
    elapsed += dt;
    switch (mode) {
      case 'intro': intro(dt, ctx); break;
      case 'results': results(dt, ctx); break;
      case 'photo': photoUpdate(dt, ctx); break;
      case 'fixed': fixedUpdate(dt); break;
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
      fixed.look0 = [l[0], l[1], l[2]];
      fixed.fov0 = f ?? fixed.fov0;
      fixed.deck = deckLevel(eye);
      fixed.first = true;
      mode = 'fixed'; fixedUpdate(1 / 60); return api;
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
