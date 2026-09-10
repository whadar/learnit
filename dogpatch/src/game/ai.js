/**
 * The opponents.
 *
 * A racing line computed once (offset toward the inside of each corner), a speed profile that
 * respects lateral grip, and pure pursuit onto it. Every kart drifts through anything sustained
 * enough to pay — on a street circuit of 90-degree corners that is most of them, and an AI that
 * never drifts costs a kart racer its character.
 */
import { clamp, clamp01, lerp, wrapPi } from '../core/math.js';

const TIER = [
  { name: 'Club',  pace: 0.90, look: 0.62, slip: 0.55 },
  { name: 'Pro',   pace: 0.96, look: 0.70, slip: 0.72 },
  { name: 'Ace',   pace: 1.00, look: 0.78, slip: 0.86 },
];

/** Offset line + speed profile. Computed once; every kart shares it. */
export function buildLine(track, opts = {}) {
  const N = track.count, ds = track.ds;
  const off = new Float32Array(N), spd = new Float32Array(N), curv = new Float32Array(N);
  const maxOff = opts.maxOffset ?? 4.6;

  for (let i = 0; i < N; i++) curv[i] = track.curvatureAt(i * ds);
  // smooth the curvature so the line does not chase every wobble in the centreline
  for (let p = 0; p < 6; p++) {
    const prev = curv.slice();
    for (let i = 0; i < N; i++) curv[i] = (prev[(i - 1 + N) % N] + 2 * prev[i] + prev[(i + 1) % N]) * 0.25;
  }
  // apex toward the inside of the bend, then relax the line so it is drivable
  for (let i = 0; i < N; i++) off[i] = clamp(-curv[i] * 260, -maxOff, maxOff);
  for (let p = 0; p < 40; p++) {
    const prev = off.slice();
    for (let i = 0; i < N; i++) off[i] = (prev[(i - 1 + N) % N] + prev[i] + prev[(i + 1) % N]) / 3;
  }

  // speed from lateral grip on the line's own radius, then swept back for braking distance
  const A_LAT = 11.5, A_BRAKE = 13.0, VMAX = 27.5;
  for (let i = 0; i < N; i++) {
    const k = Math.abs(curv[i]) + 1e-5;
    spd[i] = clamp(Math.sqrt(A_LAT / k), 6, VMAX);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let n = 0; n < N; n++) {
      const i = (N - 1 - n + N) % N, j = (i + 1) % N;
      spd[i] = Math.min(spd[i], Math.sqrt(spd[j] * spd[j] + 2 * A_BRAKE * ds));
    }
  }
  return { off, spd, curv, N, ds,
    offsetAt: s => off[(Math.round(s / ds) % N + N) % N],
    speedAt: s => spd[(Math.round(s / ds) % N + N) % N] };
}

export function createAI(track, line, opts = {}) {
  const tier = TIER[clamp(opts.tier ?? 2, 0, 2)];
  const skill = opts.skill ?? 1;
  const inp = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0 };
  let driftT = 0, wobble = opts.wobble ?? 0;

  function control(v, dt, rivals = []) {
    const s = v.state;
    const n = track.nearest(s.pos);
    const speed = s.speed;

    // aim a little further ahead the faster we go, and at the offset line rather than the centre
    const ahead = 7 + speed * tier.look;
    const m = track.sample(n.s + ahead);
    const o = line.offsetAt(n.s + ahead);
    const tx = m.pos.x + m.normal.x * o - s.pos.x;
    const tz = m.pos.z + m.normal.z * o - s.pos.z;
    let err = wrapPi(Math.atan2(tx, tz) - s.yaw);

    // nudge away from anyone alongside, so the pack does not simply drive through itself
    for (const r of rivals) {
      if (r === v) continue;
      const dx = r.state.pos.x - s.pos.x, dz = r.state.pos.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 6.5 || d < 0.001) continue;
      const side = Math.sign((dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw)) || 1);
      err -= side * (6.5 - d) * 0.055;
    }

    inp.steer = clamp(err * 2.2 + wobble, -1, 1);

    // pace: the profile speed for where we are, scaled by tier and skill
    const want = line.speedAt(n.s + speed * 0.35) * tier.pace * skill;
    inp.throttle = speed < want ? 1 : 0.18;
    inp.brake = speed > want * 1.16 ? clamp((speed - want) * 0.32, 0, 1) : 0;

    // drift anything that is a real corner and lasts long enough to charge
    const kAhead = Math.abs(track.curvatureAt(n.s + 10 + speed * 0.4));
    const worth = kAhead > 0.013 && speed > 11 && Math.abs(inp.steer) > 0.22;
    driftT = worth ? driftT + dt : 0;
    inp.drift = driftT > 0.12 ? 1 : 0;
    if (inp.drift) inp.steer = clamp(inp.steer * 1.2, -1, 1);

    inp.item = 1;
    void tier.slip;
    return inp;
  }

  return { control, tier: tier.name, set wobble(v) { wobble = v; } };
}

export const TIERS = TIER;
