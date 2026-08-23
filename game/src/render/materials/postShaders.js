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
    uSpread:   { value: 0.25 },   // 0 when the chain already runs at canvas resolution
    uSharpen:  { value: 0.34 },
  },
  vertexShader: FS_QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDstTexel;
    uniform float uSpread, uSharpen;
    varying vec2 vUv;

    ${GLSL_COMMON}

    void main() {
      vec2 o = uDstTexel * uSpread;
      vec3 c  = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
      c      += texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;
      c *= 0.25;

      // Contrast-adaptive sharpen, on the destination grid.
      //
      // Round-5 review called the whole image soft "even when nothing is moving" and, in the
      // same breath, aliased — authored detail (tile grids, asphalt aggregate, tyre tread)
      // blurred away while edges still stair-step. That pair is what a supersampled chain
      // resolved with a box filter looks like: the box kills the sub-pixel detail the extra
      // samples were spent on and gives nothing back. This puts the acutance back on the
      // *destination* grid, where it cannot reintroduce sub-pixel aliasing, and clamps the
      // result into the neighbourhood's own min/max so it can never ring into a halo — the
      // classic sharpening failure that reads as an outline round every roof.
      vec3 e  = texture2D( tDiffuse, vUv + vec2(  uDstTexel.x, 0.0 ) ).rgb;
      vec3 w  = texture2D( tDiffuse, vUv - vec2(  uDstTexel.x, 0.0 ) ).rgb;
      vec3 n  = texture2D( tDiffuse, vUv + vec2( 0.0, uDstTexel.y ) ).rgb;
      vec3 sth= texture2D( tDiffuse, vUv - vec2( 0.0, uDstTexel.y ) ).rgb;
      vec3 lo = min( c, min( min( e, w ), min( n, sth ) ) );
      vec3 hi = max( c, max( max( e, w ), max( n, sth ) ) );
      vec3 sharp = c + ( c - ( e + w + n + sth ) * 0.25 ) * uSharpen;
      sharp = clamp( sharp, lo, hi );
      // Ordered-free dither, last, on the canvas grid — one LSB of noise so the sky gradient
      // and the shadow ramp quantise smoothly instead of banding.
      sharp += ( katHash( gl_FragCoord.xy ) - 0.5 ) * ( 1.6 / 255.0 );
      gl_FragColor = vec4( clamp( sharp, 0.0, 1.0 ), 1.0 );
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
      // Round-6 review measured the asphalt at rgb(65,76,113) in `oliveGrove` shade and
      // rgb(78,84,111) in `driftCorner` — blue 60-75% over red, i.e. a saturated indigo, not
      // tarmac. The road arrives at this pass *already* cool (trackMesh's own `uTint` is
      // (0.94, 1.00, 1.135) on the lit result), so a shade tint of this size was not giving
      // a grey surface a direction, it was compounding a cast that already existed. Halved,
      // and rebalanced off the red-blue axis onto a genuine skylight azure — G now sits
      // between R and B instead of below both, which is the difference between "cool grey"
      // and "violet". `uNeutralCap` below is the hard stop that keeps the compounding
      // bounded however blue the surface was when it got here.
      uNeutral:      { value: 0.0 },
      uShadeTint:    { value: new THREE.Vector3(-0.020, 0.000, 0.028) },
      uSunTint:      { value: new THREE.Vector3(0.024, 0.009, -0.020) },
      // The most chroma this block is allowed to leave on a pixel that came in achromatic.
      uNeutralCap:   { value: 0.11 },
      // The fixed tonal anchor. Every frame ends on the same floor and the same ceiling —
      // and both ends are *reachable*: uBlackPt/uWhitePt are the display levels that map to
      // 0 and 1, so the grade owns a real black and a real white instead of living in the
      // middle of the range.
      uBlackPt:      { value: 0.014 },
      uWhitePt:      { value: 0.918 },
      uBlack:        { value: 0.0 },
      uToePivot:     { value: 0.17 },
      uToeGamma:     { value: 1.10 },
      uWhiteKnee:    { value: 0.885 },
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
      uniform float uNeutralCap;
      uniform float uBlackPt, uWhitePt, uBlack, uToePivot, uToeGamma, uWhiteKnee;
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
          // The dome gets *none* of it. A blur is a weighted read of the neighbourhood, so a
          // sky pixel with a blur vector reaches down across the silhouette below it and
          // drags whatever is there upward into the sky — which is precisely the pale
          // vertical bars round-5 review found rising out of the rooflines in photoFinish,
          // oliveGrove, hilltopVista and gridStart, and the faint parallel streaks behind the
          // clouds before that. The dome has no parallax and no high-frequency detail, so
          // there was never anything to gain here: the whip comes from the scenery, not from
          // smearing a gradient.
          vel *= 1.0 - isSky;
          blurVec += vel;
        }
        #endif

        float bl = length( blurVec );
        if ( bl > uMotionMax ) blurVec *= uMotionMax / bl;

        // The radial rush is added *after* the reprojection clamp, because it is not camera
        // motion and must not be squeezed out by it. It is the frame's actual speed cue: the
        // reprojection blur is gated to hold the road readable (and suppressed outright while
        // the chase camera is still settling), so without this a 75 km/h plate is razor-sharp
        // corner to corner. Zero at the centre, growing to the frame edge — the scenery
        // streams past while the kart and the racing line stay crisp.
        #if USE_RUSH == 1
          blurVec += c * ( uRush * smoothstep( 0.10, 1.0, r ) );
        #endif

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
          // The dome is the far end of the depth range, so smoothstep hands it a *full*
          // circle of confusion — and a blur is a weighted read of the neighbourhood, so
          // every sky pixel within the kernel of a roofline reaches down across the
          // silhouette and pulls the roof up into the sky. That is the other half of round
          // 5's vertical light-shaft bars (measured: turning DoF off shortened them by
          // 10-15 px and left only the bloom halo underneath). The sky has no depth cue to
          // sell and no aliasing to hide, so it keeps only a whisper — enough to soften the
          // dome's own banding, far too little to drag a roof anywhere.
          coc = mix( coc, uDofMax * 0.06, isSky );
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
        // The shade-to-sun ramp is deliberately wide (0.22 to 1.02). A narrow one flips
        // between the cool and the warm tint across the asphalt's own grain and turns a noise
        // pattern into blue-and-tan speckle. Round 6 measured exactly that: inside a 120x60
        // road patch the luma runs 39 to 121, and the old 0.30-0.85 ramp put a third of that
        // swing straight into the cool/warm mix, so neighbouring chippings landed on
        // different sides of the decision. The key is a *lighting* question - is this
        // surface in sun or in shade - and lighting does not change from one pixel to the
        // next, so the ramp is now wide enough that a grain-sized luma wobble barely moves it.
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
          float key = smoothstep( 0.22, 1.02, nl );
          vec3 tinted = g + uNeutral * neutral * lit * mix( uShadeTint, uSunTint, key );

          // A ceiling on what this block may manufacture. Giving a grey surface a direction
          // is the point; past ~0.11 chroma it stops reading as tinted grey and starts
          // reading as a coloured surface, which is how the asphalt became navy. The road
          // reaches this pass already carrying a cool cast from its own material, so an
          // additive tint on top compounds without bound unless something bounds it — this
          // is that bound, and it is what makes the block safe to leave switched on.
          //
          // Weighted by the neutral term, so it only touches pixels this block itself tinted:
          // a livery, a kerb or a pantile roof arrives with chroma of its own, gets no tint,
          // and must not be desaturated on its way through.
          float cmx = max( tinted.r, max( tinted.g, tinted.b ) );
          float cmn = min( tinted.r, min( tinted.g, tinted.b ) );
          float cch = cmx > 1e-4 ? ( cmx - cmn ) / cmx : 0.0;
          float capk = cch > uNeutralCap ? uNeutralCap / cch : 1.0;
          g = mix( tinted, vec3( katLuma( tinted ) ), ( 1.0 - capk ) * neutral );
        }

        float l = katLuma( g );
        g = mix( vec3( l ), g, uSaturation );
        g = ( g - 0.5 ) * uContrast + 0.5 + uLift;
        // Only the floor is clamped here. Clamping the top as well threw away every value
        // the range remap below needs in order to reach white, which is how the stack ended
        // up with clipW = 0.00% in all eight canonical frames.
        g = max( g, vec3( 0.0 ) );

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

        // ---- the tonal anchor: one black and one white for the whole game -----------------
        // Round-5 review measured clipW = 0.00% *and* clipB = 0.00% in every one of the eight
        // canonical frames: p1 ran 20-40 and p99 ran 215-244, so not one pixel in the game
        // reached either end of the range. Three ceilings were stacked on top of each other
        // (the composite's soft clip, the LUT's own asymptotic shoulder and an exponential
        // white knee whose fixed point mapped 1.0 to 0.975) and a hard 0.062 floor sat under
        // everything. High chroma over a midtone-only range is the definition of the flat,
        // milky poster-paint look the review named.
        //
        // So the anchor is now a *range*: uBlackPt and uWhitePt are the display levels that
        // land on 0 and 1. Everything between keeps its shape, the top stop still rolls into
        // white through a knee instead of slamming into it, and the bottom is a genuine toe
        // rather than a lift.
        g = ( g - uBlackPt ) / max( uWhitePt - uBlackPt, 1e-3 );

        // Toe. Below uToePivot the curve is a power law anchored on uBlack; its slope at the
        // pivot meets the untouched range smoothly, so this deepens the shadow end without
        // putting a step in it. uBlack is 0 — the frame is allowed to reach black — and what
        // keeps the darks from going blue-black is that the LUT's split tone now fades out
        // under luma 0.11 rather than tinting a pixel the renderer sent in as black.
        {
          vec3 t = max( g, vec3( 0.0 ) ) / uToePivot;
          vec3 toed = uBlack + ( uToePivot - uBlack ) * pow( t, vec3( uToeGamma ) );
          g = mix( toed, g, step( vec3( uToePivot ), g ) );
        }

        // Highlight knee. A quadratic that leaves the line at uWhiteKnee with slope 1 and
        // arrives at exactly 1.0 with slope 0, then clips. Unlike an exponential shoulder
        // this *reaches* white, so a sunlit wall or a specular hit can be white while the
        // stop below it still rolls instead of banding.
        {
          float k = uWhiteKnee;
          float w2 = 2.0 * max( 1.0 - k, 1e-3 );          // width of the knee in input units
          vec3 d = clamp( g - k, vec3( 0.0 ), vec3( w2 ) );
          vec3 kneed = k + d - d * d / ( 2.0 * w2 );
          g = mix( g, kneed, step( vec3( k ), g ) );
        }
        // Dither is *not* applied here. This pass runs on the supersampled grid, where the
        // resolve would average 2.25 samples of it back down to a third of its amplitude —
        // and it would then be fed to SMAA, whose edge detector has to look at it. It is
        // applied by the resolve pass instead, on the canvas grid, as the last thing that
        // happens to the image.
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
 * has to cross the line, but it must stop in the OLIVE range and not carry on to emerald: the
 * previous knots took hue 66 to 106 and hue 76 to 120, i.e. onto the pure green axis, where
 * the green family's saturation gain then made a sunlit canopy fluorescent — most of why
 * round 6 read the aerial plates as false-colour. The Menashe plateau in July is silver-green
 * olive, blue-black cypress and grey-green pine over gold stubble, so 58-104 now lands on
 * 68-122 instead. Everything below 51 deg (dry stubble at 44-50, limestone dust, straw bales,
 * the haze) is left exactly where it is and stays warm; below that the map tilts slightly
 * toward red, which is what separates a terracotta pantile roof from the dust of the road in
 * front of it.
 */
const HUE_WARP = [
  [0, 0], [20, 16], [36, 33], [51, 51], [58, 68], [66, 86], [76, 100], [88, 111],
  [104, 122], [126, 138], [150, 160], [180, 198], [212, 220], [245, 247], [290, 292],
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
 * Green is the mirror image, and its `hi` is doing real work: the hue warp above lands
 * saturated yellow-olives on the olive axis, and a canopy at 0.9 chroma is neon poster paint,
 * not a pine. Pushing the dull greens up while pulling the vivid ones down compresses the
 * whole family into the band a tree actually occupies.
 *
 * Read the numbers against the chroma target in lighting.js's brief — mean 0.34-0.42, where
 * Mario Kart actually sits. Round 6 measured this course well above it, and the excess was
 * not spread evenly: it was concentrated in the two families that cover the most screen area,
 * green and blue. Both of their `hi` values are now genuine compressors, so a sunlit prickly
 * pear and a zenith sky arrive already vivid and are pulled DOWN, while the dull end of each
 * family is still lifted and the palette stays separated.
 */
const HUE_ANCHORS = [
  { h:  12, sigma: 27, lo: 1.16, hi: 1.00 },                     // pantile red, kerb, livery
  { h:  46, sigma: 26, lo: 0.86, hi: 1.02 },                     // limestone, dust, straw
  { h: 104, sigma: 40, lo: 1.06, hi: 0.58, c0: 0.24, c1: 0.56 }, // olive, pine, cypress, vine
  // Blue touches the largest single object in every frame — the sky — so it is the family a
  // saturation push flatters least. The dome carries its own chroma from sky.js's `uSkySat`;
  // this only has to keep a livery and a shadow from going grey.
  { h: 215, sigma: 55, lo: 1.30, hi: 0.98 },                     // sky, shade, water, liveries
  { h: 310, sigma: 50, lo: 1.20, hi: 1.06 },                     // item box, bougainvillea
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
  // The offsets have to stay small in *linear* terms, because linear values near black are
  // tiny: at sRGB byte 8 a channel carries 0.0024 of light, so the old +0.003 red offset was
  // larger than the pixel itself and the bottom of the range came out with red surviving
  // while green and blue clipped to zero. That did not show while the split tone below was
  // lifting every dark pixel; now that the frame is allowed to reach black, it would be the
  // only thing anyone saw down there.
  const offset = [0.0010, 0.0004, -0.0004];
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
        // Shadow weight, *faded out at the very bottom of the range*. This factor is the
        // reason the game has a black at all. Round-5 review measured clipB = 0.00% in every
        // one of the eight canonical frames and traced a hard floor at sRGB byte ~40; half of
        // that floor was built right here. `(1-lum)^2` is largest exactly where the image is
        // darkest, so the split tone below and the warm lift after it were at *full strength*
        // on a pixel the renderer had sent in as pure black — this table used to map
        // (0,0,0) to (0,5,21), a blue-lifted black that no downstream curve can take back
        // out. Rolling the weight to zero under luma 0.11 keeps the cool shade where it does
        // its work (the mid-shadows on plaster and asphalt) and lets the bottom of the range
        // land on a neutral black.
        const shw = (1 - lum) * (1 - lum) * ss(0.008, 0.11, lum);
        const hi = lum * lum * lum;         // highlight weight

        // Cool shade, warm highlight — the classic sunny-afternoon split tone, but weighted
        // toward the shade end. A strong warm highlight tint tints the *sky and the haze*
        // before it tints anything else, because those are the brightest things in a frame
        // shot outdoors; that is how a Mediterranean afternoon ends up looking like a dust
        // storm. The shade side carries the colour contrast instead, which is also where it
        // does the most good — a third of this course is under an olive or a pine.
        out[0] += shadeTint * (-0.030 * shw) + warmth * (0.017 * hi);
        out[1] += shadeTint * (0.004 * shw) + warmth * (0.010 * hi);
        out[2] += shadeTint * (0.050 * shw) + warmth * (-0.011 * hi);

        // a whisper of warm lift so the mid-shadows are dusty rather than video-black; it
        // rides the same faded weight, so it never touches the bottom of the range
        out[0] += 0.012 * shw; out[1] += 0.009 * shw; out[2] += 0.006 * shw;

        // Highlight shoulder — and it has to *reach white*. The old curve was
        // `T + (1-exp(-(v-T)*9)) * (1-T)`, which is asymptotic: it maps 1.0 to 0.9665, so the
        // brightest colour this table can emit is byte 246 and no amount of exposure
        // downstream can produce a white pixel. That was one of three stacked ceilings (the
        // composite's soft clip and its white knee were the others) behind round 5's
        // clipW = 0.00% in all eight frames. Normalising by the value at v = 1 keeps the same
        // roll-off shape through the top stop and lands exactly on 1.0.
        const T = 0.962, TK = 7.0, TD = 1 - Math.exp(-(1 - T) * TK);
        for (let k = 0; k < 3; k++) {
          const v = out[k];
          out[k] = v > T ? T + (1 - Math.exp(-(v - T) * TK)) * (1 - T) / TD : v;
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
