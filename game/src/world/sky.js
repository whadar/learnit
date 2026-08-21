import * as THREE from 'three';
import { rng, clamp, lerp, smoothstep } from '../core/mathx.js';
import { createLighting } from '../render/lighting.js';

/**
 * Atmosphere for Kat Racing — Amikam Village Circuit, Ramot Menashe, Israel (32.5636 N).
 *
 * Owns: the scattering sky dome (Preetham base, retuned for a dry hazy Mediterranean
 * afternoon), procedural cumulus + cirrus cover, the real solar position for the site, and
 * the palette that `src/render/lighting.js` turns into sun / IBL / aerial perspective.
 *
 *   const sky = createSky(engine, world);
 *   sky.setTimeOfDay('golden');   // or a decimal local hour, e.g. 17.2
 *
 * Everything is deterministic: cloud fields come from rng(seed), never Math.random().
 */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------------------------------------------------------------------------------------
// Solar position (NOAA low-precision algorithm) for a fixed site and local clock time.
// ---------------------------------------------------------------------------------------

/** @returns {{elevation:number, azimuth:number}} degrees; azimuth clockwise from north. */
export function solarPosition(lat, lon, dayOfYear, localHour, tzOffset) {
  const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (localHour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));           // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);             // radians
  const timeOffset = eqTime + 4 * lon - 60 * tzOffset;                     // minutes
  const tst = localHour * 60 + timeOffset;                                 // true solar time
  const ha = (tst / 4 - 180) * D2R;                                        // hour angle
  const la = lat * D2R;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(clamp(cosZ, -1, 1));
  let az = Math.acos(clamp((Math.sin(la) * Math.cos(zenith) - Math.sin(decl)) /
    (Math.cos(la) * Math.sin(zenith) || 1e-6), -1, 1));
  az = ha > 0 ? (Math.PI + az) : (Math.PI - az);        // 0 = north, clockwise
  return { elevation: 90 - zenith * R2D, azimuth: (az * R2D + 360) % 360 };
}

/** Compass azimuth (deg from north, cw) + elevation -> world direction (+X east, +Z south). */
export function sunDirection(elevationDeg, azimuthDeg, out = new THREE.Vector3()) {
  const el = elevationDeg * D2R, az = azimuthDeg * D2R, c = Math.cos(el);
  return out.set(c * Math.sin(az), Math.sin(el), -c * Math.cos(az)).normalize();
}

// ---------------------------------------------------------------------------------------
// Preetham scattering, evaluated on the CPU with exactly the shader's constants so the
// fog / ambient palette really matches the pixels in the sky.
// ---------------------------------------------------------------------------------------

const BETA_R0 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_K = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAY_ZENITH = 8.4e3, MIE_ZENITH = 1.25e3;
const CUTOFF = 1.6110731556870734, STEEP = 1.5, EE = 1000;

function sunE(cosZ) {
  cosZ = clamp(cosZ, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(cosZ)) / STEEP)));
}
function opticalInverse(cosZenith) {
  const za = Math.acos(Math.max(0, cosZenith));
  return 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - za * R2D, -1.253));
}
function coefficients(p) {
  const sunfade = 1 - clamp(1 - Math.exp(p.sunY / 450000), 0, 1);
  const rc = p.rayleigh - (1 - sunfade);
  const c = 0.2 * p.turbidity * 1e-17;
  return {
    betaR: BETA_R0.map(v => v * rc),
    betaM: MIE_K.map(v => 0.434 * c * v * p.mie),
    sunE: sunE(p.sunElevationCos),
  };
}
/** three's ACESFilmicToneMapping, on the CPU, so the palette can be display-referred. */
const _ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const _ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const _mul3 = (m, v) => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function acesFilmic(rgb, exposure = 1) {
  let v = _mul3(_ACES_IN, rgb.map(x => Math.max(x, 0) * exposure / 0.6));
  v = v.map(x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return _mul3(_ACES_OUT, v).map(x => clamp(x, 0, 1));
}
const linToSrgb = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/** Linear radiance of the sky in `dir` (matches the fragment shader, pre-tonemap). */
function skyRadiance(dir, sunDir, p) {
  const { betaR, betaM, sunE: E } = coefficients(p);
  const inv = opticalInverse(dir.y);
  const sR = RAY_ZENITH * inv, sM = MIE_ZENITH * inv;
  const Fex = [0, 1, 2].map(i => Math.exp(-(betaR[i] * sR + betaM[i] * sM)));
  const cosT = dir.dot(sunDir);
  const rPhase = 0.05968310365946075 * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
  const g = p.mieG, g2 = g * g;
  const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5));
  const out = [0, 0, 0];
  const upDotSun = clamp(Math.pow(1 - sunDir.y, 5), 0, 1);
  for (let i = 0; i < 3; i++) {
    const bR = betaR[i] * rPhase, bM = betaM[i] * mPhase;
    const ratio = (bR + bM) / (betaR[i] + betaM[i]);
    let Lin = Math.pow(E * ratio * (1 - Fex[i]), 1.5);
    Lin *= lerp(1, Math.pow(Math.max(E * ratio * Fex[i], 0), 0.5), upDotSun);
    out[i] = Lin * 0.04;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Deterministic tileable value-noise cloud field baked to a texture.
// R base density | G billow | B fine detail | A large-scale clump/coverage modulation
// ---------------------------------------------------------------------------------------

function noiseSampler(seed) {
  const r = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = r();
  const lat = (x, y, per) => {
    x = ((x % per) + per) % per; y = ((y % per) + per) % per;
    return val[perm[(x + perm[y & 255]) & 255]];
  };
  // u,v in [0,1); `per` is the lattice period so the result tiles seamlessly.
  return function noise(u, v, per) {
    const x = u * per, y = v * per;
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = lat(ix, iy, per), b = lat(ix + 1, iy, per);
    const c = lat(ix, iy + 1, per), d = lat(ix + 1, iy + 1, per);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
}

function makeCloudTexture(size = 512, seed = 20250815) {
  const n = noiseSampler(seed);
  const fbm = (u, v, per, oct, gain = 0.5) => {
    let s = 0, amp = 1, norm = 0, f = per;
    for (let i = 0; i < oct && f <= 256; i++) { s += amp * n(u, v, f); norm += amp; amp *= gain; f *= 2; }
    return s / norm;
  };
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      // domain warp gives cauliflower edges instead of woolly blobs
      const wx = fbm(u + 0.13, v + 0.71, 4, 3) - 0.5;
      const wy = fbm(u + 0.57, v + 0.29, 4, 3) - 0.5;
      const uu = u + wx * 0.09, vv = v + wy * 0.09;
      const base = fbm(uu, vv, 4, 6);
      let bill = 0, amp = 1, norm = 0, f = 8;
      for (let i = 0; i < 4; i++) { bill += amp * (1 - Math.abs(2 * n(uu, vv, f) - 1)); norm += amp; amp *= 0.5; f *= 2; }
      bill /= norm;
      const detail = fbm(u, v, 32, 3);
      const clump = fbm(u + 0.11, v + 0.83, 2, 3);
      const i4 = (y * size + x) * 4;
      data[i4] = clamp(base * 255, 0, 255);
      data[i4 + 1] = clamp(bill * 255, 0, 255);
      data[i4 + 2] = clamp(detail * 255, 0, 255);
      data[i4 + 3] = clamp(clump * 255, 0, 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------
// Sky shader
// ---------------------------------------------------------------------------------------

const SKY_VERT = /* glsl */`
uniform vec3 uSunDir;
uniform float uRayleigh, uTurbidity, uMie;
varying vec3 vWorldPosition, vSunDirection, vBetaR, vBetaM;
varying float vSunE, vSunfade;

const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;

  vSunDirection = normalize( uSunDir );
  float zc = clamp( vSunDirection.y, -1.0, 1.0 );
  vSunE = EE * max( 0.0, 1.0 - exp( -( ( cutoffAngle - acos( zc ) ) / steepness ) ) );
  vSunfade = 1.0 - clamp( 1.0 - exp( vSunDirection.y * 1000.0 / 450.0 ), 0.0, 1.0 );

  vBetaR = totalRayleigh * ( uRayleigh - ( 1.0 - vSunfade ) );
  vBetaM = 0.434 * ( 0.2 * uTurbidity * 10E-18 ) * MieConst * uMie;
}`;

const SKY_FRAG = /* glsl */`
varying vec3 vWorldPosition, vSunDirection, vBetaR, vBetaM;
varying float vSunE, vSunfade;

uniform float uMieG, uKnee;
uniform vec3  uAureole;
uniform vec3  uGroundHaze;
uniform vec3  uEnvGround;
uniform float uHorizonHaze;
uniform vec3  uHazeTint;          // unit-luminance dust *hue*, not an absolute colour
uniform float uHazeGain;
uniform float uSkySat;
uniform float uExposure;
uniform float uToneExposure;      // renderer.toneMappingExposure, mirrored in here

uniform sampler2D uCloudTex;
uniform float uCoverage, uCloudScale, uCloudOpacity, uShine, uCirrus, uAbsorb, uShadeStep;
uniform vec2  uDrift;
uniform vec3  uCloudLit, uCloudDark;

const float pi = 3.141592653589793;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float hg( float c, float g ) {
  float g2 = g * g;
  return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) / pow( 1.0 - 2.0 * g * c + g2, 1.5 ) );
}

// ACES filmic, byte-identical to three's ACESFilmicToneMapping. The dome is drawn with
// \`toneMapped: false\` (three would otherwise re-encode the un-exposed radiance we hand it),
// so the include of <tonemapping_fragment> below compiles to nothing and the curve has to be
// applied here. Without it the sky is the only thing in frame that never sees a highlight
// shoulder: every value over 1.0 goes straight through linear-to-sRGB and the whole upper
// half of the image sits on flat paper white. This is what the reviewers saw.
vec3 katACES( vec3 x ) {
  const mat3 mIn = mat3( 0.59719, 0.07600, 0.02840,
                         0.35458, 0.90834, 0.13383,
                         0.04823, 0.01566, 0.83777 );
  const mat3 mOut = mat3(  1.60475, -0.10208, -0.00327,
                          -0.53108,  1.10813, -0.07276,
                          -0.07367, -0.00605,  1.07602 );
  vec3 v = mIn * max( x, vec3( 0.0 ) );
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return clamp( mOut * ( a / b ), 0.0, 1.0 );
}

// Raw density of the cumulus deck at a cloud-plane uv. Two decorrelated taps of the same
// tiling field hide the repeat; the clump channel punches holes of clear blue.
float cloudField( vec2 uv ) {
  vec4 a = texture2D( uCloudTex, uv * 0.55 );
  vec4 b = texture2D( uCloudTex, uv * 1.43 + vec2( 0.31, 0.67 ) );
  float clump = a.a * 0.62 + b.a * 0.38;
  clump = clump * clump * ( 3.0 - 2.0 * clump );
  float base  = a.r * 0.58 + b.g * 0.42;
  float d = base * ( 0.30 + 1.45 * clump );
  #ifndef ENV_PASS
    d -= 0.11 * b.b * ( 1.0 - clump );
  #endif
  return d;
}

// Cheap single-scatter cumulus: thickness from the field, sun transmittance from a short
// march toward the sun inside the deck, plus a powder term so cores go dark and edges glow.
vec4 cumulus( vec2 uv, float cosTheta ) {
  float d = cloudField( uv );
  float t = ( d - uCoverage ) * 5.0;
  if ( t <= 0.0 ) return vec4( 0.0 );

  float alpha = clamp( t * 2.6, 0.0, 1.0 );
  alpha = alpha * alpha * ( 3.0 - 2.0 * alpha );

  vec3 col;
#ifdef ENV_PASS
  col = mix( uCloudDark, uCloudLit, 0.6 );
#else
  vec2 stp = normalize( vSunDirection.xz + vec2( 1e-4, 0.0 ) ) * uShadeStep;
  float od = max( cloudField( uv + stp ) - uCoverage, 0.0 )
           + max( cloudField( uv + stp * 2.4 ) - uCoverage, 0.0 ) * 0.70
           + max( cloudField( uv + stp * 4.6 ) - uCoverage, 0.0 ) * 0.42;
  float T = exp( - uAbsorb * od );
  float powder = 1.0 - exp( - 2.6 * t );

  col = uCloudDark * ( 0.55 + 0.45 * powder );
  col += uCloudLit * T * mix( 0.18, 1.0, powder );
  // forward scattering: thin edges in front of the sun light up silver
  float fwd = pow( max( cosTheta, 0.0 ), 9.0 );
  col += uCloudLit * fwd * uShine * ( 0.25 + 0.9 * ( 1.0 - alpha ) );
#endif
  return vec4( col, alpha );
}

void main() {
  vec3 direction = normalize( vWorldPosition - cameraPosition );

  float zenithAngle = acos( max( 0.0, direction.y ) );
  float inv = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( zenithAngle * 180.0 / pi ), -1.253 ) );
  float sR = rayleighZenithLength * inv;
  float sM = mieZenithLength * inv;
  vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

  float cosTheta = dot( direction, vSunDirection );
  vec3 betaRTheta = vBetaR * ( THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta * 0.5 + 0.5, 2.0 ) ) );
  vec3 betaMTheta = vBetaM * hg( cosTheta, uMieG );
  vec3 ratio = ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM );

  vec3 Lin = pow( vSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );
  Lin *= mix( vec3( 1.0 ), pow( vSunE * ratio * Fex, vec3( 0.5 ) ),
              clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );

  vec3 sky = Lin * 0.04 + vec3( 0.0, 0.0006, 0.0016 );

  // --- dry Mediterranean horizon haze: desaturate the bottom of the dome ------------------
  // The haze is expressed as a *relative* term — the sky's own luminance re-tinted with the
  // dust hue — so it can never add energy. The previous form multiplied an absolute palette
  // colour (already in exposed display units) into pre-exposure radiance, which brightened
  // the horizon band by ~40% and is why the bottom third of the dome clipped to paper.
  float hz = 1.0 - smoothstep( -0.015, 0.115, direction.y );
  float skyL = max( dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0 );
  vec3 hazeCol = uHazeTint * skyL * uHazeGain;
  hazeCol *= mix( 1.0, 1.10, pow( max( cosTheta, 0.0 ), 6.0 ) );
  sky = mix( sky, hazeCol, hz * uHorizonHaze );

  // --- clouds ----------------------------------------------------------------------------
  float above = smoothstep( 0.004, 0.045, direction.y );
  if ( above > 0.001 ) {
    vec2 pl = direction.xz / max( direction.y, 0.055 );

    #ifndef ENV_PASS
    // a thin cirrus veil sits behind the cumulus deck
    if ( uCirrus > 0.001 ) {
      vec2 cu = pl * uCloudScale * 0.30 * vec2( 0.62, 1.35 ) + uDrift * 0.35;
      float w = texture2D( uCloudTex, cu ).r * 0.65 + texture2D( uCloudTex, cu * 2.1 + 0.4 ).g * 0.35;
      float wisp = smoothstep( 0.50, 0.80, 1.0 - abs( 2.0 * w - 1.0 ) );
      wisp *= smoothstep( 0.08, 0.34, direction.y );
      sky = mix( sky, mix( uCloudLit * 0.55, sky, 0.35 ), wisp * uCirrus );
    }
    #endif

    vec4 cl = cumulus( pl * uCloudScale + uDrift, cosTheta );
    if ( cl.a > 0.001 ) {
      // Distant clouds sink into the same haze the far hills do — but only in the last few
      // degrees above the skyline. The old fade ran to 0.40 (≈24 deg), and a chase camera
      // never looks higher than about 20 deg, so it dissolved 85% of every cumulus the
      // player could actually see. That is why four of seven review frames had no cloud.
      float far = 1.0 - smoothstep( 0.010, 0.115, direction.y );
      cl.rgb = mix( cl.rgb, mix( sky, uHazeTint * skyL * uHazeGain, 0.45 ), far * 0.70 );
      sky = mix( sky, cl.rgb, cl.a * uCloudOpacity * above );
    }
  }

  // The Mie aureole around a low sun is golden, not white; tint it and roll off the
  // highlight so a quarter of the frame does not clip to flat paper.
  float aur = pow( max( cosTheta, 0.0 ), 7.0 );
  sky *= mix( vec3( 1.0 ), uAureole, aur * 0.55 );
#ifdef ENV_PASS
  // The IBL wants linear radiance, so the only limiter it gets is the old luminance knee.
  {
    float L = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
    float Lc = L <= 1.0 ? L : 1.0 + ( L - 1.0 ) / ( 1.0 + ( L - 1.0 ) * uKnee );
    sky *= Lc / max( L, 1e-4 );
  }
#endif

  // --- solar disc with limb darkening + glow ---------------------------------------------
  float ang = acos( clamp( cosTheta, -1.0, 1.0 ) );
  const float sunR = 0.0082;
  float u = clamp( ang / sunR, 0.0, 1.0 );
  float limb = 1.0 - 0.62 * ( 1.0 - sqrt( max( 0.0, 1.0 - u * u ) ) );
  float disc = smoothstep( sunR, sunR * 0.82, ang ) * limb;
  vec3 sunCol = vSunE * Fex;
  float glow = pow( max( cosTheta, 0.0 ), 2600.0 ) * 5.0
             + pow( max( cosTheta, 0.0 ), 400.0 ) * 0.10
             + pow( max( cosTheta, 0.0 ), 40.0 ) * 0.014;
  #ifdef ENV_PASS
    // The directional light already carries the beam; a sun in the IBL would blow out
    // every diffuse surface in the scene.
    disc = 0.0;
    glow *= 0.10;
  #endif
  sky += sunCol * 900.0 * disc;
  sky += sunCol * glow * 0.04;

  // --- below the horizon --------------------------------------------------------------
#ifdef ENV_PASS
  // For the IBL the lower hemisphere must be the *ground*, not more sky: a warm terra-rossa
  // bounce is what lifts north-facing walls and the undersides of eaves.
  sky = mix( sky, uEnvGround, smoothstep( 0.02, -0.06, direction.y ) );
#else
  float below = smoothstep( -0.01, -0.22, direction.y );
  sky = mix( sky, uGroundHaze, below );
#endif

  sky *= uExposure;

#ifndef ENV_PASS
  // Chroma push *before* the curve. ACES desaturates as it compresses, and a Preetham sky
  // only carries a 1:3:7 channel ratio to begin with; pushing here (rather than in the
  // grade, which would drag the whole frame with it) is what turns a pale cyan wash into
  // the deep Israeli-summer blue the reference frames have.
  {
    float sl = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
    sky = max( mix( vec3( sl ), sky, uSkySat ), 0.0 );
  }
  // Same curve, same exposure knob, same order as every lit surface in the scene.
  sky = katACES( sky * uToneExposure / 0.6 );
#endif

  gl_FragColor = vec4( max( sky, 0.0 ), 1.0 );

#ifndef ENV_PASS
  #include <colorspace_fragment>
#endif
}`;

// ---------------------------------------------------------------------------------------

export const TIME_PRESETS = {
  dawn:    6.4,    //  ~7 deg  — long cold shadows, pink east
  morning: 8.6,    //  ~34 deg
  noon:    12.6,   //  ~79 deg — flat and hot
  after:   15.4,   //  ~53 deg
  golden:  17.15,  //  ~31 deg — the default: warm, long readable shadows
  evening: 18.4,   //  ~16 deg
  dusk:    19.4,   //  ~4 deg
};

const DEFAULTS = {
  lat: 32.5636, lon: 35.0208, tz: 3, dayOfYear: 196,   // mid-July, Israel summer time
  hour: 17.15,
  // A dry Israeli summer sky is genuinely clean: low turbidity, high Rayleigh. The old
  // 2.7/2.9 pair plus an un-tone-mapped dome put the whole sky above display white.
  turbidity: 2.05, rayleigh: 3.5, mie: 0.0019, mieG: 0.72,
  // Fair-weather cumulus: lower coverage threshold = more deck. `cloudField` peaks near
  // 1.4, so 0.375 gives scattered-to-broken cloud rather than the odd wisp.
  coverage: 0.375, cloudScale: 0.22, cloudOpacity: 1.0, cirrus: 0.05,
  cloudSeed: 20250815, cloudSpeed: 0.0022,
  // Pre-tonemap radiance scale for the dome. Read together with `uToneExposure`: the dome
  // now goes through the same ACES curve as everything else, so this sets where the zenith
  // sits on that curve. 0.23 lands the zenith around RGB 122,176,219 before the grade,
  // which the LUT's saturation push turns into a proper Mediterranean blue.
  exposure: 0.215,
  skySaturation: 1.36,
};

/**
 * @param {Engine} engine
 * @param {WorldData} world
 * @param {object} [opts]
 * @returns {{sky:THREE.Mesh, sun:THREE.DirectionalLight, hemi:THREE.HemisphereLight,
 *            sunPos:THREE.Vector3, csm:object, envMap:THREE.Texture,
 *            setTimeOfDay:(h:number|string)=>void, update:(dt:number)=>void}}
 */
export function createSky(engine, world, opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  // ---- global exposure -------------------------------------------------------------------
  // The renderer's ACES curve is the only stage that can still *shape* a highlight; once a
  // pixel has clipped there, no amount of grading in the composer brings it back. So the
  // image's exposure belongs to the atmosphere module, next to the light levels it has to
  // balance against. Review round 1 measured 7–11% clipped pixels and a mean luminance of
  // 178 on driftCorner at 0.72; 0.73 with half the ambient fill (and a sun raised to match) puts the sunlit limestone back under the shoulder and
  // is what lets the sky keep a gradient at all. An explicit `?exposure=` always wins.
  {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    if (!(q && q.has('exposure')) && opts.toneExposure !== false) {
      engine.renderer.toneMappingExposure = opts.toneExposure ?? 0.73;
    }
  }

  const cloudTex = makeCloudTexture(opts.cloudRes ?? 768, o.cloudSeed);

  const uniforms = {
    uSunDir:      { value: new THREE.Vector3(0.4, 0.5, -0.7).normalize() },
    uRayleigh:    { value: o.rayleigh },
    uTurbidity:   { value: o.turbidity },
    uMie:         { value: o.mie },
    uMieG:        { value: o.mieG },
    uKnee:        { value: 0.62 },
    uAureole:     { value: new THREE.Color(1.14, 0.98, 0.78) },
    uGroundHaze:  { value: new THREE.Color(0.34, 0.30, 0.25) },
    uEnvGround:   { value: new THREE.Color(0.30, 0.22, 0.15) },
    uHorizonHaze: { value: 0.15 },
    uHazeTint:    { value: new THREE.Color(1.03, 1.0, 0.95) },   // unit-luminance dust hue
    uHazeGain:    { value: 1.0 },
    uSkySat:      { value: o.skySaturation },
    uExposure:    { value: o.exposure },
    uToneExposure:{ value: engine.renderer.toneMappingExposure || 1 },
    uCloudTex:    { value: cloudTex },
    uCoverage:    { value: o.coverage },
    uCloudScale:  { value: o.cloudScale },
    uCloudOpacity:{ value: o.cloudOpacity },
    uShine:       { value: 0.55 },
    uAbsorb:      { value: 6.5 },
    uShadeStep:   { value: 0.019 },
    uCirrus:      { value: o.cirrus },
    uDrift:       { value: new THREE.Vector2(0, 0) },
    uCloudLit:    { value: new THREE.Color(1, 1, 1) },
    uCloudDark:   { value: new THREE.Color(0.4, 0.45, 0.55) },
  };

  const makeMat = env => new THREE.ShaderMaterial({
    name: env ? 'KatSkyEnv' : 'KatSky',
    uniforms,                                   // shared object: one update drives both
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    defines: env ? { ENV_PASS: '' } : {},
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const skyMat = makeMat(false);
  const skyMesh = new THREE.Mesh(geo, skyMat);
  skyMesh.name = 'sky';
  skyMesh.scale.setScalar(60000);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = 900;      // draw after opaque geometry: far fewer sky pixels shaded
  skyMesh.matrixAutoUpdate = false;
  skyMesh.updateMatrix();
  engine.scene.add(skyMesh);

  // A second dome, un-tonemapped, used only as the source for the PMREM environment map.
  const envScene = new THREE.Scene();
  const envMesh = new THREE.Mesh(geo, makeMat(true));
  envMesh.scale.setScalar(600);
  envMesh.frustumCulled = false;
  envScene.add(envMesh);

  // ---- palette (recomputed on every time-of-day change) --------------------------------
  const palette = {
    sunColor: new THREE.Color(1, 0.95, 0.86), sunIntensity: 3.4,
    skyAmbient: new THREE.Color(0.45, 0.6, 0.9), groundAmbient: new THREE.Color(0.35, 0.26, 0.18),
    hemiIntensity: 0.45,
    bounceColor: new THREE.Color(0.5, 0.32, 0.22), bounceIntensity: 0.35,
    horizon: new THREE.Color(0.6, 0.63, 0.66), zenith: new THREE.Color(0.3, 0.45, 0.7),
    hazeSun: new THREE.Color(1, 0.85, 0.65),
    hazeDensity: 0.0016, hazeSunAmount: 0.55,
  };

  const state = { sunDir: uniforms.uSunDir.value, palette, envScene, elevation: 0, azimuth: 0, hour: o.hour };

  const _d = new THREE.Vector3();
  const _dust = new THREE.Color();
  const _warm = new THREE.Color();
  function computePalette() {
    const p = {
      rayleigh: o.rayleigh, turbidity: o.turbidity, mie: o.mie, mieG: o.mieG,
      sunY: state.sunDir.y * 1000, sunElevationCos: state.sunDir.y,
    };
    const elev = state.elevation;
    // Direct-beam transmittance through the real air mass at this elevation.
    const { betaR, betaM } = coefficients(p);
    const inv = opticalInverse(Math.max(state.sunDir.y, 0.02));
    const Fex = [0, 1, 2].map(i => Math.exp(-(betaR[i] * RAY_ZENITH * inv + betaM[i] * MIE_ZENITH * inv)));
    const lum = 0.2126 * Fex[0] + 0.7152 * Fex[1] + 0.0722 * Fex[2] || 1e-4;
    // Unit-luminance beam hue: keeps the frame luminous at any hour, hue shift intact.
    const phys = [Fex[0] / lum, Fex[1] / lum, Fex[2] / lum];
    // Physical extinction alone is nearly white at 30 deg — true, but Mario Kart reads warm.
    // Art-direct a colour-temperature ramp (~4500 K low, ~5900 K high) and let the physical
    // hue modulate it, so dusk still swings hard orange on its own.
    const t = smoothstep(3, 62, elev);
    _warm.setRGB(1.0, lerp(0.845, 0.965, t), lerp(0.66, 0.92, t), THREE.SRGBColorSpace);
    const w = clamp(opts.warmth ?? 1, 0, 2);
    palette.sunColor.setRGB(
      _warm.r * lerp(1, phys[0], w),
      _warm.g * lerp(1, phys[1], w),
      _warm.b * lerp(1, phys[2], w),
      THREE.LinearSRGBColorSpace);
    const up = clamp(Math.sin(Math.max(elev, 0) * D2R), 0, 1);
    palette.sunIntensity = (opts.sunIntensity ?? 5.9) * lerp(0.55, 1.0, smoothstep(0, 30, elev)) * lerp(0.85, 1, up);

    // Sky colours straight out of the same scattering model the dome renders.
    //
    // Two different spaces come out of this block and mixing them up is what bleached the
    // distance in review round 1:
    //
    //  * `rad*`  — pre-exposure linear radiance, the units the dome shader works in. The
    //    in-dome uniforms (`uGroundHaze`, `uEnvGround`, cloud colours) must be given these.
    //  * `palette.horizon/zenith/hazeSun` — **display-referred sRGB**, because three runs
    //    `fog_fragment` *after* `tonemapping_fragment` and `colorspace_fragment`, so the
    //    aerial-perspective mix in lighting.js happens on an already-encoded pixel. These
    //    used to be raw exposed radiance, which for the horizon was 1.4–1.75 — well over
    //    white. Every hill past ~300 m was therefore being mixed toward a colour brighter
    //    than paper, which is exactly the "far ridge dissolves into the sky" finding.
    const ex = uniforms.uExposure.value;
    const toneEx = uniforms.uToneExposure.value || 1;
    const skySat = uniforms.uSkySat.value;
    const display = a => {
      const L = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      const sat = a.map(x => Math.max(L + (x - L) * skySat, 0));
      return acesFilmic(sat.map(x => x * ex), toneEx).map(linToSrgb);
    };
    const radZen = skyRadiance(_d.set(0, 1, 0), state.sunDir, p);
    // Airlight away from the sun is the dim end of the range; the shader interpolates
    // toward `hazeSun` as the view swings back into the beam.
    const side = sunDirection(3, (state.azimuth + 155) % 360, _d);
    const radHor = skyRadiance(side, state.sunDir, p);
    const towardSun = sunDirection(5, state.azimuth, _d);
    const radSun = skyRadiance(towardSun, state.sunDir, p);
    const zen = display(radZen), hor = display(radHor), hsun = display(radSun);

    const clampCol = (c, arr, boost = 1) => c.setRGB(
      clamp(arr[0] * boost, 0, 4), clamp(arr[1] * boost, 0, 4), clamp(arr[2] * boost, 0, 4),
      THREE.LinearSRGBColorSpace);

    clampCol(palette.zenith, zen, 1.0);
    clampCol(palette.horizon, hor, 1.0);
    clampCol(palette.hazeSun, hsun, 1.02);
    // Dust over the Menashe plateau: desaturate the horizon toward its own luminance and
    // warm it slightly, without adding energy (that is what washed the frame out before).
    {
      const hl = 0.2126 * palette.horizon.r + 0.7152 * palette.horizon.g + 0.0722 * palette.horizon.b;
      _dust.setRGB(hl * 1.05, hl * 1.0, hl * 0.92, THREE.LinearSRGBColorSpace);
      palette.horizon.lerp(_dust, 0.30);
    }
    // The in-dome haze tint is a *hue*, normalised to unit luminance (see the shader).
    {
      const hueL = Math.max(0.2126 * radHor[0] + 0.7152 * radHor[1] + 0.0722 * radHor[2], 1e-5);
      uniforms.uHazeTint.value.setRGB(
        lerp(radHor[0] / hueL, 1.02, 0.6),
        lerp(radHor[1] / hueL, 1.00, 0.6),
        lerp(radHor[2] / hueL, 0.97, 0.6),
        THREE.LinearSRGBColorSpace);
    }
    // Below the skyline the dome shows dusty ground, in the dome's own radiance units.
    uniforms.uGroundHaze.value.setRGB(radHor[0], radHor[1], radHor[2], THREE.LinearSRGBColorSpace)
      .multiplyScalar(0.62)
      .lerp(new THREE.Color(0.42, 0.34, 0.25).multiplyScalar(1 / Math.max(ex, 1e-3)), 0.30);

    // Ambient: sky dome above, warm terra-rossa / dry-stubble bounce below. Hue comes from
    // the raw radiance so the fill light keeps the sky's real blue, not its encoded pastel.
    palette.skyAmbient.setRGB(radZen[0], radZen[1], radZen[2], THREE.LinearSRGBColorSpace)
      .lerp(new THREE.Color().setRGB(radHor[0], radHor[1], radHor[2], THREE.LinearSRGBColorSpace), 0.35);
    const skyLum = 0.2126 * palette.skyAmbient.r + 0.7152 * palette.skyAmbient.g + 0.0722 * palette.skyAmbient.b;
    palette.skyAmbient.multiplyScalar(1 / Math.max(skyLum, 1e-3));
    palette.groundAmbient.setRGB(0.42, 0.30, 0.20, THREE.LinearSRGBColorSpace);
    // Ambient fill is the single biggest reason review round 1 had no readable shadows: with
    // the old numbers the shaded side of a kart still received about half the light of the
    // sunlit side, so a cast shadow was worth only a fifth of a stop. Mario Kart's shadows
    // are dark. Fill is now roughly 40% of what it was, and the sun makes up the difference.
    palette.hemiIntensity = (opts.hemiIntensity ?? 0.125) * lerp(0.55, 1, smoothstep(-2, 18, elev));

    // Radiance of the sunlit terra-rossa / dry-stubble ground, in the dome's pre-exposure
    // units, used as the lower hemisphere of the environment map.
    uniforms.uEnvGround.value.setRGB(0.46, 0.33, 0.22, THREE.LinearSRGBColorSpace)
      .multiplyScalar((1 / Math.max(ex, 1e-3)) * lerp(0.10, 0.42, smoothstep(0, 32, elev)));

    palette.bounceColor.setRGB(0.55, 0.34, 0.22, THREE.LinearSRGBColorSpace)
      .lerp(palette.sunColor, 0.25);
    palette.bounceIntensity = (opts.bounceIntensity ?? 0.16) * lerp(0.3, 1, smoothstep(0, 25, elev));

    // Aerial perspective now mixes toward a *correct* display colour, so it no longer has to
    // be weak to avoid bleaching — but 1.5 km of course does not need a kilometre of murk
    // either. This lands the far ridge visibly behind the near hills instead of erasing it.
    palette.hazeDensity = opts.hazeDensity ?? 0.00072;
    palette.hazeSunAmount = 0.55 + 0.30 * smoothstep(30, 4, elev);

    // Cloud lighting tracks the sun so the deck never looks pasted on. Values are given in
    // pre-exposure radiance; `gain` converts an *exposed* target back into those units, so
    // the numbers below read directly as positions on the ACES curve. A sunlit top at 1.15
    // exposed lands around RGB 236 — bright white with the shading still legible — while
    // the old 3.3 put every cumulus at a flat clipped 255 with no form at all.
    const gain = 1 / Math.max(ex, 1e-3);
    uniforms.uCloudLit.value.copy(palette.sunColor)
      .lerp(new THREE.Color(1, 1, 1), 0.72)
      .multiplyScalar(gain * lerp(0.80, 1.15, smoothstep(2, 30, elev)));
    uniforms.uCloudDark.value.setRGB(radZen[0], radZen[1], radZen[2], THREE.LinearSRGBColorSpace);
    {
      const dl = Math.max(0.2126 * radZen[0] + 0.7152 * radZen[1] + 0.0722 * radZen[2], 1e-5);
      uniforms.uCloudDark.value.multiplyScalar(1 / dl)          // hue only
        .multiplyScalar(gain * lerp(0.24, 0.34, smoothstep(2, 30, elev)))
        .lerp(palette.sunColor.clone().multiplyScalar(gain * 0.22), 0.14 + 0.25 * smoothstep(20, 0, elev));
    }
    uniforms.uShine.value = lerp(0.35, 0.8, smoothstep(25, 3, elev));
    uniforms.uHorizonHaze.value = 0.13 + 0.20 * smoothstep(22, 2, elev);
  }

  /** @param {number|string} h local decimal hour, or a key of TIME_PRESETS. */
  function setSunAngles(elevation, azimuth) {
    state.elevation = elevation; state.azimuth = azimuth;
    sunDirection(elevation, azimuth, uniforms.uSunDir.value);
    computePalette();
  }

  function resolveTime(h) {
    if (typeof h === 'string') h = TIME_PRESETS[h] ?? DEFAULTS.hour;
    state.hour = h;
    return solarPosition(o.lat, o.lon, o.dayOfYear, h, o.tz);
  }

  if (opts.elevation != null || opts.azimuth != null) {
    setSunAngles(opts.elevation ?? 31, opts.azimuth ?? 283);
  } else {
    const s = resolveTime(o.hour);
    setSunAngles(s.elevation, s.azimuth);
  }

  // ---- lighting rig ---------------------------------------------------------------------
  let lighting = null;
  try {
    lighting = createLighting(engine, world, state, opts);
  } catch (e) {
    console.warn('[sky] lighting rig failed, using a plain sun:', e);
    const sun = new THREE.DirectionalLight(palette.sunColor, palette.sunIntensity);
    sun.position.copy(state.sunDir).multiplyScalar(1500);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera; c.left = -300; c.right = 300; c.top = 300; c.bottom = -300; c.far = 3000;
    const hemi = new THREE.HemisphereLight(palette.skyAmbient, palette.groundAmbient, 0.6);
    engine.scene.add(sun, sun.target, hemi);
    engine.scene.fog = new THREE.FogExp2(palette.horizon.clone(), 0.00055);
    lighting = {
      sun, hemi, bounce: null, csm: null, envMap: null, apUniforms: null,
      setupMaterial() {}, scan() {}, update() {},
      refresh() {
        sun.color.copy(palette.sunColor); sun.intensity = palette.sunIntensity;
        sun.position.copy(state.sunDir).multiplyScalar(1500);
        hemi.color.copy(palette.skyAmbient); hemi.groundColor.copy(palette.groundAmbient);
        engine.scene.fog.color.copy(palette.horizon);
      },
    };
  }

  function setTimeOfDay(h) {
    if (typeof h === 'number' || typeof h === 'string') {
      const s = resolveTime(h);
      setSunAngles(s.elevation, s.azimuth);
    }
    lighting.refresh(true);
    return { elevation: state.elevation, azimuth: state.azimuth, hour: state.hour };
  }

  const drift = uniforms.uDrift.value;
  const api = {
    sky: skyMesh,
    material: skyMat,
    uniforms,
    sun: lighting.sun,
    hemi: lighting.hemi,
    bounce: lighting.bounce,
    csm: lighting.csm,
    lighting,
    palette,
    sunDir: state.sunDir,
    sunPos: state.sunDir,                        // legacy name kept for callers
    get envMap() { return lighting.envMap; },
    get elevation() { return state.elevation; },
    get azimuth() { return state.azimuth; },
    setTimeOfDay,
    setSunAngles,
    update(dt) {
      drift.x += o.cloudSpeed * dt;
      drift.y += o.cloudSpeed * 0.35 * dt;
      // The dome tone-maps itself (see SKY_FRAG), so it has to track the renderer's exposure
      // if anything else changes it at runtime — otherwise the sky and the ground drift apart.
      const te = engine.renderer.toneMappingExposure || 1;
      if (Math.abs(te - uniforms.uToneExposure.value) > 1e-4) {
        uniforms.uToneExposure.value = te;
        computePalette();
        lighting.refresh(false);
      }
    },
  };
  engine.add({ update: dt => api.update(dt) });
  return api;
}
