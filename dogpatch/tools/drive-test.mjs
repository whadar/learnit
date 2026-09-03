/** Does the kart actually drive? Numbers only, no renderer. */
import fs from 'node:fs';
import { World } from '../src/world/world.js';
import { buildTrack } from '../src/track/track.js';
import { createVehicle } from '../src/physics/vehicle.js';

const json = JSON.parse(fs.readFileSync('public/data/world.json', 'utf8'));
const bin = fs.readFileSync('public/data/world-height.bin');
const world = new World(json, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));
const track = buildTrack(world);
const v = createVehicle(world, track, { seed: 1 });
const g = track.startGrid[0];
v.reset(g.pos, g.rot);
const DT = 1 / 120;
const inp = { throttle: 1, brake: 0, steer: 0, drift: 0 };

let peak = 0, t = 0, t50 = -1;
for (; t < 12; t += DT) {
  // steer toward a point down the road, so it follows the circuit instead of a wall
  const n = track.nearest(v.state.pos);
  const a = track.sample(n.s + 10 + v.state.speed * 0.7);
  const dx = a.pos.x - v.state.pos.x, dz = a.pos.z - v.state.pos.z;
  const err = Math.atan2(dx, dz) - v.state.yaw;
  inp.steer = Math.max(-1, Math.min(1, Math.atan2(Math.sin(err), Math.cos(err)) * 2.0));
  v.update(DT, inp);
  peak = Math.max(peak, v.state.speed);
  if (t50 < 0 && v.state.speed * 3.6 >= 50) t50 = t;
}
const n = track.nearest(v.state.pos);
console.log(`0-50 km/h        ${t50 >= 0 ? t50.toFixed(2) + ' s' : 'never'}`);
console.log(`top speed        ${(peak * 3.6).toFixed(1)} km/h`);
console.log(`after 12 s       ${(n.s).toFixed(0)} m along, lateral ${n.lateral.toFixed(2)} m, ${n.onTrack ? 'on track' : 'OFF TRACK'}`);
console.log(`respawns         ${v.state.respawns}`);
