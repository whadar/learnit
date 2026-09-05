/**
 * The start line, and who is driving.
 *
 * Two bugs shipped past every other bench here, because every other bench runs the race with
 * `autopilot: true` — which is not how a human plays it:
 *
 *  - The grid hold was expressed as `brake: 1`, and the vehicle reads a brake held at a
 *    standstill as a request to reverse, so the whole field crept BACKWARDS off the line for
 *    the ten seconds the lights were red.
 *  - `autopilot: false` (what main.js passes the moment a person takes the wheel) gated the
 *    AI for the entire field rather than for the player's kart alone, so no opponent moved.
 *
 * This wires the race the way main.js does for a real race and asserts on both.
 *
 *   node tools/sim/grid.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { WorldData } from '../../src/world/worldData.js';
import { buildTrack } from '../../src/track/track.js';
import { createRace } from '../../src/game/race.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const DT = 1 / 60;
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };

const base = fs.existsSync(path.join(ROOT, 'public/data/amikam.json'))
  ? path.join(ROOT, 'public/data') : path.join(ROOT, 'dist/data');
const json = JSON.parse(fs.readFileSync(path.join(base, 'amikam.json'), 'utf8'));
const buf = fs.readFileSync(path.join(base, 'amikam-height.bin'));
const world = new WorldData(json, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const track = buildTrack(world, {});

const human = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
const race = createRace(world, track, {
  field: 8, laps: 3, seed: 11, playerIndex: 0,
  autopilot: false,                      // exactly what main.js passes when a person plays
  introTime: 2.0, countdownTime: 3.0,
});
race.setInput(human);
race.start(false);

const P = race.racers[race.state.playerIndex];
const start = { x: P.vehicle.state.pos.x, z: P.vehicle.state.pos.z };
let maxDrift = 0, minOmega = 0;

for (let t = 0; t < 5.0; t += DT) {              // the whole intro + countdown
  race.update(DT);
  const s = P.vehicle.state;
  maxDrift = Math.max(maxDrift, Math.hypot(s.pos.x - start.x, s.pos.z - start.z));
  for (const w of P.vehicle.wheels) minOmega = Math.min(minOmega, w.omega);
}
console.log('\n  phase at the flag: ' + race.state.phase);
check('the grid does not creep while the lights are red', maxDrift < 0.25, `moved ${maxDrift.toFixed(3)} m`);
check('no kart is driven backwards on the grid', -minOmega < 1.0, `worst rearward wheel speed ${(-minOmega).toFixed(1)} rad/s`);

// Now let it race. The human holds full throttle and never steers, so it will eventually
// bury itself in the scenery — the question here is only whether it LAUNCHES, so take the
// best speed over the window rather than whatever it happens to be sitting at at the end.
human.throttle = 1;
let peak = 0;
for (let t = 0; t < 9; t += DT) { race.update(DT); peak = Math.max(peak, P.vehicle.state.forwardSpeed); }

const opp = race.racers.filter(r => !r.isPlayer);
const meanOppSpeed = opp.reduce((a, r) => a + r.vehicle.state.speed, 0) / opp.length;
const movedOpp = opp.filter(r => r.vehicle.state.speed > 3).length;
check('the opponents race when a human is driving', meanOppSpeed > 5,
  `mean ${(meanOppSpeed * 3.6).toFixed(1)} km/h, ${movedOpp}/${opp.length} of them moving`);
check('the player gets off the line', peak > 5, `reached ${(peak * 3.6).toFixed(1)} km/h`);

console.log('\n' + (fails ? `FAILED ${fails}` : 'the start line is sound'));
process.exit(fails ? 1 : 0);
