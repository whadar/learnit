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
// Per-pixel hash, fed raw gl_FragCoord. The multiplier has to stay small: the old constants
// (443.8975 / 397.2973) put a 1920 px coordinate at ~852000, and a 32-bit float carries that
// with about four bits of fraction — so fract() of it collapses onto a handful of values and
// the "noise" degenerates into a diagonal lattice. Measured over a 1920x1080 grid, the old
// hash produced 7868 distinct values where this one produces 21774, with a peak
// autocorrelation five times lower. That mattered twice over: it is the jitter that
// decorrelates the motion-blur taps (a structured jitter turns a long smear into visible
// parallel stripes across the sky) and it is the final dither.
float katHash( vec2 p ) {
  vec3 q = fract( p.xyx * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
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

// Soft highlight shoulder. Below \`k\` this is *exactly* the identity, so nothing another
// module graded is touched; above it, values roll asymptotically into 1.0 instead of
// slamming into a hard clamp. That difference is the whole reason a hot boost flame reads
// as a glow with a gradient instead of a flat white plateau with a hard rim — a hard
// clamp turns every over-bright pixel into the same 1.0 and erases the shape behind it.
vec3 katSoftClip( vec3 v, float k ) {
  vec3 x = max( v, vec3( 0.0 ) );
  float w = max( 1.0 - k, 1e-4 );
  vec3 over = min( ( x - k ) / w, vec3( 24.0 ) );          // bound the exponent argument
  vec3 rolled = k + w * ( 1.0 - exp( - over ) );
  return mix( x, rolled, step( vec3( k ), x ) );
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
// Instead the tone curve is inverted (`m / (1.02 - m)`, the inverse of a Reinhard-ish
// shoulder) to recover roughly how far over white a pixel was before tone mapping, and the
// threshold is applied there.
//
// Two details here are what stop this pass from eating the frame, and both were learned the
// hard way from a `driftCorner` plate in which bloom off the boost flame covered a fifth of
// the screen in flat white with the kart nowhere to be seen:
//
//  * **The denominator floor bounds the reconstruction.** With a 0.02 floor, display white
//    reconstructs to 50 and display 0.95 to 7 — a 7x jump across the last 5% of the range,
//    so no threshold can separate "sunlit plaster" from "glowing" and the effect is a
//    cliff. At 0.06 display white lands near 17, which leaves a usable tuning range.
//  * **The energy limit is applied to the magnitude, not per channel.** `min(c, clamp)`
//    clips each channel independently, so a hot orange flame enters the mip pyramid as a
//    *white* disc, already the brightest thing the blur can carry. Scaling the whole colour
//    keeps its hue and caps how much light one pixel may smear across the frame.
//
// Downstream, UnrealBloomPass multiplies this by `3.0 * bloomStrength * sum(mipFactors)`,
// and that sum is about 3.0 — so the effective gain on this image is roughly 9x the
// strength. Any tuning here has to be read with that 9x in mind.
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
    vec3 lin = katSRGBToLinear( c );
    // Score the highlight partly on the brightest channel, so a saturated orange flame is
    // treated as the highlight it is instead of being scored as mid-grey and skipped.
    float m = mix( katLuma( lin ), max( lin.r, max( lin.g, lin.b ) ), 0.6 );
    float hdr = m / max( 1.02 - m, 0.06 );
    float a = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, hdr );

    float peak = max( c.r, max( c.g, c.b ) );
    c *= bloomClamp / max( peak, bloomClamp );          // hue-preserving energy limit

    gl_FragColor = vec4( c * a, 1.0 );
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
// Supersample resolve — the last pass when the stack renders above canvas resolution.
//
// The whole chain (scene, AO, bloom, composite, SMAA) runs at `renderScale` times the canvas
// and this filters it back down. SMAA is a morphological filter: it can straighten an edge
// it can see, but a 2 px marker post, an olive canopy or a bunting line that lands *between*
// samples never produces an edge for it to find, so it shimmers however well SMAA is tuned.
// The only cure for sub-pixel content is more samples, and this is where they are spent.
//
// Four bilinear taps at the quarter-points of the destination pixel. Each tap is itself a
// weighted read of up to four source texels, so at a 1.5x scale the sixteen source samples
// under a destination pixel are all represented, with a tent-ish falloff — a straight
// bilinear stretch would skip a third of them and reintroduce the aliasing.
// ---------------------------------------------------------------------------------------

export const ResolveShader = {
  name: 'KatPostResolve',
  uniforms: {
    tDiffuse:  { value: null },
    uDstTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: FS_QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDstTexel;
    varying vec2 vUv;
    void main() {
      vec2 o = uDstTexel * 0.25;
      vec3 c  = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;
      gl_FragColor = vec4( c * 0.25, 1.0 );
    }`,
};

// ---------------------------------------------------------------------------------------
// Auto-key probe — two tiny passes that reduce the finished composite to one number.
//
// Stage A takes the full-resolution frame down to a 16x9 luma map with a 4x4 stratified
// grid of taps per output texel (2304 samples over the frame, at fixed positions, so the
// measurement is reproducible between review rounds). Stage B averages those 144 texels into
// a single texel and damps it against last frame's value, and the composite reads that one
// texel next frame. Total cost is 144 pixels plus one.
// ---------------------------------------------------------------------------------------

export const KeyDownShader = {
  name: 'KatKeyDown',
  uniforms: {
    tDiffuse:  { value: null },
    uDstTexel: { value: new THREE.Vector2(1 / 16, 1 / 9) },
  },
  vertexShader: FS_QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDstTexel;
    varying vec2 vUv;
    ${GLSL_COMMON}
    void main() {
      float s = 0.0;
      for ( int y = 0; y < 4; y ++ ) {
        for ( int x = 0; x < 4; x ++ ) {
          vec2 f = ( vec2( float( x ), float( y ) ) + 0.5 ) * 0.25 - 0.5;
          s += katLuma( min( texture2D( tDiffuse, vUv + f * uDstTexel ).rgb, vec3( 1.0 ) ) );
        }
      }
      gl_FragColor = vec4( vec3( s * ( 1.0 / 16.0 ) ), 1.0 );
    }`,
};

export const KeyReduceShader = {
  name: 'KatKeyReduce',
  uniforms: {
    tDiffuse: { value: null },   // the 16x9 luma map
    tPrev:    { value: null },   // last frame's 1x1
    uBlend:   { value: 1.0 },    // 0 = hold, 1 = follow instantly
  },
  vertexShader: FS_QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tPrev;
    uniform float uBlend;
    varying vec2 vUv;
    void main() {
      float s = 0.0;
      for ( int y = 0; y < 9; y ++ ) {
        for ( int x = 0; x < 16; x ++ ) {
          s += texture2D( tDiffuse,
            vec2( ( float( x ) + 0.5 ) / 16.0, ( float( y ) + 0.5 ) / 9.0 ) ).r;
        }
      }
      s *= 1.0 / 144.0;
      float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
      // An unwritten previous target reads 0; take the measurement whole in that case so the
      // very first frame is already at the right key instead of ramping in from black.
      float v = prev > 0.002 ? mix( prev, s, clamp( uBlend, 0.0, 1.0 ) ) : s;
      gl_FragColor = vec4( vec3( v ), 1.0 );
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
      uShoulder:     { value: 0.86 },
      // Auto-key: the mean luma of last frame's finished composite, measured by the probe
      // chain below. `uKeyTarget` is where every frame's key is pulled to; the clamp bounds
      // how far it may be pulled, so this is an anchor, not a light meter.
      tKey:          { value: null },
      uKeyTarget:    { value: 0.405 },
      uKeyStrength:  { value: 0.0 },
      uKeyRange:     { value: new THREE.Vector2(0.86, 1.18) },
      // Neutral chroma: the asphalt, plaster and dust that make up most of this course
      // carry almost no hue, and no saturation control can multiply zero. These two tints
      // give the achromatic mass a direction instead — cool in shade, warm in the sun.
      uNeutral:      { value: 0.0 },
      uShadeTint:    { value: new THREE.Vector3(-0.052, -0.006, 0.078) },
      uSunTint:      { value: new THREE.Vector3(0.030, 0.012, -0.028) },
      // The fixed tonal anchor. Every frame ends on the same floor and the same ceiling.
      uBlack:        { value: 0.062 },
      uToePivot:     { value: 0.22 },
      uToeGamma:     { value: 1.30 },
      uWhiteKnee:    { value: 0.92 },
      uWhiteCeil:    { value: 1.02 },
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
      uniform float uShoulder;
      uniform sampler2D tKey;
      uniform float uKeyTarget, uKeyStrength;
      uniform vec2  uKeyRange;
      uniform float uNeutral;
      uniform vec3  uShadeTint, uSunTint;
      uniform float uBlack, uToePivot, uToeGamma, uWhiteKnee, uWhiteCeil;
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
          // The dome is the one surface with no parallax and no detail to lose, and it is
          // also where a long smear shows every tap: a hard yaw through a drift was dragging
          // the whole sky sideways and leaving faint parallel streaks behind the cloud
          // gradient. It keeps a third of the blur, which is enough to sell the whip.
          vel *= mix( 1.0, 0.35, isSky );
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
          // The dome used to be force-blurred at 0.55 of the full circle of confusion — a
          // 0.19 CoC over every sky pixel, which is enough to dissolve a cumulus edge into
          // the gradient behind it. The sky is the one surface with no aliasing to hide, so
          // it gets only a whisper, just enough to soften the dome's own banding.
          coc = max( coc, isSky * uDofMax * 0.10 );
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

        // ---- auto-key ---------------------------------------------------------------------
        // A shipped racer holds one key across a lap: the player's eye must not re-adapt
        // between a pine tunnel and an open vista. Round-4 review measured mean luma running
        // 0.318 to 0.466 across the canonical set — the same course at the same hour. The
        // probe chain (KeyDownShader / KeyReduceShader) measures the mean luma of the frame
        // this pass produced last time round and this pulls it back toward uKeyTarget,
        // bounded hard by uKeyRange so it is a stabiliser rather than a light meter.
        // uKeyStrength 0 disables it, and an unwritten probe (first frame, or the probe pass
        // off) reads 0 and is ignored, so the stack always degrades to a fixed exposure.
        float keyMeasured = texture2D( tKey, vec2( 0.5 ) ).r;
        float keyGain = 1.0;
        if ( uKeyStrength > 0.001 && keyMeasured > 0.002 ) {
          keyGain = clamp( pow( uKeyTarget / keyMeasured, uKeyStrength ),
                           uKeyRange.x, uKeyRange.y );
        }

        // ---- grade ---------------------------------------------------------------------------
        // Roll the over-range top end into white instead of clamping it. Bloom and additive
        // VFX both hand this pass values above 1.0; a hard clamp fuses them into one flat
        // white shape with a hard edge, which is exactly how a boost flame ends up erasing
        // the kart. Below uShoulder (0.86) this is the identity, so the graded midtones and
        // shadows every other module tuned come through untouched.
        vec3 g = clamp( katSoftClip( col * ( uExposure * keyGain ), uShoulder ), 0.0, 1.0 );

        #if USE_LUT == 1
          g = mix( g, katLUT( tLut, g ), uLutMix );
        #endif

        // ---- neutral chroma ---------------------------------------------------------------
        // Round-4 review measured the road-heavy plates at 0.26-0.34 mean chroma against a
        // Mario Kart band of 0.45-0.60, and correctly named the cause: a saturation control
        // multiplies the chroma a pixel already has, and a grey asphalt ribbon covering half
        // the frame has none. So give the achromatic mass a *direction* — the cool sky-fill
        // that actually lights a shaded road, and the warm key on the parts the sun reaches.
        // Weighted by how neutral the pixel is, so nothing that already carries a hue (the
        // kerbs, the roofs, the foliage, a livery) is touched.
        //
        // The shade-to-sun ramp is deliberately wide (0.30 to 0.85). A narrow one flips
        // between the cool and the warm tint across the asphalt's own grain and turns a noise
        // pattern into blue-and-tan speckle.
        {
          float nmx = max( g.r, max( g.g, g.b ) );
          float nmn = min( g.r, min( g.g, g.b ) );
          float nchroma = nmx > 1e-4 ? ( nmx - nmn ) / nmx : 0.0;
          float neutral = 1.0 - smoothstep( 0.06, 0.26, nchroma );
          float nl = katLuma( g );
          // Scale with the light level. A fixed offset is a *stronger* cast the darker the
          // pixel is, which turned shadowed asphalt into blue ink at 0.51 chroma while the
          // sunlit lane next to it barely moved; a cast that scales with luma is both what
          // a real fill light does and what keeps the shadow end believable.
          float lit = smoothstep( 0.015, 0.45, nl );
          float key = smoothstep( 0.30, 0.85, nl );
          g += uNeutral * neutral * lit * mix( uShadeTint, uSunTint, key );
        }

        float l = katLuma( g );
        g = mix( vec3( l ), g, uSaturation );
        g = ( g - 0.5 ) * uContrast + 0.5 + uLift;
        g = clamp( g, 0.0, 1.0 );

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
          // The streaks live in the outer ring only. The old ramp started at r = 0.30-0.60,
          // which is the middle of the frame: review round 4 found evenly spaced diagonal
          // lines over the pine canopy, over the sky and across the horizon band in plates
          // that were not even boosting hard, because a tier-2 mini-turbo was enough to
          // switch them on and they then reached most of the way to the centre. Starting at
          // 0.66 leaves the two-thirds of the frame the player is actually reading clean.
          float radial = smoothstep( 0.66 + n * 0.18, 1.10, r );
          g += gate * thin * radial * uRushLines * uRushTint * 0.90;
          // ...and the broad edge flare is a rim, not a veil. At 0.09 from r = 0.62 it laid
          // a milky wash over a third of the image and was a large part of why the darks
          // read hazy.
          g += uRushLines * uRushTint * 0.030 * smoothstep( 0.88, 1.20, r );
        }
        #endif

        // ---- vignette ---------------------------------------------------------------------
        g *= 1.0 - uVignette * smoothstep( 0.30, 1.12, r );

        // ---- the tonal anchor: one floor and one ceiling for the whole game ---------------
        // Round-4 review measured the fraction of the frame below luma 0.06 running from
        // 0.31% to 12.35% across the canonical set — the same course at the same hour — with
        // shadowed asphalt and the chequered flag's dark squares both landing on RGB 3,11,30:
        // black with a blue cast and no detail left in it. The cause is that nothing in this
        // stack owned the bottom of the range; the LUT's cool-shade split tone simply ran off
        // the end of it.
        //
        // This is a toe, not a lift. Below uToePivot the curve is a power law anchored on
        // uBlack, and its slope at the pivot is (pivot-black)/pivot * gamma = 0.96, so it
        // meets the untouched range smoothly instead of putting a milky step in the shadows.
        // Above the pivot nothing changes at all. The effect is that every frame in the game
        // ends on exactly the same black, and the last few percent of the range keeps its
        // gradient instead of collapsing onto one value.
        {
          vec3 t = max( g, vec3( 0.0 ) ) / uToePivot;
          vec3 toed = uBlack + ( uToePivot - uBlack ) * pow( t, vec3( uToeGamma ) );
          g = mix( toed, g, step( vec3( uToePivot ), g ) );
        }
        // ...and the matching ceiling, so a bright plate cannot drift past the top either.
        {
          float wr = max( uWhiteCeil - uWhiteKnee, 1e-3 );
          vec3 over = max( g - uWhiteKnee, vec3( 0.0 ) );
          g = min( g, vec3( uWhiteKnee ) ) + wr * ( 1.0 - exp( - over / wr ) );
        }

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

const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** shortest distance between two hue angles, in degrees (0..180) */
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Where each hue *lands*. This is a monotone map from the hue the renderer produced to the
 * hue the frame should show, given as knots and interpolated linearly; monotonicity matters,
 * because a non-monotone map lets two neighbouring shades cross over each other and a smooth
 * gradient breaks into bands.
 *
 * The work happens between 50 and 90 deg. Foliage on this course — pine, cypress, olive,
 * vine — renders at hue 44-64: yellow-olive, on the *warm* side of the R=G line at 60, which
 * is why an aerial plate of a village surrounded by forest read as one sepia wash. That band
 * is stretched onto 50-126 so a canopy becomes green, while everything below 50 deg (dry
 * stubble at 44-50, limestone dust, straw bales, the haze) is left where it is and stays
 * warm. Below that the map tilts slightly toward red, which is what separates a terracotta
 * pantile roof from the dust of the road in front of it.
 */
const HUE_WARP = [
  [0, 0], [20, 15], [36, 32], [51, 51], [58, 78], [66, 106], [76, 120], [88, 130],
  [104, 138], [126, 150], [150, 168], [180, 202], [212, 223], [245, 248], [290, 292],
  [330, 334], [360, 360],
];
function hueWarp(h) {
  for (let i = 1; i < HUE_WARP.length; i++) {
    const b = HUE_WARP[i];
    if (h <= b[0]) {
      const a = HUE_WARP[i - 1];
      const t = (h - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return h;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1)      { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  const m = v - c;
  return [r + m, g + m, b + m];
}

/**
 * The palette, as hue families. `lo` is the saturation gain applied to a low-chroma pixel of
 * that hue, `hi` the gain once it is already vivid; `sigma` is the kernel width in degrees.
 *
 * The amber family is the only one whose `lo` is below 1.0, and that is the whole point of
 * this table: on a course lit by a low warm sun, *everything* neutral lands there, so it is
 * the one family that needs pulling back rather than pushing. Its `hi` stays above 1.0 so the
 * things that are genuinely orange — boost flame, item-box gold, terracotta — are untouched.
 *
 * Green is the mirror image, and its `hi` of 0.82 is doing real work: the hue warp above
 * lands saturated yellow-olives on the green axis, and a canopy at 0.9 chroma is neon poster
 * paint, not a pine. Pushing the dull greens up while pulling the vivid ones down compresses
 * the whole family into the band a tree actually occupies.
 */
const HUE_ANCHORS = [
  { h:  12, sigma: 27, lo: 1.24, hi: 1.06 },                     // pantile red, kerb, livery
  { h:  46, sigma: 26, lo: 0.88, hi: 1.10 },                     // limestone, dust, straw
  { h: 118, sigma: 40, lo: 1.40, hi: 0.80, c0: 0.28, c1: 0.60 }, // olive, pine, cypress, vine
  { h: 215, sigma: 55, lo: 1.78, hi: 1.38 },                     // sky, shade, water, liveries
  { h: 310, sigma: 50, lo: 1.30, hi: 1.14 },                     // item box, bougainvillea
];

/**
 * Builds the 32^3 grading LUT as a 1024x32 RGBA strip. Deterministic and dependency-free,
 * so a screenshot round always gets exactly the same grade.
 *
 * The look: Ramot Menashe at about 15:30. Warm sun, cool-teal shade so Jerusalem stone
 * reads three-dimensional, and — the part that carries the whole frame — a palette built
 * per *hue family* rather than per pixel: terracotta red, limestone amber, olive-and-pine
 * green and sky blue each get their own saturation, so a village surrounded by forest reads
 * as four colours at kart speed instead of one. The domain is the renderer's ACES output,
 * so the curve only has to add character — the highlight shoulder is already there and this
 * must not fight it.
 */
export function makeGradeLUT(opts = {}) {
  const N = 32;
  const W = N * N, H = N;
  const data = new Uint8Array(W * H * 4);

  // `saturation` is the *strength* of the palette shaping below, not a flat multiplier:
  // 1.42 (what post.js asks for) means "apply the hue table at full weight".
  const sat       = opts.saturation ?? 1.28;
  const strength  = clamp((sat - 1) / 0.42, 0, 2.2);
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

        // --- the palette: per-hue saturation and hue placement --------------------------
        // Round-3 review measured 94.9% of every chromatic pixel in the frame inside the
        // 0-90 deg red-to-yellow arc, with greens at 1.0% and blues at 3.4% — a kart racer
        // rendered in one colour. The cause was a *vibrance* curve here that gave its full
        // push to near-neutrals and rolled off on things already saturated: with a warm key
        // light, that drives every neutral surface in the moshav (limestone, plaster,
        // asphalt, dust, haze) into the same orange while leaving the sky and the foliage —
        // the only things that carry another hue — untouched. It optimised mean chroma and
        // destroyed the palette.
        //
        // The priority is inverted here. Saturation is a function of *hue*: the amber mass
        // is pulled back so stone reads as stone, and the green and blue families are pushed
        // hard so the olive groves, the pine ridge, the shade and the sky come back as their
        // own colours. A hue rotation runs first, because the foliage on this course renders
        // at hue 44-64 — yellow-olive, on the warm side of the R=G line at 60 — and no
        // amount of saturation makes a yellow read as a tree. The warp is flat below 51 deg,
        // just above the dry stubble and dust at 44-50, so the ground stays warm while the
        // canopy above it turns green.
        {
          const mx = Math.max(out[0], out[1], out[2]);
          const mn = Math.min(out[0], out[1], out[2]);
          const chroma = mx > 1e-5 ? (mx - mn) / mx : 0;

          // Hue, degrees. Below the chroma gate a pixel has no meaningful hue, so every
          // hue-driven term fades out there — that is what keeps neutrals neutral and keeps
          // the trilinear interpolation between LUT cells smooth across the grey axis.
          const gate = ss(0.05, 0.15, chroma);
          let h = 0;
          const d = mx - mn;
          if (d > 1e-6) {
            if (mx === out[0])      h = 60 * ((((out[1] - out[2]) / d) % 6) + 6) % 360;
            else if (mx === out[1]) h = 60 * (((out[2] - out[0]) / d) + 2);
            else                    h = 60 * (((out[0] - out[1]) / d) + 4);
            h = ((h % 360) + 360) % 360;
          }

          const h2 = ((h + (hueWarp(h) - h) * gate) % 360 + 360) % 360;

          // Saturation gain, blended between the hue anchors with a normalised gaussian
          // kernel so there are no seams between families. Each family crossfades from `lo`
          // to `hi` across its own chroma window: `hi` is the gain for colours that are
          // already vivid — a boost flame, item-box gold, a kart livery — which must keep
          // their gradients rather than smear into a flat primary, and for green it is a
          // compressor that keeps a sunlit prickly pear from going fluorescent.
          let wSum = 0, gSum = 0;
          for (let a = 0; a < HUE_ANCHORS.length; a++) {
            const A = HUE_ANCHORS[a];
            const t = hueDist(h2, A.h) / A.sigma;
            const w = Math.exp(-t * t);
            wSum += w;
            gSum += w * (A.lo + (A.hi - A.lo) * ss(A.c0 ?? 0.55, A.c1 ?? 0.85, chroma));
          }
          const gain = wSum > 1e-6 ? gSum / wSum : 1;

          // Keep plaster and cloud tops white: the push eases out in the top stop.
          const hiRoll = 1 - 0.45 * clamp((lum - 0.82) / 0.18, 0, 1);
          const satHere = clamp(1 + (gain - 1) * strength * hiRoll, 0.25, 3);

          const s2 = clamp(chroma * satHere, 0, 1);
          const rgb2 = hsvToRgb(h2, s2, mx);
          // Rotating a yellow to a green at constant value darkens it (green carries more
          // luma per unit value), and a saturation push darkens too. Restore most of the
          // original luma so the canopy keeps its shape and the sky keeps its brightness.
          const l1 = 0.2126 * rgb2[0] + 0.7152 * rgb2[1] + 0.0722 * rgb2[2];
          const k = l1 > 1e-4 ? clamp((l1 + (lum - l1) * 0.38) / l1, 0.72, 1.45) : 1;
          for (let n = 0; n < 3; n++) out[n] = Math.max(rgb2[n] * k, 0);
        }

        // filmic S-curve about a 0.46 pivot
        for (let k = 0; k < 3; k++) {
          const x = out[k] - 0.46;
          out[k] = 0.46 + x * contrast * (1 + 0.14 * (1 - Math.abs(x) * 2));
        }

        lum = clamp(0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2], 0, 1);
        const sh = (1 - lum) * (1 - lum);   // shadow weight
        const hi = lum * lum * lum;         // highlight weight

        // cool-teal shade, warm amber highlight — the classic sunny-afternoon split tone
        // Cool shade, warm highlight — the classic sunny-afternoon split tone, but weighted
        // toward the shade end. A strong warm highlight tint tints the *sky and the haze*
        // before it tints anything else, because those are the brightest things in a frame
        // shot outdoors; that is how a Mediterranean afternoon ends up looking like a dust
        // storm. The shade side carries the colour contrast instead, which is also where it
        // does the most good — a third of this course is under an olive or a pine.
        out[0] += shadeTint * (-0.042 * sh) + warmth * (0.019 * hi);
        out[1] += shadeTint * (0.005 * sh) + warmth * (0.011 * hi);
        out[2] += shadeTint * (0.072 * sh) + warmth * (-0.012 * hi);

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
