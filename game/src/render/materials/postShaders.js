import * as THREE from 'three';
import { clamp } from '../../core/mathx.js';

/**
 * Shader sources and the procedural grading LUT for the Kat Racing post stack
 * (`src/render/post.js`). Nothing here has side effects on import.
 *
 * The whole composite chain runs in **linear HDR**: `post.js` switches the renderer to
 * `NoToneMapping` and this module's composite shader does exposure -> ACES -> LUT grade ->
 * sRGB encode as the very last step before SMAA. That is what makes the bloom threshold and
 * the depth-of-field mix physically meaningful instead of operating on already-crushed
 * display values.
 */

// ---------------------------------------------------------------------------------------
// GLSL building blocks
// ---------------------------------------------------------------------------------------

export const GLSL_COMMON = /* glsl */`
float katLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Deterministic per-pixel hash — no time input, so screenshots are reproducible.
float katHash( vec2 p ) {
  p = fract( p * vec2( 443.8975, 397.2973 ) );
  p += dot( p, p.yx + 19.19 );
  return fract( ( p.x + p.y ) * p.x );
}
float katHash1( float n ) { return fract( sin( n * 127.1 ) * 43758.5453123 ); }

vec3 katLinearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}
`;

/** Stephen Hill's ACES RRT+ODT fit — the same curve three's ACESFilmicToneMapping uses. */
export const GLSL_ACES = /* glsl */`
const mat3 KAT_ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 KAT_ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

vec3 katRRTODT( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 katACES( vec3 color ) {
  color = KAT_ACES_IN * ( color / 0.6 );
  color = katRRTODT( color );
  color = KAT_ACES_OUT * color;
  return clamp( color, 0.0, 1.0 );
}
`;

/** 32^3 LUT packed as a 1024x32 strip, sampled with trilinear interpolation. */
export const GLSL_LUT = /* glsl */`
vec3 katLUT( sampler2D lut, vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  const float N = 32.0;
  float sliceW   = 1.0 / N;              // width of one slice in the strip
  float pixelW   = sliceW / N;           // width of one texel
  float innerW   = pixelW * ( N - 1.0 );
  float zBlue    = c.b * ( N - 1.0 );
  float z0       = floor( zBlue );
  float z1       = min( z0 + 1.0, N - 1.0 );
  float xo       = pixelW * 0.5 + c.r * innerW;
  float yy       = ( 0.5 / N ) + c.g * ( ( N - 1.0 ) / N );
  vec3 a = texture2D( lut, vec2( xo + z0 * sliceW, yy ) ).rgb;
  vec3 b = texture2D( lut, vec2( xo + z1 * sliceW, yy ) ).rgb;
  return mix( a, b, zBlue - z0 );
}
`;

const FS_QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// ---------------------------------------------------------------------------------------
// Downsample + separable blur (feeds depth-of-field)
// ---------------------------------------------------------------------------------------

export const BlurShader = {
  name: 'KatPostBlur',
  uniforms: {
    tDiffuse: { value: null },
    uTexel:   { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uDir:     { value: new THREE.Vector2(1, 0) },
  },
  vertexShader: FS_QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform vec2 uDir;
    varying vec2 vUv;

    void main() {
      // 9-tap gaussian, sampled at half-texel offsets so hardware bilinear does the work.
      vec2 o = uTexel * uDir;
      vec3 c = texture2D( tDiffuse, vUv ).rgb * 0.227027;
      c += ( texture2D( tDiffuse, vUv + o * 1.3846 ).rgb +
             texture2D( tDiffuse, vUv - o * 1.3846 ).rgb ) * 0.316216;
      c += ( texture2D( tDiffuse, vUv + o * 3.2308 ).rgb +
             texture2D( tDiffuse, vUv - o * 3.2308 ).rgb ) * 0.070270;
      gl_FragColor = vec4( c, 1.0 );
    }`,
};

// ---------------------------------------------------------------------------------------
// Bloom prefilter — drop-in replacement for UnrealBloomPass's LuminosityHighPassShader.
//
// Two changes matter. (1) It keeps only the *excess* above the knee instead of passing the
// whole texel, so a pixel that just crosses the threshold contributes almost nothing rather
// than popping. (2) It clamps that excess: our sun disc carries ~300 units of radiance, and
// unclamped it smears a bright veil across the entire frame through the widest bloom mip —
// that single effect was washing the blue out of the sky and the green off the far ridge.
// ---------------------------------------------------------------------------------------

export const BloomPrefilterFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  uniform float bloomClamp;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D( tDiffuse, vUv ).rgb;
    float v = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    float knee = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );
    vec3 excess = c * knee * ( max( v - luminosityThreshold, 0.0 ) / max( v, 1e-4 ) );
    float m = max( max( excess.r, excess.g ), excess.b );
    if ( m > bloomClamp ) excess *= bloomClamp / m;
    gl_FragColor = vec4( excess, 1.0 );
  }`;

// ---------------------------------------------------------------------------------------
// Composite: motion blur + rush blur + DoF + chromatic aberration + ACES + LUT grade +
// saturation/contrast push + speed lines + vignette + dither + sRGB encode.
// ---------------------------------------------------------------------------------------

export function makeCompositeShader() {
  return {
    name: 'KatPostComposite',
    defines: {
      MB_TAPS: 8,
      USE_MOTION: 0,
      USE_DOF: 0,
      USE_CA: 0,
      USE_LUT: 1,
      USE_RUSH: 0,
    },
    uniforms: {
      tDiffuse:      { value: null },
      tBlur:         { value: null },
      tDepth:        { value: null },
      tLut:          { value: null },
      uResolution:   { value: new THREE.Vector2(1280, 720) },
      uCameraNear:   { value: 0.25 },
      uCameraFar:    { value: 8000 },
      uInvViewProj:  { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uMotionScale:  { value: 0.0 },
      uMotionMax:    { value: 0.014 },
      uMotionNear:   { value: new THREE.Vector2(2.5, 13.0) },
      uRush:         { value: 0.0 },
      uRushLines:    { value: 0.0 },
      uRushTint:     { value: new THREE.Color(1.0, 0.94, 0.78) },
      uFocus:        { value: new THREE.Vector2(70, 420) },
      uDofMax:       { value: 0.0 },
      uExposure:     { value: 1.0 },
      uContrast:     { value: 1.0 },
      uSaturation:   { value: 1.0 },
      uLutMix:       { value: 1.0 },
      uVignette:     { value: 0.0 },
      uCA:           { value: 0.0 },
      uLift:         { value: 0.0 },
      uChromaKeep:   { value: 0.65 },
    },
    vertexShader: FS_QUAD_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform sampler2D tBlur;
      uniform sampler2D tDepth;
      uniform sampler2D tLut;
      uniform vec2  uResolution;
      uniform float uCameraNear, uCameraFar;
      uniform mat4  uInvViewProj, uPrevViewProj;
      uniform float uMotionScale, uMotionMax;
      uniform vec2  uMotionNear;
      uniform float uRush, uRushLines;
      uniform vec3  uRushTint;
      uniform vec2  uFocus;
      uniform float uDofMax;
      uniform float uExposure, uContrast, uSaturation, uLutMix, uVignette, uCA, uLift;
      uniform float uChromaKeep;
      varying vec2 vUv;

      ${GLSL_COMMON}
      ${GLSL_ACES}
      ${GLSL_LUT}

      float viewDepth( float d ) {
        // perspective depth (NDC 0..1 window space) -> positive distance along -Z, metres
        float z = d * 2.0 - 1.0;
        return ( 2.0 * uCameraNear * uCameraFar ) /
               ( uCameraFar + uCameraNear - z * ( uCameraFar - uCameraNear ) );
      }

      void main() {
        vec2 uv = vUv;
        float aspect = uResolution.x / max( uResolution.y, 1.0 );
        vec2 c = uv - 0.5;
        vec2 q = c * vec2( aspect, 1.0 );
        float r = length( q ) / ( 0.5 * sqrt( aspect * aspect + 1.0 ) );  // 0 centre, 1 corner

        float rawDepth = texture2D( tDepth, uv ).x;
        float dist = viewDepth( rawDepth );
        float isSky = step( 0.99999, rawDepth );

        // ---- screen-space blur vector -------------------------------------------------
        vec2 blurVec = vec2( 0.0 );

        #if USE_MOTION == 1
        {
          vec4 clip  = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
          vec4 world = uInvViewProj * clip;
          world /= world.w;
          vec4 prev  = uPrevViewProj * world;
          vec2 prevUv = ( prev.xy / prev.w ) * 0.5 + 0.5;
          vec2 vel = ( uv - prevUv ) * uMotionScale;
          // Keep the kart (and anything else in the near field) crisp.
          vel *= smoothstep( uMotionNear.x, uMotionNear.y, dist );
          blurVec += vel;
        }
        #endif

        #if USE_RUSH == 1
          blurVec += c * ( uRush * smoothstep( 0.10, 1.0, r ) );
        #endif

        float bl = length( blurVec );
        if ( bl > uMotionMax ) blurVec *= uMotionMax / bl;

        // ---- resolve colour ------------------------------------------------------------
        vec3 col;
        #if ( USE_MOTION == 1 ) || ( USE_RUSH == 1 )
          float jitter = katHash( gl_FragCoord.xy );
          col = vec3( 0.0 );
          for ( int i = 0; i < MB_TAPS; i ++ ) {
            float t = ( float( i ) + jitter ) / float( MB_TAPS ) - 0.5;
            vec2 su = clamp( uv + blurVec * t, vec2( 0.0015 ), vec2( 0.9985 ) );
            col += texture2D( tDiffuse, su ).rgb;
          }
          col /= float( MB_TAPS );
        #else
          col = texture2D( tDiffuse, uv ).rgb;
        #endif

        // ---- depth of field ------------------------------------------------------------
        float coc = 0.0;
        #if USE_DOF == 1
          coc = smoothstep( uFocus.x, uFocus.y, dist ) * uDofMax;
          coc = max( coc, isSky * uDofMax );
          col = mix( col, texture2D( tBlur, uv ).rgb, coc );
        #endif

        // ---- chromatic aberration (edge only) ------------------------------------------
        // Sampled from the half-res blur, and applied as a *difference*: a real lens fringe
        // is a low-frequency colour shift. Offsetting the sharp image instead turns every
        // pixel of high-frequency terrain noise into rainbow speckle.
        #if USE_CA == 1
        {
          float m = smoothstep( 0.30, 1.0, r ) * step( 1e-6, uCA );
          if ( m > 0.001 ) {
            vec2 off = vec2( ( uv.x - 0.5 ), ( uv.y - 0.5 ) ) * ( uCA * r );
            vec3 mid = texture2D( tBlur, uv ).rgb;
            float rr = texture2D( tBlur, clamp( uv + off, 0.002, 0.998 ) ).r;
            float bb = texture2D( tBlur, clamp( uv - off, 0.002, 0.998 ) ).b;
            col.r += ( rr - mid.r ) * m;
            col.b += ( bb - mid.b ) * m;
          }
        }
        #endif

        // ---- tone map + grade ------------------------------------------------------------
        col *= uExposure;

        // ACES gives the filmic shoulder we want but famously desaturates and lifts strongly
        // saturated colour — on this course it turned the sky milky and the pine ridge grey.
        // Blend it with a luminance-only map, which reproduces the ACES *brightness* while
        // keeping the original hue and saturation ratios intact.
        vec3 mapped = katACES( col );
        {
          float lIn  = max( katLuma( col ), 1e-4 );
          float lOut = katLuma( mapped );
          vec3 keep  = clamp( col * ( lOut / lIn ), 0.0, 1.0 );
          mapped = mix( mapped, keep, uChromaKeep );
        }
        vec3 g = katLinearToSRGB( mapped );

        #if USE_LUT == 1
          g = mix( g, katLUT( tLut, g ), uLutMix );
        #endif

        float l = katLuma( g );
        g = mix( vec3( l ), g, uSaturation );
        g = ( g - 0.5 ) * uContrast + 0.5 + uLift;

        // ---- boost rush: radial speed lines + edge flare -----------------------------
        #if USE_RUSH == 1
        if ( uRushLines > 0.001 ) {
          float ang = atan( q.y, q.x );
          float a2  = ang * 84.0 + 40.0;
          float seg = floor( a2 );
          float f   = fract( a2 );
          float n   = katHash1( seg * 1.7 );
          float gate = smoothstep( 0.58, 0.94, n );
          // thin streak down the middle of each angular wedge — wide wedges read as bands
          float thin = smoothstep( 0.42, 0.10, abs( f - 0.5 ) );
          float radial = smoothstep( 0.30 + n * 0.30, 1.05, r );
          float streak = gate * thin * radial * uRushLines;
          g += streak * uRushTint * 1.15;
          g += uRushLines * uRushTint * 0.09 * smoothstep( 0.62, 1.18, r );
        }
        #endif

        // ---- vignette + dither ----------------------------------------------------------
        g *= 1.0 - uVignette * smoothstep( 0.30, 1.12, r );
        g += ( katHash( gl_FragCoord.xy ) - 0.5 ) * ( 1.5 / 255.0 );

        gl_FragColor = vec4( clamp( g, 0.0, 1.0 ), 1.0 );
      }`,
  };
}

// ---------------------------------------------------------------------------------------
// The grade LUT — "Mediterranean afternoon"
// ---------------------------------------------------------------------------------------

const srgbToLin = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linToSrgb = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Builds the 32^3 grading LUT as a 1024x32 RGBA strip. Deterministic and dependency-free,
 * so a screenshot round always gets exactly the same grade.
 *
 * The look: Ramot Menashe at ~15:30. Warm amber key, cool-teal shade so limestone reads
 * three-dimensional, a hard saturation push on the terracotta/olive/sky triad that makes
 * the village legible from a kart, and a filmic shoulder so white plaster never clips flat.
 */
export function makeGradeLUT(opts = {}) {
  const N = 32;
  const W = N * N, H = N;
  const data = new Uint8Array(W * H * 4);

  const sat        = opts.saturation ?? 1.28;
  const contrast   = opts.contrast ?? 1.13;
  const warmth     = opts.warmth ?? 1.0;
  const shadeTint  = opts.shadeTint ?? 1.0;

  // ASC-CDL: slope / offset / power, authored in linear light.
  // Kept deliberately gentle: a strong global R/B slope makes *everything* orange and, worse,
  // eats the blue out of the sky. The Mediterranean warmth comes from the split-tone below,
  // which only touches shadows and highlights.
  const slope  = [1.020 * warmth, 1.0, 0.984 / warmth];
  const offset = [0.003, 0.001, -0.001];
  const power  = [0.985, 1.0, 1.022];

  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        let rgb = [ri / (N - 1), gi / (N - 1), bi / (N - 1)];

        // --- linear-light grade ---------------------------------------------------------
        let lin = rgb.map(srgbToLin);
        for (let k = 0; k < 3; k++) {
          lin[k] = Math.pow(Math.max(lin[k] * slope[k] + offset[k], 0), power[k]);
        }
        // gentle channel crosstalk: film never separates channels perfectly, and it stops
        // the saturation push below from tearing on the terracotta roofs.
        const cx = 0.045;
        const lm = (lin[0] + lin[1] + lin[2]) / 3;
        for (let k = 0; k < 3; k++) lin[k] = lin[k] * (1 - cx) + lm * cx;

        let out = lin.map(linToSrgb);

        // --- display-referred shaping ---------------------------------------------------
        let lum = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];

        // saturation, rolled off in the very brightest values so plaster stays white
        const satHere = sat * (1 - 0.45 * Math.max(0, lum - 0.82) / 0.18);
        for (let k = 0; k < 3; k++) out[k] = lum + (out[k] - lum) * satHere;

        // filmic S-curve about a 0.46 pivot
        for (let k = 0; k < 3; k++) {
          const x = out[k] - 0.46;
          out[k] = 0.46 + x * contrast * (1 + 0.14 * (1 - Math.abs(x) * 2));
        }

        lum = clamp(0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2], 0, 1);
        const sh = (1 - lum) * (1 - lum);   // shadow weight
        const hi = lum * lum * lum;         // highlight weight

        // cool-teal shade, warm amber highlight — the classic sunny-afternoon split tone
        out[0] += shadeTint * (-0.030 * sh) + warmth * (0.036 * hi);
        out[1] += shadeTint * (0.006 * sh) + warmth * (0.016 * hi);
        out[2] += shadeTint * (0.050 * sh) + warmth * (-0.030 * hi);

        // a whisper of warm lift so the blacks are dusty, not video-black
        out[0] += 0.012 * sh; out[1] += 0.008 * sh; out[2] += 0.005 * sh;

        // Soft clamp on the very top end so a saturated channel rolls into white instead of
        // clipping. Deliberately shallow and late: a hard shoulder here desaturates every
        // bright colour in the frame — it was quietly draining the blue out of the sky.
        const T = 0.945;
        for (let k = 0; k < 3; k++) {
          const v = out[k];
          out[k] = v > T ? T + (1 - Math.exp(-(v - T) * 9)) * (1 - T) : v;
        }

        const idx = ((gi * W) + (bi * N + ri)) * 4;
        data[idx]     = Math.round(clamp(out[0], 0, 1) * 255);
        data[idx + 1] = Math.round(clamp(out[1], 0, 1) * 255);
        data[idx + 2] = Math.round(clamp(out[2], 0, 1) * 255);
        data[idx + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'KatGradeLUT';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // raw grade data, never re-decoded
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
