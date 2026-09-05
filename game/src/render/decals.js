/**
 * Ground decal manager: persistent tyre marks, skid scuffs, mud splats and scorch, all in
 * one instanced draw call with a shared procedural atlas (vfxLibrary.js).
 *
 * A decal is a quad defined by a centre and two world-space half-axes, so it tilts with the
 * terrain instead of hovering over it. Trails are stamped segment-by-segment as the kart
 * moves, which keeps the marks continuous on curves and lets each wheel own its own line.
 *
 *   const d = createDecals(engine, world, opts);
 *   d.trail(wheelId, worldPos, forwardDir, { kind:'tyre', width, alpha, life });
 *   d.breakTrail(wheelId);
 *   d.stamp('splat', { pos, dir, size, alpha, life });
 *   d.update(dt, time);
 */
import * as THREE from 'three';
import { clamp, rng } from '../core/mathx.js';
import { buildDecalAtlas, DECAL_INDEX } from './vfxLibrary.js';

const STRIDE = 18;
const OFF = { pos: 0, ax: 3, az: 6, life: 9, col: 11, par: 14 };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _r = new THREE.Vector3(), _m = new THREE.Vector3(), _c = new THREE.Color();
const _nrm = { x: 0, y: 1, z: 0 };

const VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aAx;
attribute vec3 aAz;
attribute vec2 aLife;      // t0, life
attribute vec3 aCol;
attribute vec4 aPar;       // alpha, spriteIndex, vTile, vOffset

uniform float uTime;
uniform vec2  uGrid;
uniform float uInset;

varying vec2  vUv;
varying vec3  vCol;
varying float vAlpha;
varying float vFogDepth;

void main() {
  float age = uTime - aLife.x;
  float t = age / max(aLife.y, 1e-3);
  if (age < 0.0 || t >= 1.0) {
    vUv = vec2(0.0); vCol = vec3(0.0); vAlpha = 0.0; vFogDepth = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 p = aPos + position.x * aAx + position.y * aAz;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFogDepth = -mv.z;

  float fadeIn  = smoothstep(0.0, 0.02, t);
  float fadeOut = 1.0 - smoothstep(0.45, 1.0, t);
  vAlpha = aPar.x * fadeIn * fadeOut;

  float idx = aPar.y;
  float cx = mod(idx, uGrid.x), cy = floor(idx / uGrid.x);
  vec2 luv = vec2(uv.x, fract(uv.y * aPar.z + aPar.w));
  luv = luv * (1.0 - 2.0 * uInset) + uInset;
  vUv = (vec2(cx, cy) + luv) / uGrid;
  vCol = aCol;

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
varying vec2  vUv;
varying vec3  vCol;
varying float vAlpha;
varying float vFogDepth;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a <= 0.004) discard;
  vec3 col = vCol * t.rgb;
  if (uFogRange.y > uFogRange.x) {
    float f = clamp((vFogDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
    col = mix(col, uFogColor, f * f * (3.0 - 2.0 * f));
  }
  gl_FragColor = vec4(col, a);
}
`;

/**
 * createDecals(engine, world, opts)
 *   opts: { capacity, seed, parent, segment, lift, atlasCell }
 */
export function createDecals(engine, world, opts = {}) {
  const {
    capacity = 1400, seed = 21, parent = null, segment = 0.42, lift = 0.045, atlasCell = 256,
  } = opts;

  const atlas = buildDecalAtlas({ cell: atlasCell });
  const rand = rng(seed);

  const data = new Float32Array(capacity * STRIDE);
  const expiry = new Float32Array(capacity);
  let cursor = 0, used = 0, dirtyLo = Infinity, dirtyHi = -Infinity, time = 0, stamped = 0;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = 0;
  const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
  buf.setUsage(THREE.DynamicDrawUsage);
  const attr = (n, size, off) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, size, off));
  attr('aPos', 3, OFF.pos); attr('aAx', 3, OFF.ax); attr('aAz', 3, OFF.az);
  attr('aLife', 2, OFF.life); attr('aCol', 3, OFF.col); attr('aPar', 4, OFF.par);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      uMap: { value: atlas.texture },
      uTime: { value: 0 },
      uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
      uInset: { value: 0.75 / atlas.cell },
      uFogColor: { value: new THREE.Color(0x9dc0dc) },
      uFogRange: { value: new THREE.Vector2(0, -1) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -6,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;                       // under the particles, over the ground
  mesh.name = 'vfx.decals';
  (parent || engine.scene).add(mesh);

  /* --------------------------------------------------------------- helpers ---- */
  function groundY(x, z, fallback) {
    if (world?.heightAt) { const h = world.heightAt(x, z); if (Number.isFinite(h)) return h; }
    return fallback;
  }
  function groundNormal(x, z, out) {
    if (world?.normalAt) {
      try { const n = world.normalAt(x, z, _nrm); if (n) return out.set(n.x, n.y, n.z).normalize(); } catch (e) { /* ignore */ }
    }
    return out.set(0, 1, 0);
  }

  /** Low-level write. ax/az are *half* axes in world space. */
  function write(pos, ax, az, kind, alpha, life, color, vTile, vOff) {
    const i = cursor;
    const b = i * STRIDE;
    data[b + 0] = pos.x; data[b + 1] = pos.y; data[b + 2] = pos.z;
    data[b + 3] = ax.x; data[b + 4] = ax.y; data[b + 5] = ax.z;
    data[b + 6] = az.x; data[b + 7] = az.y; data[b + 8] = az.z;
    data[b + 9] = time; data[b + 10] = life;
    data[b + 11] = color[0]; data[b + 12] = color[1]; data[b + 13] = color[2];
    data[b + 14] = alpha; data[b + 15] = DECAL_INDEX[kind] ?? 0; data[b + 16] = vTile; data[b + 17] = vOff;
    expiry[i] = time + life;
    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;
    cursor = (i + 1) % capacity;
    used = Math.min(capacity, Math.max(used, i + 1));
    geo.instanceCount = used;
    stamped++;
    return i;
  }

  const COLORS = {
    tyre: [0.30, 0.29, 0.30], scuff: [0.42, 0.38, 0.32],
    splat: [0.52, 0.40, 0.27], scorch: [0.18, 0.16, 0.15],
  };

  /* ----------------------------------------------------------------- stamp ---- */
  /**
   * stamp(kind, params)
   *   pos    world position (Vector3 | [x,y,z])
   *   dir    heading the quad's +z axis points along (defaults to +Z)
   *   size   metres (number, or [width, length])
   *   alpha, life, color, rot (extra yaw in radians)
   */
  function stamp(kind = 'scuff', params = {}) {
    const p = params.pos;
    if (!p) return -1;
    const px = p.x ?? p[0], pz = p.z ?? p[2];
    const py = groundY(px, pz, p.y ?? p[1] ?? 0) + lift;
    _m.set(px, py, pz);

    groundNormal(px, pz, _n);
    const d = params.dir;
    _a.set(d ? (d.x ?? d[0] ?? 0) : 0, 0, d ? (d.z ?? d[2] ?? 1) : 1);
    if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
    const rot = params.rot ?? (params.randomRot === false ? 0 : (rand() - 0.5) * 0.6);
    if (rot) {
      const ca = Math.cos(rot), sa = Math.sin(rot), ax = _a.x, az = _a.z;
      _a.set(ax * ca - az * sa, 0, ax * sa + az * ca);
    }
    // project heading onto the ground plane, then build an orthonormal ground frame
    _a.addScaledVector(_n, -_a.dot(_n)).normalize();
    _r.crossVectors(_a, _n).normalize();

    const size = params.size ?? 1;
    const w = (Array.isArray(size) ? size[0] : size) * 0.5;
    const l = (Array.isArray(size) ? size[1] : size) * 0.5;
    _r.multiplyScalar(w); _a.multiplyScalar(l);
    return write(_m, _r, _a, kind, clamp(params.alpha ?? 0.7, 0, 1), params.life ?? 12,
      params.color || COLORS[kind] || COLORS.scuff, params.vTile ?? 1, params.vOffset ?? 0);
  }

  /* ----------------------------------------------------------------- trail ---- */
  const trails = new Map();

  /**
   * trail(id, pos, dir, opts) — extend a continuous mark. Call every frame while the wheel
   * is laying rubber; call breakTrail(id) the moment it stops so the next mark starts clean.
   */
  function trail(id, pos, dir, o = {}) {
    const px = pos.x ?? pos[0], pz = pos.z ?? pos[2];
    const py = groundY(px, pz, pos.y ?? pos[1] ?? 0) + lift;
    let t = trails.get(id);
    if (!t) { t = { x: px, y: py, z: pz, v: 0, live: true }; trails.set(id, t); return -1; }
    if (!t.live) { t.x = px; t.y = py; t.z = pz; t.live = true; return -1; }

    const dx = px - t.x, dy = py - t.y, dz = pz - t.z;
    const len = Math.hypot(dx, dy, dz);
    const seg = o.segment ?? segment;
    if (len < seg) return -1;
    if (len > seg * 12) { t.x = px; t.y = py; t.z = pz; return -1; }   // teleport / respawn

    const mx = (px + t.x) * 0.5, my = (py + t.y) * 0.5, mz = (pz + t.z) * 0.5;
    groundNormal(mx, mz, _n);
    _a.set(dx, dy, dz);
    _r.crossVectors(_a, _n).setLength((o.width ?? 0.32) * 0.5);
    _a.multiplyScalar(0.5);
    _m.set(mx, my, mz);
    const vTile = Math.max(1, Math.round(len / (o.width ?? 0.32) * 0.6));
    const idx = write(_m, _r, _a, o.kind || 'tyre', clamp(o.alpha ?? 0.75, 0, 1),
      o.life ?? 14, o.color || COLORS[o.kind || 'tyre'], vTile, t.v);
    t.v = (t.v + vTile) % 1024;
    t.x = px; t.y = py; t.z = pz;
    return idx;
  }

  function breakTrail(id) { const t = trails.get(id); if (t) t.live = false; }

  /* ---------------------------------------------------------------- update ---- */
  function update(dt, t) {
    time = t !== undefined ? t : time + dt;
    material.uniforms.uTime.value = time;
    const fog = engine.scene.fog;
    if (fog) {
      material.uniforms.uFogColor.value.copy(fog.color);
      if (fog.isFog) material.uniforms.uFogRange.value.set(fog.near, fog.far);
      else material.uniforms.uFogRange.value.set(10, Math.max(40, 3.0 / Math.max(fog.density, 1e-5)));
    } else material.uniforms.uFogRange.value.set(0, -1);

    if (dirtyHi >= dirtyLo) {
      const lo = dirtyLo * STRIDE, count = (dirtyHi - dirtyLo + 1) * STRIDE;
      if (buf.addUpdateRange) { buf.clearUpdateRanges?.(); buf.addUpdateRange(lo, count); }
      buf.needsUpdate = true;
      dirtyLo = Infinity; dirtyHi = -Infinity;
    }
  }

  function alive() { let n = 0; for (let i = 0; i < used; i++) if (expiry[i] > time) n++; return n; }

  return {
    mesh, material, atlas, capacity,
    stamp, trail, breakTrail, update,
    get time() { return time; },
    setTime(t) { time = t; material.uniforms.uTime.value = t; },
    setQuality(q) { mesh.visible = q > 0.12; },
    stats() { return { alive: alive(), used, capacity, stamped, trails: trails.size }; },
    clear() {
      data.fill(0); expiry.fill(0); cursor = 0; used = 0; geo.instanceCount = 0; stamped = 0;
      buf.needsUpdate = true; trails.clear();
    },
    dispose() {
      (parent || engine.scene).remove(mesh);
      geo.dispose(); material.dispose(); atlas.dispose();
    },
  };
}

export default createDecals;
