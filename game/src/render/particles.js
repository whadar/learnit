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
 * The library presets are the *physics* of each effect; these overrides are the *look*.
 *
 * The blowout post-mortem, because the shape of the fix is not obvious.  The boost plume
 * used to be an additive stack: ten glow quads, each nearly opaque, all landing on the same
 * hundred pixels.  Additive has no ceiling, so the sum clipped to flat white over a quarter
 * of the frame and the kart disappeared inside it.  Screen blending (the `add` batch) fixes
 * the *ceiling* — it can never exceed 1.0 — but it trades one failure for another: `dst +
 * src*(1-dst)` spends the remaining headroom, and on a sunlit limestone road there is no
 * headroom left, so the flame simply vanished.  Neither blend mode can carry a flame in a
 * bright outdoor game.
 *
 * So the plume is split by *job*:
 *   - the flame **body** is alpha-over (`blend:'fire'`).  Alpha-over is idempotent in hue:
 *     stack fifty orange sprites and the result is still exactly that orange, never white,
 *     and it reads at full contrast against pale sand because it *replaces* the background
 *     instead of adding to it.  This is where the silhouette lives.
 *   - the white-hot **core** is one ~0.14 m kernel per exhaust, also alpha-over, and it is
 *     the *only* layer allowed near white.  Its footprint is a few hundred pixels, so that
 *     is the whole budget for clipped white and for what the bloom prefilter can see.
 *   - **soot** sits behind the fire, dark and alpha-blended, because a flame reads by value
 *     contrast against something darker, not by being brighter than everything else.
 */
const FX_TUNE = {
  /**
   * Mini-turbo charge sparks.
   *
   * The blue-confetti post-mortem. Round 3 ran these through the alpha-over `fire` batch to
   * escape the round-1 white blowout. Alpha-over *replaces* the background with the particle
   * colour, so a saturated tier hue on dark tarmac came out as a solid mid-blue quad with a
   * hard edge and no value structure at all — a dozen blue chips scattered over the road.
   * A spark is light, not paint, and it has to be brighter than what it sits on.
   *
   * So they go back to the screen-blended `add` batch — `dst + src*(1-dst)`, which *cannot*
   * exceed 1.0 no matter how many overlap, so the round-1 blowout is structurally impossible
   * — and the ramp runs white-hot core -> saturated tier hue instead of tier hue -> lighter
   * tier hue. Over a dark road that is a white head with a coloured tail: a comet.
   *
   * `spin: 0` matters as much as the blend. `stretch` maps the quad into the screen-space
   * velocity frame, so with no spin the four-point star's long arm lies *along* the streak
   * and the sprite reads as motion. Round 3 spun it at 5 rad/s, which is exactly why twelve
   * sparks sat at twelve unrelated angles and read as scattered plastic chips.
   */
  driftSpark: {
    blend: 'add',
    // stretch is a *multiplier on screen-space velocity*, so raising it and the base size
    // together turned a 0.26 m spark into a 3 m streak and the shower into a firework that
    // bloomed to white over the kart. Short and dense reads as a mini-turbo; long does not.
    size: [0.28, 0.055], life: [0.18, 0.34], alpha: 1.0, stretch: 0.40,
    speed: [3.0, 7.0], spread: 0.30, jitter: 0.5, drag: 5.6, grav: -2.4,
    turb: [0.02, 3.0], spin: 0, fadeIn: 0.02,
  },
  /* the soft bloom that sits under a spark shower — small and dim, it is not the star */
  miniTurbo: { blend: 'add', size: [0.30, 0.045], life: [0.12, 0.24], alpha: 0.50, speed: [0.8, 2.2], spin: 0 },

  /* Exhaust fire body. Alpha-over, so this orange is the orange you see, no matter how many
   * sprites overlap; the colour ramp does the cooling, hot yellow-orange at birth to
   * saturated red as it dies.
   * The cell is `fire`, not `flame`: `flame` bakes its own orange gradient into RGB, which
   * multiplies with the particle ramp and drags the tip of every tongue to a muddy
   * near-black red. The neutral cell lets the ramp alone own the hue. */
  boostFlame: {
    blend: 'fire', sprite: 'fire',
    size: [0.28, 0.62], life: [0.14, 0.24], alpha: 1.0,
    speed: [3.0, 6.5], spread: 0.16, jitter: 0.30, drag: 5.4, grav: 0.35,
    turb: [0.04, 3.4], stretch: 0, fadeIn: 0.04, spin: 0.5,
    colorA: [1.00, 0.82, 0.34], colorB: [1.00, 0.26, 0.045],
  },
  boostBurst: {
    blend: 'fire', sprite: 'fire',
    count: 9, size: [0.40, 0.90], life: [0.18, 0.34], alpha: 0.95,
    speed: [4.0, 9.0], spread: 0.32, jitter: 1.0, drag: 4.8, grav: 1.1,
    turb: [0.10, 2.2], fadeIn: 0.03, spin: 1.1, stretch: 0,
    colorA: [1.00, 0.86, 0.42], colorB: [1.00, 0.22, 0.035],
  },
  /* Soot, not steam. Dark and short — it is the shadow the fire sits in. */
  boostSmoke: {
    sprite: 'wisp', lit: 1,
    size: [0.16, 0.72], life: [0.26, 0.55], alpha: 0.22,
    speed: [0.9, 2.4], spread: 0.36, jitter: 0.40, drag: 3.2, grav: 1.2,
    colorA: [0.40, 0.37, 0.36], colorB: [0.17, 0.16, 0.17], fadeIn: 0.08, spin: 1.0,
  },
  ember: { blend: 'fire', size: [0.058, 0.010], alpha: 1.0, stretch: 0.5, life: [0.35, 0.85] },
  impactShock: { alpha: 0.42 },
  railSpark: { blend: 'fire', alpha: 1.0, size: [0.24, 0.03] },
  starBurst: { blend: 'fire', alpha: 1.0 },

  /* Tyre smoke: a pair of compact puffs off the rear wheels. It used to run at nearly twice
   * this size and lifetime, which merged every puff into one fog bank around the kart.
   * Now lit, so a column of it has a bright shoulder and a dark underside and reads as a
   * column rather than as a wash — which is what lets it be this big without flattening. */
  driftSmoke: {
    lit: 1,
    // Fewer, denser, shorter-lived puffs than round 3. A wash is what you get when thirty
    // 0.38-alpha billboards overlap: every pixel lands on the same integrated grey and the
    // plume has no billow. Half as many puffs at 0.54 alpha integrate to the same coverage
    // but each one keeps a lit shoulder and a shaded belly, so the column has lumps.
    size: [0.26, 1.30], life: [0.38, 0.80], alpha: 0.54,
    speed: [1.1, 2.9], spread: 0.5, jitter: 0.6, drag: 2.0, grav: 0.85,
    turb: [0.30, 0.75], fadeIn: 0.05, spin: 1.3,
    colorA: [0.95, 0.93, 0.91], colorB: [0.40, 0.39, 0.41],
  },
  /**
   * Surface dust.
   *
   * Round 3 sized this for a full-lock slide across a ploughed field and then let a kart
   * tracking dead straight emit at 45% of that rate (see the `loose` term in the rig), so a
   * 59 km/h run down Ridge Road put ~48 concurrent 2.3 m puffs at 0.58 effective alpha
   * directly between the chase lens and the hero. That is the round-1 "blown blob erases
   * the kart" failure wearing a beige coat.
   *
   * A dust trail is a *trail*: small, short-lived, dense near the tyre and gone a car length
   * later. The rate is now slip-driven rather than speed-driven, and the plume budget in the
   * rig caps what any combination of speed and surface can put in the air at once.
   */
  dust: {
    lit: 1,
    size: [0.34, 1.40], life: [0.50, 1.00], alpha: 0.42,
    speed: [1.0, 2.8], spread: 0.6, jitter: 0.7, drag: 1.7, grav: 0.20,
    turb: [0.40, 0.50], fadeIn: 0.09, spin: 0.9,
  },
};

/** Effects that exist only here: the shaped layers the boost flame is built from. */
const FX_EXTRA = {
  /** The white-hot kernel. Deliberately tiny — this is the only near-white boost layer. */
  boostCore: {
    // Alpha-over like the body, not additive: on a sunlit road a screen-blended core has no
    // headroom left to spend and simply disappears. Alpha-over puts a real white-hot kernel
    // on screen, and because it is ~0.15 m across it is also the entire clipped-white budget
    // — which is exactly the seed the bloom prefilter wants and nothing more.
    sprite: 'flare', blend: 'fire', count: 1, life: [0.09, 0.15], size: [0.14, 0.022],
    speed: [1.8, 3.6], spread: 0.10, jitter: 0.22, drag: 6.0, grav: 0.4, turb: [0.02, 3.0],
    alpha: 0.82, colorA: [1.0, 0.91, 0.62], colorB: [1.0, 0.50, 0.12], fadeIn: 0.02,
  },
  /**
   * The charge-tier tongue — MK8's blue / orange / purple mini-turbo colour, riding just
   * outside the orange body. It uses the neutral `fire` cell rather than `flame`: `flame`
   * bakes an orange gradient into its RGB, which would drag a blue tongue back to brown.
   */
  boostTierFlame: {
    sprite: 'fire', blend: 'fire', count: 1, life: [0.13, 0.23], size: [0.23, 0.52],
    speed: [3.4, 7.0], spread: 0.20, jitter: 0.42, drag: 5.2, grav: 0.4, turb: [0.05, 3.0],
    alpha: 0.60, colorA: [0.34, 0.75, 1.0], colorB: [0.05, 0.18, 0.74], fadeIn: 0.04, spin: 0.7,
  },
  /** Grit lifted off the road by the exhaust blast — gives the fire something to sit in. */
  boostGrit: {
    sprite: 'dust', blend: 'alpha', lit: 1, count: 1, life: [0.5, 1.2], size: [0.35, 2.2],
    speed: [2.0, 5.5], spread: 0.6, jitter: 1.0, drag: 2.0, grav: 0.8, turb: [0.3, 0.9],
    alpha: 0.42, colorA: [0.82, 0.78, 0.72], colorB: [0.45, 0.42, 0.40], fadeIn: 0.10, spin: 1.1,
  },
  /**
   * Rooster tail: the long, low plume a kart drags across loose ground *while sliding*.
   * Round 3 gated it on speed alone with a 0.55 floor, so a straight-line kart threw a
   * 1.8 s, 2.8 m, 0.72-alpha column on top of the dust above it. Now it is the reward for
   * actually scrubbing the tyres, and it is a plume rather than a wall.
   */
  rooster: {
    sprite: 'dust', blend: 'alpha', lit: 1, count: 1, life: [0.55, 1.15], size: [0.42, 1.85],
    speed: [2.8, 7.2], spread: 0.30, jitter: 1.1, drag: 1.9, grav: 0.30, turb: [0.55, 0.45],
    alpha: 0.46, colorA: [0.94, 0.87, 0.73], colorB: [0.50, 0.44, 0.37], fadeIn: 0.10, spin: 0.8,
  },
  /**
   * The tier-coloured pool of light at the contact patch. A mini-turbo in MK8 is not only
   * the individual sparks — it is the glow they come out of, which is what makes the charge
   * level readable at race distance when no single spark is more than four pixels wide.
   * Screen-blended, low alpha and pinned to the tyre so it never becomes a light source
   * floating in the air.
   */
  sparkGlow: {
    sprite: 'flare', blend: 'add', count: 1, life: [0.10, 0.22], size: [0.62, 0.10],
    speed: [0.4, 1.6], spread: 0.9, jitter: 0.35, drag: 7.0, grav: 0.5, turb: [0.02, 2.0],
    alpha: 0.40, fadeIn: 0.02, spin: 0,
  },
  /**
   * Tyre scrub: the dense, low, hard-edged kernel that sits *at the contact patch* while a
   * kart is sliding. `driftSmoke` is the column that rises off it; this is the root of the
   * column, and without it a slide has smoke floating over a road it never touched.
   */
  scrubPuff: {
    sprite: 'smoke', blend: 'alpha', lit: 1, count: 1, life: [0.26, 0.52], size: [0.22, 0.78],
    speed: [0.6, 1.8], spread: 0.7, jitter: 0.5, drag: 3.4, grav: 0.25, turb: [0.10, 1.1],
    alpha: 0.62, colorA: [0.96, 0.94, 0.92], colorB: [0.58, 0.55, 0.55], fadeIn: 0.03, spin: 2.2,
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
varying vec2  vLocal;     // quad-local coords, -1..1, for the fake-sphere normal
varying float vLit;       // 1 = shade this sprite like a lump of matter, 0 = emissive

void main() {
  float age = uTime - aLife.x;
  float life = max(aLife.y, 1e-4);
  float t = age / life;

  // aShape.w carries a lighting flag in its 8s place: 0..4 are the billboard modes, +8
  // asks the fragment shader to light the sprite as a sphere. Packing it here keeps the
  // vertex stride at 28 floats -- a smoke puff needs the sun, a spark does not.
  float lit = step(7.5, aShape.w);
  float mode = aShape.w - 8.0 * lit;
  vLit = lit;
  vLocal = position.xy * 2.0;

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
  if (mode > 0.5 && mode < 1.5) {
    // flat: lies in the world XZ plane (ripple rings, ground shock)
    vec3 wp = p + vec3(qr.x, 0.0, qr.y);
    mv = modelViewMatrix * vec4(wp, 1.0);
  } else if (mode > 1.5) {
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
uniform float uNearFade;
uniform vec3  uSunView;       // unit vector towards the sun, in VIEW space
uniform vec3  uUpView;        // world up, in VIEW space
uniform vec3  uSunTint;       // multiplier on the sunlit face of a puff
uniform vec3  uShadeTint;     // multiplier on the self-shadowed face
uniform float uWrap;          // wrap-around term: how far light bends round the sphere
#ifdef SOFT
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uSoftness;
#endif

varying vec2  vUv;
varying vec3  vCol;
varying float vAlpha;
varying float vViewZ;
varying vec2  vLocal;
varying float vLit;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a <= 0.002) discard;
  // Sharpen the coverage profile: a gamma > 1 keeps the hot core and pulls the broad,
  // low-alpha skirt in, so a stack of glow sprites reads as a shape and not as a disc.
  a = pow(a, uAlphaPow);
  vec3 col = vCol * tex.rgb * uBrightness;

  // --- lit puffs ---------------------------------------------------------------------
  // A dust plume is matter, not light. Unlit sprites all carry exactly the same value, so
  // a stack of them integrates to one flat plateau — a fog veil, which is precisely what
  // the round-2 plume looked like. Giving each billboard a hemispherical normal and one
  // wrapped sun term costs four instructions and buys the thing that actually reads:
  // every puff gets a warm sunlit shoulder and a cool shaded underside, so the plume has
  // internal structure, a direction of light shared with the terrain, and enough value
  // range that it sits *behind* the kart instead of greying it out.
  if (vLit > 0.5) {
    float r2 = dot(vLocal, vLocal);
    vec3 n = normalize(vec3(vLocal, sqrt(max(1.0 - min(r2, 1.0), 0.04))));
    // Half sun, half sky. A pure sun term is unstable on a billboard: the fake normal at the
    // centre of the sprite points at the *camera*, so with the sun behind the lens the whole
    // puff shades to mud. Mixing in world-up guarantees what every real dust plume does —
    // bright crown, dark belly — while the sun still decides which shoulder is hot.
    float w = clamp((0.52 * dot(n, uSunView) + 0.48 * dot(n, uUpView) + uWrap) / (1.0 + uWrap), 0.0, 1.0);
    w = w * w * (3.0 - 2.0 * w);
    col *= mix(uShadeTint, uSunTint, w);
    // the rim of a puff is thinner, so it scatters more light and holds less opacity —
    // this is what gives a plume a soft, torn edge instead of a stencilled disc
    a *= mix(1.0, 0.72, clamp(r2, 0.0, 1.0));
  }

  float dist = -vViewZ;

  // Never let a particle slice through the near plane — and, for the big alpha-blended
  // layers, keep the last few metres in front of the lens clear as well. A chase camera
  // flies through its own dust trail continuously; without this the plume stops reading as
  // a plume behind the kart and becomes a flat tan veil over the whole hero.
  a *= smoothstep(uNearFar.x * 1.5, max(uNearFar.x * 8.0, uNearFade), dist);

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
  // Screen blending (dst + src*(1-dst)) needs premultiplied source: the blend factor is
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
    soft = false, brightness = 1, alphaPow = 1, nearFade = 1.2,
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
        uNearFade: { value: nearFade },
        uSunView: { value: new THREE.Vector3(0, 0, 1) },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uSunTint: { value: new THREE.Vector3(1.30, 1.21, 1.06) },
        uShadeTint: { value: new THREE.Vector3(0.56, 0.58, 0.66) },
        uWrap: { value: 0.34 },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uSoftness: { value: 0.55 },
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
    // blending — out = dst + src * (1 - dst) — spends the *remaining headroom* instead,
    // so a stack converges smoothly on white and never overshoots 1.0 (the scene target is
    // tone-mapped and sRGB-encoded, so dst is always in [0,1]). It caps what the bloom
    // prefilter can ever see, which is why explosion cores and shock rings live here.
    //
    // What screen blending is NOT good for is a flame in a sunlit outdoor game: `1 - dst`
    // is the headroom left over the *background*, and over a limestone road at display 0.85
    // there is almost none, so a screen-blended plume vanishes instead of blowing out. The
    // flame body, the drift sparks and the embers therefore use the alpha-over 'fire' batch
    // (see createVFX) — alpha-over is idempotent in hue and always wins against its
    // background, which is what makes a coloured flame read at any exposure.
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
      // The fragment shader outputs premultiplied colour (col * a). AdditiveBlending would
      // scale it by srcAlpha a second time and the ribbon would all but vanish; One/One is
      // the correct factor pair for a premultiplied additive source.
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation, side: THREE.DoubleSide,
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

  /** Recolour the band — a mini-turbo trail carries the tier hue that bought it. */
  setColors(a, b) {
    const u = this.material.uniforms;
    if (a) Array.isArray(a) ? u.uColorA.value.fromArray(a) : u.uColorA.value.set(a);
    if (b) Array.isArray(b) ? u.uColorB.value.fromArray(b) : u.uColorB.value.set(b);
  }

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

  // Three batches, drawn in this order, because the order *is* the composition:
  //   alpha  soot, tyre smoke, dust           — the dark backing the fire reads against
  //   fire   the flame body, alpha-over       — owns the silhouette and the hue
  //   add    cores, sparks, embers, screen    — the only layer allowed anywhere near white
  // Keeping fire in its own batch is what guarantees a puff of tyre smoke emitted a frame
  // later cannot paint over the flame: within one batch there is no sort, only push order.
  const batches = {
    alpha: new ParticleBatch(atlas, { capacity: capAlpha, blend: 'alpha', name: 'vfx.alpha', renderOrder: 10, soft, brightness: 1.0, nearFade: 2.2 }),
    // No soft-fade on the fire batch. The exhaust plume is emitted flush against the kart's
    // own bodywork, so a depth fade against the scene depth buffer erases exactly the part
    // that matters — the base of the flame — and leaves only the tip poking past the
    // silhouette. Fire is allowed to intersect the kart; smoke is not.
    fire: new ParticleBatch(atlas, { capacity: capAdd, blend: 'alpha', name: 'vfx.fire', renderOrder: 11, soft: false, brightness: 1.0 }),
    // `screen`, not `add`: see the note in ParticleBatch. alphaPow tightens the glow skirt.
    add: new ParticleBatch(atlas, { capacity: capAdd, blend: 'screen', name: 'vfx.add', renderOrder: 12, soft: false, brightness: 1.06, alphaPow: 1.3 }),
  };
  group.add(batches.alpha.mesh, batches.fire.mesh, batches.add.mesh);

  // --- decals (sibling module; degrade gracefully rather than take the whole system down) -
  /**
   * Skid marks snap to `world.heightAt` — the raw SRTM heightfield. The circuit does not
   * live there: the road ribbon is built on its own smoothed spline and sits anything up to
   * 0.7 m above the terrain on an embanked corner, so every mark the karts laid on tarmac
   * was stamped *under* the road and never drawn. The rig knows exactly where its wheels are
   * touching, so it hands that height over through `surfaceHint` for the duration of one
   * stamp and the mark lands on the surface the tyre is actually scrubbing.
   */
  const hint = { on: false, x: 0, z: 0, y: 0, r2: 4 };
  // two interleaved trails per rear wheel per kart, so the buffer turns over twice as fast
  const decalCap = decalOpts.capacity ?? 2800;
  const decalWorld = (world && world.heightAt) ? {
    heightAt(x, z) {
      if (hint.on) {
        const dx = x - hint.x, dz = z - hint.z;
        if (dx * dx + dz * dz <= hint.r2) return hint.y;
      }
      return world.heightAt(x, z);
    },
    normalAt: world.normalAt ? (x, z, out) => world.normalAt(x, z, out) : undefined,
    slopeAt: world.slopeAt ? (x, z) => world.slopeAt(x, z) : undefined,
    inBounds: world.inBounds ? (x, z) => world.inBounds(x, z) : undefined,
  } : world;
  /** surfaceHint(x, z, y, radius) — or no arguments to clear it. */
  function surfaceHint(x, z, y, r) {
    if (x === undefined || x === null || !Number.isFinite(y)) { hint.on = false; return; }
    hint.on = true; hint.x = x; hint.z = z; hint.y = y; hint.r2 = (r || 2) * (r || 2);
  }

  let decals = null;
  try {
    decals = createDecals(engine, decalWorld, {
      seed: seed + 5, parent: group, capacity: decalCap, ...decalOpts,
    });
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
      batches.alpha.uniforms.uDepth.value = depthPass.target.depthTexture;
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
    const batch = blend === 'add' ? batches.add : blend === 'fire' ? batches.fire : batches.alpha;
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
    // A flame tongue has an up. `rot` pins the sprite's local +Y to a screen angle and
    // `rotJitter` fans it; without it every teardrop points somewhere different and the
    // plume reads as confetti rather than fire.
    rec.rot = o.rot !== undefined
      ? o.rot + (o.rotJitter ?? 0) * (rand() * 2 - 1)
      : rand() * Math.PI * 2;
    rec.spin = ((o.spin ?? P.spin ?? 0)) * (rand() * 2 - 1);
    rec.drag = o.drag ?? P.drag ?? 1;
    rec.grav = o.grav ?? P.grav ?? 0;
    rec.turbA = (o.turb ?? P.turb ?? [0, 0])[0] * sizeScale;
    rec.turbF = (o.turb ?? P.turb ?? [0, 0])[1];
    rec.alpha = (o.alpha ?? P.alpha ?? 1) * (o.opacity ?? 1);
    rec.sprite = SPRITE_INDEX[o.sprite || P.sprite] ?? 0;
    rec.stretch = o.stretch ?? P.stretch ?? 0;
    // `lit` rides in the 8s place of `mode` (see VERT): matter is shaded, light is not.
    rec.mode = (o.mode ?? P.mode ?? (P.flat ? MODE.flat : MODE.billboard))
      + ((o.lit ?? P.lit) ? 8 : 0);
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
      { p: 'boostSmoke', count: 5, scale: 1.3, own: true },
      { p: 'boostGrit', count: 4, scale: 1.1 },
      { p: 'boostBurst', own: true },
      { p: 'boostTierFlame', count: 5, scale: 1.25, tier: true },
      { p: 'boostCore', count: 3, scale: 1.4, own: true },
      { p: 'ember', count: 14, own: true },
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
    // sun direction in view space — the lit-puff term is evaluated against a view-space
    // hemisphere normal, so this has to travel with the camera, not the world
    _v1.copy(sunDir).transformDirection(cam.matrixWorldInverse).normalize();
    _v2.set(0, 1, 0).transformDirection(cam.matrixWorldInverse).normalize();

    for (const k of ['alpha', 'fire', 'add']) {
      const b = batches[k], u = b.uniforms;
      u.uNearFar.value.set(cam.near, cam.far);
      u.uSunView.value.copy(_v1);
      u.uUpView.value.copy(_v2);
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
    if (depthPass) batches.alpha.setSoft(e >= 0.35);
    return q.value;
  }

  /**
   * setSunDirection(x, y, z) | setSunDirection(vec3|[x,y,z])
   * Callers hand this either three numbers or the sky's own direction vector; taking only
   * the first form quietly wrote NaN into every ambience layer's sun uniform.
   */
  function setSunDirection(x, y, z) {
    if (y === undefined && x && typeof x === 'object') {
      const v = x;
      sunDir.set(v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 1, v.z ?? v[2] ?? 0);
    } else sunDir.set(x, y, z);
    if (!Number.isFinite(sunDir.x + sunDir.y + sunDir.z) || sunDir.lengthSq() < 1e-8) {
      sunDir.set(-0.45, 0.62, 0.64);
    }
    sunDir.normalize();
    for (const l of amb.layers) l.uniforms.uSunDir.value.copy(sunDir);
  }

  const api = {
    group, atlas, batches, decals, ambience: amb, speedLines: speedFX, rigs,
    /** Emission multiplier from the quality setting; continuous rigs scale their rates by it. */
    get emitScale() { return qEmit(); },
    emit, update, resize, attach, setQuality, setSunDirection, surfaceHint,
    get time() { return time; },
    /** Screen-space rush intensity, 0..1. Driven by rigs, or set it yourself. */
    set speed(v) { speedFX.intensity = clamp(v, 0, 1); },
    get speed() { return speedFX.intensity; },
    setSceneTexture: (t) => speedFX.setSceneTexture(t),
    stats() {
      return {
        alpha: { alive: batches.alpha.alive(time), used: batches.alpha.used, capacity: batches.alpha.capacity },
        fire: { alive: batches.fire.alive(time), used: batches.fire.used, capacity: batches.fire.capacity },
        add: { alive: batches.add.alive(time), used: batches.add.used, capacity: batches.add.capacity },
        decals: decals ? decals.stats() : null,
        emitted: stats.emitted, bursts: stats.bursts, quality: q.value, time,
      };
    },
    clear() { batches.alpha.clear(); batches.fire.clear(); batches.add.clear(); decals?.clear(); },
    dispose() {
      batches.alpha.dispose(); batches.fire.dispose(); batches.add.dispose();
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
  /* eslint-disable-next-line no-param-reassign */
  const seed = o.seed ?? 5;
  const rand = rng(seed);
  const wheels = o.wheels || [[-0.58, -0.24, -0.72], [0.58, -0.24, -0.72]];
  const front = o.frontWheels || [[-0.55, -0.24, 0.66], [0.55, -0.24, 0.66]];
  const exhausts = o.exhausts || [[-0.26, -0.20, -1.00], [0.26, -0.20, -1.00]];
  const sparkAnchor = o.sparkAnchor || [[-0.62, -0.18, -0.55], [0.62, -0.18, -0.55]];

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), vel = new THREE.Vector3();
  const prevPos = new THREE.Vector3(); let havePrev = false;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  const wp = new THREE.Vector3(), dirv = new THREE.Vector3();

  const trail = new TrailRibbon({ segments: 40, width: 0.36, fade: 0.5 });
  vfx.group.add(trail.mesh);

  const acc = { smoke: 0, smoke2: 0, dust: 0, rooster: 0, scrub: 0, grit: 0, spark: 0, core: 0, flame: 0, chip: 0, splash: 0, ember: 0, mud: 0, ripple: 0 };
  let lastTier = 0, wasTier = 0, wasDrifting = false, wasBoosting = false, wasGrounded = true;
  // which charge tier bought the boost currently burning — MK8 tints the flame by it
  let boostTier = tierColor(1), boostTierT = 0;
  // The last charge tier this kart actually reached. A boost can start without this rig ever
  // having seen the release (a boost pad, a mushroom, or a scenario that fast-forwards the
  // race headlessly), and without it the plume would lose its tier colour entirely.
  let heldTier = 1;
  let mudLevel = 0;

  /**
   * Plume budget — the standing guard against "the VFX ate the hero".
   *
   * This game has now lost the player kart twice to a lobe of my own output: round 1 to a
   * white boost blowout, round 3 to a beige dust column. Both times the emitter was obeying
   * its rate formula perfectly; the failure was that no rate formula anywhere knew how much
   * was *already in the air*. Tuning constants cannot fix that, because the next surface,
   * the next speed or the next quality setting simply finds a new combination that stacks.
   *
   * So the ground plume carries an explicit occupancy counter: every alpha-blended puff this
   * rig emits adds one, and it bleeds off at roughly one puff-lifetime. Past PLUME_SOFT the
   * emission rate rolls smoothly to zero at PLUME_HARD, so the plume is allowed to be dense
   * and is structurally incapable of becoming opaque, whatever the inputs do.
   */
  let plume = 0;
  const PLUME_SOFT = 22, PLUME_HARD = 40;

  const skidId = seed;
  const TRAIL_ANCHOR = [0, -0.02, -0.95];
  const LANDING_ANCHOR = [0, -0.3, 0];
  const events = { boosts: 0, tierUps: 0, impacts: 0, landings: 0 };
  const st = {
    speed: 0, slip: 0, drifting: false, tier: 0, charge: 0, boosting: false,
    grounded: true, surface: 'tarmac', steer: 0,
    slide: 0,          // 0..1 "this kart is sideways", measured, not declared
    slideT: 0,         // seconds of continuous slide — the charge clock
    airT: 0,           // seconds since the last real ground contact
    airTime: null,     // the physics' own airborne clock, when it keeps one
    contact: 1,        // 0..1 how much ground effect this kart still earns
  };

  /**
   * Mini-turbo charge, derived from motion.
   *
   * Round 2 gated every drift effect on `target.drifting` / `target.driftTier`. In the
   * canonical drift plate the physics reports *false* and *0* while the kart is crossed up
   * at 22 m/s with 46% of its velocity pointing sideways — the hop-and-hold drift state had
   * already lapsed — so the sparks, the tier colour and the release burst were all dead and
   * the most expensive moment in the game rendered as a clean straight-line frame.
   *
   * A VFX rig must not depend on another module's bookkeeping to know what it can measure
   * itself: a kart with that much slip angle *is* drifting, whatever the flag says. So the
   * charge clock runs off `slide` (slip fraction, gated on speed and ground contact), and
   * the physics flags are folded in as a floor rather than a gate. The declared tier still
   * wins when it is higher, so a real hold-drift steps blue -> orange -> purple exactly as
   * the vehicle intends; a scripted or lapsed slide now gets the same treatment.
   */
  const SLIDE_ON = 0.30;         // slip fraction where a corner becomes a slide
  const SLIDE_FULL = 0.52;       // slip fraction that charges at full rate
  const TIER_T = [0.20, 0.72, 1.45];   // seconds of full slide per charge tier

  /**
   * Ground contact, with coyote time.
   *
   * A kart on a real heightfield is airborne far more often than it looks: the wadi hairpin
   * launches the hero for a quarter of a second on every lap, and the canonical drift plate
   * catches it exactly there. Gating tyre smoke, dust and skid marks on the raw `grounded`
   * boolean meant the whole plate emitted nothing at all — the frame was clean because the
   * physics said "in the air", not because the art said "no drift".
   *
   * Real ground FX do not switch, they decay: rubber keeps smoking, the dust the wheels
   * already threw is still in the air, and the mark is already on the road. So contact fades
   * out over a third of a second and only a genuine jump silences it. Sparks ignore this
   * entirely — a mini-turbo charge survives a hop in MK8, which is exactly how you start one.
   */
  const COYOTE_ON = 0.12, COYOTE_OFF = 0.55;

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
    // The physics keeps its own airborne clock; prefer it. Integrating render dt here is
    // wrong whenever the simulation is not stepped at the render rate — the review harness
    // fixes the sim at 1/60 while frames land at 1/15 under software rasterisation, which
    // made the rig believe a 0.2 s hop had lasted the best part of a second and shut every
    // ground effect off in exactly the frame that most needed them.
    st.airTime = t.airTime ?? s?.airTime ?? null;
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

    // --- ground contact, smoothed ---------------------------------------------------
    st.airT = st.grounded ? 0
      : (st.airTime !== null && st.airTime !== undefined ? st.airTime : st.airT + dt);
    st.contact = 1 - smoothstep(COYOTE_ON, COYOTE_OFF, st.airT);

    // --- measured slide -> charge clock -> tier ------------------------------------
    const fastEnough = smoothstep(7, 13, st.speed);
    st.slide = smoothstep(SLIDE_ON, SLIDE_FULL, st.slip) * fastEnough;
    if (st.drifting && st.speed > 7) st.slide = Math.max(st.slide, 0.75);
    if (st.slide > 0.05) st.slideT += dt * (0.35 + 0.65 * st.slide);
    else st.slideT = Math.max(0, st.slideT - dt * 3.2);   // a brief straighten does not reset
    let syn = 0;
    for (let i = 0; i < 3; i++) if (st.slideT >= TIER_T[i]) syn = i + 1;
    st.tier = Math.max(st.tier, syn);
    st.charge = Math.max(st.charge, clamp(st.slideT / TIER_T[2], 0, 1));
    // downstream code asks "is this kart drifting"; answer it from the motion
    st.drifting = st.drifting || st.slide > 0.25;
  }

  function local(offset, out) {
    out.set(offset[0], offset[1], offset[2]).applyQuaternion(quat).add(pos);
    return out;
  }

  /** The physics wheel array, when the target is a vehicle handle: [FL, FR, RL, RR]. */
  function physWheels() {
    const w = target && target.wheels;
    return (Array.isArray(w) && w.length >= 4) ? w : null;
  }

  /**
   * Distance from this rig's rear-wheel anchor down to the surface the tyre is on, learned
   * from the physics whenever a wheel is actually touching. The anchors are art positions in
   * kart space and the contact patch is wherever the suspension currently puts it, so the
   * gap is a per-kart constant worth measuring rather than guessing — and once measured it
   * survives the hops and kerb-hops where no wheel reports a contact at all.
   */
  const wtmp = new THREE.Vector3();
  const markPrev = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const markHave = [false, false, false, false];
  function breakMarks() {
    if (!vfx.decals) return;
    for (let i = 0; i < 4; i++) {
      vfx.decals.breakTrail(skidId + i); vfx.decals.breakTrail(skidId + 4 + i);
      markHave[i] = false;
    }
  }
  let wheelDrop = 0.40;
  /**
   * How far the racing ribbon sits above the raw SRTM terrain, learned at every real wheel
   * contact. The circuit is a smoothed spline draped over the heightfield and stands up to
   * 0.7 m proud of it on an embanked corner, so `world.heightAt` alone puts a mark under the
   * road. Carrying the measured offset forward is what lets the rig still place a mark on
   * the *road* during the quarter-second hops where no wheel reports a contact at all — the
   * alternative is stamping at the kart's flight height, which hangs the stripe in mid-air.
   */
  let ribbonLift = 0;
  function roadYAt(x, z, fallback) {
    if (world && world.heightAt) {
      const h = world.heightAt(x, z);
      if (Number.isFinite(h)) return h + ribbonLift;
    }
    return fallback;
  }
  function trackSurfaceLift(dt) {
    const pw = physWheels();
    if (!pw) return;
    for (let i = 2; i < 4; i++) {
      const c = pw[i];
      if (!c || !c.contact || !c.contactPos || !Number.isFinite(c.contactPos.y)) continue;
      local(wheels[i - 2] || wheels[0], wtmp);
      wheelDrop = damp(wheelDrop, clamp(wtmp.y - c.contactPos.y, 0.02, 1.4), 8, dt);
      if (world && world.heightAt) {
        const h = world.heightAt(c.contactPos.x, c.contactPos.z);
        if (Number.isFinite(h)) ribbonLift = damp(ribbonLift, clamp(c.contactPos.y - h, -2, 4), 6, dt);
      }
      return;
    }
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
    trackSurfaceLift(dt);
    const fx = surfaceFX(st.surface);
    const spd = st.speed;
    const fast = clamp(spd / 26, 0, 1.35);
    const slip = st.slip;
    const grounded = st.grounded;
    const onWater = fx.wet > 0;

    // Bleed the plume occupancy off over roughly one puff lifetime, then derive the gate
    // that every alpha-blended ground emitter below multiplies into its rate.
    plume = Math.max(0, plume - dt * (plume * 1.15 + 0.5));
    const plumeGate = 1 - smoothstep(PLUME_SOFT, PLUME_HARD, plume);

    /* --- tyre smoke / surface dust ------------------------------------------------ */
    if (st.contact > 0.02 && spd > 1.2) {
      const heat = clamp(slip * 2.1, 0, 1.25) * (0.35 + 0.85 * fast);
      /**
       * Loose-surface dust rate.
       *
       * The 0.45 floor this used to carry is what put a dust column over the hero on Ridge
       * Road: a kart with 1% slip angle, tracking dead straight down a road the art renders
       * as asphalt, still earned 45% of the full-lock-slide rate purely for being fast. But
       * dust is thrown by tyres *scrubbing*, not by tyres *rolling* — a kart tracking true
       * on hard-packed dirt leaves a thin trail off the rear contact patches and nothing
       * else. So the rate is now dominated by slip and by the measured slide, with only a
       * small speed-driven floor to keep a trail alive on a straight.
       */
      const loose = fx.rate * (0.10 + 0.55 * fast) * (0.12 + 0.70 * slip + 0.55 * st.slide);
      const hard = fx.decal === 'tyre';
      // Halved against the old rates. driftSmoke lives ~0.65 s, so 46/s on tarmac put ~30
      // metre-wide puffs around the kart at once and they merged into one fog bank that hid
      // the wheels. A pair of readable plumes needs ~8 concurrent, not 30.
      const smokeRate = (onWater ? 22 * fast
        : (hard ? fx.rate * heat * 0.48 : loose * 1.00 + fx.rate * heat * 0.30)) * st.contact * plumeGate;
      const n = rate('smoke', smokeRate * (o.rate ?? 1) * vfx.emitScale, dt);
      plume += n;
      for (let i = 0; i < n; i++) {
        const w = wheels[i % wheels.length];
        local(w, wp);
        // Lift the spawn clear of the road. Soft particles fade against scene depth, so a
        // puff born flush with the tarmac is erased by the very surface it came off — which
        // is why the round-2 drift frame carried tyre smoke in the particle stats and none
        // on screen. Half a puff-radius up is enough to survive and still hug the ground.
        wp.y += hard ? 0.20 + rand() * 0.16 : 0.08;
        wp.addScaledVector(fwd, -0.7 - rand() * 0.7);
        // push the spawn point outboard of the bodywork so the plume frames the kart
        wp.addScaledVector(right, (w[0] < 0 ? -1 : 1) * (0.15 + rand() * 0.3));
        dirv.set(0, fx.rise * 1.5, 0).addScaledVector(fwd, -0.5 - rand() * 0.5)
          .addScaledVector(right, (rand() < 0.5 ? -1 : 1) * (0.40 + rand() * 0.5));
        // Velocity inheritance. Carrying too much of the kart's velocity kept the plume
        // pinned around the kart instead of behind it, and a veil that sits *between* the
        // lens and the hero is what desaturated the kart in the round-2 grove shot. A third
        // keeps the column trailing without letting it sweep out of frame in one beat.
        const inh = onWater ? 0 : (hard ? 0.32 : 0.44);
        vfx.emit(onWater ? 'splashMist' : (hard ? 'driftSmoke' : 'dust'), {
          pos: wp, dir: dirv, count: 1, raw: true,
          vx: vel.x * inh, vy: vel.y * inh, vz: vel.z * inh,
          colorA: fx.a, colorB: fx.b,
          scale: lerp(0.58, 1.35, rand()) * (hard ? lerp(0.80, 1.25, heat) : 1),
          // per-puff opacity spread: identical alphas integrate to a flat plateau, a spread
          // of them keeps individual puffs readable inside the plume
          // A loose-ground puff's opacity follows the scrub too, not the speedometer: a
          // straight-line trail is a translucent smudge, a full slide is a solid plume.
          opacity: (hard ? clamp(0.40 + heat * 0.52, 0, 0.98)
            : clamp(0.24 + 0.26 * fast + 0.42 * st.slide, 0, 1.0)) * lerp(0.7, 1.18, rand()),
          speedScale: 0.7 + fast * 0.9,
          drag: fx.drag,
        });
      }

      // Scrub kernel: the bright, dense root of a slide, pinned to the contact patch and
      // thrown outboard the way the tyre is actually being dragged. The rising column above
      // has to grow out of something that touches the road, or the whole plume floats.
      if (!onWater && st.slide > 0.12) {
        const sgn = vel.dot(right) < 0 ? -1 : 1;
        const scrubRate = (hard ? 34 : 16) * st.slide * (0.45 + 0.75 * fast) * st.contact * plumeGate;
        const sn = rate('scrub', scrubRate * (o.rate ?? 1) * vfx.emitScale, dt);
        plume += sn * 0.6;                       // scrub puffs are small; they count for less
        for (let i = 0; i < sn; i++) {
          const w = wheels[i % wheels.length];
          local(w, wp);
          wp.y += 0.10 + rand() * 0.10;
          wp.addScaledVector(fwd, -0.30 - rand() * 0.45)
            .addScaledVector(right, sgn * (0.10 + rand() * 0.42));
          dirv.copy(right).multiplyScalar(sgn * (0.75 + rand() * 0.6))
            .addScaledVector(up, 0.55 + rand() * 0.5)
            .addScaledVector(fwd, -0.35);
          vfx.emit('scrubPuff', {
            pos: wp, dir: dirv, count: 1, raw: true,
            vx: vel.x * 0.34, vy: vel.y * 0.34, vz: vel.z * 0.34,
            colorA: hard ? undefined : fx.a, colorB: hard ? undefined : fx.b,
            scale: (hard ? 1.0 : 1.25) * lerp(0.75, 1.35, rand()),
            opacity: clamp(0.5 + 0.55 * st.slide, 0, 1.1) * lerp(0.75, 1.15, rand()),
            speedScale: 0.75 + fast * 0.7,
          });
        }
      }

      // Rooster tail. `dust` above is the fine haze that hangs; this is the long low plume
      // the rear wheels drag across loose ground, and it is the single strongest speed cue
      // available on a pale sand surface where nothing else has any value contrast.
      if (!onWater && fx.chips !== undefined && fx.decal !== 'tyre' && fast > 0.25) {
        // Slip- and slide-driven, like the dust above: a rooster tail is thrown by a tyre
        // being dragged sideways. The old 0.55 speed-only floor is what doubled the beige
        // column over the hero on a straight.
        const rr = fx.rate * 0.34 * fast * (0.10 + 0.55 * slip + 0.55 * st.slide) * st.contact * plumeGate;
        const rn = rate('rooster', rr * (o.rate ?? 1) * vfx.emitScale, dt);
        plume += rn;
        for (let i = 0; i < rn; i++) {
          const w = wheels[i % wheels.length];
          local(w, wp);
          wp.y += 0.06; wp.addScaledVector(fwd, -0.85 - rand() * 0.55);
          dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.42 + rand() * 0.35)
            .addScaledVector(right, (rand() * 2 - 1) * 0.45);
          vfx.emit('rooster', {
            pos: wp, dir: dirv, count: 1, raw: true,
            vx: vel.x * 0.52, vy: vel.y * 0.52, vz: vel.z * 0.52,
            colorA: fx.a, colorB: fx.b,
            scale: 0.85 + rand() * 0.6, speedScale: 0.55 + fast * 0.85,
            opacity: clamp(0.26 + 0.24 * fast + 0.40 * st.slide, 0, 1.0) * lerp(0.72, 1.16, rand()),
          });
        }
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
      if ((fx.mud || 0) > 0 && spd > 6) {
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
    // A slide has to leave the road marked, or the smoke above it has no cause. The mark is
    // laid under all four wheels while sliding (a crossed-up kart scrubs its fronts too) and
    // widened, because a 0.34 m strip seen from a chase lens 7 m back is two pixels of value
    // against tarmac and simply is not there.
    if (vfx.decals && st.contact > 0.35 && spd > 3) {
      const heat = clamp(Math.max(slip * 2.0, st.slide * 1.15), 0, 1) * st.contact;
      const strength = (fx.decalAlpha || 0) * heat * (1 + 0.45 * st.slide) * (st.boosting ? 1.15 : 1);
      // a crossed-up kart scrubs its fronts as hard as its rears
      // Two lines, not four. A crossed-up kart does scrub its fronts, but four parallel
      // ladders read as clutter from a chase lens; the rears are the mark of a drift.
      const marks = wheels;
      const pw = physWheels();
      const pIdx = [2, 3];
      if (fx.decal && strength > 0.04) {
        const opts = {
          kind: fx.decal,
          // A stamp is drawn at half the axes it is handed, so ask for twice the rubber a
          // tyre actually lays and the mark comes out tyre-width on screen.
          width: (o.markWidth ?? 0.52) * (1.0 + 0.30 * st.slide),
          alpha: clamp(strength, 0, 0.86),
          /**
           * The mark has to be darker than the road, not the same value as it.
           *
           * decals.js defaults a tyre mark to [0.30, 0.29, 0.30]. That is almost exactly the
           * display value of the sunlit asphalt on this circuit, and the decal shader is a
           * plain alpha-over — so the whole ladder of stamps was being painted, uploaded and
           * drawn in the right place at 0.78 alpha, and changed the road by nothing. It read
           * on screen as "there are no skid marks", which is what three review rounds have
           * called it. Hot rubber laid on asphalt is near-black with a warm cast; giving the
           * trail an explicit colour is what makes the mark exist.
           */
          color: fx.decal === 'tyre' ? [0.052, 0.046, 0.050] : [0.30, 0.26, 0.20],
          life: fx.decal === 'tyre' ? 11 : 7,
          // A stamp is only laid once the wheel has travelled `segment`, and it covers half
          // of what it was given. Leaving that at the 0.42 m default meant a kart moving
          // 0.37 m per step stamped every *other* step, so the mark came out as a ladder of
          // blocks with a metre of clean road between them. Stamping every step, and filling
          // the halves with the interleaved trail below, is what makes it a continuous line.
          segment: 0.26,
        };
        for (let i = 0; i < marks.length; i++) {
          local(marks[i], wp);
          // The surface height, in order of preference: the physics wheel that is touching
          // right now, else this kart's own measured wheel-to-road drop. Either way the mark
          // lands on the road ribbon, not on the terrain half a metre below it.
          const c = pw && pw[pIdx[i]];
          let sy;
          if (c && c.contact && c.contactPos && Number.isFinite(c.contactPos.y)) {
            sy = c.contactPos.y; wp.x = c.contactPos.x; wp.z = c.contactPos.z;
          } else sy = roadYAt(wp.x, wp.z, wp.y - wheelDrop);
          wp.y = sy;
          vfx.surfaceHint(wp.x, wp.z, sy, 2.2);
          vfx.decals.trail(skidId + i, wp, fwd, opts);
          // Each stamp only covers the middle half of the ground it was given, so a mark
          // laid at 22 m/s comes out as a row of dashes with a metre of clean road between
          // them. A second trail per wheel, fed the midpoints, is exactly half a phase out
          // and drops its stamps into the first one's gaps: one continuous scrub.
          const mp = markPrev[i];
          if (mp.set !== undefined && markHave[i]) {
            wtmp.set((mp.x + wp.x) * 0.5, (mp.y + wp.y) * 0.5, (mp.z + wp.z) * 0.5);
            vfx.surfaceHint(wtmp.x, wtmp.z, wtmp.y, 2.2);
            vfx.decals.trail(skidId + 4 + i, wtmp, fwd, opts);
          }
          mp.copy(wp); markHave[i] = true;
          vfx.surfaceHint();
        }
        for (let i = marks.length; i < 4; i++) {
          vfx.decals.breakTrail(skidId + i); vfx.decals.breakTrail(skidId + 4 + i);
          markHave[i] = false;
        }
      } else { breakMarks(); }
    } else if (vfx.decals) { breakMarks(); }

    /* --- mini-turbo charge sparks ------------------------------------------------- */
    if (st.drifting && st.tier > 0) {
      const T = tierColor(st.tier);
      heldTier = st.tier;
      /**
       * Charge staging. MK8 steps blue -> orange -> purple, and the step is the whole point
       * of holding a drift. One flat hue for the entire charge (which is what a plate caught
       * mid-tier used to show) throws that away, so as `slideT` climbs toward the next tier
       * a growing share of the shower is emitted in the *next* tier's colours. The result is
       * a blue shower that visibly starts throwing orange before it flips — the charge
       * reading MK8 gets from its gauge, on the sparks themselves.
       */
      const nextT = tierColor(Math.min(3, st.tier + 1));
      const span = TIER_T[Math.min(2, st.tier)] - (st.tier > 0 ? TIER_T[st.tier - 1] : 0);
      const toNext = st.tier >= 3 ? 0
        : clamp((st.slideT - (st.tier > 0 ? TIER_T[st.tier - 1] : 0)) / Math.max(span, 1e-3), 0, 1);
      const bleed = smoothstep(0.45, 1.0, toNext) * 0.5;

      // sparks come off the loaded, outboard rear wheel — the one being dragged sideways
      const sgn = vel.dot(right) < 0 ? -1 : 1;
      const n = rate('spark', T.rate * 3.6 * (0.55 + 0.55 * fast) * (0.35 + 0.75 * st.slide) * vfx.emitScale, dt);
      const pwS = physWheels();
      for (let i = 0; i < n; i++) {
        /**
         * Anchor at the *contact patch*, not at an art offset.
         *
         * The rig's `sparkAnchor` is a guess about where a kart's rear wheels sit in its own
         * space; the suspension decides where they actually are, and on a kerb-hop or a
         * cambered corner the guess is a good half metre out. That is why sparks were seen
         * floating clear of any wheel, sitting on the road like dropped chips. When the
         * physics reports a rear contact, spawn there and the shower is welded to the tyre.
         */
        const wi = i % 2;
        const c = pwS && pwS[2 + wi];
        if (c && c.contact && c.contactPos && Number.isFinite(c.contactPos.y)) {
          wp.set(c.contactPos.x, c.contactPos.y + 0.06, c.contactPos.z);
        } else {
          local(sparkAnchor[wi % sparkAnchor.length], wp);
        }
        // bias the shower to the loaded, outboard wheel — that is the one being scrubbed
        wp.addScaledVector(right, sgn * (0.04 + rand() * 0.10));
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.55 + rand() * 0.30)
          .addScaledVector(right, sgn * (0.40 + rand() * 0.50));
        const S = (bleed > 0 && rand() < bleed) ? nextT : T;
        /**
         * Hue survival under a screen blend.
         *
         * `dst + src*(1-dst)` drives *every* channel toward 1, so a source that already has
         * two bright channels (the tier `glow`, e.g. 0x86e2ff) lands as plain white over a
         * mid-value road and the charge tier stops reading at all — which is what the first
         * pass of this fix produced. The hue has to live in a colour with real channel
         * separation, so the tail is the deep tier flame (0x0e34c4 blue, 0xc42a00 orange,
         * 0x5c10b4 purple), and only a third of the shower gets the white-hot head. That is
         * a blue shower with white leaders in it, not a white shower.
         */
        const hot = rand() < 0.34;
        // White-hot head cooling into the saturated tier hue. Screen-blended over dark
        // tarmac that is a bright core with a coloured tail; `rot: 0` with `stretch` pins
        // the star's long arm along the streak so it reads as a comet and not as a chip.
        vfx.emit('driftSpark', {
          pos: wp, dir: dirv, count: 1, raw: true,
          colorA: hot ? S.core : S.flameA, colorB: S.flameB,
          rot: 0, rotJitter: 0,
          scale: S.size * (0.85 + rand() * 0.8),
          speedScale: 0.85 + rand() * 0.7,
        });
        // A few longer, brighter leaders so the shower has a size hierarchy rather than a
        // dozen identical quads — the other half of why round 3 read as confetti.
        if (rand() < 0.22) {
          vfx.emit('driftSpark', {
            pos: wp, dir: dirv, count: 1, raw: true,
            colorA: S.core, colorB: S.flameA,
            rot: 0, rotJitter: 0, stretch: 0.70,
            scale: S.size * (1.5 + rand() * 0.7), lifeScale: 1.25,
            speedScale: 1.25 + rand() * 0.5,
          });
        }
        // the soft tier-coloured pool the shower sits in: MK8 reads its charge level from
        // this glow as much as from the individual sparks
        if (rand() < 0.45) {
          vfx.emit('miniTurbo', {
            pos: wp, dir: dirv, count: 1, raw: true,
            colorA: S.flameA, colorB: S.flameB, scale: S.size * (1.0 + rand() * 0.6),
            rot: 0, rotJitter: 0,
            opacity: 0.8, speedScale: 0.5 + rand() * 0.5,
          });
        }
        // and the pool of light at the tyre itself, which is what makes the charge tier
        // legible at race distance when no single spark is four pixels across
        if (rand() < 0.30) {
          vfx.emit('sparkGlow', {
            pos: wp, dir: up, count: 1, raw: true,
            colorA: S.flameA, colorB: S.flameB,
            scale: S.size * (1.1 + rand() * 0.6),
            opacity: 0.55 + 0.35 * st.slide,
          });
        }
      }
      if (st.tier > lastTier) {                      // tier-up pop
        events.tierUps++;
        for (const a of sparkAnchor) {
          local(a, wp);
          vfx.emit('miniTurbo', { pos: wp, dir: up, count: 6, scale: T.size * 2.0, colorA: T.flameA, colorB: T.flameB, rot: 0, rotJitter: 0, opacity: 0.9, speedScale: 1.6 });
          vfx.emit('driftSpark', { pos: wp, dir: up, count: 16, scale: T.size * 1.3, colorA: T.core, colorB: T.flameB, rot: 0, rotJitter: 0, speedScale: 1.5 });
          vfx.emit('sparkGlow', { pos: wp, dir: up, count: 3, scale: T.size * 2.2, colorA: T.flameA, colorB: T.flameB, opacity: 0.85 });
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
      boostTier = T; boostTierT = 0.9; heldTier = tier;
      for (const e of exhausts) {
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1);
        vfx.emit('boostBurst', {
          pos: wp, dir: dirv, scale: 0.62 + 0.16 * tier,
          vx: vel.x * 0.85, vy: vel.y * 0.85, vz: vel.z * 0.85,
          rot: 0, rotJitter: 0.45,
          tierA: T.flameA, tierB: T.flameB, speedScale: 0.9 + 0.25 * tier,
        });
      }
      trail.setColors(T.core, T.flameA);
      // a fan of tier-coloured sparks thrown off the rear as the turbo lets go
      for (const a of sparkAnchor) {
        local(a, wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.4);
        vfx.emit('driftSpark', {
          pos: wp, dir: dirv, count: 10 + 4 * tier, scale: T.size * 1.25,
          colorA: T.core, colorB: T.flameB, rot: 0, rotJitter: 0, speedScale: 1.5,
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
      boostTier = tierColor(heldTier); boostTierT = 0.9;
      trail.setColors(boostTier.core, boostTier.flameA);
      for (const e of exhausts) {
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1);
        vfx.emit('boostBurst', {
          pos: wp, dir: dirv, scale: 0.8, speedScale: 1.1, rot: 0, rotJitter: 0.45,
          vx: vel.x * 0.85, vy: vel.y * 0.85, vz: vel.z * 0.85,
        });
      }
    }
    if (st.boosting) {
      /* The exhaust plume, back to front:
       *   soot           dark, alpha-blended, laid down first so the fire has a backing
       *   flame body     orange, alpha-over -> keeps its hue and silhouette under any overlap
       *   tier tongue    the charge colour that earned this boost, riding the outside
       *   core           one ~0.15 m near-white kernel per exhaust: the whole bloom budget
       *   embers         individually readable specks trailing up and back
       *
       * INHERIT is the other half of the old blowout. Particles were emitted with only their
       * own exhaust velocity, so at 60 km/h the kart drove out from under them and a 0.2 s
       * plume ended up 3 m behind the kart — which, from a chase camera 5 m back, is 2 m from
       * the lens and fills a third of the screen. Carrying most of the kart's velocity pins
       * the plume to the exhaust; what is left over (~12% of forward speed plus the exhaust
       * blast) is what stretches it into a tongue about a metre long. */
      const INHERIT = 0.82;
      const ivx = vel.x * INHERIT, ivy = vel.y * INHERIT, ivz = vel.z * INHERIT;
      const tierMix = clamp(boostTierT / 0.45, 0, 1);

      const nf = rate('flame', 54 * vfx.emitScale, dt);
      for (let i = 0; i < nf; i++) {
        const e = exhausts[i % exhausts.length];
        local(e, wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.06).addScaledVector(right, (rand() * 2 - 1) * 0.08);
        vfx.emit('boostFlame', {
          pos: wp, dir: dirv, count: 1, raw: true, vx: ivx, vy: ivy, vz: ivz,
          rot: 0, rotJitter: 0.45,
          scale: 0.85 + rand() * 0.40, speedScale: 0.85 + fast * 0.35,
        });
        if (tierMix > 0 && rand() < 0.55) {
          local(e, wp);
          // splayed outwards and set a little further back, so the tier colour rides the
          // outside of the orange core the way MK8's mini-turbo flame does
          wp.addScaledVector(right, (e[0] < 0 ? -1 : 1) * (0.05 + rand() * 0.09));
          wp.addScaledVector(fwd, -0.12 - rand() * 0.10);
          vfx.emit('boostTierFlame', {
            pos: wp, dir: dirv, count: 1, raw: true, vx: ivx, vy: ivy, vz: ivz,
            rot: 0, rotJitter: 0.40,
            colorA: boostTier.flameA, colorB: boostTier.flameB,
            scale: 0.95 + rand() * 0.35, opacity: tierMix,
            speedScale: 0.95 + fast * 0.35,
          });
        }
      }
      // soot: half the flame rate, launched a little high and wide so it frames the fire
      const ns = rate('smoke2', 10 * vfx.emitScale, dt);
      for (let i = 0; i < ns; i++) {
        local(exhausts[i % exhausts.length], wp);
        wp.y += 0.05;
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.65).addScaledVector(right, (rand() * 2 - 1) * 0.35);
        vfx.emit('boostSmoke', {
          pos: wp, dir: dirv, count: 1, raw: true, vx: ivx * 0.82, vy: ivy * 0.82, vz: ivz * 0.82,
          scale: 0.9 + rand() * 0.6,
        });
      }
      const nc = rate('core', 28 * vfx.emitScale, dt);
      for (let i = 0; i < nc; i++) {
        local(exhausts[i % exhausts.length], wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.12);
        vfx.emit('boostCore', {
          pos: wp, dir: dirv, count: 1, raw: true, vx: ivx, vy: ivy, vz: ivz,
          scale: 0.9 + rand() * 0.30,
        });
      }
      const en = rate('ember', 22 * vfx.emitScale, dt);
      for (let i = 0; i < en; i++) {
        local(exhausts[i % exhausts.length], wp);
        dirv.copy(fwd).multiplyScalar(-1).addScaledVector(up, 0.6).addScaledVector(right, (rand() * 2 - 1) * 0.45);
        vfx.emit('ember', {
          pos: wp, dir: dirv, count: 1, raw: true, speedScale: 0.9 + rand(),
          vx: ivx * 0.55, vy: ivy * 0.55, vz: ivz * 0.55,
          colorA: boostTier.core, colorB: boostTier.flameA || PALETTE.boostFlame, opacity: 1,
        });
      }
      // grit torn off the road by the blast — the dust plume a boost should leave behind
      if (grounded && fx.wet === 0) {
        const gn = rate('grit', (12 + 16 * fast) * vfx.emitScale, dt);
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
    const targetTrail = boostAmt * clamp(0.16 + fast * 0.26, 0, 0.45);
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
    // main.js re-points a rig at its vehicle every frame (`rig.target = vehicle`). Without
    // these accessors that assignment landed on a dead property and the rig kept reading
    // whatever handle it was built with — fine while the race object is stable, silently
    // wrong the moment the field is rebuilt.
    get target() { return target; },
    set target(v) { if (v) target = v; },
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
