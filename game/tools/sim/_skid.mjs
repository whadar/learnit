import fs from 'node:fs';
import { makeFallbackTrack, createVehicle } from '../../src/physics/vehicle.js';
const { WorldData } = await import('../../src/world/worldData.js');
const json = JSON.parse(fs.readFileSync('public/data/amikam.json', 'utf8'));
const buf = fs.readFileSync('public/data/amikam-height.bin');
const world = new WorldData(json, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const track = makeFallbackTrack(world, { seed: 7 });
const DT = 1 / 60;
// skidpad: hold a constant steer, cap the speed with throttle control, measure lateral accel
for (const steer of [0.25, 0.4, 0.6, 0.8, 1.0]) {
  for (const target of [10, 14, 18, 22, 26]) {
    const v = createVehicle(world, track, { seed: 3 });
    v.reset(track.startGrid[0].pos, track.startGrid[0].rot);
    let t = 0, sumA = 0, n = 0, best = 0;
    while (t < 14) {
      const st = v.state;
      const thr = st.forwardSpeed < target ? 1 : 0;
      const brk = st.forwardSpeed > target + 1.5 ? 0.4 : 0;
      v.update(DT, { throttle: thr, brake: brk, steer, drift: 0 });
      t += DT;
      if (t > 6 && st.grounded) { const a = Math.abs(st.angVel.y) * st.speed; sumA += a; n++; best = Math.max(best, a); }
    }
    if (n) console.log(`steer ${steer.toFixed(2)} target ${String(target).padStart(3)} m/s -> speed ${(v.state.speed).toFixed(1)} aLat mean ${(sumA / n).toFixed(2)} peak ${best.toFixed(2)} m/s2  (${(sumA / n / 9.81).toFixed(2)} g)`);
  }
}
