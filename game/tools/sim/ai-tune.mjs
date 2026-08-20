/**
 * Steering-gain bench for src/game/ai.js: one Ace alone on the loop, reporting RMS distance from
 * the racing line, time off-track, respawns and lap times. Pass a JSON array of createAI() option
 * overrides to sweep them.
 *
 *   GRID='[{},{"stanley":0.2},{"aimGain":0.7}]' node tools/sim/ai-tune.mjs
 *   TRACE=1 T=45 node tools/sim/ai-tune.mjs        # per-0.25 s trace of one lap
 */
import fs from 'node:fs';
import { makeFallbackTrack, createVehicle } from '../../src/physics/vehicle.js';
import { createCollisionWorld } from '../../src/physics/collision.js';
import { createAI, buildRacingLine } from '../../src/game/ai.js';
const { WorldData } = await import('../../src/world/worldData.js');
const json = JSON.parse(fs.readFileSync('public/data/amikam.json', 'utf8'));
const buf = fs.readFileSync('public/data/amikam-height.bin');
const world = new WorldData(json, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const track = makeFallbackTrack(world, { seed: 7 });
const col = createCollisionWorld(world, track, {});
const line = buildRacingLine(track, JSON.parse(process.env.LINE_OPTS || '{}'));
const DT = 1 / 60;
const startS = track.startS ?? 0, LEN = track.length;

function run(aiOpts, T = 150, trace = false) {
  const ai = createAI(world, track, (i, o) => createVehicle(world, track, { ...o, collision: col }), Object.assign({
    count: 1, line, tiers: [3], seed: 999, rubberBand: false, step: true,
  }, aiOpts));
  const r = ai.racers[0];
  r.vehicle.reset(track.startGrid[0].pos, track.startGrid[0].rot);
  ai.setGate({ racing: true, tMinus: 0, go: true });
  let t = 0, err2 = 0, n = 0, off = 0, prevU = 0, lapStart = 0, first = true;
  const laps = [];
  const rows = [];
  while (t < T) {
    ai.update(DT); t += DT;
    const st = r.vehicle.state;
    const e = (r.lateral ?? 0) - line.offsetAt(r.s);
    err2 += e * e; n++;
    if (!st.onTrack) off += DT;
    const u = ((r.s - startS) % LEN + LEN) % LEN;
    if (u < prevU - LEN * 0.5) { if (!first) laps.push(t - lapStart); lapStart = t; first = false; }
    prevU = u;
    if (trace && Math.round(t * 60) % 15 === 0) rows.push([t.toFixed(1), (st.speed * 3.6).toFixed(0), (r.targetSpeed * 3.6).toFixed(0), (r.lateral ?? 0).toFixed(1), line.offsetAt(r.s).toFixed(1), r.input.steer.toFixed(2), r.input.throttle.toFixed(1), r.input.brake.toFixed(1), r.drift.on ? 'D' : '.', st.onTrack ? '.' : 'OFF'].join('\t'));
  }
  if (trace) console.log(rows.join('\n'));
  return { rms: Math.sqrt(err2 / n), off, laps, respawns: r.vehicle.state.respawns };
}
const grid = JSON.parse(process.env.GRID || '[{}]');
for (const g of grid) {
  const o = run(g, +(process.env.T || 150), !!process.env.TRACE);
  const lp = o.laps.map(x => x.toFixed(1)).join(',');
  console.log(JSON.stringify(g).padEnd(72), 'rms', o.rms.toFixed(2), 'off', o.off.toFixed(1), 'resp', o.respawns, 'laps', lp);
}
