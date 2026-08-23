import * as THREE from 'three';
import { clamp, lerp as lerpN } from '../core/mathx.js';

/**
 * Lighting rig for Kat Racing: a camera-fitted sun shadow, sky IBL and physically flavoured
 * aerial perspective. Driven by `src/world/sky.js` (which owns the atmosphere itself).
 *
 *   const lighting = createLighting(engine, world, skyState);
 *
 * The rig patches materials so that (a) they cast their FRONT faces into the shadow map —
 * see `installShadowSideDefault()`, it is why anything has a shadow at all — and (b) fog
 * becomes a height-aware, sun-tinted aerial-perspective term. Patching composes with any
 * `onBeforeCompile` another system already installed, and is re-applied automatically if
 * somebody overwrites it later, so parallel systems cannot silently break each other.
 *
 * Materials are adopted automatically for the built-in mesh material types. A system that
 * uses a custom ShaderMaterial can opt in explicitly with `lighting.setupMaterial(mat)`.
 */

/* =====================================================================================
 * THE LOOK — one direction for the whole image.
 *
 * Six review rounds were lost to six agents tuning six files toward six different pictures.
 * These six files (lighting, sky, post, postShaders, terrainMaterial, trackMesh) compose into
 * ONE pixel, so they now answer to one written brief. If a change does not serve the brief
 * below, it does not go in — whatever a defect list says.
 *
 * SUBJECT. A sun-bleached Mediterranean afternoon on the Menashe plateau — 15:24 local on a
 * mid-July day, which for 32.56 N puts the sun at elevation 53.4 deg, azimuth 263 (due west,
 * a shade south). Jerusalem limestone, red pantile, olive silver-green, dark cypress, dry
 * gold stubble, dust on the ridges. Bright, but the sun has been up a long time and
 * everything is a little bleached. Mario Kart 8's clarity, not its Nintendo-primary palette.
 *
 * KEY / FILL / AMBIENT.
 *   - ONE directional sun, faintly warm (~5600 K at this elevation), carrying ~72 % of the
 *     light on a lit horizontal surface. Sunlit limestone lands at display 0.84-0.90 and
 *     must not clip.
 *   - Sky hemisphere + terra-rossa bounce + sky IBL *diffuse* together carry the other ~28 %.
 *     That is the whole shadow budget: a cast shadow is therefore worth about 1.6 stops —
 *     dark enough to read at speed, open enough to keep the material's own hue. Shadows
 *     must never go to one flat blue-black.
 *   - Sky IBL *specular* stays bolted down (see installIblChunks); an unshadowed reflection
 *     brighter than sunlit ground is the white-smear failure mode this project keeps hitting.
 *
 * EXPOSURE. Mean frame luma 0.38-0.46. Under 1 % of pixels above 250 and a real black
 * present (p1 near 10) so the frame owns its whole range. The tonal anchor lives in
 * post.js (uBlackPt/uWhitePt) and is a constant: one black and one white for the game.
 *
 * SATURATION. Mean chroma 0.34-0.42 — the Mario Kart band, and about 20 % below where
 * round 6 sat. Chroma comes from the palette being *separated*, not from a global push:
 * terracotta red, limestone amber, olive-green and sky azure each graded as their own
 * family (postShaders HUE_ANCHORS). Foliage lands olive/yellow-green at hue 90-110, never
 * emerald; dry ground stays ochre, never Mars orange; the dome is azure at 210-214.
 *
 * DISTANCE. Aerial perspective is the primary depth cue and is deliberately strong: ~10 %
 * of the way to the haze at 150 m, ~28 % at 400 m, ~55 % at 1 km, capped at 0.74. It also
 * *desaturates* (apDesat), because losing chroma with distance is what actually separates a
 * 3 km ridge from the kerb in front of the kart — mixing toward a bright horizon colour on
 * its own only makes the distance pale, not far away.
 *
 * ROAD vs VERGE. The racing surface is the darkest large mass in frame — display luma
 * 0.22-0.32 in sun — against a dry ochre verge at 0.55-0.68 and kerbs at full red/white
 * contrast. That value step is what makes the ribbon legible at 200 km/h. The asphalt's
 * own texture must stay LOW contrast at every distance: aggregate reads through the normal
 * map and roughness, not through albedo noise. Any albedo swing wide enough to see as
 * mottle from the chase camera is a bug, not detail (see trackMesh `agg`).
 *
 * ANCHORING. Every kart carries a visible ground shadow in every frame. At 53 deg the sun
 * throws a SHORT shadow — about 0.75 of the caster's height — so most of it lands under the
 * chassis where a chase camera cannot see it, and the shadow map alone can never anchor the
 * field on this course. It therefore gets two mechanisms: the map's own cast shadow, and an
 * explicit ambient-occlusion pool with a soft lobe pushed down-sun far enough to clear the
 * silhouette. They are independent on purpose — if one is ever broken again, the other still
 * glues the field to the road.
 * ===================================================================================== */

// ---------------------------------------------------------------------------------------
// Global shader-chunk surgery. Everything is guarded behind AERIAL_PERSPECTIVE so that any
// material we did NOT adopt keeps three's stock fog behaviour and still compiles.
// ---------------------------------------------------------------------------------------

let chunksInstalled = false;

function installFogChunks() {
  if (chunksInstalled) return;
  chunksInstalled = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  #ifdef AERIAL_PERSPECTIVE
    varying vec3 vFogWorld;
  #endif
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  #ifdef AERIAL_PERSPECTIVE
    {
      vec4 apWorld = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
        apWorld = batchingMatrix * apWorld;
      #endif
      #ifdef USE_INSTANCING
        apWorld = instanceMatrix * apWorld;
      #endif
      vFogWorld = ( modelMatrix * apWorld ).xyz;
    }
  #endif
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  #ifdef AERIAL_PERSPECTIVE
    varying vec3 vFogWorld;
    uniform vec3  apSunDir;
    uniform vec3  apHorizon;
    uniform vec3  apZenith;
    uniform vec3  apSunTint;
    uniform float apDensity;
    uniform float apFalloff;
    uniform float apBase;
    uniform float apSunAmount;
    uniform float apMax;
    uniform float apDesat;
  #endif
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  #ifdef AERIAL_PERSPECTIVE

    vec3  apRay   = vFogWorld - cameraPosition;
    float apDist  = length( apRay );
    vec3  apDir   = apDist > 1e-4 ? apRay / apDist : vec3( 0.0, 0.0, -1.0 );

    // Analytic integral of an exponential atmosphere along the view ray.
    float apH0 = cameraPosition.y - apBase;
    float apH1 = vFogWorld.y - apBase;
    float apDy = apH1 - apH0;
    float apAir;
    if ( abs( apDy ) < 0.75 ) {
      apAir = apDist * exp( - apFalloff * apH0 );
    } else {
      apAir = apDist * ( exp( - apFalloff * apH0 ) - exp( - apFalloff * apH1 ) ) / ( apFalloff * apDy );
    }

    float apAmount = 1.0 - exp( - apDensity * apAir );
    apAmount = min( apAmount, apMax );

    // Haze colour follows the sky: warm and bright looking into the sun, cooler up high.
    float apUp   = smoothstep( -0.05, 0.42, apDir.y );
    vec3  apCol  = mix( apHorizon, apZenith, apUp );
    // Airlight looking down at the ground is dimmer than the horizon sky; without this the
    // hills bleach into the skyline instead of receding behind it.
    apCol *= mix( 0.74, 1.0, smoothstep( -0.30, 0.02, apDir.y ) );
    float apCos  = max( dot( apDir, apSunDir ), 0.0 );
    apCol = mix( apCol, apSunTint, pow( apCos, 5.0 ) * apSunAmount );

    // Distance eats CHROMA before it eats contrast, and that is the half of aerial
    // perspective this rig was missing: mixing toward a bright horizon colour alone makes
    // the far ridge pale but leaves it just as vivid as the kerb in front of the kart, which
    // is exactly what round 6 read as "no aerial perspective in the first 600 m". Scattering
    // is spectrally broad by the time it has crossed a kilometre of dusty summer air, so the
    // surface's own colour washes toward its own luminance on the way in. Applied before the
    // haze mix so a surface loses its colour and *then* recedes, rather than being painted
    // over — the ridge keeps its form and stops competing for attention.
    {
      float apL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( apL ), apAmount * apDesat );
    }

    gl_FragColor.rgb = mix( gl_FragColor.rgb, apCol, apAmount );

  #else

    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

  #endif
#endif`;
}

// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// IBL specular roll-off.
//
// The sky IBL is the only fill a shaded surface gets here, and it has to be raised a long way
// for shadows to stay readable (see the ambient block in createLighting). Raising it naively
// is what put white smears on the asphalt: the environment's *specular* lobe is not shadowed
// by anything, it is sampled at grazing angles all over a road whose repair patches vary in
// roughness, and the env dome still carries the sun's Mie glow — so a low-roughness patch in
// full tree shadow returned a lobe brighter than directly sunlit tarmac. Physically impossible
// and it read as a light leak.
//
// Diffuse irradiance and specular radiance therefore get separate controls: `ktIblDiffuse`
// scales the fill that opens the shadows, `ktIblSpec` scales the reflection, and everything
// above `ktIblClamp` is compressed by a soft knee so no reflection of the sky can ever out-run
// the sun. Guarded by AERIAL_PERSPECTIVE, i.e. only on materials this rig adopted.
// ---------------------------------------------------------------------------------------

function installIblChunks() {
  const pars = THREE.ShaderChunk.envmap_physical_pars_fragment;
  if (typeof pars === 'string' && !/ktIblSpec/.test(pars)) {
    THREE.ShaderChunk.envmap_physical_pars_fragment = pars.replace('#ifdef USE_ENVMAP', `#ifdef USE_ENVMAP

	#ifdef AERIAL_PERSPECTIVE
		uniform float ktIblDiffuse;
		uniform float ktIblSpec;
		uniform float ktIblClamp;
		uniform float ktIblKnee;
	#endif
`);
  }

  const maps = THREE.ShaderChunk.lights_fragment_maps;
  if (typeof maps === 'string' && !/ktIblSpec/.test(maps)) {
    THREE.ShaderChunk.lights_fragment_maps = maps + /* glsl */`
#ifdef AERIAL_PERSPECTIVE
	#if defined( RE_IndirectDiffuse ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance *= ktIblDiffuse;
	#endif
	#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
		{
			radiance *= ktIblSpec;
			float ktL = max( max( radiance.r, radiance.g ), radiance.b );
			if ( ktL > ktIblClamp ) {
				float ktOver = ktL - ktIblClamp;
				radiance *= ( ktIblClamp + ktOver / ( 1.0 + ktOver * ktIblKnee ) ) / max( ktL, 1e-5 );
			}
		}
	#endif
#endif
`;
  }
}

// ---------------------------------------------------------------------------------------
// Shadow filter surgery.
//
// three's PCF path takes FIVE Vogel-disk taps and rotates the disk per pixel with interleaved
// gradient noise. Five rotated taps only ever return 0, 0.2, 0.4, 0.6, 0.8 or 1.0, and the
// rotation scatters which of those a given pixel lands on — so at any radius wide enough to
// read as a penumbra the boundary is *stipple*, not a gradient. That is the dithered, speckled
// shadow edge on the tan verge in itemChaos and the aliased crawl on the olive-grove shadows in
// hilltopVista; a hard-edged look (radius 1) is the only way to hide it, which is the jagged
// stair-stepping on the building shadows in introFlythrough. The same scene therefore showed
// both failure modes at once.
//
// Twelve taps give 13 quantisation levels — below the 8-bit quantisation of the frame — so the
// radius can finally be opened to a real world-space penumbra. It is one loop over the same
// hardware-compared sampler; the taps are the only extra cost, and the disk is still rotated
// deterministically from gl_FragCoord so screenshots stay reproducible.
// ---------------------------------------------------------------------------------------

let shadowChunkInstalled = false;

function installShadowChunk(taps) {
  if (shadowChunkInstalled) return;
  shadowChunkInstalled = true;
  try {
    const src = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (typeof src !== 'string') return;
    // Match ONLY the directional/spot 2D block: the point-light one below it builds its taps
    // into named `sampleN` variables and must be left alone.
    const re = /shadow = \(\s*\n(?:[^\n]*vogelDiskSample\([^\n]*\n){5}\s*\) \* 0\.2;/;
    if (!re.test(src)) {
      console.warn('[lighting] three\'s PCF chunk was not recognised; keeping the stock 5-tap filter');
      return;
    }
    const n = Math.max(5, Math.round(taps));
    THREE.ShaderChunk.shadowmap_pars_fragment = src.replace(re, `shadow = 0.0;
				for ( int ktTap = 0; ktTap < ${n}; ktTap ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( ktTap, ${n}, phi ) * radius, shadowCoord.z ) );
				}
				shadow *= ${(1 / n).toFixed(7)};`);
  } catch (e) {
    console.warn('[lighting] shadow filter patch failed:', e);
  }
}

// ---------------------------------------------------------------------------------------
// THE SHADOW-CASTER DEFAULT.  Read this before touching anything to do with shadows.
//
// three renders a caster's depth pass with the OPPOSITE side to the one the material draws:
// `WebGLShadowMap.getDepthMaterial` does
//
//     result.side = ( material.shadowSide !== null ) ? material.shadowSide : shadowSide[ material.side ];
//
// with `shadowSide = { FrontSide: BackSide, ... }`. That is an acne dodge for closed solids,
// and it is catastrophic here: every kart panel, cat, foliage card, sign, kerb and roof in
// this game is an open, single-sided shell with no back faces pointing at the sun, so with
// BackSide it writes NOTHING into the depth map. Measured on the gridStart fit: 81.9 % of the
// 2048^2 map still at the cleared depth of 1.0 while the shadow pass was submitting 1.35 M
// triangles. The karts were, literally, not occluders.
//
// The old cure was to walk the scene every 30 frames and set `shadowSide = FrontSide` on the
// materials found. THAT IS WHY THIS DEFECT HAS COME BACK FOUR TIMES. The fix was correct but
// it was a *registration*, and a registration is only as good as the last time it ran:
//
//   * `main.js buildRacerVisuals()` disposes and rebuilds all eight racer rigs — with brand
//     new materials — whenever a race is (re)built, and `setView()` restages the field for
//     every review plate;
//   * the review harness renders only EIGHT frames per view, so a scan on a 30-frame timer
//     usually does not run at all between the rebuild and the screenshot;
//   * so the karts in the shot were, once again, materials nobody had registered — casting
//     nothing — while the code that "fixed" it sat right there looking correct.
//
// Any object created between two scans had the bug. Polling cannot fix that, only shrink the
// window. So the default itself is changed instead: `shadowSide` becomes a prototype accessor
// whose *unset* value is FrontSide. A material is then a correct caster from the instant it is
// constructed, with nothing to register, no scan to have run and no ordering to get right —
// and a material that genuinely wants three's flip (see the closed-solid note below) says so
// explicitly, which is now the only way to get it.
//
// three assigns `this.shadowSide = null` in the Material constructor; that assignment hits the
// setter, stores null, and the getter reports FrontSide. `Material.copy()` and `setValues()`
// go through the same setter, so clones and JSON loads inherit the same rule.
// ---------------------------------------------------------------------------------------

let shadowSideDefaultInstalled = false;

function installShadowSideDefault() {
  if (shadowSideDefaultInstalled) return;
  shadowSideDefaultInstalled = true;
  try {
    const proto = THREE.Material && THREE.Material.prototype;
    if (!proto || Object.getOwnPropertyDescriptor(proto, 'shadowSide')) return;
    Object.defineProperty(proto, 'shadowSide', {
      configurable: true,
      enumerable: true,
      get() {
        const v = this.__ktShadowSide;
        return (v === undefined || v === null) ? THREE.FrontSide : v;
      },
      set(v) { this.__ktShadowSide = v; },
    });
  } catch (e) {
    console.warn('[lighting] shadowSide default not installed; casters may be empty:', e);
  }
}

// ---------------------------------------------------------------------------------------
// Closed-solid detection.
//
// `setupMaterial` forces `shadowSide = FrontSide` because three defaults a FrontSide material's
// depth pass to BackSide, and every kart panel, cat, foliage card and sign here is an open
// single-sided shell with no back faces — with BackSide they write nothing at all and the field
// floats. But that dodge is only *needed* for open shells, and it is actively harmful on a
// closed solid: a sphere that writes its own near surface into the shadow map then compares
// against it, so the whole lit half sits within a bias of its own occluder and the shadow term
// snaps off along a straight chord. That is the razor terminator across the jaffa oranges — a
// 0.28 m sphere cannot survive a bias sized for 0.09 m terrain texels. three's BackSide default
// is exactly right for those: the far surface is a whole diameter deeper, so nothing self-
// shadows and the item still casts correctly.
//
// So: decide per geometry. Weld positions onto a coarse lattice (SphereGeometry and friends
// duplicate their UV-seam vertices, so index equality is not enough) and count how many edges
// are used by only one triangle. A watertight solid has none.
// ---------------------------------------------------------------------------------------

const CLOSED_TRI_LIMIT = 6000;   // terrain chunks and merged building batches are never solids

function isClosedSolid(geo) {
  if (!geo || !geo.isBufferGeometry) return false;
  const ud = geo.userData;
  if (ud.__ktClosed !== undefined) return ud.__ktClosed;
  let closed = false;
  try {
    const pos = geo.attributes && geo.attributes.position, idx = geo.index;
    const tris = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    if (pos && tris >= 4 && tris <= CLOSED_TRI_LIMIT && Number.isInteger(tris)) {
      const weld = new Map(), id = new Int32Array(pos.count);
      const Q = 1e4;    // 0.1 mm lattice — finer than any seam gap, coarser than float noise
      for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
        let v = weld.get(k);
        if (v === undefined) { v = weld.size; weld.set(k, v); }
        id[i] = v;
      }
      const edges = new Map();
      const bump = (a, b) => {
        if (a === b) return;                                  // degenerate (pole fans)
        const k = a < b ? a * 8388608 + b : b * 8388608 + a;
        edges.set(k, (edges.get(k) || 0) + 1);
      };
      for (let t = 0; t < tris; t++) {
        const a = id[idx ? idx.getX(t * 3) : t * 3];
        const b = id[idx ? idx.getX(t * 3 + 1) : t * 3 + 1];
        const c = id[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
        bump(a, b); bump(b, c); bump(c, a);
      }
      let open = 0;
      for (const n of edges.values()) if (n < 2) open++;
      closed = edges.size > 0 && open === 0;
    }
  } catch (e) { closed = false; }
  ud.__ktClosed = closed;
  return closed;
}

const LIT = m => !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial ||
                    m.isMeshPhongMaterial || m.isMeshToonMaterial);

const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * @param {Engine} engine
 * @param {WorldData} world
 * @param {object} sky  state from createSky: { sunDir, palette, envScene }
 */
export function createLighting(engine, world, sky, opts = {}) {
  installShadowSideDefault();
  installFogChunks();
  installIblChunks();
  installShadowChunk(opts.shadowTaps ?? 12);

  const scene = engine.scene, renderer = engine.renderer;
  const pal = sky.palette;

  const shadows = opts.shadows !== false;

  const groundY = world ? world.minH : 0;

  // ---- shared uniforms (the same objects are handed to every patched shader) -----------
  const apUniforms = {
    apSunDir:    { value: new THREE.Vector3(0, 1, 0) },
    apHorizon:   { value: new THREE.Color(0.62, 0.66, 0.72) },
    apZenith:    { value: new THREE.Color(0.34, 0.47, 0.70) },
    apSunTint:   { value: new THREE.Color(1.0, 0.86, 0.66) },
    apDensity:   { value: opts.hazeDensity ?? 0.0016 },
    apFalloff:   { value: opts.hazeFalloff ?? 0.0075 },
    apBase:      { value: groundY },
    apSunAmount: { value: 0.55 },
    // A 1.5 km course never needs the distance fully replaced by haze; capping the mix
    // keeps the far ridge a *ridge* rather than a silhouette-free band of sky.
    apMax:       { value: opts.hazeMax ?? 0.74 },
    // How much of a surface's own chroma the same column of air takes with it. Runs ahead of
    // the haze mix so distance costs colour first and contrast second; see the shader note.
    apDesat:     { value: opts.hazeDesat ?? 0.70 },
    // Split IBL controls — see installIblChunks(). The diffuse term carries the whole shadow
    // fill so it runs hot; the specular one is held down and knee-compressed so a grazing
    // reflection of the sky can never be brighter than sunlit ground.
    ktIblDiffuse: { value: opts.iblDiffuse ?? 1.0 },
    ktIblSpec:    { value: opts.iblSpecular ?? 0.34 },
    ktIblClamp:   { value: opts.iblSpecClamp ?? 0.22 },
    ktIblKnee:    { value: opts.iblSpecKnee ?? 9.0 },
  };

  const shadowMapSize = opts.shadowMapSize ?? 2048;

  // ------------------------------------------------------------------------------------
  // Shadows.
  //
  // This used to run three's CSM addon. It produced a shadow map that *looked* right when
  // dumped, resolved every cascade uniform correctly, and still put no shadow on the ground
  // under anything — because of the failure mode below, which no amount of cascade tuning
  // can reach:
  //
  //   three renders shadow casters with `shadowSide = BackSide` whenever the material is
  //   `FrontSide` (the acne dodge in WebGLShadowMap.getDepthMaterial). Every kart, cat,
  //   item box, sign and foliage card in this game is an open, single-sided shell: it has
  //   no back faces facing the sun, so with BackSide it writes *nothing* into the shadow
  //   map. Probing cascade 0 at a kart's own texel returned depth 1.0 (empty) — the karts
  //   were literally not occluders. Forcing `shadowSide = FrontSide` puts the kart roof in
  //   the map at the right depth, which is the actual fix and is applied by fitShadowSide()
  //   below — to open shells only; see the closed-solid note at the top of the file.
  //
  // With that fixed, three cascades bought nothing but two extra depth passes and a large
  // surface of cascade-selection maths, so the rig is now ONE directional light whose
  // orthographic shadow camera is re-fitted around the player every frame on the stock
  // three lighting path. 2048 px over a ~180 m box is ~0.09 m/texel: a 2 m kart is ~22
  // texels across, which is a real contact shadow rather than a suggestion.
  // ------------------------------------------------------------------------------------

  // Half-width of the shadow box at ground level, in metres. Grows when the camera climbs
  // (the vista plates look down on a lot of landscape); stays tight for the chase camera,
  // where texel density is what sells the contact shadow.
  const shadowExtentNear = opts.shadowExtent ?? 92;
  const shadowExtentFar  = opts.shadowExtentFar ?? 260;
  // How far back along the sun ray the light sits. Has to clear the tallest thing that can
  // stand above the focus point (a cypress, the start gantry, a ridge).
  const lightBack = opts.lightMargin ?? 240;
  // Depth bias in **metres**, converted to the light camera's normalised depth below.
  const biasMetres = opts.shadowBiasMetres ?? 0.020;

  const lightDir = new THREE.Vector3().copy(sky.sunDir).negate(); // from sun toward ground

  // The canonical sun handle other systems read (vegetation.js reads .position/.color).
  const sun = new THREE.DirectionalLight(pal.sunColor.clone(), pal.sunIntensity);
  sun.position.copy(sky.sunDir).multiplyScalar(2000);
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);

  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    // `shadow.radius` is in TEXELS, and the texel is a different size in every view — 0.09 m
    // behind a kart, 0.25 m from the hilltop. A constant radius therefore means a penumbra
    // that is three times wider on the vista than in the chase, which is why the same build
    // showed razor-hard building shadows in one plate and shapeless blobs in another. It is
    // re-derived from `penumbraMetres` in fitShadow() so the softness is a fixed distance on
    // the ground in every frame. The disk rotation is a deterministic function of
    // gl_FragCoord, so screenshots stay reproducible.
    sun.shadow.radius = 3;
  }
  // Half-width of the shadow penumbra on the ground, in metres. The sun's angular diameter
  // puts a real one at ~0.5% of the caster's height above the receiver — 5 cm under a kart,
  // 20 cm under a 4 m olive. Sold here as one constant that reads soft on foliage without
  // dissolving the gantry.
  const penumbraMetres = opts.penumbraMetres ?? 0.26;

  const _lightBasis = new THREE.Matrix4();
  const _lightBasisInv = new THREE.Matrix4();
  const _focus = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _origin = new THREE.Vector3();
  let shadowExtent = shadowExtentNear;

  /**
   * Re-aim the shadow camera at the ground just ahead of the view camera and size its depth
   * range to the box it actually covers, so the normalised bias stays a few centimetres
   * instead of the ~28 cm a 3.5 km light frustum used to cost.
   */
  function fitShadow() {
    if (!shadows) return;
    const cam = engine.camera;
    cam.getWorldDirection(_fwd);

    // Ground under the camera decides how wide to spread the map: a chase camera sits ~3 m
    // up and wants density, a hilltop plate sits 40 m up and wants coverage.
    const camGround = world ? world.heightAt(cam.position.x, cam.position.z) : 0;
    const height = Math.max(0, cam.position.y - (Number.isFinite(camGround) ? camGround : 0));
    shadowExtent = clamp(shadowExtentNear + height * 3.2, shadowExtentNear, shadowExtentFar);

    // Push the focus down the view axis so the box is spent on what is in frame, not on the
    // ground behind the camera.
    _focus.copy(cam.position).addScaledVector(_fwd, shadowExtent * 0.55);
    const gy = world ? world.heightAt(_focus.x, _focus.z) : 0;
    _focus.y = Number.isFinite(gy) ? gy + 2 : cam.position.y;

    // Snap the focus to whole shadow texels in light space, otherwise the map crawls with
    // sub-texel camera motion and every shadow edge shimmers.
    _lightBasis.lookAt(_origin, lightDir, _up);
    _lightBasisInv.copy(_lightBasis).invert();
    const texel = (shadowExtent * 2) / shadowMapSize;
    _focus.applyMatrix4(_lightBasisInv);
    _focus.x = Math.floor(_focus.x / texel) * texel;
    _focus.y = Math.floor(_focus.y / texel) * texel;
    _focus.applyMatrix4(_lightBasis);

    sun.target.position.copy(_focus);
    sun.position.copy(_focus).addScaledVector(lightDir, -lightBack);
    sun.target.updateMatrixWorld();

    const c = sun.shadow.camera;
    c.left = -shadowExtent; c.right = shadowExtent;
    c.top = shadowExtent; c.bottom = -shadowExtent;
    c.near = 1;
    c.far = lightBack + shadowExtent * 2.2;
    c.updateProjectionMatrix();

    const span = c.far - c.near;
    sun.shadow.bias = -(biasMetres / span);
    // Slope term, in metres. It has to cover a texel's worth of depth error on the terrain,
    // which is what `texel` scales it to, but it is also a *lateral* displacement of the
    // lookup, so anything much bigger than the smallest caster in frame walks the sample off
    // that caster entirely. Capped at 11 cm: a kart wheel is 0.5 m across and survives that,
    // and with the wider filter below the terrain no longer needs 16.
    sun.shadow.normalBias = opts.normalBias ?? clamp(1.35 * texel, 0.035, 0.11);
    // Penumbra held at a fixed size *on the ground*, not a fixed number of texels — see the
    // note where shadow.radius is first set.
    sun.shadow.radius = clamp(penumbraMetres / texel, 1.15, 4.6);
  }
  fitShadow();

  // ---- ambient: sky/ground hemisphere + a terra-rossa bounce --------------------------
  // Gains on top of whatever sky.js's palette hands over; see the long note in applyPalette().
  // Sized against the brief at the top of this file: sky + bounce + IBL diffuse together carry
  // about 28 % of what a lit horizontal surface receives, so a cast shadow is worth roughly
  // 1.6 stops. The previous 3.1 put the fill near 36 % — shadows that were present but soft
  // enough that the eye did not use them, which is half of why the field read as floating even
  // in the plates where the shadow map WAS working.
  const SKY_FILL_GAIN   = opts.hemiGain ?? 2.55;
  const SKY_FILL_WARMTH = clamp(opts.hemiWarmth ?? 0.44, 0, 1);
  const BOUNCE_GAIN     = opts.bounceGain ?? 1.95;

  const hemi = new THREE.HemisphereLight(pal.skyAmbient, pal.groundAmbient, pal.hemiIntensity);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  // Light coming *up* off the sun-warmed ground: fills undersides of eaves and canopies.
  const bounce = new THREE.DirectionalLight(pal.bounceColor, pal.bounceIntensity);
  bounce.castShadow = false;
  bounce.position.set(-sky.sunDir.x * 0.35, -1, -sky.sunDir.z * 0.35).normalize().multiplyScalar(-500);
  bounce.target.position.set(0, 0, 0);
  scene.add(bounce, bounce.target);

  // ---- scene fog (stock fallback for anything we do not adopt) -------------------------
  const fog = new THREE.FogExp2(pal.horizon.clone(), opts.fogDensity ?? 0.00055);
  scene.fog = fog;

  // ---- image-based lighting ------------------------------------------------------------
  let pmrem = null, envRT = null, envMap = null;
  function buildEnv() {
    if (opts.env === false || !sky.envScene) return null;
    try {
      if (!pmrem) { pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileCubemapShader?.(); }
      const next = pmrem.fromScene(sky.envScene, 0.0, 1, 2000);
      envRT?.texture?.dispose?.(); envRT?.dispose?.();
      envRT = next; envMap = next.texture;
      scene.environment = envMap;
      // The dome already renders in exposed units (sky.uExposure), so the IBL lands at a
      // sane fraction of the sun without any extra normalisation.
      // Sky IBL is the other half of the ambient-fill problem. It was pulled down to 0.35
      // because raising it washed the shaded side of everything out — but what was actually
      // washing out was the *specular* lobe, which is unshadowed, grazing-angle heavy and, on
      // the road's smoother repair patches, brighter than sunlit tarmac. Now that diffuse and
      // specular have separate controls (installIblChunks), the diffuse half can carry the
      // shadow fill it is supposed to carry while the reflection stays bolted down.
      scene.environmentIntensity = opts.envIntensity ?? 0.70;
      return envMap;
    } catch (e) {
      console.warn('[lighting] environment map generation failed:', e);
      return null;
    }
  }

  // ---- material adoption ---------------------------------------------------------------
  const adopted = new Set();

  function shaderMaterialWants(mat) {
    // Opt a custom ShaderMaterial in only when its source actually includes the chunk we
    // rewrote — otherwise the define would reference uniforms it never declares.
    const vs = mat.vertexShader || '', fs = mat.fragmentShader || '';
    return {
      ap: vs.includes('project_vertex') && vs.includes('fog_vertex') && fs.includes('fog_fragment'),
    };
  }

  function setupMaterial(mat) {
    if (!mat || mat.isSpriteMaterial || mat.isPointsMaterial || mat.isLineBasicMaterial ||
        mat.isLineDashedMaterial || mat.isShadowMaterial) return;

    let wantAP = LIT(mat) || !!mat.isMeshBasicMaterial;
    if (mat.isShaderMaterial || mat.isRawShaderMaterial) {
      wantAP = mat.isRawShaderMaterial ? false : shaderMaterialWants(mat).ap;
    }

    // The shadowSide decision used to live here, blind to geometry, and forced FrontSide on
    // everything. It now needs to know whether the mesh is an open shell or a closed solid,
    // so it moved to fitShadowSide() in the scan below, which sees the mesh.

    if (!wantAP) return;

    const ud = mat.userData;
    if (ud.__ktLightFn && mat.onBeforeCompile === ud.__ktLightFn) return; // already ours, untouched

    // Compose with whatever hook is installed right now (ours from a previous pass excluded).
    const prev = (mat.onBeforeCompile && mat.onBeforeCompile !== ud.__ktLightFn)
      ? mat.onBeforeCompile : (ud.__ktLightPrev || null);
    ud.__ktLightPrev = prev;

    const fn = function (shader, r) {
      ud.__ktLightPrev?.call(this, shader, r);
      Object.assign(shader.uniforms, apUniforms);
    };
    ud.__ktLightFn = fn;
    mat.onBeforeCompile = fn;

    mat.defines = mat.defines || {};
    mat.defines.AERIAL_PERSPECTIVE = '';
    // Legacy CSM defines from an earlier rig would now reference uniforms nothing supplies.
    delete mat.defines.USE_CSM; delete mat.defines.CSM_CASCADES; delete mat.defines.CSM_FADE;
    mat.needsUpdate = true;
    adopted.add(mat);
  }

  // Landscape self-shadowing is most of what sells a low sun, but terrain systems often
  // ship with castShadow off (it costs nothing when the sun is overhead). Opt them in here,
  // where the lighting decision belongs; `terrainShadows: false` restores their choice.
  const terrainShadows = opts.terrainShadows !== false;
  const TERRAIN_RE = /terrain|ground|hill|apron|plateau/i;

  // The other half of the missing-contact-shadow bug. Whether a surface RECEIVES shadow is a
  // lighting decision, but it is spelled per mesh in a dozen other modules, and the ones that
  // matter most had it off: `circuit:grid` (the slabs the eight karts sit on at the start),
  // `circuit:startline` (the black-and-white checker in photoFinish), `terrain-apron`. Karts
  // were casting into a surface that had opted out of being lit by the result, so the whole
  // field floated even once the casters were fixed. Anything with a lit material and a sun in
  // the sky receives; unlit chrome — the sky dome, additive VFX, sprites — is left alone.
  const receiveAll = opts.receiveShadows !== false;

  /**
   * Which side of a caster goes into the depth map.
   *
   * THIS IS THE FUNCTION THAT EMPTIED THE SHADOW MAP. Leaving `shadowSide` at `null` hands the
   * caster to three's acne dodge, which renders a FrontSide material's depth pass with BACK
   * faces only — and in this scene that writes nothing at all for most of the world. Measured
   * directly by sampling `sun.shadow.map.depthTexture` with a sampler2DShadow ramp over the
   * gridStart fit: **81.9 % of the 2048² map was still at the cleared depth of 1.0**, i.e. no
   * occluder, while the shadow pass was submitting 1.35 M triangles in 366 draw calls — they
   * were all being back-face culled. Forcing FrontSide (or DoubleSide) on every caster took the
   * empty fraction to 0.0 %. That single flag is why a fifteen-metre pine, a start gantry, a
   * hay bale, a house and eight karts all cast nothing onto ground that was demonstrably
   * receiving: verified with a 14 m debug cube dropped on the start straight with
   * castShadow = true, which cast no shadow before this change.
   *
   * The BackSide branch is still right for the case it was written for — a small closed solid
   * like a jaffa orange, whose near surface sits within a bias of itself and snaps the terminator
   * along a straight chord. But that argument only holds while the solid is small enough that
   * near and far surfaces are a bias apart. Above that it is the difference between an occluder
   * and no occluder, so the size gate below decides: sub-metre closed solids keep three's
   * default, everything else writes its front faces and is actually in the map.
   */
  const SOLID_BACKSIDE_RADIUS = 0.9;   // metres; a jaffa is 0.28, a hay bale 0.9, a kart 1.4

  function fitShadowSide(mesh, mat) {
    if (!shadows || !mat || mat.isShadowMaterial) return;
    const ud = mat.userData;
    // `installShadowSideDefault()` has already made FrontSide the answer for every material in
    // the game, so this pass can only ever *downgrade* a small closed solid to three's flip.
    // That inversion is the point: if this scan never runs — a rig built between two scans, a
    // material swapped mid-race — the caster is still correct, and the worst that can happen
    // is a little self-shadow acne on a jaffa. It used to be the difference between an
    // occluder and no occluder at all, which is why the defect kept coming back.
    if (ud.__ktSideFitted) return;
    ud.__ktSideFitted = true;
    if (isSmallClosedSolid(mesh)) mat.shadowSide = THREE.BackSide;
  }

  /** Closed AND small enough that its far surface is only a bias deeper than its near one. */
  function isSmallClosedSolid(mesh) {
    const geo = mesh && mesh.geometry;
    if (!geo || !isClosedSolid(geo)) return false;
    if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch (e) { return false; } }
    const r = geo.boundingSphere ? geo.boundingSphere.radius : Infinity;
    const m = mesh.matrixWorld.elements;
    // Largest column length of the world matrix — the mesh's biggest axis scale.
    const s = Math.sqrt(Math.max(
      m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
      m[4] * m[4] + m[5] * m[5] + m[6] * m[6],
      m[8] * m[8] + m[9] * m[9] + m[10] * m[10])) || 1;
    return r * s <= SOLID_BACKSIDE_RADIUS;
  }

  let dirty = false;
  function scan(root = scene) {
    root.traverse(o => {
      if (o.isMesh) {
        // Opt terrain in FIRST: fitShadowSide() only looks at meshes that already cast, so
        // doing this second left the landscape a caster with an unfitted shadowSide for a
        // whole scan interval.
        if (terrainShadows && o.receiveShadow && !o.castShadow && TERRAIN_RE.test(o.name)) {
          o.castShadow = true; dirty = true;
        }
        if (o.castShadow) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of ms) fitShadowSide(o, mm);
        }
        if (receiveAll && shadows && !o.receiveShadow) {
          // Every mesh drawn with a lit material opts in, transparent ones included. three
          // uploads `receiveShadow` as a *program* uniform but only re-sends it when the
          // material it is drawing changes, so a single non-receiving mesh sharing a program
          // with the road leaves the flag false for everything drawn after it and the shadow
          // term silently disappears from the whole frame. Making the flag uniformly true
          // removes that coupling as well as the intended per-mesh omissions.
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          if (ms.some(mm => mm && LIT(mm))) { o.receiveShadow = true; dirty = true; }
        }
      }
      const m = o.material; if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) { const b = adopted.has(mm); setupMaterial(mm); if (!b) dirty = true; } }
      else { const b = adopted.has(m); setupMaterial(m); if (!b) dirty = true; }
    });
  }

  // ---- sun / palette application --------------------------------------------------------
  function applyPalette() {
    lightDir.copy(sky.sunDir).negate().normalize();
    sun.position.copy(sky.sunDir).multiplyScalar(2000);
    sun.color.copy(pal.sunColor);
    sun.intensity = pal.sunIntensity;
    // ---- shadow fill ------------------------------------------------------------------
    // Everything a surface out of the sun receives comes from these three terms plus the IBL,
    // and measured against the frame they were nowhere near enough: with the sun switched off
    // in itemChaos, lit terra rossa fell from luma 100 to 6 — a shaded diffuse surface was
    // getting 6% of a lit one, so 10% of gridStart sat below luma 12 and the winery hoarding,
    // the spectator cats and the wall behind them collapsed onto one flat blue-black. A real
    // dry Mediterranean afternoon puts sky+bounce at roughly a third of the direct beam, and
    // MK8 pushes further still: its shadows stay open and keep their local hue.
    //
    // The hue matters as much as the level. `pal.skyAmbient` is close to cyan, so what little
    // fill there was arrived heavily blue — the shadows did not just go dark, they went dark
    // AND lost their material identity. The sky term keeps its cool cast but is pulled part of
    // the way to the sun's own colour, and the warm ground/bounce terms are lifted alongside
    // it so shaded stone stays stone-coloured.
    hemi.color.copy(pal.skyAmbient).lerp(pal.sunColor, SKY_FILL_WARMTH);
    hemi.groundColor.copy(pal.groundAmbient);
    hemi.intensity = pal.hemiIntensity * SKY_FILL_GAIN;
    bounce.color.copy(pal.bounceColor);
    bounce.intensity = pal.bounceIntensity * BOUNCE_GAIN;
    bounce.position.set(-sky.sunDir.x * 0.35, -1, -sky.sunDir.z * 0.35).normalize().multiplyScalar(-500);

    apUniforms.apSunDir.value.copy(sky.sunDir);
    apUniforms.apHorizon.value.copy(pal.horizon);
    apUniforms.apZenith.value.copy(pal.zenith);
    apUniforms.apSunTint.value.copy(pal.hazeSun);
    apUniforms.apDensity.value = pal.hazeDensity;
    apUniforms.apSunAmount.value = pal.hazeSunAmount;
    fog.color.copy(pal.horizon);
    dirty = true;
  }
  applyPalette();

  // ---- contact shadows -------------------------------------------------------------------
  //
  // A shadow map can only ever darken the ground *behind* an occluder. What sells a kart as
  // standing on the road is the little wedge of near-black right where rubber meets tarmac —
  // the ambient occlusion of a 1 m box sitting on a plane, which no directional shadow map
  // resolves at any sun angle — and at this course's 53 deg sun the map's own cast shadow is
  // only ~0.75 of the kart's height long, so nearly all of it hides under the chassis anyway.
  // MK8 draws an explicit soft blob under every kart, and so does this. It is deliberately
  // redundant with the cast shadow: two independent mechanisms anchor the field, so a
  // regression in either one still leaves the karts on the ground.
  //
  // TWO THINGS KEPT THIS INVISIBLE, and both were geometry, not tuning.
  //
  // 1. IT WAS BURIED IN THE ROAD. The pool was placed at the racer root's world Y plus 3 cm,
  //    on the assumption that the root sits on the surface the kart is driving on. It does
  //    not: measured across three canonical views the racer roots sit 0.06-0.20 m above the
  //    raw heightfield, while `trackMesh` builds the racing surface with a 8.5 cm parabolic
  //    CROWN on top of the track spline, plus banking, plus whatever grading the ribbon
  //    carries over raw terrain. So on most of the course the pool was a few centimetres
  //    UNDER the tarmac and lost the depth test outright. Proved directly: rendering the same
  //    frame with `depthTest = false` puts the pool back on screen, with nothing else changed.
  //    It is now lifted by `contactLift` (12 cm — clears the crown and normal grading) and
  //    carries a polygon offset strictly stronger than anything trackMesh uses (the tarmac is
  //    -5/-14, its decals -8/-16), so neither the crown nor a banked corner can swallow it.
  //
  // 2. IT WAS THE WRONG SHAPE. A symmetric pool the size of the kart's own footprint is drawn
  //    almost entirely into pixels the kart already occludes — a chase camera sits a metre up
  //    and behind, so the ground *under* a kart is exactly what it cannot see. What has to be
  //    visible is the part that spills OUTSIDE the silhouette, and that is also where the real
  //    shadow goes, so the pool is now anisotropic: a tight AO core under the chassis with
  //    four tyre-contact lobes, plus a soft lobe stretched and offset down-sun, which puts
  //    darkness on open road in every frame regardless of which way the kart is pointing.
  //
  // One InstancedMesh, black over the road so it darkens the surface's own texture instead of
  // painting grey over it. The texture is authored in the pool's own frame with +Y = down-sun.
  const contact = (() => {
    if (opts.contactShadows === false) return null;
    try {
      const S = 128;
      const mk = (paint) => {
        const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
        if (!cv) return null;
        cv.width = cv.height = S;
        const c = cv.getContext('2d');
        const img = c.createImageData(S, S);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
          // The alpha is windowed to exactly zero at the border: a quad edge carrying even 4 %
          // over tarmac reads as a printed rectangle, and that straight line is the "hard-edged
          // slab behind the kart" this project keeps re-filing.
          const win = (1 - smoothstep01(0.62, 1.0, Math.abs(dx))) * (1 - smoothstep01(0.62, 1.0, Math.abs(dy)));
          const i = (y * S + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
          img.data[i + 3] = Math.round(255 * clamp(paint(dx, dy) * win, 0, 1));
        }
        c.putImageData(img, 0, 0);
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        // NO MIPMAPS. A mip chain averages the border ramp away — by level 4 the border and the
        // centre are within a few percent — and a chase camera, which sees this quad at a
        // grazing angle and therefore picks a coarse mip, would get back the flat translucent
        // square with four straight edges the window above exists to prevent.
        t.minFilter = t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        return t;
      };

      /** Smooth elliptical lobe, 1 at the centre, 0 at d = 1 + soft. */
      const lobe = (dx, dy, rx, ry, soft) => {
        const d = Math.sqrt((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry));
        const t = 1 - clamp((d - (1 - soft)) / (2 * soft), 0, 1);
        return t * t * (3 - 2 * t);
      };

      // --- A: the AO core, in the KART's frame (x across, y along) -------------------------
      const WX = 0.44, WY = 0.34;                       // wheel centres in pool space
      // The core has to have a genuinely dark HEART, not just a soft field. Over tarmac at
      // display luma ~0.33 a broad 40 % pool only takes the road to 0.20, and that step is too
      // small to read at speed — the kart looks like it is hovering over a slightly dirty
      // patch. A tight, dense chassis lobe with four denser tyre lobes inside it gives the eye
      // an edge to find, and the wide halo then keeps it from looking like a printed sticker.
      const coreTex = mk((dx, dy) => {
        let occ = 1 - lobe(dx, dy, 0.86, 0.92, 0.98) * 0.34;     // wide halo
        occ *= 1 - lobe(dx, dy, 0.46, 0.54, 0.62) * 0.88;        // chassis
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          occ *= 1 - lobe(dx - sx * WX, dy - sy * WY, 0.19, 0.15, 0.80);   // tyre contact
        }
        return 1 - occ;
      });

      // --- B: the soft cast lobe, in the SUN's ground frame (y = down-sun) -----------------
      // Tapered: dense where it leaves the tyres, feathering out down-sun, so it reads as a
      // thrown shadow rather than a stamped oval. Its length follows the real sun elevation
      // (see `reach` in update), so it is a short tail at this course's 53 deg midday sun and
      // a long one if the time of day is ever wound back toward golden hour.
      const castTex = mk((dx, dy) => {
        const t = (dy + 1) * 0.5;                       // 0 at the kart, 1 at the far end
        const wid = 0.62 - 0.16 * t;                    // narrows as it runs away
        const a = lobe(dx, dy * 0.92 - 0.06, wid, 0.96, 0.55);
        return a * (0.92 - 0.42 * t * t);
      });
      if (!coreTex || !castTex) return null;

      const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const MAX = opts.contactMax ?? 24;

      // Black over the road, so the pool darkens the surface's own aggregate instead of
      // painting flat grey on top of it.
      //
      // The polygon offset is the important number here, and it is deliberately stronger than
      // anything `trackMesh.js` uses (tarmac -5/-14, road decals -8/-16, boost pads -8/-16).
      // The pool has to win against the racing surface at every banking angle and over the
      // 8.5 cm road crown; losing that contest is what made it invisible for four rounds.
      const makeMat = (map, op) => new THREE.MeshBasicMaterial({
        map, color: 0x000000, transparent: true, opacity: op,
        depthWrite: false, fog: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -18, polygonOffsetUnits: -72,
      });
      const mkMesh = (map, op, name, order) => {
        const m = new THREE.InstancedMesh(geo, makeMat(map, op), MAX);
        m.name = name;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
        // Above every transparent piece of road dressing — skid decals (5), grid slabs (6) and
        // boost pads (8) are all drawn after the opaque pass and would otherwise paint over the
        // shadow — and below the additive VFX, which belong on top of everything.
        m.renderOrder = order; m.count = 0;
        m.userData.__ktContact = true;
        scene.add(m);
        return m;
      };
      // Cast lobe first so the AO core lands on top of it where they overlap.
      const castMesh = mkMesh(castTex, opts.castStrength ?? 0.66, 'lighting:contactCast', 9);
      const mesh = mkMesh(coreTex, opts.contactStrength ?? 0.90, 'lighting:contact', 10);

      // How far the pool sits above the racer root. Not cosmetic: `trackMesh` crowns the
      // racing surface by 8.5 cm over the track spline and the ribbon is graded over raw
      // terrain, while the racer roots measure only 0.06-0.20 m above the heightfield — so a
      // 3 cm lift put the pool inside the tarmac on most of the course.
      const LIFT = opts.contactLift ?? 0.12;

      const targets = [];
      const restY = new WeakMap();      // racer -> { y, x, z } resting reference, see update()
      const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
      const _n = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
      const _m = new THREE.Matrix4();
      const _basis = new THREE.Matrix4();
      const _sunFwd = new THREE.Vector3(), _sunRt = new THREE.Vector3();
      const _cFw = new THREE.Vector3(), _cRt = new THREE.Vector3();

      /**
       * Refresh the target list.
       *
       * THIS RUNS EVERY FRAME, and that is not laziness — it is the fix. `main.js`
       * `buildRacerVisuals()` destroys and rebuilds all eight rigs whenever a race is built,
       * and the review harness renders only eight frames per view, so a list rebuilt on a
       * 30-frame timer is stale exactly when a screenshot is taken. Racer rigs are added
       * straight to the scene root, so the fast path is a loop over `scene.children` — about
       * thirty entries — and the deep traverse is only used as a fallback when that finds
       * nothing, which keeps it correct even if somebody nests a rig later.
       */
      function collect() {
        targets.length = 0;
        for (const o of scene.children) {
          if (targets.length >= MAX) break;
          if (!/^racer:/.test(o.name || '')) continue;
          if (o.userData && o.userData.contactShadow === false) continue;
          targets.push(o);
        }
        if (targets.length) return;
        scene.traverse(o => {
          if (targets.length >= MAX) return;
          if (o.userData && o.userData.contactShadow === false) return;
          if (/^racer:/.test(o.name || '')) targets.push(o);
        });
      }

      function update() {
        collect();
        if (!targets.length) { mesh.count = 0; castMesh.count = 0; return; }
        // Ground-projected sun direction: the axis the cast lobe is laid along.
        _sunFwd.set(lightDir.x, 0, lightDir.z);
        if (_sunFwd.lengthSq() < 1e-6) _sunFwd.set(0, 0, 1); else _sunFwd.normalize();
        _sunRt.set(-_sunFwd.z, 0, _sunFwd.x);
        // How long the lobe runs: a 1.1 m tall kart with the sun at elevation e throws
        // 1.1 / tan(e). Bounded so a low sun does not paint a runway.
        const tanEl = Math.max(0.28, Math.abs(sky.sunDir.y) /
          Math.max(1e-3, Math.hypot(sky.sunDir.x, sky.sunDir.z)));
        const reach = clamp(1.15 / tanEl, 1.2, 3.4);

        let n = 0;
        for (const o of targets) {
          if (!o.visible || !o.parent) continue;
          o.getWorldPosition(_p);
          // The heightfield is only a sanity reference: the track ribbon is graded and can sit
          // a metre above raw terrain, so `heightAt` alone cannot place or gate the pool.
          const gy = world ? world.heightAt(_p.x, _p.z) : _p.y;
          const airTerrain = Number.isFinite(gy) ? Math.max(0, _p.y - gy) : 0;
          // ...and it cannot decide whether a kart is airborne either, because a graded corner
          // or a bridged culvert puts the ribbon several metres over raw terrain and every kart
          // driving over it would silently lose its shadow. Track a per-racer resting height:
          // it snaps down the moment the kart is lower than the reference and creeps up slowly,
          // so a jump reads as air while a climb does not. Airborne means BOTH measures agree.
          //
          // The reference needs a TELEPORT guard. `setView()` re-stages the field with
          // packAt()/simulate(): every kart jumps to a different part of the course between two
          // rendered frames, often tens of metres lower, and the creep would need drop/0.045
          // frames to catch up — several seconds of "this kart is 30 m in the air". A jump moves
          // a kart a couple of metres per frame at most, so a horizontal step over 6 m is a
          // re-stage, not a jump: re-seat the reference on the spot.
          const st = restY.get(o);
          const staged = !st || Math.abs(_p.x - st.x) + Math.abs(_p.z - st.z) > 6;
          const ref = staged ? _p.y
            : (_p.y < st.y ? _p.y : Math.min(_p.y, st.y + 0.045));
          restY.set(o, { y: ref, x: _p.x, z: _p.z });
          const air = staged ? 0 : Math.min(airTerrain, Math.max(0, _p.y - ref));
          // A kart in the air has no contact to occlude: the pool widens and fades, then is
          // dropped once it would only be a smudge.
          if (air > 2.4) continue;
          const grow = 1 + Math.min(0.9, Math.max(0, air - 1.1) * 0.6);
          const y = _p.y + LIFT;

          // --- A: AO core, kart-aligned so the tyre lobes land on the tyres ---------------
          o.getWorldQuaternion(_q);
          _n.set(0, 1, 0).applyQuaternion(_q);
          if (!Number.isFinite(_n.x) || _n.lengthSq() < 1e-6) _n.set(0, 1, 0); else _n.normalize();
          _fw.set(0, 0, 1).applyQuaternion(_q);
          _fw.addScaledVector(_n, -_fw.dot(_n));
          if (_fw.lengthSq() < 1e-6) _fw.set(0, 0, 1); else _fw.normalize();
          _rt.crossVectors(_n, _fw).normalize();
          _basis.makeBasis(_rt, _n, _fw);
          _basis.setPosition(_p.x, y, _p.z);
          _s.set(2.55 * grow, 1, 3.20 * grow);
          _m.copy(_basis).scale(_s);
          mesh.setMatrixAt(n, _m);

          // --- B: cast lobe, sun-aligned and pushed down-sun so it clears the silhouette ---
          // Laid in the plane the kart is standing on, not the world horizontal: this quad is
          // nearly four metres long, so on a banked corner or a 10 % climb a world-flat one
          // buries its far end in the road and the shadow stops halfway.
          _cFw.copy(_sunFwd).addScaledVector(_n, -_sunFwd.dot(_n));
          if (_cFw.lengthSq() < 1e-6) _cFw.copy(_fw); else _cFw.normalize();
          _cRt.crossVectors(_n, _cFw).normalize();
          _basis.makeBasis(_cRt, _n, _cFw);
          _basis.setPosition(
            _p.x + _cFw.x * reach * 0.46,
            y + _cFw.y * reach * 0.46 - 0.004,
            _p.z + _cFw.z * reach * 0.46);
          _s.set(2.05 * grow, 1, (2.0 + reach) * grow);
          _m.copy(_basis).scale(_s);
          castMesh.setMatrixAt(n, _m);

          n++;
        }
        mesh.count = n; castMesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        castMesh.instanceMatrix.needsUpdate = true;
      }

      return { mesh, castMesh, collect, update, get count() { return mesh.count; } };
    } catch (e) {
      console.warn('[lighting] contact shadows unavailable:', e);
      return null;
    }
  })();

  // ---- frame loop -----------------------------------------------------------------------
  const lastCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
  const lastCamQuat = new THREE.Quaternion(9, 9, 9, 9);
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated in this three build and silently downgrades; ask for the
  // supported filter directly so the console stays clean and the look is predictable.
  if (renderer.shadowMap.type === THREE.PCFSoftShadowMap) renderer.shadowMap.type = THREE.PCFShadowMap;
  // One depth pass instead of three, so it can be redrawn whenever the fit actually moves
  // rather than on a timer. `lazyShadows` still skips the pass on frames where neither the
  // camera nor the scene changed.
  renderer.shadowMap.autoUpdate = false;
  let frame = 0;
  // Cheap structural fingerprint of the scene root. Racer rigs, item props, the VFX group and
  // every other system's root are all direct children of the scene, so a change here means
  // something was created, swapped or destroyed — which is precisely when material adoption,
  // receiveShadow and caster registration have to be redone. Polling on a 30-frame timer left
  // a window of up to half a second in which brand-new geometry was unregistered, and the
  // review harness renders eight frames per plate, so that window WAS the screenshot. See the
  // long note by installShadowSideDefault().
  const sceneStamp = () => {
    let k = scene.children.length * 131;
    for (let i = 0; i < scene.children.length; i++) k += scene.children[i].id;
    return k;
  };
  let lastStamp = -1;

  const system = {
    update(dt) {
      const stamp = sceneStamp();
      if (stamp !== lastStamp || (frame % 30) === 0) { lastStamp = stamp; scan(); }
      frame++;
      contact?.update();
      const cam = engine.camera;
      const moved = cam.position.distanceToSquared(lastCamPos) > 2.5e-3 ||
                    Math.abs(cam.quaternion.dot(lastCamQuat)) < 0.99999;
      // The shadow box follows the camera, so a moved camera means a new fit AND a new map;
      // karts and items move every frame regardless, which is why this also refreshes on a
      // short timer when nothing else changed.
      if (moved || dirty || (frame % 3) === 0) {
        fitShadow();
        renderer.shadowMap.needsUpdate = true;
      }
      if (moved) { lastCamPos.copy(cam.position); lastCamQuat.copy(cam.quaternion); }
      dirty = false;
    },
    resize() { fitShadow(); dirty = true; },
  };
  engine.add(system);


  scan();
  contact?.collect();
  const env = buildEnv();

  const api = {
    sun, hemi, bounce, fog,
    csm: null,               // the CSM rig is gone; kept null so sky.js's handle stays valid
    envMap: env,
    apUniforms,
    setupMaterial,
    scan,
    contact,
    /** Re-read sky.palette / sky.sunDir after a time-of-day change. */
    refresh(rebuildEnv = true) {
      applyPalette();
      fitShadow();
      if (rebuildEnv) api.envMap = buildEnv();
      // Nothing to recompile: every patched shader holds the *same* uniform objects.
    },
    dispose() {
      sun.shadow?.dispose?.();
      envRT?.dispose?.(); pmrem?.dispose?.();
    },
    update: system.update,
  };
  engine.lighting = api;   // discovery hook for other systems (no engine.js edit needed)
  return api;
}
