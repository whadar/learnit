import fs from 'node:fs';
import { makeFallbackTrack, createVehicle } from '../../src/physics/vehicle.js';
const { WorldData } = await import('../../src/world/worldData.js');
const json = JSON.parse(fs.readFileSync('public/data/amikam.json', 'utf8'));
const buf = fs.readFileSync('public/data/amikam-height.bin');
const world = new WorldData(json, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const track = makeFallbackTrack(world, { seed: 7 });
const DT = 1 / 60;
for (const steer of [0.3, -0.3]) {
  const v = createVehicle(world, track, { seed: 3 });
  v.reset(track.startGrid[0].pos, track.startGrid[0].rot);
  let t = 0; const log = [];
  while (t < 3.2) {
    v.update(DT, { throttle: 0.55, brake: 0, steer, drift: 0 });
    t += DT;
    if (Math.round(t * 60) % 30 === 0) {
      const n = track.nearest(v.state.pos);
      const sm = track.sample(n.s);
      const right = v.getTransform().right;
      log.push(`t=${t.toFixed(1)} lat=${n.lateral.toFixed(2)} yaw=${v.state.yaw.toFixed(2)} angVelY=${v.state.angVel.y.toFixed(2)} right·normal=${(right.x * sm.normal.x + right.z * sm.normal.z).toFixed(2)}`);
    }
  }
  console.log('steer', steer, '\n  ' + log.join('\n  '));
}
