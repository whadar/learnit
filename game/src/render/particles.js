/**
 * GPU-instanced VFX system for Kat Racing.
 *
 * Design
 *   - One InstancedBufferGeometry per blend mode (alpha / additive). A particle is 28 floats
 *     of *initial conditions*; the vertex shader integrates its whole life analytically
 *     (exponential drag + gravity + banded turbulence), so the CPU never touches a live
 *     particle again. Emission writes into a ring buffer and uploads one contiguous range.
 *   - Soft particles: optional depth prepass; smoke fades where it intersects the terrain
 *     instead of slicing it. Also fades against the near plane so the camera never punches
 *     a hole through a puff.
 *   - Every sprite comes from a procedurally rasterised atlas (vfxLibrary.js) — no downloads.
 *
 * Public API (contract):
 *   createVFX(engine, world, opts) -> {
 *     emit(type, params), update(dt, elapsed), attach(target, opts), setQuality(t),
 *     decals, ambience, speedLines, stats(), dispose()
 *   }
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep, damp, rng } from '../core/mathx.js';
import {
  buildSpriteAtlas, PRESETS, PALETTE, TIERS, tierColor, surfaceFX, SPRITE_INDEX,
} from './vfxLibrary.js';
import { createDecals } from './decals.js';

/* -------------------------------------------------------------- constants ---- */
const STRIDE = 28;
const OFF = { pos: 0, vel: 3, life: 6, size: 8, rot: 10, col0: 12, col1: 15, phys: 18, shape: 22, misc: 26 };
const MODE = { billboard: 0, flat: 1, upright: 2 };

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _size = new THREE.Vector2();
const _q1 = new THREE.Quaternion();
const _c1 = new THREE.Color();

/* -------------------------------------------------------------- art tuning ---- */
/**
 * Art-direction layer over `vfxLibrary.PRESETS`.
 *
 * The library presets are the *physics* of each effect; these overrides are the *look*, and
 * they live here because the look is a property of how this system composites — screen
 * blending with a sharpened coverage profile — not of the sprite atlas.
 *
 * The rule for every additive effect below: a large sprite never carries a high alpha, and
 * only a *small* sprite is allowed to be near-white. Body layers stay saturated (deep orange
 * for fire, the charge-tier hue for sparks) so that when the screen blend does drive a
 * channel to 1.0 the result is a hot core inside a coloured flame, not a white lobe.
 */
const FX_TUNE = {
  /* mini-turbo charge sparks: short, stretched, individually readable comets */
  driftSpark: {
    size: [0.19, 0.026], life: [0.20, 0.40], alpha: 0.85, stretch: 0.70,
    speed: [4.0, 9.5], spread: 0.75, jitter: 1.3, drag: 3.6, grav: -4.5,
    turb: [0.04, 3.0], spin: 5, fadeIn: 0.03,
  },
  /* the soft bloom that sits under a spark shower — small and dim, it is not the star */
  miniTurbo: { size: [0.24, 0.03], life: [0.13, 0.26], alpha: 0.34, speed: [0.8, 2.2] },

  /* exhaust fire. Deep orange body, cool blue-black smoke, white only in `boostCore`. */
  boostFlame: {
    size: [0.30, 0.74], life: [0.13, 0.23], alpha: 0.30,
    speed: [3.0, 7.0], spread: 0.20, jitter: 0.55, drag: 5.4, grav: 0.85,
    turb: [0.05, 3.4], stretch: 0.05, fadeIn: 0.07, spin: 1.2,
    colorA: [1.00, 0.60, 0.20], colorB: [1.00, 0.24, 0.045],
  },
  boostBurst: {
    count: 9, size: [0.36, 1.00], life: [0.20, 0.40], alpha: 0.26,
    speed: [5, 12], spread: 0.38, jitter: 1.6, drag: 4.6, grav: 1.0,
    turb: [0.14, 2.2], fadeIn: 0.05, spin: 2,
    colorA: [1.00, 0.68, 0.28], colorB: [1.00, 0.22, 0.04],
  },
  boostSmoke: {
    size: [0.24, 1.55], life: [0.45, 1.00], alpha: 0.22,
    speed: [1.2, 3.2], spread: 0.45, jitter: 0.7, drag: 2.4, grav: 0.9,
    colorA: [0.60, 0.56, 0.53], colorB: [0.26, 0.24, 0.25], fadeIn: 0.14,
  },
  ember: { size: [0.052, 0.011], alpha: 0.85, stretch: 0.45, life: [0.45, 1.0] },
  impactShock: { alpha: 0.42 },
};

/** Effects that exist only here: the shaped layers the boost flame is built from. */
const FX_EXTRA = {
  /** The white-hot kernel. Deliberately tiny — this is the only near-white boost layer. */
  boostCore: {
    sprite: 'flare', blend: 'add', count: 1, life: [0.10, 0.17], size: [0.19, 0.032],
    speed: [1.4, 3.2], spread: 0.14, jitter: 0.35, drag: 6.0, grav: 0.7, turb: [0.02, 3.0],
    alpha: 0.50, colorA: [1.0, 0.95, 0.84], colorB: [1.0, 0.62, 0.22], fadeIn: 0.02,
  },
  /** Charge-tier coloured tongue riding outside the orange fire (MK8 tints its mini-turbo). */
  boostTierFlame: {
    sprite: 'flame', blend: 'add', count: 1, life: [0.16, 0.30], size: [0.36, 0.95],
    speed: [3.5, 8.0], spread: 0.30, jitter: 0.8, drag: 5.0, grav: 1.0, turb: [0.08, 3.0],
    alpha: 0.20, colorA: [0.55, 0.85, 1.0], colorB: [0.20, 0.45, 0.9], fadeIn: 0.06, spin: 1.4,
  },
  /** Grit lifted off the road by the exhaust blast — gives the fire something to sit in. */
  boostGrit: {
    sprite: 'dust', blend: 'alpha', count: 1, life: [0.5, 1.1], size: [0.35, 2.0],
    speed: [2.0, 5.0], spread: 0.6, jitter: 1.0, drag: 2.2, grav: 0.75, turb: [0.3, 0.9],
    alpha: 0.34, colorA: [0.82, 0.78, 0.72], colorB: [0.45, 0.42, 0.40], fadeIn: 0.10, spin: 1.1,
  },
};

/* ---------------------------------------------------------------- shaders ---- */
const VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec3 aVel;
attribute vec2 aLife;     // t0, life
attribute vec2 aSize;     // size0, size1
attribute vec2 aRot;      // rot0, spin
attribute vec3 aCol0;
attribute vec3 aCol1;
attribute vec4 aPhys;     // drag, gravity, turbAmp, turbFreq
attribute vec4 aShape;    // alpha, spriteIndex, stretch, mode
attribute vec2 aMisc;     // fadeIn, seed

uniform float uTime;
uniform vec2  uGrid;      // atlas cols, rows
uniform float uInset;     // uv inset inside a cell, in cell fractions
uniform float uSizeScale;

varying vec2  vUv;
varying vec3  vCol;
varying float vAlpha;
varying float vViewZ;

void main() {
  float age = uTime - aLife.x;
  float life = max(aLife.y, 1e-4);
  float t = age / life;

  if (age < 0.0 || t >= 1.0 || aShape.x <= 0.0) {          // dead: collapse behind the camera
    vUv = vec2(0.0); vCol = vec3(0.0); vAlpha = 0.0; vViewZ = -1.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // --- analytic integration: v(t) = v0 e^(-k t),  plus gravity, plus banded turbulence ----
  float k = aPhys.x;
  float ex = (k > 1e-3) ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = aPos + aVel * ex;
  p.y += 0.5 * aPhys.y * age * age;

  float ph = aMisc.y * 6.2831853;
  float tf = aPhys.w;
  float ramp = smoothstep(0.0, 0.35, t);
  p += aPhys.z * ramp * vec3(
        sin(age * tf * 6.2831853 + ph),
        sin(age * tf * 4.7123 + ph * 2.3) * 0.6,
        cos(age * tf * 5.9 + ph * 1.7));

  // --- size / alpha curves -----------------------------------------------------------
  float easeOut = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(aSize.x, aSize.y, easeOut) * uSizeScale;
  float fadeIn = max(aMisc.x, 1e-3);
  float a = aShape.x * smoothstep(0.0, fadeIn, t) * pow(1.0 - t, 1.25);

  // --- placement ---------------------------------------------------------------------
  float ang = aRot.x + aRot.y * age;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = position.xy * size;
  vec2 qr = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);

  vec4 mv;
  if (aShape.w > 0.5 && aShape.w < 1.5) {
    // flat: lies in the world XZ plane (ripple rings, ground shock)
    vec3 wp = p + vec3(qr.x, 0.0, qr.y);
    mv = modelViewMatrix * vec4(wp, 1.0);
  } else if (aShape.w > 1.5) {
    // upright: billboards around Y only (flames, tall wisps keep their vertical axis)
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    vec3 wp = p + right * qr.x + vec3(0.0, qr.y, 0.0);
    mv = modelViewMatrix * vec4(wp, 1.0);
  } else {
    mv = modelViewMatrix * vec4(p, 1.0);
    if (aShape.z > 0.0) {                                   // stretch along screen velocity
      vec3 vv = (modelViewMatrix * vec4(aVel * exp(-k * age), 0.0)).xyz;
      vec2 d = vv.xy;
      float dl = length(d);
      if (dl > 1e-4) {
        d /= dl;
        vec2 n = vec2(-d.y, d.x);
        float st = 1.0 + aShape.z * min(dl, 40.0);
        mv.xy += n * qr.x + d * qr.y * st;
      } else { mv.xy += qr; }
    } else {
      mv.xy += qr;
    }
  }

  vViewZ = mv.z;

  // --- atlas cell --------------------------------------------------------------------
  float idx = aShape.y;
  float cx = mod(idx, uGrid.x);
  float cy = floor(idx / uGrid.x);
  vec2 luv = uv * (1.0 - 2.0 * uInset) + uInset;
  vUv = (vec2(cx, cy) + luv) / uGrid;

  vCol = mix(aCol0, aCol1, t);
  vAlpha = a;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;
#include <packing>

uniform sampler2D uMap;
uniform vec3  uFogColor;
uniform vec2  uFogRange;      // near, far  (far <= near disables)
uniform float uAdditive;
uniform float uBrightness;
uniform float uAlphaPow;
uniform vec2  uNearFar;
#ifdef SOFT
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uSoftness;
#endif

varying vec2  vUv;
varying vec3  vCol;
varying float vAlpha;
varying float vViewZ;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a <= 0.002) discard;
  // Sharpen the coverage profile: a gamma > 1 keeps the hot core and pulls the broad,
  // low-alpha skirt in, so a stack of glow sprites reads as a shape and not as a disc.
  a = pow(a, uAlphaPow);
  vec3 col = vCol * tex.rgb * uBrightness;

  float dist = -vViewZ;

  // never let a particle slice through the near plane
  a *= smoothstep(uNearFar.x * 1.5, uNearFar.x * 8.0, dist);

#ifdef SOFT
  vec2 suv = gl_FragCoord.xy / uResolution;
  float d = texture2D(uDepth, suv).x;
  float sceneVZ = perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
  a *= clamp((vViewZ - sceneVZ) / uSoftness, 0.0, 1.0);
#endif

  if (uFogRange.y > uFogRange.x) {
    float f = clamp((dist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
    f *= f * (3.0 - 2.0 * f);
    if (uAdditive > 0.5) a *= (1.0 - f);          // additive fades out rather than to grey
    else col = mix(col, uFogColor, f);
  }

#ifdef PREMUL
  // Screen blending (`dst + src*(1-dst)`) needs premultiplied source: the blend factor is
  // 1-dst, so the alpha has to already be folded into the colour.
  gl_FragColor = vec4(col * a, a);
#else
  gl_FragColor = vec4(col, a);
#endif
}
`;

/* ----------------------------------------------------------- ParticleBatch ---- */
/** One draw call's worth of particles: ring-buffered instances with a single upload range. */
export class ParticleBatch {
  constructor(atlas, {
    capacity = 2000, blend = 'alpha', name = 'particles', renderOrder = 10,
    soft = false, brightness = 1, alphaPow = 1,
  } = {}) {
    this.blend = blend;
    this.capacity = capacity;
    this.cursor = 0;
    this.used = 0;
    this.data = new Float32Array(capacity * STRIDE);
    this.expiry = new Float32Array(capacity);
    this._dirtyLo = Infinity; this._dirtyHi = -Infinity;

    const geo = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(quad, 2));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = 0;

    const buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    this.buffer = buf;
    const attr = (n, size, off) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, size, off));
    attr('aPos', 3, OFF.pos); attr('aVel', 3, OFF.vel); attr('aLife', 2, OFF.life);
    attr('aSize', 2, OFF.size); attr('aRot', 2, OFF.rot);
    attr('aCol0', 3, OFF.col0); attr('aCol1', 3, OFF.col1);
    attr('aPhys', 4, OFF.phys); attr('aShape', 4, OFF.shape); attr('aMisc', 2, OFF.misc);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // never frustum-cull
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uMap: { value: atlas.texture },
        uTime: { value: 0 },
        uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
        uInset: { value: 0.75 / atlas.cell },
        uSizeScale: { value: 1 },
        uFogColor: { value: new THREE.Color(0x9dc0dc) },
        uFogRange: { value: new THREE.Vector2(0, -1) },
        uAdditive: { value: blend === 'alpha' ? 0 : 1 },
        uBrightness: { value: brightness },
        uAlphaPow: { value: alphaPow },
        uNearFar: { value: new THREE.Vector2(0.25, 8000) },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uSoftness: { value: 1.4 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    // --- 'screen' blend: glow that physically cannot clip ------------------------------
    // Straight additive is why the boost flame used to erase the kart: every overlapping
    // sprite adds its full energy, so ten 0.9-alpha quads land at 9.0 and the framebuffer
    // clamps a huge region to flat white, with no shape, no hue and a bloom source that
    // reads as an HDR value of ~9 after the prefilter inverts the tone curve. Screen
    // blending — `out = dst + src * (1 - dst)` — spends the *remaining headroom* instead,
    // so a stack converges smoothly on white, never overshoots 1.0 (the scene target is
    // tone-mapped and sRGB-encoded, so dst is always in [0,1]), and the red channel of an
    // orange flame saturates well before green and blue: the core goes white-hot while the
    // body stays orange. It also caps what the bloom prefilter can ever see.
    this.premultiplied = blend === 'screen';
    if (this.premultiplied) {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneMinusDstColorFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    this._baseDefines = this.premultiplied ? { PREMUL: '' } : {};
    mat.defines = { ...this._baseDefines, ...(soft ? { SOFT: '' } : {}) };
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = name;
    this.geometry = geo;
  }

  get uniforms() { return this.material.uniforms; }

  setSoft(on) {
    const has = !!(this.material.defines && 'SOFT' in this.material.defines);
    if (on === has) return;
    this.material.defines = { ...this._baseDefines, ...(on ? { SOFT: '' } : {}) };
    this.material.needsUpdate = true;
  }

  /** Write one particle. `p` is a plain record; see emitOne() for the field list. */
  push(p) {
    const i = this.cursor;
    const b = i * STRIDE, d = this.data;
    d[b + 0] = p.px; d[b + 1] = p.py; d[b + 2] = p.pz;
    d[b + 3] = p.vx; d[b + 4] = p.vy; d[b + 5] = p.vz;
    d[b + 6] = p.t0; d[b + 7] = p.life;
    d[b + 8] = p.size0; d[b + 9] = p.size1;
    d[b + 10] = p.rot; d[b + 11] = p.spin;
    d[b + 12] = p.r0; d[b + 13] = p.g0; d[b + 14] = p.b0;
    d[b + 15] = p.r1; d[b + 16] = p.g1; d[b + 17] = p.b1;
    d[b + 18] = p.drag; d[b + 19] = p.grav; d[b + 20] = p.turbA; d[b + 21] = p.turbF;
    d[b + 22] = p.alpha; d[b + 23] = p.sprite; d[b + 24] = p.stretch; d[b + 25] = p.mode;
    d[b + 26] = p.fadeIn; d[b + 27] = p.seed;
    this.expiry[i] = p.t0 + p.life;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    this.cursor = (i + 1) % this.capacity;
    this.used = Math.min(this.capacity, Math.max(this.used, i + 1));
    this.geometry.instanceCount = this.used;
    return i;
  }

  /** Upload whatever changed this frame and advance the shader clock. */
  flush(time) {
    this.uniforms.uTime.value = time;
    if (this._dirtyHi >= this._dirtyLo) {
      const lo = this._dirtyLo * STRIDE, count = (this._dirtyHi - this._dirtyLo + 1) * STRIDE;
      if (this.buffer.addUpdateRange) {
        this.buffer.clearUpdateRanges?.();
        this.buffer.addUpdateRange(lo, count);
      }
      this.buffer.needsUpdate = true;
      this._dirtyLo = Infinity; this._dirtyHi = -Infinity;
    }
  }

  alive(time) {
    let n = 0;
    for (let i = 0; i < this.used; i++) if (this.expiry[i] > time) n++;
    return n;
  }

  clear() {
    this.data.fill(0); this.expiry.fill(0);
    this.cursor = 0; this.used = 0; this.geometry.instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/**
 * CPU mirror of the vertex-shader trajectory. Used by the headless sim to check that
 * particles land where the art direction says they should. Keep in sync with VERT.
 */
export function evalParticle(p, age) {
  const k = p.drag;
  const ex = k > 1e-3 ? (1 - Math.exp(-k * age)) / k : age;
  const ph = p.seed * Math.PI * 2, tf = p.turbF;
  const t = clamp(age / p.life, 0, 1);
  const ramp = smoothstep(0, 0.35, t);
  return {
    x: p.px + p.vx * ex + p.turbA * ramp * Math.sin(age * tf * 6.2831853 + ph),
    y: p.py + p.vy * ex + 0.5 * p.grav * age * age + p.turbA * ramp * Math.sin(age * tf * 4.7123 + ph * 2.3) * 0.6,
    z: p.pz + p.vz * ex + p.turbA * ramp * Math.cos(age * tf * 5.9 + ph * 1.7),
    size: lerp(p.size0, p.size1, 1 - (1 - t) * (1 - t)),
    alpha: age < 0 || t >= 1 ? 0 : p.alpha * smoothstep(0, Math.max(p.fadeIn, 1e-3), t) * Math.pow(1 - t, 1.25),
  };
}

/* ------------------------------------------------------------ trail ribbon ---- */
const RIBBON_VERT = /* glsl */`
attribute float aAge;
attribute float aSide;
uniform float uTime;
uniform float uFade;
varying float vT;
varying float vSide;
void main() {
  vT = clamp((uTime - aAge) / uFade, 0.0, 1.0);
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RIBBON_FRAG = /* glsl */`
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uIntensity;
varying float vT;
varying float vSide;
void main() {
  float edge = 1.0 - abs(vSide);
  float a = pow(1.0 - vT, 1.6) * pow(edge, 0.65) * uIntensity;
  vec3 col = mix(uColorA, uColorB, vT * 0.85 + (1.0 - edge) * 0.3);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(col * a, a);
}
`;

/** A rolling triangle strip left behind the kart during a boost. */
export class TrailRibbon {
  constructor({ segments = 34, width = 0.42, fade = 0.55, colorA = PALETTE.boostCore, colorB = PALETTE.sparkBlue } = {}) {
    this.segments = segments; this.width = width; this.fade = fade;
    this.points = []; this.time = 0; this.intensity = 0;
    const n = segments;
    const pos = new Float32Array(n * 2 * 3);
    const age = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; age[i * 2] = age[i * 2 + 1] = -1e9; }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAge', new THREE.BufferAttribute(age, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
      uniforms: {
        uTime: { value: 0 }, uFade: { value: fade }, uIntensity: { value: 1 },
        uColorA: { value: new THREE.Color().fromArray(colorA) },
        uColorB: { value: new THREE.Color().fromArray(colorB) },
      },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }

  /** Push a new head sample; `p` world position, `right` lateral unit vector. */
  push(p, right, time, width = this.width) {
    this.points.unshift({ x: p.x, y: p.y, z: p.z, rx: right.x, ry: right.y, rz: right.z, t: time, w: width });
    if (this.points.length > this.segments) this.points.length = this.segments;
  }

  setIntensity(v) { this.material.uniforms.uIntensity.value = v; this.mesh.visible = v > 0.01 && this.points.length > 2; }

  update(time) {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    const pos = this.geometry.attributes.position.array;
    const age = this.geometry.attributes.aAge.array;
    const n = this.segments;
    for (let i = 0; i < n; i++) {
      const p = this.points[Math.min(i, this.points.length - 1)];
      if (!p) break;
      const taper = 1 - i / n;
      const w = p.w * (0.35 + 0.65 * taper);
      pos[i * 6 + 0] = p.x - p.rx * w; pos[i * 6 + 1] = p.y - p.ry * w; pos[i * 6 + 2] = p.z - p.rz * w;
      pos[i * 6 + 3] = p.x + p.rx * w; pos[i * 6 + 4] = p.y + p.ry * w; pos[i * 6 + 5] = p.z + p.rz * w;
      age[i * 2] = age[i * 2 + 1] = p.t;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAge.needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/* -------------------------------------------------------------- speed FX ---- */
const SPEEDLINE_VERT = /* glsl */`
attribute vec3 aSeed;
uniform float uTime;
uniform float uIntensity;
uniform float uAspect;
varying float vA;
varying vec2 vUvL;
void main() {
  float sp = 0.9 + aSeed.z * 1.6;
  float cyc = fract(aSeed.x * 7.13 + uTime * sp);
  float ang = aSeed.y * 6.2831853;
  // lines rush outward from the screen centre
  float r = mix(0.10, 1.55, pow(cyc, 0.55));
  vec2 dir = vec2(cos(ang), sin(ang));
  float len = mix(0.06, 0.30, aSeed.z) * (0.4 + uIntensity);
  vec2 c = dir * r;
  vec2 tangent = dir, normal = vec2(-dir.y, dir.x);
  vec2 local = position.xy;
  vec2 p = c + tangent * local.y * len + normal * local.x * 0.012;
  p.x /= max(uAspect, 0.001);
  vA = uIntensity * smoothstep(0.10, 0.45, r) * (1.0 - smoothstep(0.9, 1.5, r)) * (0.35 + 0.65 * aSeed.z);
  vUvL = uv;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;
const SPEEDLINE_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vA;
varying vec2 vUvL;
void main() {
  float across = 1.0 - abs(vUvL.x * 2.0 - 1.0);
  float along = sin(vUvL.y * 3.14159);
  float a = vA * pow(across, 1.4) * along;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/** Screen-space rush lines + a subtle refractive warp ring, both parented to the camera. */
export function createSpeedFX({ count = 120, seed = 99 } = {}) {
  const r = rng(seed);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1], 2));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) seeds[i] = r();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPEEDLINE_VERT, fragmentShader: SPEEDLINE_FRAG,
    uniforms: {
      uTime: { value: 0 }, uIntensity: { value: 0 }, uAspect: { value: 1.777 },
      uColor: { value: new THREE.Color(0xdff0ff) },
    },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 900; mesh.visible = false;

  // --- warp: a thin quad just in front of the near plane. When post-processing hands us a
  // scene texture we refract it; otherwise we fall back to a chromatic shimmer ring, which
  // still reads as heat/velocity distortion at the edges of frame.
  const warpMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uIntensity: { value: 0 }, uAspect: { value: 1.777 },
      uScene: { value: null }, uHasScene: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUvW;
      void main() { vUvW = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uIntensity, uAspect, uHasScene;
      uniform sampler2D uScene;
      varying vec2 vUvW;
      void main() {
        vec2 c = (vUvW - 0.5) * vec2(uAspect, 1.0);
        float r = length(c);
        float wob = sin(r * 26.0 - uTime * 7.0) * 0.5 + 0.5;
        float band = smoothstep(0.18, 0.62, r) * wob * uIntensity;
        if (uHasScene > 0.5) {
          vec2 off = normalize(c + 1e-5) * band * 0.012;
          vec3 col = vec3(
            texture2D(uScene, vUvW + off * 1.15).r,
            texture2D(uScene, vUvW + off).g,
            texture2D(uScene, vUvW + off * 0.85).b);
          gl_FragColor = vec4(col, 1.0);
        } else {
          float a = band * 0.16;
          vec3 tint = mix(vec3(0.55, 0.75, 1.0), vec3(1.0, 0.82, 0.55), wob);
          if (a <= 0.002) discard;
          gl_FragColor = vec4(tint * a, a);
        }
      }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const warp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), warpMat);
  warp.frustumCulled = false; warp.renderOrder = 901; warp.visible = false;

  return {
    mesh, warp, material: mat, warpMaterial: warpMat,
    set intensity(v) {
      mat.uniforms.uIntensity.value = v;
      warpMat.uniforms.uIntensity.value = v;
      mesh.visible = v > 0.01;
      warp.visible = v > 0.01 || warpMat.uniforms.uHasScene.value > 0.5;
    },
    get intensity() { return mat.uniforms.uIntensity.value; },
    setSceneTexture(tex) { warpMat.uniforms.uScene.value = tex; warpMat.uniforms.uHasScene.value = tex ? 1 : 0; },
    update(dt, time, aspect) {
      mat.uniforms.uTime.value = time; warpMat.uniforms.uTime.value = time;
      mat.uniforms.uAspect.value = aspect; warpMat.uniforms.uAspect.value = aspect;
    },
    dispose() { geo.dispose(); mat.dispose(); warp.geometry.dispose(); warpMat.dispose(); },
  };
}

/* -------------------------------------------------------------- ambience ---- */
const SWARM_VERT = /* glsl */`
attribute vec4 aSeed;                 // x,y,z position seed + w variation
uniform float uTime;
uniform vec3  uBox;                   // volume size
uniform vec3  uDrift;                 // m/s
uniform vec2  uSize;                  // min,max world size
uniform float uMode;                  // 0 mote/pollen, 1 leaf tumble, 2 bird orbit, 3 shimmer band
uniform float uWobble;
uniform vec3  uSunDir;
uniform float uOpacity;
uniform vec2  uGrid;
uniform float uSprite;
uniform float uInset;
varying vec2  vUv;
varying float vA;

void main() {
  vec3 p;
  float size = mix(uSize.x, uSize.y, aSeed.w);
  float spin = 0.0;
  float glint = 1.0;

  if (uMode < 2.5) {
    vec3 base = (aSeed.xyz - 0.5) * uBox;
    p = base + uDrift * uTime;
    float w = uWobble;
    p += w * vec3(
      sin(uTime * (0.5 + aSeed.w) + aSeed.x * 21.0),
      sin(uTime * (0.7 + aSeed.z) + aSeed.y * 17.0) * (uMode > 0.5 ? 1.6 : 0.5),
      cos(uTime * (0.6 + aSeed.y) + aSeed.z * 13.0));
    p = mod(p + uBox * 0.5, uBox) - uBox * 0.5;              // wrap inside the volume
    if (uMode > 0.5) spin = uTime * (1.2 + aSeed.w * 2.5) + aSeed.x * 6.28;
  } else if (uMode < 3.5) {
    float R = mix(28.0, 96.0, aSeed.x);
    float sp = mix(0.06, 0.14, aSeed.y) * (aSeed.w > 0.5 ? 1.0 : -1.0);
    float a = uTime * sp + aSeed.z * 6.2831853;
    p = vec3(cos(a) * R, (aSeed.y - 0.5) * uBox.y + sin(uTime * 0.3 + aSeed.x * 5.0) * 2.0, sin(a) * R);
    float flap = sin(uTime * (5.0 + aSeed.w * 3.0) + aSeed.z * 9.0);
    size *= 1.0 + flap * 0.18;
    spin = -a + 1.5707963;
  } else {
    // shimmer band: wide, low quads hugging the ground, gently breathing
    vec3 base = (aSeed.xyz - 0.5) * uBox;
    p = base;
    p.y += sin(uTime * 1.7 + aSeed.x * 12.0) * 0.12;
    spin = 0.0;
  }

  float ca = cos(spin), sa = sin(spin);
  vec2 q = position.xy * size * (uMode > 3.5 ? vec2(6.0, 0.6) : vec2(1.0));
  vec2 qr = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += qr;

  // dust motes catch the low sun: brightest when you look into it
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 toCam = normalize(cameraPosition - wp);
  glint = mix(0.55, 1.85, pow(max(dot(toCam, uSunDir), 0.0), 3.0));

  float fade = 1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.52, length(p.xz));
  vA = uOpacity * (uMode < 1.5 ? glint : 1.0) * (uMode > 2.5 ? 1.0 : fade);

  float cx = mod(uSprite, uGrid.x), cy = floor(uSprite / uGrid.x);
  vec2 luv = uv * (1.0 - 2.0 * uInset) + uInset;
  vUv = (vec2(cx, cy) + luv) / uGrid;
  gl_Position = projectionMatrix * mv;
}
`;
const SWARM_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uAdditive;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
varying vec2 vUv;
varying float vA;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vA;
  if (a <= 0.003) discard;
  vec3 col = uColor * t.rgb;
  gl_FragColor = vec4(uAdditive > 0.5 ? col * a : col, a);
}
`;

/** One instanced ambient layer (motes, pollen, leaves, birds, heat shimmer). */
function createSwarm(atlas, opts) {
  const {
    count = 200, sprite = 'mote', color = PALETTE.white, box = [60, 14, 60], drift = [0.4, 0, 0.2],
    size = [0.05, 0.12], mode = 0, wobble = 0.6, opacity = 0.6, blend = 'add', seed = 7, name = 'swarm',
  } = opts;
  const r = rng(seed);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const s = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) s[i] = r();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s, 4));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SWARM_VERT, fragmentShader: SWARM_FRAG,
    uniforms: {
      uMap: { value: atlas.texture },
      uTime: { value: 0 },
      uBox: { value: new THREE.Vector3(...box) },
      uDrift: { value: new THREE.Vector3(...drift) },
      uSize: { value: new THREE.Vector2(size[0], size[1]) },
      uMode: { value: mode },
      uWobble: { value: wobble },
      uSunDir: { value: new THREE.Vector3(-0.4, 0.55, 0.72).normalize() },
      uOpacity: { value: opacity },
      uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
      uSprite: { value: atlas.index(sprite) },
      uInset: { value: 0.75 / atlas.cell },
      uColor: { value: new THREE.Color().fromArray(color) },
      uAdditive: { value: blend === 'add' ? 1 : 0 },
      uFogColor: { value: new THREE.Color(0x9dc0dc) },
      uFogRange: { value: new THREE.Vector2(0, -1) },
    },
    transparent: true, depthWrite: false, depthTest: true,
    blending: blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.name = name;
  return { mesh, material: mat, uniforms: mat.uniforms, count, dispose() { geo.dispose(); mat.dispose(); } };
}

/* ------------------------------------------------------------- depth pass ---- */
/** Half-res depth prepass so smoke can fade softly into the terrain instead of slicing it. */
function createDepthPass(engine, scale = 0.5) {
  const size = new THREE.Vector2();
  engine.renderer.getDrawingBufferSize(size);
  const w = Math.max(2, Math.floor(size.x * scale)), h = Math.max(2, Math.floor(size.y * scale));
  const target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
  target.depthTexture = new THREE.DepthTexture(w, h);
  target.depthTexture.type = THREE.UnsignedIntType;
  target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
  const depthMat = new THREE.MeshDepthMaterial();
  let hidden = [];
  return {
    target, scale,
    resize() {
      engine.renderer.getDrawingBufferSize(size);
      target.setSize(Math.max(2, Math.floor(size.x * scale)), Math.max(2, Math.floor(size.y * scale)));
    },
    /** Render scene depth with the VFX group hidden. */
    render(scene, camera, skip) {
      hidden.length = 0;
      for (const o of skip) if (o && o.visible) { o.visible = false; hidden.push(o); }
      const prevTarget = engine.renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      const prevBg = scene.background;
      scene.overrideMaterial = depthMat;
      scene.background = null;
      engine.renderer.setRenderTarget(target);
      engine.renderer.clear(true, true, false);
      engine.renderer.render(scene, camera);
      engine.renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      for (const o of hidden) o.visible = true;
    },
    dispose() { target.dispose(); depthMat.dispose(); },
  };
}

/* ------------------------------------------------------------- the system ---- */
/**
 * createVFX(engine, world, opts)
 *
 * opts: { quality, seed, capacity:{alpha,add}, soft, ambience, decals, sunDirection }
 */
export function createVFX(engine, world, opts = {}) {
  const {
    seed = 1337, quality = 1, soft = false, softScale = 0.5,
    ambience = true, decals: decalOpts = {}, capacity = {},
  } = opts;

  const atlas = buildSpriteAtlas({ cell: opts.atlasCell || 128 });
  const rand = rng(seed);
  const group = new THREE.Group();
  group.name = 'vfx';
  group.matrixAutoUpdate = false;
  engine.scene.add(group);

  const q = { value: clamp(quality, 0, 1) };
  const capAlpha = Math.round((capacity.alpha ?? 2600) * lerp(0.35, 1, q.value));
  const capAdd = Math.round((capacity.add ?? 1800) * lerp(0.35, 1, q.value));

  const batches = {
    alpha: new ParticleBatch(atlas, { capacity: capAlpha, blend: 'alpha', name: 'vfx.alpha', renderOrder: 10, soft, brightness: 1.0 }),
    // `screen`, not `add`: see the note in ParticleBatch. alphaPow tightens the glow skirt.
    add: new ParticleBatch(atlas, { capacity: capAdd, blend: 'screen', name: 'vfx.add', renderOrder: 11, soft: false, brightness: 1.06, alphaPow: 1.3 }),
  };
  group.add(batches.alpha.mesh, batches.add.mesh);

  // --- decals (sibling module; degrade gracefully rather than take the whole system down) -
  let decals = null;
  try {
    decals = createDecals(engine, world, { seed: seed + 5, parent: group, ...decalOpts });
  } catch (e) { console.warn('[vfx] decals unavailable:', e.message); decals = null; }

  // --- speed FX (camera children) --------------------------------------------------
  const speedFX = createSpeedFX({ count: Math.round(lerp(50, 150, q.value)), seed: seed + 11 });
  engine.camera.add(speedFX.mesh, speedFX.warp);
  if (!engine.scene.children.includes(engine.camera)) engine.scene.add(engine.camera);

  // --- ambience ---------------------------------------------------------------------
  const amb = { layers: [], group: new THREE.Group() };
  amb.group.name = 'vfx.ambience';
  group.add(amb.group);
  const sunDir = new THREE.Vector3(...(opts.sunDirection || [-0.45, 0.62, 0.64])).normalize();

  if (ambience) {
    const mk = (o) => { const s = createSwarm(atlas, o); s.uniforms.uSunDir.value.copy(sunDir); amb.group.add(s.mesh); amb.layers.push(s); return s; };
    amb.motes = mk({ name: 'motes', sprite: 'mote', count: Math.round(260 * q.value + 60), color: PALETTE.heat, box: [70, 16, 70], drift: [0.55, 0.05, 0.35], size: [0.035, 0.11], mode: 0, wobble: 0.5, opacity: 0.5, blend: 'add', seed: seed + 21, follow: 'camera' });
    amb.pollen = mk({ name: 'pollen', sprite: 'mote', count: Math.round(200 * q.value + 40), color: PALETTE.pollen, box: [90, 10, 90], drift: [1.4, 0.1, 0.9], size: [0.05, 0.16], mode: 0, wobble: 0.9, opacity: 0.42, blend: 'add', seed: seed + 22 });
    amb.chaff = mk({ name: 'chaff', sprite: 'straw', count: Math.round(90 * q.value + 20), color: PALETTE.straw, box: [70, 8, 70], drift: [2.1, 0.15, 1.3], size: [0.06, 0.2], mode: 1, wobble: 1.1, opacity: 0.55, blend: 'alpha', seed: seed + 23 });
    amb.leaves = mk({ name: 'leaves', sprite: 'leaf', count: Math.round(70 * q.value + 16), color: PALETTE.leafDry, box: [60, 6, 60], drift: [2.6, 0.2, 1.6], size: [0.1, 0.26], mode: 1, wobble: 1.4, opacity: 0.85, blend: 'alpha', seed: seed + 24 });
    amb.birds = mk({ name: 'birds', sprite: 'bird', count: 14, color: [0.28, 0.26, 0.24], box: [140, 26, 140], drift: [0, 0, 0], size: [0.9, 2.0], mode: 3, wobble: 0, opacity: 0.85, blend: 'alpha', seed: seed + 25 });
    amb.shimmer = mk({ name: 'shimmer', sprite: 'wisp', count: 40, color: PALETTE.heat, box: [180, 1.2, 180], drift: [0, 0, 0], size: [1.4, 3.0], mode: 4, wobble: 0, opacity: 0.11, blend: 'add', seed: seed + 26 });
    amb.birds.mesh.renderOrder = 6;
  }

  // --- soft-particle depth prepass --------------------------------------------------
  let depthPass = null;
  if (soft) {
    try {
      depthPass = createDepthPass(engine, softScale);
      const u = batches.alpha.uniforms;
      u.uDepth.value = depthPass.target.depthTexture;
      batches.alpha.setSoft(true);
    } catch (e) { console.warn('[vfx] soft particles unavailable:', e.message); depthPass = null; }
  }

  /* ------------------------------------------------------------- emission ---- */
  // Library physics + the local art tuning, resolved once.
  const FX = {};
  for (const k of Object.keys(PRESETS)) FX[k] = FX_TUNE[k] ? { ...PRESETS[k], ...FX_TUNE[k] } : PRESETS[k];
  for (const k of Object.keys(FX_EXTRA)) FX[k] = FX_EXTRA[k];

  let time = 0;
  const rec = {};             // reused particle record — zero allocation per particle
  const stats = { emitted: 0, bursts: 0 };

  function vecOf(v, def) {
    if (!v) return def;
    if (Array.isArray(v)) return _v3.set(v[0], v[1], v[2]);
    return _v3.set(v.x, v.y, v.z);
  }

  /** Emit a single particle from a preset + overrides. */
  function emitOne(P, o) {
    const blend = o.blend || P.blend || 'alpha';
    const batch = blend === 'add' ? batches.add : batches.alpha;
    const px = o._px, py = o._py, pz = o._pz;

    // direction: base dir + cone spread
    const spread = o.spread ?? P.spread ?? 0;
    let dx = o._dx, dy = o._dy, dz = o._dz;
    if (spread > 0) {
      const a = (rand() * 2 - 1) * spread, b = (rand() * 2 - 1) * spread;
      // rotate the base direction by two small angles around arbitrary perpendicular axes
      const len = Math.hypot(dx, dy, dz) || 1;
      let ux = -dz / len, uy = 0, uz = dx / len;                 // horizontal perpendicular
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uz /= ul;
      const wx = uy * dz - uz * dy, wy = uz * dx - ux * dz, wz = ux * dy - uy * dx;
      const wl = Math.hypot(wx, wy, wz) || 1;
      dx += (ux * Math.sin(a) + wx / wl * Math.sin(b)) * len;
      dy += (uy * Math.sin(a) + wy / wl * Math.sin(b)) * len;
      dz += (uz * Math.sin(a) + wz / wl * Math.sin(b)) * len;
    }
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    const spd0 = (o.speed ?? P.speed)[0], spd1 = (o.speed ?? P.speed)[1];
    const spdScale = o.speedScale ?? 1;
    const spd = lerp(spd0, spd1, rand()) * spdScale;
    const jit = (o.jitter ?? P.jitter ?? 0) * spdScale;

    const life = lerp((o.life ?? P.life)[0], (o.life ?? P.life)[1], rand()) * (o.lifeScale ?? 1);
    const sizeScale = (o.scale ?? 1);
    const sz = o.size ?? P.size;

    rec.px = px; rec.py = py; rec.pz = pz;
    rec.vx = dx * spd + (rand() * 2 - 1) * jit + (o.vx || 0);
    rec.vy = dy * spd + (rand() * 2 - 1) * jit * 0.7 + (o.vy || 0);
    rec.vz = dz * spd + (rand() * 2 - 1) * jit + (o.vz || 0);
    rec.t0 = time; rec.life = life;
    rec.size0 = sz[0] * sizeScale * (0.8 + rand() * 0.45);
    rec.size1 = sz[1] * sizeScale * (0.8 + rand() * 0.45);
    rec.rot = rand() * Math.PI * 2;
    rec.spin = ((o.spin ?? P.spin ?? 0)) * (rand() * 2 - 1);
    rec.drag = o.drag ?? P.drag ?? 1;
    rec.grav = o.grav ?? P.grav ?? 0;
    rec.turbA = (o.turb ?? P.turb ?? [0, 0])[0] * sizeScale;
    rec.turbF = (o.turb ?? P.turb ?? [0, 0])[1];
    rec.alpha = (o.alpha ?? P.alpha ?? 1) * (o.opacity ?? 1);
    rec.sprite = SPRITE_INDEX[o.sprite || P.sprite] ?? 0;
    rec.stretch = o.stretch ?? P.stretch ?? 0;
    rec.mode = o.mode ?? P.mode ?? (P.flat ? MODE.flat : MODE.billboard);
    rec.fadeIn = o.fadeIn ?? P.fadeIn ?? 0.05;
    rec.seed = rand();

    const cA = o.colorA || P.colorA || PALETTE.white;
    const cB = o.colorB || P.colorB || cA;
    if (Array.isArray(cA)) { rec.r0 = cA[0]; rec.g0 = cA[1]; rec.b0 = cA[2]; }
    else { _c1.set(cA); rec.r0 = _c1.r; rec.g0 = _c1.g; rec.b0 = _c1.b; }
    if (Array.isArray(cB)) { rec.r1 = cB[0]; rec.g1 = cB[1]; rec.b1 = cB[2]; }
    else { _c1.set(cB); rec.r1 = _c1.r; rec.g1 = _c1.g; rec.b1 = _c1.b; }
    const tint = o.tint ?? 1;
    if (tint !== 1) {
      rec.r0 *= tint; rec.g0 *= tint; rec.b0 *= tint;
      rec.r1 *= tint; rec.g1 *= tint; rec.b1 *= tint;
    }
    batch.push(rec);
    stats.emitted++;
    return rec;
  }

  /** Composite effects: one name, several presets. */
  const COMPOSITE = {
    splash: [
      { p: 'splash' }, { p: 'splashMist' },
      { p: 'ripple', count: 2, mode: MODE.flat, dirUp: true },
    ],
    impact: [
      { p: 'impact' }, { p: 'impactShock' }, { p: 'squashPuff' }, { p: 'starBurst', count: 6 },
    ],
    explosion: [
      { p: 'explosionCore' }, { p: 'explosionSmoke' }, { p: 'impactShock', count: 1, scale: 1.8 },
      { p: 'ember', count: 22 }, { p: 'railSpark', count: 14 },
    ],
    // A mini-turbo pop, layered so it has a silhouette: a saturated orange fan, a small
    // white kernel, a tier-coloured tongue, embers, and smoke/grit behind it for contrast.
    boostBurst: [
      { p: 'boostBurst', own: true },
      { p: 'boostCore', count: 4, scale: 1.5, own: true },
      { p: 'boostTierFlame', count: 6, scale: 1.15, tier: true },
      { p: 'ember', count: 12, own: true },
      { p: 'boostSmoke', count: 7, scale: 1.2, own: true },
      { p: 'boostGrit', count: 5, scale: 1.1 },
      { p: 'impactShock', count: 1, scale: 0.30, own: true },
    ],
    spinOut: [
      { p: 'starBurst', count: 10 }, { p: 'squashPuff', count: 10 }, { p: 'dust', count: 8 },
    ],
    railSparks: [{ p: 'railSpark' }, { p: 'squashPuff', count: 4, scale: 0.5 }],
  };

  /**
   * emit(type, params)
   *   pos      Vector3 | [x,y,z]        world position (required)
   *   dir      Vector3 | [x,y,z]        emission direction, default +Y
   *   count    number                   override the preset burst size
   *   scale    number                   size multiplier
   *   speedScale, lifeScale, opacity, tint, colorA, colorB, sprite, spread, drag, grav
   */
  function emit(type, params = {}) {
    // `raw` asks for the single preset even when a composite shares the name
    const comp = (params.raw && FX[type]) ? null : COMPOSITE[type];
    const pos = vecOf(params.pos, _v3.set(0, 0, 0));
    const px = pos.x, py = pos.y, pz = pos.z;
    const d = params.dir ? vecOf(params.dir, null) : null;
    const dx = d ? d.x : 0, dy = d ? d.y : 1, dz = d ? d.z : 0;

    if (comp) {
      stats.bursts++;
      for (const c of comp) {
        const P = FX[c.p];
        if (!P) continue;
        const n = Math.max(1, Math.round((c.count ?? P.count ?? 1) * (params.countScale ?? 1) * qEmit()));
        const o = { ...params };
        // By default a component inherits the caller's tint (surface colours for dust and
        // splashes). `own` pins a layer to its authored colours so a multi-layer effect
        // keeps its internal colour structure; `tier` gives it the charge-tier hue.
        if (c.own) { o.colorA = P.colorA; o.colorB = P.colorB; }
        if (c.tier) { o.colorA = params.tierA || P.colorA; o.colorB = params.tierB || P.colorB; }
        if (c.alpha !== undefined) o.alpha = c.alpha;
        o.scale = (params.scale ?? 1) * (c.scale ?? 1);
        o._px = px; o._py = py; o._pz = pz;
        if (c.dirUp) { o._dx = 0; o._dy = 1; o._dz = 0; o.mode = MODE.flat; }
        else { o._dx = dx; o._dy = dy; o._dz = dz; }
        if (c.mode !== undefined) o.mode = c.mode;
        for (let i = 0; i < n; i++) emitOne(P, o);
      }
      return;
    }

    const P = FX[type];
    if (!P) { console.warn('[vfx] unknown effect: ' + type); return; }
    const n = Math.max(1, Math.round((params.count ?? P.count ?? 1) * (params.raw ? 1 : qEmit())));
    const o = params;
    o._px = px; o._py = py; o._pz = pz;
    o._dx = dx; o._dy = dy; o._dz = dz;
    for (let i = 0; i < n; i++) emitOne(P, o);
  }

  const qEmit = () => lerp(0.4, 1, q.value);

  /* -------------------------------------------------------------- attach ---- */
  const rigs = [];

  /**
   * attach(target, opts) — bind a continuous emitter rig to a kart.
   * `target` may be a THREE.Object3D, a vehicle handle (position/quaternion/velocity/
   * drifting/driftTier/boosting/surface/grounded), or any object exposing `vfxState`.
   */
  function attach(target, o = {}) {
    const rig = createKartRig(api, world, target, { seed: seed + rigs.length * 17 + 3, ...o });
    rigs.push(rig);
    return rig;
  }

  /* -------------------------------------------------------------- update ---- */
  const camPos = new THREE.Vector3();
  const followOrigin = new THREE.Vector3();
  let aspect = 1.777;

  function update(dt, elapsed) {
    dt = Math.min(dt, 1 / 12);
    time += dt;
    if (decals) decals.setTime(time);          // stamps this frame must carry this frame's clock

    for (const r of rigs) r.update(dt, time);

    const cam = engine.camera;
    cam.getWorldPosition(camPos);
    aspect = cam.aspect || aspect;

    // fog + camera params travel into every particle shader
    const fog = engine.scene.fog;
    let fnear = 0, ffar = -1, fcol = null;
    if (fog) {
      fcol = fog.color;
      if (fog.isFog) { fnear = fog.near; ffar = fog.far; }
      else if (fog.isFogExp2) { fnear = 10; ffar = Math.max(40, 3.0 / Math.max(fog.density, 1e-5)); }
    }
    for (const k of ['alpha', 'add']) {
      const b = batches[k], u = b.uniforms;
      u.uNearFar.value.set(cam.near, cam.far);
      if (fcol) { u.uFogColor.value.copy(fcol); u.uFogRange.value.set(fnear, ffar); }
      else u.uFogRange.value.set(0, -1);
      b.flush(time);
    }

    // ambience volumes follow the camera so the world always feels populated
    if (amb.layers.length) {
      const gy = world?.heightAt ? world.heightAt(camPos.x, camPos.z) : 0;
      for (const l of amb.layers) {
        l.uniforms.uTime.value = time;
        if (fcol) { l.uniforms.uFogColor.value.copy(fcol); l.uniforms.uFogRange.value.set(fnear, ffar); }
      }
      amb.motes && amb.motes.mesh.position.set(camPos.x, camPos.y, camPos.z);
      amb.pollen && amb.pollen.mesh.position.set(camPos.x, gy + 3.5, camPos.z);
      amb.chaff && amb.chaff.mesh.position.set(camPos.x, gy + 2.2, camPos.z);
      amb.leaves && amb.leaves.mesh.position.set(camPos.x, gy + 1.4, camPos.z);
      amb.birds && amb.birds.mesh.position.set(
        Math.round(camPos.x / 220) * 220, gy + 62, Math.round(camPos.z / 220) * 220);
      if (amb.shimmer) {
        amb.shimmer.mesh.position.set(camPos.x, gy + 0.65, camPos.z);
        // keep the shimmer band sitting on the ground as the camera travels
        if (world?.heightAt && (engine.frame % 12) === 0) {
          amb.shimmer.mesh.position.y = world.heightAt(camPos.x, camPos.z) + 0.7;
        }
      }
    }

    speedFX.update(dt, time, aspect);
    if (decals) decals.update(dt, time);

    if (depthPass) {
      depthPass.render(engine.scene, cam, [group, speedFX.mesh, speedFX.warp]);
      engine.renderer.getDrawingBufferSize(_size);
      batches.alpha.uniforms.uResolution.value.set(_size.x, _size.y);
    }
  }

  function resize(w, h) {
    aspect = w / Math.max(h, 1);
    depthPass?.resize();
  }

  function setQuality(t) {
    q.value = clamp(t, 0, 1);
    const e = q.value;
    for (const l of amb.layers) {
      l.mesh.visible = e > 0.18;
      l.uniforms.uOpacity.value = l.uniforms.uOpacity.value;   // opacity kept; count scales at build
      l.mesh.geometry.instanceCount = Math.max(4, Math.round(l.count * lerp(0.25, 1, e)));
    }
    speedFX.mesh.geometry.instanceCount = Math.max(12, Math.round(speedFX.mesh.geometry.attributes.aSeed.count * lerp(0.3, 1, e)));
    if (decals) decals.setQuality?.(e);
    if (e < 0.35 && depthPass) batches.alpha.setSoft(false);
    else if (depthPass) batches.alpha.setSoft(true);
    return q.value;
  }

  function setSunDirection(x, y, z) {
    sunDir.set(x, y, z).normalize();
    for (const l of amb.layers) l.uniforms.uSunDir.value.copy(sunDir);
  }

  const api = {
    group, atlas, batches, decals, ambience: amb, speedLines: speedFX, rigs,
    /** Emission multiplier from the quality setting; continuous rigs scale their rates by it. */
    get emitScale() { return qEmit(); },
    emit, update, resize, attach, setQuality, setSunDirection,
    get time() { return time; },
    /** Screen-space rush intensity, 0..1. Driven by rigs, or set it yourself. */
    set speed(v) { speedFX.intensity = clamp(v, 0, 1); },
    get speed() { return speedFX.intensity; },
    setSceneTexture: (t) => speedFX.setSceneTexture(t),
    stats() {
      return {
        alpha: { alive: batches.alpha.alive(time), used: batches.alpha.used, capacity: batches.alpha.capacity },
        add: { alive: batches.add.alive(time), used: batches.add.used, capacity: batches.add.capacity },
        decals: decals ? decals.stats() : null,
        emitted: stats.emitted, bursts: stats.bursts, quality: q.value, time,
      };
    },
    clear() { batches.alpha.clear(); batches.add.clear(); decals?.clear(); },
    dispose() {
      batches.alpha.dispose(); batches.add.dispose();
      for (const l of amb.layers) l.dispose();
      speedFX.dispose(); depthPass?.dispose(); decals?.dispose();
      atlas.dispose();
      engine.scene.remove(group);
    },
  };

  engine.add?.(api);
  setQuality(q.value);
  return api;
}

/* --------------------------------------------------------------- kart rig ---- */
/**
 * Continuous emitters bound to one kart: tyre smoke, mini-turbo sparks, boost flames,
 * surface dust, water splash, mud spatter, skid decals and the boost trail ribbon.
 */
function createKartRig(vfx, world, target, o = {}) {
  const seed = o.seed ?? 5;
  const rand = rng(seed);
  const wheels = o.wheels || [[-0.58, -0.24, -0.72], [0.58, -0.24, -0.72]];
  const front = o.frontWheels || [[-0.55, -0.24, 0.66], [0.55, -0.24, 0.66]];
  const exhausts = o.exhausts || [[-0.30, -0.05, -0.92], [0.30, -0.05, -0.92]];
  const sparkAnchor = o.sparkAnchor || [[-0.62, -0.18, -0.55], [0.62, -0.18, -0.55]];

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), vel = new THREE.Vector3();
  const prevPos = new THREE.Vector3(); let havePrev = false;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  const wp = new THREE.Vector3(), dirv = new THREE.Vector3();

  const trail = new TrailRibbon({ segments: 40, width: 0.36, fade: 0.5 });
  vfx.group.add(trail.mesh);

  const acc = { smoke: 0, dust: 0, spark: 0, flame: 0, chip: 0, splash: 0, ember: 0, mud: 0, ripple: 0 };
  let lastTier = 0, wasTier = 0, wasDrifting = false, wasBoosting = false, wasGrounded = true;
  // which charge tier bought the boost currently burning — MK8 tints the flame by it
  let boostTier = tierColor(1), boostTierT = 0;
  let mudLevel = 0;
  const skidId = seed;
  const TRAIL_ANCHOR = [0, -0.02, -0.95];
  const LANDING_ANCHOR = [0, -0.3, 0];
  const events = { boosts: 0, tierUps: 0, impacts: 0, landings: 0 };
  const st = {
    speed: 0, slip: 0, drifting: false, tier: 0, charge: 0, boosting: false,
    grounded: true, surface: 'tarmac', steer: 0,
  };

  function readState(dt, override) {
    const t = target || {};
    const s = override || t.vfxState || t.state || null;

    // position / orientation
    if (t.isObject3D) { t.getWorldPosition(pos); t.getWorldQuaternion(quat); }
    else {
      const p = t.position || s?.pos || s?.position;
      if (p) pos.set(p.x ?? p[0] ?? 0, p.y ?? p[1] ?? 0, p.z ?? p[2] ?? 0);
      const qq = t.quaternion || s?.quat || s?.quaternion;
      if (qq) quat.set(qq.x ?? qq[0] ?? 0, qq.y ?? qq[1] ?? 0, qq.z ?? qq[2] ?? 0, qq.w ?? qq[3] ?? 1);
    }
    // velocity: prefer the physics vector, else differentiate
    const v = t.velocity || s?.vel || s?.velocity;
    if (v) vel.set(v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 0, v.z ?? v[2] ?? 0);
    else if (havePrev && dt > 1e-5) vel.copy(pos).sub(prevPos).multiplyScalar(1 / dt);
    prevPos.copy(pos); havePrev = true;

    st.speed = (t.speed ?? s?.speed ?? vel.length()) || 0;
    st.drifting = !!(t.drifting ?? s?.drifting ?? s?.drift ?? false);
    st.tier = (t.driftTier ?? s?.tier ?? s?.driftTier ?? 0) | 0;
    st.charge = t.driftCharge ?? s?.charge ?? 0;
    st.boosting = !!(t.boosting ?? s?.boosting ?? (s?.boostT > 0));
    st.grounded = (t.grounded ?? s?.grounded ?? true) !== false;
    st.surface = t.surface ?? s?.surface ?? 'tarmac';
    st.steer = s?.steer ?? 0;

    // slip: lateral share of velocity — this is what actually smokes the tyres
    right.set(1, 0, 0).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);
    fwd.set(0, 0, 1).applyQuaternion(quat);
    const lat = Math.abs(vel.dot(right));
    st.slip = st.speed > 1 ? clamp(lat / Math.max(st.speed, 1e-3), 0, 1) : 0;
    if (st.drifting) st.slip = Math.max(st.slip, 0.34 + 0.18 * Math.min(st.tier, 3));
    if (o.slip !== undefined) st.slip = o.slip;
  }

  function local(offset, out) {
    out.set(offset[0], offset[1], offset[2]).applyQuaternion(quat).add(pos);
    return out;
  }

  /** Poisson-ish rate emitter: accumulates fractional counts so low rates still sparkle. */
  function rate(key, perSec, dt) {
    acc[key] += perSec * dt;
    const n = Math.floor(acc[key]);
    acc[key] -= n;
    return n;
  }

  function update(dt, time, override) {
    readState(dt, override);
    const fx = surfaceFX(st.surface);
    const spd = st.speed;
    const fast = clamp(spd / 26, 0, 1.35);
    const slip = st.slip;
    const grounded = st.grounded;
    const onWater = fx.wet > 0;

    /* --- tyre smoke / surface dust ------------------------------------------------ */
    if (grounded && spd > 1.2) {
      const heat = clamp(slip * 2.1, 0, 1.25) * (0.35 + 0.85 * fast);
      const loose = fx.rate * (0.30 + 0.85 * fast) * (0.45 + 0.85 * slip);
      const smokeRate = onWater ? 22 * fast
        : (fx.decal === 'tyre' ? fx.rate * heat : loose * 0.55 + fx.rate * heat * 0.5);
      const n = rate('smoke', smokeRate * (o.rate ?? 1) * vfx.emitScale, dt);
      for (let i = 0; i < n; i++) {
        const w = wheels[i % wheels.length];
        local(w, wp);
        wp.y += 0.06;
        const back = -0.25 - rand() * 0.4;
        wp.addScaledVector(fwd, back);
        dirv.set(0, fx.rise, 0).addScaledVector(fwd, -0.55 - rand() * 0.5).addScaledVector(right, (rand() * 2 - 1) * 0.6);
        vfx.emit(onWater ? 'splashMist' : (fx.decal === 'tyre' ? 'driftSmoke' : 'dust'), {
          pos: wp, dir: dirv, count: 1, raw: true,
          colorA: fx.a, colorB: fx.b,
          scale: lerp(0.7, 1.25, rand()) * (fx.decal === 'tyre' ? lerp(0.8, 1.4, heat) : 1),
          opacity: fx.decal === 'tyre' ? clamp(0.35 + heat * 0.8, 0, 1.1) : clamp(0.5 + 0.5 * fast, 0, 1),
          speedScale: 0.7 + fast * 0.9,
          drag: fx.drag,
        });
      }

      // chips, straw, grass blades kicked out of the loose stuff
      if (fx.chips > 0) {
        const cn = rate('chip', fx.chips * 26 * fast * (0.4 + slip) * vfx.emitScale, dt);
        for (let i = 0; i < cn; i++) {
          const w = wheels[i % wheels.length];
          local(w, wp); wp.y += 0.05;
          dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.9).addScaledVector(right, (rand() * 2 - 1) * 0.7);
          const kind = fx.chipSprite === 'leaf' ? 'grassKick' : fx.chipSprite === 'straw' ? 'strawKick' : 'gravelChip';
          vfx.emit(kind, { pos: wp, dir: dirv, count: 1, raw: true, colorA: fx.a, colorB: fx.b, speedScale: 0.6 + fast });
        }
      }

      // water: droplets, mist and expanding ripple rings
      if (onWater) {
        const sn = rate('splash', (34 * fast + 8) * vfx.emitScale, dt);
        for (let i = 0; i < sn; i++) {
          const w = wheels[i % wheels.length];
          local(w, wp); wp.y += 0.02;
          dirv.copy(up).addScaledVector(fwd, -0.6).addScaledVector(right, (rand() * 2 - 1) * 0.8);
          vfx.emit('splashDrop', { pos: wp, dir: dirv, count: 1, raw: true, scale: 0.8 + rand() * 0.6, speedScale: 0.5 + fast });
        }
        if (rate('ripple', 5 * fast * vfx.emitScale, dt) > 0) {
          local(wheels[0], wp); wp.y += 0.02;
          vfx.emit('ripple', { pos: wp, count: 1, raw: true, mode: 1, scale: 0.9 + rand() * 0.7, opacity: 0.55 });
        }
      }

      // mud thrown up onto the kart itself
      if (fx.wet === 0 && fx.chips > 0.4 && spd > 6) {
        const mn = rate('mud', 5 * fast * vfx.emitScale, dt);
        mudLevel = clamp(mudLevel + mn * 0.05, 0, 1);
        for (let i = 0; i < mn; i++) {
          local(wheels[i % wheels.length], wp);
          dirv.copy(fwd).multiplyScalar(0.4).addScaledVector(up, 1);
          vfx.emit('mudSpatter', {
            pos: wp, dir: dirv, count: 2, raw: true, scale: 0.7 + rand() * 0.5,
            colorA: fx.b, colorB: fx.b, speedScale: 0.5,
          });
        }
      }
    }

    /* --- skid decals -------------------------------------------------------------- */
    if (vfx.decals && grounded && spd > 3) {
      const heat = clamp(slip * 2.0, 0, 1);
      const strength = (fx.decalAlpha || 0) * heat * (st.boosting ? 1.15 : 1);
      if (fx.decal && strength > 0.04) {
        for (let i = 0; i < wheels.length; i++) {
          local(wheels[i], wp); wp.y -= 0.16;
          vfx.decals.trail(skidId + i, wp, fwd, {
            kind: fx.decal, width: o.markWidth ?? 0.34, alpha: clamp(strength, 0, 1),
            life: fx.decal === 'tyre' ? 14 : 7,
          });
        }
      } else {
        vfx.decals.breakTrail(skidId); vfx.decals.breakTrail(skidId + 1);
      }
    } else if (vfx.decals) { vfx.decals.breakTrail(skidId); vfx.decals.breakTrail(skidId + 1); }

    /* --- mini-turbo charge sparks ------------------------------------------------- */
    if (st.drifting && st.tier > 0) {
      const T = tierColor(st.tier);
      const n = rate('spark', T.rate * (0.6 + 0.5 * fast) * vfx.emitScale, dt);
      for (let i = 0; i < n; i++) {
        const a = sparkAnchor[i % sparkAnchor.length];
        local(a, wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.55)
          .addScaledVector(right, (rand() * 2 - 1) * 0.9);
        // hot at birth, cooling into the saturated tier hue: a spark reads as a coloured
        // comet with a white tip rather than a white dot with a coloured halo.
        vfx.emit('driftSpark', {
          pos: wp, dir: dirv, count: 1, raw: true,
          colorA: T.core, colorB: T.glow, scale: T.size * (0.8 + rand() * 0.9),
          speedScale: 0.85 + rand() * 0.9,
        });
        if (rand() < 0.22) {
          vfx.emit('miniTurbo', {
            pos: wp, dir: dirv, count: 1, raw: true,
            colorA: T.glow, colorB: T.glow, scale: T.size * 1.4, opacity: 0.7,
          });
        }
      }
      if (st.tier > lastTier) {                      // tier-up pop
        events.tierUps++;
        for (const a of sparkAnchor) {
          local(a, wp);
          vfx.emit('miniTurbo', { pos: wp, dir: up, count: 6, scale: T.size * 2.2, colorA: T.glow, colorB: T.glow, opacity: 0.8, speedScale: 1.6 });
          vfx.emit('driftSpark', { pos: wp, dir: up, count: 16, scale: T.size * 1.3, colorA: T.core, colorB: T.glow, speedScale: 1.5 });
        }
      }
    }

    /* --- drift release -> mini-turbo boost burst ----------------------------------- */
    let releasedBurst = false;
    if (wasDrifting && !st.drifting && wasTier > 0) {
      releasedBurst = true;
      const tier = clamp(wasTier, 1, 3);
      const T = tierColor(tier);
      events.boosts++;
      boostTier = T; boostTierT = 0.75;
      for (const e of exhausts) {
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1);
        vfx.emit('boostBurst', {
          pos: wp, dir: dirv, scale: 0.62 + 0.16 * tier,
          tierA: T.core, tierB: T.glow, speedScale: 0.9 + 0.25 * tier,
        });
      }
      // a fan of tier-coloured sparks thrown off the rear as the turbo lets go
      for (const a of sparkAnchor) {
        local(a, wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.4);
        vfx.emit('driftSpark', {
          pos: wp, dir: dirv, count: 10 + 4 * tier, scale: T.size * 1.25,
          colorA: T.core, colorB: T.glow, speedScale: 1.5,
        });
      }
      vfx.emit('squashPuff', { pos, dir: up, count: 8, scale: 1.2, opacity: 0.35 });
    }
    wasTier = st.drifting ? st.tier : 0;
    lastTier = st.drifting ? st.tier : 0;
    wasDrifting = st.drifting;

    /* --- boost: exhaust flame, embers, trail, rush lines --------------------------- */
    const boostAmt = st.boosting ? 1 : 0;
    if (st.boosting && !wasBoosting && !releasedBurst) {        // boost pad / item boost kick
      events.boosts++;
      for (const e of exhausts) {
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1);
        vfx.emit('boostBurst', { pos: wp, dir: dirv, scale: 0.8, speedScale: 1.1 });
      }
    }
    if (st.boosting) {
      /* The exhaust plume is built in layers so it has a silhouette instead of a mass:
       *   grit + smoke   dark, alpha-blended, laid down first so the fire has a backing
       *   flame body     deep orange, low alpha, many small sprites -> a tapered tongue
       *   tier tongue    the charge colour that earned this boost, riding the outside
       *   core           one tiny near-white kernel per exhaust, ~0.2 m across
       *   embers         individually readable specks trailing up and back
       * The rates are roughly half what they were: with screen blending the plume gets its
       * density from overlap, and past ~4 concurrent sprites per exhaust it stops reading. */
      const nf = rate('flame', 34 * vfx.emitScale, dt);
      for (let i = 0; i < nf; i++) {
        const e = exhausts[i % exhausts.length];
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.16).addScaledVector(right, (rand() * 2 - 1) * 0.10);
        vfx.emit('boostFlame', {
          pos: wp, dir: dirv, count: 1, raw: true,
          scale: 0.85 + rand() * 0.45, speedScale: 0.8 + fast * 0.6,
        });
        if (boostTierT > 0 && rand() < 0.6) {
          vfx.emit('boostTierFlame', {
            pos: wp, dir: dirv, count: 1, raw: true,
            colorA: boostTier.core, colorB: boostTier.glow,
            scale: 1.0 + rand() * 0.5, opacity: clamp(boostTierT / 0.5, 0, 1),
            speedScale: 0.9 + fast * 0.5,
          });
        }
        if (rand() < 0.5) {
          local(e, wp); wp.y -= 0.04;
          dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.5);
          vfx.emit('boostSmoke', { pos: wp, dir: dirv, count: 1, raw: true, scale: 1.0 + rand() * 0.5 });
        }
      }
      const nc = rate('spark', 24 * vfx.emitScale, dt);
      for (let i = 0; i < nc; i++) {
        local(exhausts[i % exhausts.length], wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.1);
        vfx.emit('boostCore', { pos: wp, dir: dirv, count: 1, raw: true, scale: 0.9 + rand() * 0.35 });
      }
      const en = rate('ember', 20 * vfx.emitScale, dt);
      for (let i = 0; i < en; i++) {
        local(exhausts[i % exhausts.length], wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.55).addScaledVector(right, (rand() * 2 - 1) * 0.4);
        vfx.emit('ember', { pos: wp, dir: dirv, count: 1, raw: true, speedScale: 0.9 + rand() });
      }
      // grit torn off the road by the blast — the dust plume a boost should leave behind
      if (grounded && fx.wet === 0) {
        const gn = rate('dust', (10 + 12 * fast) * vfx.emitScale, dt);
        for (let i = 0; i < gn; i++) {
          local(wheels[i % wheels.length], wp);
          wp.y += 0.04; wp.addScaledVector(fwd, -0.35 - rand() * 0.5);
          dirv.set(0, 0.7, 0).addScaledVector(fwd, -0.9).addScaledVector(right, (rand() * 2 - 1) * 0.7);
          vfx.emit('boostGrit', {
            pos: wp, dir: dirv, count: 1, raw: true,
            colorA: fx.a, colorB: fx.b, scale: 0.8 + rand() * 0.7,
            speedScale: 0.7 + fast * 0.8,
          });
        }
      }
    }
    boostTierT = Math.max(0, boostTierT - dt);

    // trail ribbon: a bright band that hangs behind the kart while boosting
    local(TRAIL_ANCHOR, wp);
    trail.push(wp, right, time, (o.trailWidth ?? 0.34) * (0.7 + 0.5 * fast));
    trail.update(time);
    const targetTrail = boostAmt * clamp(0.35 + fast * 0.8, 0, 1.2);
    trail.setIntensity(damp(trail.material.uniforms.uIntensity.value, targetTrail, 8, dt));

    // screen rush: strongest during a boost, present at high speed
    const rush = clamp(boostAmt * 0.75 + smoothstep(18, 34, spd) * 0.45, 0, 1);
    if (o.driveSpeedLines !== false) {
      vfx.speedLines.intensity = damp(vfx.speedLines.intensity, rush, 6, dt);
    }

    /* --- landing puff -------------------------------------------------------------- */
    if (!wasGrounded && grounded && spd > 3) {
      events.landings++;
      local(LANDING_ANCHOR, wp);
      vfx.emit(onWater ? 'splash' : 'squashPuff', {
        pos: wp, dir: up, count: onWater ? 20 : 12, scale: 1.3,
        colorA: onWater ? undefined : fx.a, colorB: onWater ? undefined : fx.b, opacity: 0.6,
      });
      if (vfx.decals && !onWater) vfx.decals.stamp('scuff', { pos: wp, dir: fwd, size: 1.6, alpha: 0.3 * (fx.decalAlpha || 0.3), life: 9 });
    }
    wasGrounded = grounded;
    wasBoosting = st.boosting;
    mudLevel = Math.max(0, mudLevel - dt * 0.05);
  }

  return {
    update,
    state: st,
    trail,
    events,
    get mudLevel() { return mudLevel; },
    /** Manual one-shots so the game can report hits without knowing preset names. */
    hit(kind = 'impact', params = {}) {
      events.impacts++;
      vfx.emit(kind, { pos: params.pos || pos, dir: params.dir || up, ...params });
    },
    detach() {
      vfx.group.remove(trail.mesh); trail.dispose();
      const i = vfx.rigs.indexOf(this); if (i >= 0) vfx.rigs.splice(i, 1);
    },
  };
}

export default createVFX;
