/**
 * The kart.
 *
 * Four raycast suspension wheels carrying a rigid body: each wheel casts down at the heightfield,
 * a spring/damper pushes the body up, and the contact patch generates longitudinal and lateral
 * tyre force. Drift is a servo — holding the button past a threshold locks a target body-slip
 * angle and the steering feeds it, which is what makes a kart racer feel like one rather than
 * like a simulator.
 *
 * Convention, and it matters: +X east, +Z south, +Y up, and `yaw = atan2(fwd.x, fwd.z)`, so a
 * POSITIVE yaw rate is a turn to the driver's LEFT. Input steer is signed the same way, and
 * `input.js` is the one place that flips it for the player. Measured, not assumed.
 */
import { clamp, clamp01, damp, lerp, wrapPi, rng } from '../core/math.js';

export const TUNE = {
  mass: 240, wheelbase: 1.9, track: 1.35, cgH: 0.34,
  wheelR: 0.32, restLen: 0.42, springK: 34000, damp: 2600,
  topSpeed: 26.5, drive: 2900, brake: 7200, reverse: 8,
  grip: 1.55, gripRear: 1.62, steerLow: 0.62, steerHigh: 0.28,
  steerRate: 7.0, driftInner: 0.34, driftRange: 0.5,
  driftSlip: 26, driftTiers: [0.85, 1.75, 2.65], boost: [0.55, 0.9, 1.3],
  drag: 0.42, rollDrag: 4.2, downforce: 0.9,
};

const SURF = {
  tarmac: { grip: 1.0, top: 1.0, drag: 1.0 },
  kerb:   { grip: 0.92, top: 0.98, drag: 1.1 },
  dirt:   { grip: 0.72, top: 0.82, drag: 1.9 },
};

export function createVehicle(world, track, opts = {}) {
  const P = { ...TUNE, ...opts };
  const rand = rng(opts.seed ?? 7);

  const state = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, yawRate: 0, pitch: 0, roll: 0,
    speed: 0, forwardSpeed: 0, throttle: 0, brake: 0, steer: 0, steerAngle: 0,
    grounded: true, surface: 'tarmac', onTrack: true, lateral: 0, s: 0,
    drift: { active: false, dir: 0, charge: 0, tier: 0, hop: false },
    boost: { time: 0, power: 0 }, slipDeg: 0, skid: 0, airTime: 0,
    respawns: 0, wallHit: 0,
  };
  const wheels = [0, 1, 2, 3].map(i => ({
    fx: (i < 2 ? 1 : -1) * P.wheelbase * 0.5,      // +forward
    fz: (i % 2 ? 1 : -1) * P.track * 0.5,          // +left
    steerable: i < 2, contact: true, comp: 0, load: P.mass * 2.45, spin: 0,
  }));

  let hopT = 0, driftHeld = 0;

  function reset(pos, rot = 0) {
    state.pos = { x: pos.x, y: (pos.y ?? world.heightAt(pos.x, pos.z)) + 0.5, z: pos.z };
    state.vel = { x: 0, y: 0, z: 0 };
    state.yaw = rot; state.yawRate = 0; state.speed = 0; state.forwardSpeed = 0;
    state.drift = { active: false, dir: 0, charge: 0, tier: 0, hop: false };
    state.boost = { time: 0, power: 0 };
    state.slipDeg = 0; state.skid = 0; state.airTime = 0;
    for (const w of wheels) { w.spin = 0; w.comp = 0; w.contact = true; }
  }

  /** Put the kart back on the centreline, facing the right way. */
  function respawn() {
    const n = track.nearest(state.pos);
    const m = track.sample(n.s + 6);
    state.respawns++;
    reset({ x: m.pos.x, y: m.pos.y, z: m.pos.z }, Math.atan2(m.tangent.x, m.tangent.z));
  }

  function surfaceAt(n) {
    if (!n.onTrack) return 'dirt';
    return Math.abs(n.lateral) > n.width * 0.5 - 0.9 ? 'kerb' : 'tarmac';
  }

  function update(dt, inp) {
    dt = clamp(dt, 1 / 240, 1 / 20);
    const fwd = { x: Math.sin(state.yaw), z: Math.cos(state.yaw) };
    const rgt = { x: fwd.z, z: -fwd.x };                  // right of travel
    const vF = state.vel.x * fwd.x + state.vel.z * fwd.z;
    const vR = state.vel.x * rgt.x + state.vel.z * rgt.z;
    state.forwardSpeed = vF;
    state.speed = Math.hypot(state.vel.x, state.vel.z);

    const n = track.nearest(state.pos);
    state.onTrack = n.onTrack; state.lateral = n.lateral; state.s = n.s;
    state.surface = surfaceAt(n);
    const S = SURF[state.surface];

    /* ---- suspension: one ray per wheel at the heightfield ---- */
    let load = 0, contacts = 0;
    for (const w of wheels) {
      const wx = state.pos.x + fwd.x * w.fx - rgt.x * w.fz;
      const wz = state.pos.z + fwd.z * w.fx - rgt.z * w.fz;
      const g = world.heightAt(wx, wz);
      const rest = state.pos.y - P.restLen - P.wheelR;
      const pen = g - rest;
      if (pen > 0) {
        w.contact = true; contacts++;
        w.comp = clamp(pen, 0, P.restLen);
        const vY = state.vel.y;
        const f = P.springK * w.comp - P.damp * vY;
        w.load = clamp(f, 0, P.mass * 34);
        state.vel.y += (f / P.mass) * dt;
        load += w.load;
      } else { w.contact = false; w.comp = 0; w.load = 0; }
    }
    state.grounded = contacts > 0;
    state.airTime = state.grounded ? 0 : state.airTime + dt;

    state.vel.y -= 9.81 * dt;
    if (state.grounded) {
      // settle onto the surface rather than oscillating on the spring
      const gy = world.heightAt(state.pos.x, state.pos.z) + P.restLen + P.wheelR;
      if (state.pos.y < gy) { state.pos.y = lerp(state.pos.y, gy, clamp01(dt * 22)); state.vel.y = Math.max(state.vel.y, 0); }
    }

    /* ---- steering ---- */
    const spdT = clamp01(state.speed / P.topSpeed);
    const maxSteer = lerp(P.steerLow, P.steerHigh, spdT);
    let want = clamp(inp.steer ?? 0, -1, 1);

    /* ---- drift: a servo on body slip, not a friction trick ---- */
    const d = state.drift;
    const wantDrift = (inp.drift ?? 0) > 0.5;
    driftHeld = wantDrift ? driftHeld + dt : 0;
    if (wantDrift && !d.active && state.grounded && state.speed > 8 && Math.abs(want) > 0.25) {
      if (hopT <= 0) { hopT = 0.18; d.hop = true; }
      if (driftHeld > 0.12) { d.active = true; d.dir = Math.sign(want); d.charge = 0; d.tier = 0; }
    }
    if (hopT > 0) { hopT -= dt; if (hopT <= 0) d.hop = false; }
    if (d.active && (!wantDrift || state.speed < 5)) {
      if (d.tier > 0) { state.boost.time = P.boost[d.tier - 1]; state.boost.power = 0.22 + d.tier * 0.09; }
      d.active = false; d.dir = 0; d.charge = 0; d.tier = 0;
    }
    if (d.active) {
      const inward = clamp(want * d.dir, -1, 1);
      want = d.dir * (P.driftInner + P.driftRange * inward);
      d.charge += dt * (0.7 + 0.5 * spdT);
      d.tier = d.charge > P.driftTiers[2] ? 3 : d.charge > P.driftTiers[1] ? 2 : d.charge > P.driftTiers[0] ? 1 : 0;
    }
    state.steer = damp(state.steer, want, P.steerRate, dt);
    state.steerAngle = state.steer * maxSteer;

    /* ---- engine ---- */
    const boostP = state.boost.time > 0 ? state.boost.power : 0;
    const top = P.topSpeed * S.top * (1 + boostP);
    const thr = clamp01(inp.throttle ?? 0), brk = clamp01(inp.brake ?? 0);
    state.throttle = thr; state.brake = brk;
    const reversing = brk > 0.05 && vF < 0.6 && thr < 0.05;
    let drive;
    if (reversing) drive = -P.drive * 0.4 * brk * clamp01(1 - (-vF / P.reverse) ** 3);
    else {
      drive = P.drive * thr * clamp01(1 - (Math.max(vF, 0) / Math.max(top * (0.4 + 0.6 * thr), 1)) ** 3);
      if (boostP > 0) drive += P.drive * 0.9 * boostP * clamp01(1 - Math.max(vF, 0) / (top * 1.06));
    }
    if (state.boost.time > 0) state.boost.time = Math.max(0, state.boost.time - dt);

    /* ---- tyres ---- */
    if (state.grounded) {
      const gripN = P.grip * S.grip * (1 + P.downforce * spdT * spdT * 0.35);
      const maxLat = gripN * P.mass * 9.81 * 0.5;

      // lateral: pull the body toward the direction it points, harder as grip rises
      let latF = -vR * P.mass * 7.4 * (d.active ? 0.42 : 1.0);
      latF = clamp(latF, -maxLat, maxLat);

      // longitudinal: drive minus braking minus rolling drag
      let lonF = drive - (reversing ? 0 : brk * P.brake * Math.sign(vF || 1));
      lonF -= vF * P.rollDrag * S.drag;
      lonF -= Math.sign(vF) * state.speed * state.speed * P.drag * 0.04 * S.drag;

      state.vel.x += (fwd.x * lonF + rgt.x * latF) / P.mass * dt;
      state.vel.z += (fwd.z * lonF + rgt.z * latF) / P.mass * dt;

      // yaw: steering makes rate, and a drift adds the servo term that holds the angle out
      const wheelbase = P.wheelbase;
      let yawWant = (vF / wheelbase) * Math.tan(state.steerAngle);
      if (d.active) {
        const target = d.dir * P.driftSlip * Math.PI / 180;
        const slip = Math.atan2(vR, Math.abs(vF) + 0.6);
        yawWant += (target - slip) * 2.6;
      }
      const maxYaw = clamp(1.05 + spdT * 1.5, 0.6, 2.6);
      state.yawRate = damp(state.yawRate, clamp(yawWant, -maxYaw, maxYaw), 9, dt);
      state.skid = clamp01(Math.abs(vR) / 6 + (d.active ? 0.5 : 0));
      // Outside a drift the slip readout is zero, not whatever the last drift ended at.
      state.slipDeg = d.active ? Math.atan2(vR, Math.abs(vF) + 0.6) * 180 / Math.PI : 0;
    } else {
      state.yawRate = damp(state.yawRate, 0, 1.2, dt);
      state.skid = damp(state.skid, 0, 6, dt);
      state.slipDeg = 0;
    }

    state.yaw = wrapPi(state.yaw + state.yawRate * dt);
    state.pos.x += state.vel.x * dt;
    state.pos.y += state.vel.y * dt;
    state.pos.z += state.vel.z * dt;

    // Keep the kart in the world. Off the ribbon it just gets slow and draggy; outside the box
    // it would sample clamped heightfield forever, so it goes back to the line.
    if (!world.inBounds(state.pos.x, state.pos.z) || state.pos.y < world.terrain.min - 30) respawn();

    // body attitude follows the surface, purely visual
    const gn = world.normalAt(state.pos.x, state.pos.z);
    const targetPitch = -Math.asin(clamp(gn.x * fwd.x + gn.z * fwd.z, -1, 1));
    const targetRoll = Math.asin(clamp(gn.x * rgt.x + gn.z * rgt.z, -1, 1)) - state.yawRate * clamp(state.speed, 0, 20) * 0.006;
    state.pitch = damp(state.pitch, targetPitch, 6, dt);
    state.roll = damp(state.roll, targetRoll, 6, dt);
    for (const w of wheels) w.spin += (vF / P.wheelR) * dt;
    void rand; void load;
    return state;
  }

  return { state, wheels, update, reset, respawn, tune: P,
    get transform() { return { pos: state.pos, yaw: state.yaw, pitch: state.pitch, roll: state.roll }; } };
}
