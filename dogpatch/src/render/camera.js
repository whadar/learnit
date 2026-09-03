/**
 * Chase camera.
 *
 * Sits behind and above the kart, aims a little ahead of it, and widens with speed. Two things
 * it deliberately does: it never lets a rival get between itself and the player (that was a real
 * defect once — a kart riding 2.6 m from a camera whose player sat at 9 m, smearing across the
 * bottom of the frame), and it pulls in when the ground behind rises so it does not bury itself
 * in a hill.
 */
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/math.js';

export function createCamera(camera, world) {
  const pos = new THREE.Vector3(), aim = new THREE.Vector3();
  let started = false, shake = 0, fov = 62;

  function update(dt, target, rivals = []) {
    if (!target) return;
    const s = target.state;
    const spd = clamp01(s.speed / 26);
    const back = lerp(6.2, 7.6, spd), up = lerp(2.5, 2.9, spd), ahead = lerp(5, 11, spd);
    const fwd = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };

    let wx = s.pos.x - fwd.x * back, wz = s.pos.z - fwd.z * back;
    let wy = s.pos.y + up;
    // do not sink into rising ground behind
    wy = Math.max(wy, world.heightAt(wx, wz) + 1.5);

    // Keep the shot clear: if a rival is nearer the camera than the player, ease the camera back
    // so it is behind them too rather than looking through their head.
    for (const r of rivals) {
      if (r === target) continue;
      const d = Math.hypot(r.state.pos.x - wx, r.state.pos.z - wz);
      if (d < back * 0.72) {
        const push = (back * 0.72 - d) * 0.8;
        wx -= fwd.x * push; wz -= fwd.z * push; wy += push * 0.25;
      }
    }

    if (!started) { pos.set(wx, wy, wz); started = true; }
    const k = 7.5;
    pos.set(damp(pos.x, wx, k, dt), damp(pos.y, wy, k * 0.8, dt), damp(pos.z, wz, k, dt));
    aim.set(damp(aim.x, s.pos.x + fwd.x * ahead, 9, dt),
            damp(aim.y, s.pos.y + 1.0, 9, dt),
            damp(aim.z, s.pos.z + fwd.z * ahead, 9, dt));

    if (shake > 0) {
      shake = Math.max(0, shake - dt * 2.4);
      const a = shake * 0.35;
      pos.x += Math.sin(dt * 977 + shake * 31) * a;
      pos.y += Math.cos(dt * 811 + shake * 17) * a;
    }
    camera.position.copy(pos);
    camera.lookAt(aim);
    const want = lerp(60, 74, spd) + (s.boost.time > 0 ? 4 : 0);
    fov = damp(fov, want, 4, dt);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  return { update, snap() { started = false; }, hit(a = 1) { shake = clamp(shake + a, 0, 1.4); },
    get position() { return pos; } };
}
