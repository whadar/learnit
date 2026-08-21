import * as THREE from 'three';
import { clamp } from '../../core/mathx.js';

/**
 * Shader sources and the procedural grading LUT for the Kat Racing post stack
 * (`src/render/post.js`). Nothing here has side effects on import.
 *
 * ## Which colour space this stack works in, and why
 *
 * The obvious design is to render the scene to an HDR buffer with tone mapping off, do
 * bloom / depth of field / grading in linear radiance, and tone-map at the very end. That
 * is what a deferred AAA renderer does, and it is *wrong for this engine*: three's fragment
 * shader applies chunks in the order
 *
 *     opaque_fragment -> tonemapping_fragment -> colorspace_fragment -> fog_fragment
 *
 * so fog — here, `src/render/lighting.js`'s aerial perspective, which is most of what you
 * see past 200 m on this course — is blended **after** tone mapping and **after** the sRGB
 * encode, against haze colours that were authored against that ordering. Move tone mapping
 * into the composer and every hazy pixel is blended in the wrong space: measured on the
 * `lane` view, the far pine ridge went from RGB 134 to RGB 195 and turned into white milk.
 *
 * So this stack renders the scene exactly as it would have gone to the canvas — renderer
 * ACES tone mapping on, scene target tagged `SRGBColorSpace` so `colorspace_fragment`
 * encodes into it — and then grades that display-referred image. The grade LUT is authored
 * against the ACES output, bloom reconstructs an HDR value from the tone curve so its
 * threshold still means "brighter than white" rather than "brighter than mid-grey", and
 * nothing this module does can change the colour of a pixel another agent tuned.
 */

// ---------------------------------------------------------------------------------------
// GLSL building blocks
// ---------------------------------------------------------------------------------------

export const GLSL_COMMON = /* glsl */`
// The sky dome writes un-tone-mapped radiance, so encoded values above 1.0 reach us for the
// solar disc and the brightest cumulus. Clamp anything we divide or difference to keep a
// stray +Inf from turning into a NaN and blackening the frame through a blur kernel.
const float KAT_MAX = 16.0;

float katLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Deterministic per-pixel hash — no time input, so screenshots are reproducible.
float katHash( vec2 p ) {
  p = fract( p * vec2( 443.8975, 397.2973 ) );
  p += dot( p, p.yx + 19.19 );
  return fract( ( p.x + p.y ) * p.x );
}
float katHash1( float n ) { return fract( sin( n * 127.1 ) * 43758.5453123 ); }

vec3 katSRGBToLinear( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}
vec3 katLinearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}
`;

/** 32^3 LUT packed as a 1024x32 strip, sampled with trilinear interpolation. */
export const GLSL_LUT = /* glsl */`
vec3 katLUT( sampler2D lut, vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  const float N = 32.0;
  float sliceW = 1.0 / N;                // width of one slice in the strip
  float pixelW = sliceW / N;             // width of one texel
  float innerW = pixelW * ( N - 1.0 );
  float zBlue  = c.b * ( N - 1.0 );
  float z0     = floor( zBlue );
  float z1     = min( z0 + 1.0, N - 1.0 );
  float xo     = pixelW * 0.5 + c.r * innerW;
  float yy     = ( 0.5 / N ) + c.g * ( ( N - 1.0 ) / N );
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
// Bloom prefilter — a drop-in replacement for UnrealBloomPass's LuminosityHighPassShader.
//
// The input is display-referred, so a plain luminance threshold would bloom off mid-grey.
// Instead the tone curve is inverted (`lin / (1.02 - lin)`, the inverse of a Reinhard-ish
// shoulder) to recover roughly how far over white a pixel was before tone mapping, and the
// threshold is applied there. Sunlit white plaster sits near 0.95 display, which
// reconstructs to about 4; the solar disc, boost flames and item sparkles reconstruct to
// hundreds. A threshold around 6 therefore blooms the things that should glow and leaves
// the village walls alone — which is the entire tuning problem for this effect.
// ---------------------------------------------------------------------------------------

export const BloomPrefilterFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  uniform float bloomClamp;
  varying vec2 vUv;

  ${GLSL_COMMON}

  void main() {
    vec3 c = min( texture2D( tDiffuse, vUv ).rgb, vec3( KAT_MAX ) );
    float lin = katLuma( katSRGBToLinear( c ) );
    float hdr = lin / max( 1.02 - lin, 0.02 );          // undo the tone curve's shoulder
    float a = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, hdr );
    gl_FragColor = vec4( min( c, vec3( bloomClamp ) ) * a, 1.0 );
  }`;

// ---------------------------------------------------------------------------------------
// Downsample + separable blur (feeds depth of field and the chromatic-aberration fringe)
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
      // 9-tap gaussian, sampled at the bilinear sweet spots so 5 fetches do 9 taps' work.
      vec2 o = uTexel * uDir;
      vec3 c = texture2D( tDiffuse, vUv ).rgb * 0.227027;
      c += ( texture2D( tDiffuse, vUv + o * 1.3846 ).rgb +
             texture2D( tDiffuse, vUv - o * 1.3846 ).rgb ) * 0.316216;
      c += ( texture2D( tDiffuse, vUv + o * 3.2308 ).rgb +
             texture2D( tDiffuse, vUv - o * 3.2308 ).rgb ) * 0.070270;
      gl_FragColor = vec4( min( c, vec3( 16.0 ) ), 1.0 );
    }`,
};

// ---------------------------------------------------------------------------------------
// Composite: motion blur + rush blur + DoF + chromatic aberration + LUT grade +
// speed-driven saturation/contrast + speed lines + vignette + dither.
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
      uRushTint:     { value: new THREE.Color(1.0, 0.95, 0.82) },
      uFocus:        { value: new THREE.Vector2(70, 420) },
      uDofMax:       { value: 0.0 },
      uExposure:     { value: 1.0 },
      uContrast:     { value: 1.0 },
      uSaturation:   { value: 1.0 },
      uLutMix:       { value: 1.0 },
      uVignette:     { value: 0.0 },
      uCA:           { value: 0.0 },
      uLift:         { value: 0.0 },
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
      varying vec2 vUv;

      ${GLSL_COMMON}
      ${GLSL_LUT}

      /** window-space depth -> distance along the view axis, in metres */
      float viewDepth( float d ) {
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

        // ---- screen-space blur vector ---------------------------------------------------
        vec2 blurVec = vec2( 0.0 );

        #if USE_MOTION == 1
        {
          // Camera reprojection: unproject this pixel, project it with last frame's
          // view-projection, and smear along the difference. This is what makes 120 km/h
          // look like 120 km/h — the world streams past while the kart stays sharp.
          vec4 clip  = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
          vec4 world = uInvViewProj * clip;
          world /= world.w;
          vec4 prev  = uPrevViewProj * world;
          vec2 prevUv = ( prev.xy / prev.w ) * 0.5 + 0.5;
          vec2 vel = ( uv - prevUv ) * uMotionScale;
          vel *= smoothstep( uMotionNear.x, uMotionNear.y, dist );   // keep the kart crisp
          blurVec += vel;
        }
        #endif

        #if USE_RUSH == 1
          blurVec += c * ( uRush * smoothstep( 0.10, 1.0, r ) );
        #endif

        float bl = length( blurVec );
        if ( bl > uMotionMax ) blurVec *= uMotionMax / bl;

        // ---- resolve colour ---------------------------------------------------------------
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
        col = min( col, vec3( KAT_MAX ) );

        // ---- depth of field -----------------------------------------------------------------
        #if USE_DOF == 1
        {
          float coc = smoothstep( uFocus.x, uFocus.y, dist ) * uDofMax;
          coc = max( coc, isSky * uDofMax * 0.55 );
          col = mix( col, min( texture2D( tBlur, uv ).rgb, vec3( KAT_MAX ) ), coc );
        }
        #endif

        // ---- chromatic aberration (frame edge only) -----------------------------------------
        // Taken from the half-res blur and applied as a *difference*, so it reads as a smooth
        // lens fringe. Offsetting the sharp image turns every pixel of high-frequency terrain
        // noise into rainbow speckle instead.
        #if USE_CA == 1
        {
          float m = smoothstep( 0.30, 1.0, r ) * step( 1e-6, uCA );
          if ( m > 0.001 ) {
            vec2 off = c * ( uCA * r );
            vec3 mid = min( texture2D( tBlur, uv ).rgb, vec3( KAT_MAX ) );
            float rr = min( texture2D( tBlur, clamp( uv + off, 0.002, 0.998 ) ).r, KAT_MAX );
            float bb = min( texture2D( tBlur, clamp( uv - off, 0.002, 0.998 ) ).b, KAT_MAX );
            col.r += ( rr - mid.r ) * m;
            col.b += ( bb - mid.b ) * m;
          }
        }
        #endif

        // ---- grade ---------------------------------------------------------------------------
        vec3 g = clamp( col * uExposure, 0.0, 1.0 );

        #if USE_LUT == 1
          g = mix( g, katLUT( tLut, g ), uLutMix );
        #endif

        float l = katLuma( g );
        g = mix( vec3( l ), g, uSaturation );
        g = ( g - 0.5 ) * uContrast + 0.5 + uLift;

        // ---- boost rush: radial speed lines + edge flare ---------------------------------
        #if USE_RUSH == 1
        if ( uRushLines > 0.001 ) {
          float ang = atan( q.y, q.x );
          float a2  = ang * 84.0 + 40.0;
          float seg = floor( a2 );
          float f   = fract( a2 );
          float n   = katHash1( seg * 1.7 );
          float gate = smoothstep( 0.58, 0.94, n );
          // a thin streak down the middle of each angular wedge; whole wedges read as bands
          float thin = smoothstep( 0.42, 0.10, abs( f - 0.5 ) );
          float radial = smoothstep( 0.30 + n * 0.30, 1.05, r );
          g += gate * thin * radial * uRushLines * uRushTint * 1.15;
          g += uRushLines * uRushTint * 0.09 * smoothstep( 0.62, 1.18, r );
        }
        #endif

        // ---- vignette + dither ---------------------------------------------------------------
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
 * The look: Ramot Menashe at about 15:30. Warm amber highlights, cool-teal shade so
 * Jerusalem stone reads three-dimensional, and a hard saturation push on the
 * terracotta / olive / sky triad that keeps the village legible at kart speed. The domain
 * is the renderer's ACES output, so the curve only has to add character — the highlight
 * shoulder is already there and this must not fight it.
 */
export function makeGradeLUT(opts = {}) {
  const N = 32;
  const W = N * N, H = N;
  const data = new Uint8Array(W * H * 4);

  const sat       = opts.saturation ?? 1.28;
  const contrast  = opts.contrast ?? 1.10;
  const warmth    = opts.warmth ?? 1.0;
  const shadeTint = opts.shadeTint ?? 1.0;

  // ASC-CDL slope / offset / power, in linear light. Kept deliberately gentle: a strong
  // global R/B slope makes *everything* orange and eats the blue out of the sky. The
  // Mediterranean warmth comes from the split tone below, which only moves the ends.
  const slope  = [1.020 * warmth, 1.0, 0.984 / warmth];
  const offset = [0.003, 0.001, -0.001];
  const power  = [0.985, 1.0, 1.022];

  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        const rgb = [ri / (N - 1), gi / (N - 1), bi / (N - 1)];

        // --- linear-light grade ---------------------------------------------------------
        const lin = rgb.map(srgbToLin);
        for (let k = 0; k < 3; k++) {
          lin[k] = Math.pow(Math.max(lin[k] * slope[k] + offset[k], 0), power[k]);
        }
        // Gentle channel crosstalk: film never separates channels perfectly, and it stops
        // the saturation push below from tearing on the terracotta roofs.
        const cx = 0.045;
        const lm = (lin[0] + lin[1] + lin[2]) / 3;
        for (let k = 0; k < 3; k++) lin[k] = lin[k] * (1 - cx) + lm * cx;

        const out = lin.map(linToSrgb);

        // --- display-referred shaping ------------------------------------------------------
        let lum = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];

        // saturation, eased off in the very brightest values so plaster stays white
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
        out[0] += shadeTint * (-0.030 * sh) + warmth * (0.028 * hi);
        out[1] += shadeTint * (0.006 * sh) + warmth * (0.014 * hi);
        out[2] += shadeTint * (0.050 * sh) + warmth * (-0.023 * hi);

        // a whisper of warm lift so the blacks are dusty, not video-black
        out[0] += 0.019 * sh; out[1] += 0.014 * sh; out[2] += 0.010 * sh;

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
