/**
 * Drift sparks, tyre smoke and boost trail — one points cloud, recycled.
 *
 * A fixed pool of particles in a single BufferGeometry: emitting is writing into a slot, and
 * there is never an allocation in the frame loop. Colour carries the drift tier, because that is
 * the one thing the player must read at a glance while looking at the road.
 */
import * as THREE from 'three';
import { clamp01, rng } from '../core/math.js';

const MAX = 900;
const TIER_COL = [[1.0, 0.86, 0.45], [0.45, 0.72, 1.0], [1.0, 0.45, 0.85]];

export function createVFX(scene, opts = {}) {
  const rand = rng(opts.seed ?? 31);
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 3);
  const siz = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);
  const max = new Float32Array(MAX);
  let head = 0;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(siz, 1));
  // PointsMaterial takes ONE size for every point: the per-point `size` attribute is ignored
  // unless a shader reads it, so authoring 0.5 metre points gave half-metre white squares all
  // over the frame. Small, round-ish, and normally blended — additive on top of that was what
  // made them read as blocks of paper.
  const mat = new THREE.PointsMaterial({
    size: 0.16, vertexColors: true, transparent: true, opacity: 0.7,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(g, mat);
  points.name = 'vfx'; points.frustumCulled = false;
  scene.add(points);

  function emit(x, y, z, c, spread, size, ttl) {
    const i = head; head = (head + 1) % MAX;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel[i * 3] = (rand() - 0.5) * spread;
    vel[i * 3 + 1] = rand() * spread * 0.8 + 0.6;
    vel[i * 3 + 2] = (rand() - 0.5) * spread;
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    siz[i] = size; life[i] = ttl; max[i] = ttl;
  }

  function update(dt, vehicles) {
    for (const v of vehicles) {
      const s = v.state;
      const d = s.drift;
      const fwd = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
      const rgt = { x: fwd.z, z: -fwd.x };
      if (d.active && s.grounded && s.speed > 6) {
        const c = d.tier > 0 ? TIER_COL[Math.min(2, d.tier - 1)] : [0.72, 0.70, 0.66];
        for (const side of [-1, 1]) {
          emit(s.pos.x - fwd.x * 0.8 + rgt.x * side * 0.66, s.pos.y - 0.18,
               s.pos.z - fwd.z * 0.8 + rgt.z * side * 0.66,
               c, d.tier > 0 ? 2.4 : 1.1, 1, d.tier > 0 ? 0.34 : 0.5);
        }
      }
      if (s.boost.time > 0) {
        emit(s.pos.x - fwd.x * 1.2, s.pos.y + 0.1, s.pos.z - fwd.z * 1.2,
             [0.55, 0.82, 1.0], 1.0, 0.6, 0.3);
      }
      if (!s.onTrack && s.speed > 8) {
        emit(s.pos.x - fwd.x * 0.9, s.pos.y - 0.2, s.pos.z - fwd.z * 0.9,
             [0.58, 0.56, 0.5], 1.6, 0.7, 0.55);
      }
    }

    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) { siz[i] = 0; continue; }
      life[i] -= dt;
      const t = clamp01(life[i] / max[i]);
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      vel[i * 3 + 1] -= 1.6 * dt;
      siz[i] = siz[i] * (0.55 + 0.45 * t);
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
  }

  return { update, points, dispose() { scene.remove(points); g.dispose(); mat.dispose(); } };
}
