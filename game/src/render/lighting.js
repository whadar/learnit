import * as THREE from 'three';
import { clamp, lerp as lerpN } from '../core/mathx.js';

/**
 * Lighting rig for Kat Racing: a camera-fitted sun shadow, sky IBL and physically flavoured
 * aerial perspective. Driven by `src/world/sky.js` (which owns the atmosphere itself).
 *
 *   const lighting = createLighting(engine, world, skyState);
 *
 * The rig patches materials so that (a) they cast their FRONT faces into the shadow map —
 * see the long note by `fitShadow()`, it is why anything has a contact shadow at all — and
 * (b) fog becomes a height-aware, sun-tinted aerial-perspective term. Patching composes with any
 * `onBeforeCompile` another system already installed, and is re-applied automatically if
 * somebody overwrites it later, so parallel systems cannot silently break each other.
 *
 * Materials are adopted automatically for the built-in mesh material types. A system that
 * uses a custom ShaderMaterial can opt in explicitly with `lighting.setupMaterial(mat)`.
 */

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
    apMax:       { value: opts.hazeMax ?? 0.62 },
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
  const SKY_FILL_GAIN   = opts.hemiGain ?? 3.1;
  const SKY_FILL_WARMTH = clamp(opts.hemiWarmth ?? 0.42, 0, 1);
  const BOUNCE_GAIN     = opts.bounceGain ?? 2.2;

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
   * Which side of a caster goes into the depth map. Open shells (karts, cats, foliage cards,
   * signage) must write their FRONT faces or they write nothing; closed solids keep three's
   * BackSide default so they cannot self-shadow. A material shared between the two takes the
   * FrontSide branch, because a missing occluder is worse than a soft self-shadow.
   */
  function fitShadowSide(mesh, mat) {
    if (!shadows || !mat || mat.isShadowMaterial) return;
    const ud = mat.userData;
    if (ud.__ktShadowAuthored === undefined) ud.__ktShadowAuthored = mat.shadowSide != null;
    if (ud.__ktShadowAuthored) return;                 // the material's owner chose; respect it
    if (!ud.__ktOpenShell && !isClosedSolid(mesh.geometry)) ud.__ktOpenShell = true;
    const want = ud.__ktOpenShell ? THREE.FrontSide : null;
    if (mat.shadowSide !== want) mat.shadowSide = want;   // read per draw; no recompile needed
  }

  let dirty = false;
  function scan(root = scene) {
    root.traverse(o => {
      if (o.isMesh) {
        if (o.castShadow) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of ms) fitShadowSide(o, mm);
        }
        if (terrainShadows && o.receiveShadow && !o.castShadow && TERRAIN_RE.test(o.name)) {
          o.castShadow = true; dirty = true;
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
  // resolves at this sun angle (elevation 53 deg puts the cast shadow almost entirely under
  // the chassis, and the canonical views all look within ~30 deg of the sun's azimuth). MK8 draws it as an explicit soft blob under every kart and so does this.
  //
  // The previous pool was the size of the kart's own footprint — 2.3 x 3.0 m — and that is
  // exactly why it never appeared in a frame. A chase or photo-finish camera sits about a
  // metre above the road: the ground directly beneath a kart is entirely hidden by the kart,
  // so a pool that stops at the silhouette is drawn into pixels the kart already occludes.
  // Toggling it on and off in photoFinish changed 1041 pixels out of 921600, all of them
  // slivers off to one side — the karts might as well have had no contact shadow, which is
  // what three critics reported. What has to be visible is the ring OUTSIDE the silhouette:
  // the darkening that spills past the tyres and out behind the rear axle, which is the part
  // of the ground the camera can actually see.
  //
  // So the pool is 2.95 x 3.85 m over a kart that is about 1.5 x 2.1 m, and it is not an
  // ellipse: four tight tyre-contact lobes at the wheels, a broad chassis lobe between them
  // and a wide low-density halo, unioned. The tyre lobes are what read as rubber touching
  // tarmac; the halo is what survives a grazing camera.
  //
  // One InstancedMesh, black over the road so it darkens the surface's own texture instead of
  // painting grey over it, lifted 3 cm and polygon-offset so it never z-fights, pulled a
  // little down-sun so it reads as anchored to the light rather than stamped.
  const contact = (() => {
    if (opts.contactShadows === false) return null;
    try {
      const S = 128, cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
      if (!cv) return null;
      cv.width = cv.height = S;
      const c = cv.getContext('2d');
      const img = c.createImageData(S, S);
      // Normalised half-extents: x across the kart, y along it. 1.0 == the pool's own edge.
      const lobe = (dx, dy, rx, ry, soft) => {
        const d = Math.sqrt((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry));
        const t = 1 - Math.min(1, Math.max(0, (d - (1 - soft)) / (2 * soft)));
        return t * t * (3 - 2 * t);
      };
      const WX = 0.44, WY = 0.35;                       // wheel centres in pool space
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
        let occ = 1 - lobe(dx, dy, 0.90, 0.94, 0.98) * 0.34;      // wide halo
        occ *= 1 - lobe(dx, dy, 0.50, 0.58, 0.72) * 0.72;         // chassis
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          occ *= 1 - lobe(dx - sx * WX, dy - sy * WY, 0.21, 0.17, 0.85);   // tyre contact
        }
        // The halo still carries a few percent of alpha at the quad's corners, and a quad edge
        // at 4% over tarmac is a visible straight line — the pool reads as a printed rectangle.
        // Window it to exactly zero at the border.
        const win = (1 - smoothstep01(0.66, 1.0, Math.abs(dx))) * (1 - smoothstep01(0.66, 1.0, Math.abs(dy)));
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        img.data[i + 3] = Math.round(255 * Math.min(1, (1 - occ) * win));
      }
      c.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;

      const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0x000000, transparent: true, opacity: opts.contactStrength ?? 0.80,
        depthWrite: false, fog: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
      });
      const MAX = opts.contactMax ?? 24;
      const mesh = new THREE.InstancedMesh(geo, mat, MAX);
      mesh.name = 'lighting:contact';
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
      // Above the transparent road dressing — the grid slabs (6) and the skid decals (5) are
      // drawn after opaque geometry and would otherwise paint straight over the pool — and
      // below the boost pads and the additive VFX, which belong on top of everything.
      mesh.renderOrder = 7; mesh.count = 0;
      mesh.userData.__ktContact = true;
      scene.add(mesh);

      const targets = [];
      const restY = new WeakMap();      // racer -> smoothed resting height, see update()
      const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
      const _n = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
      const _m = new THREE.Matrix4();
      const _basis = new THREE.Matrix4();

      function collect() {
        targets.length = 0;
        scene.traverse(o => {
          if (targets.length >= MAX) return;
          if (o.userData && o.userData.contactShadow === false) return;
          if (/^racer:/.test(o.name || '')) targets.push(o);
        });
      }

      function update() {
        if (!targets.length) return;
        let n = 0;
        for (const o of targets) {
          if (!o.visible || !o.parent) continue;
          o.getWorldPosition(_p);
          // `createRacer` builds each rig with its wheels on the ground at local y = 0, so the
          // root's world Y *is* the contact height. The heightfield is only a sanity reference
          // here: the track ribbon is graded and can sit a metre above raw terrain, and putting
          // the pool on `heightAt` buries it under the road.
          const gy = world ? world.heightAt(_p.x, _p.z) : _p.y;
          const airTerrain = Number.isFinite(gy) ? Math.max(0, _p.y - gy) : 0;
          // ...but the heightfield ALONE cannot decide whether a kart is airborne, because a
          // graded corner or a bridged culvert can put the ribbon several metres over raw
          // terrain, and every kart driving over it would silently lose its contact shadow.
          // Track a per-racer resting height instead: it snaps down the moment the kart is
          // lower than the reference and creeps up slowly, so a jump reads as air while a
          // climb does not. Airborne means BOTH measures agree.
          let ref = restY.get(o);
          ref = (ref === undefined || _p.y < ref) ? _p.y : Math.min(_p.y, ref + 0.045);
          restY.set(o, ref);
          const air = Math.min(airTerrain, Math.max(0, _p.y - ref));
          // A kart in the air has no contact to occlude: the pool widens, then is dropped once
          // it would only be a smudge.
          if (air > 2.4) continue;
          const grow = 1 + Math.min(0.9, Math.max(0, air - 1.1) * 0.6);

          o.getWorldQuaternion(_q);
          _n.set(0, 1, 0).applyQuaternion(_q);
          if (!Number.isFinite(_n.x) || _n.lengthSq() < 1e-6) _n.set(0, 1, 0); else _n.normalize();
          _fw.set(0, 0, 1).applyQuaternion(_q);
          _fw.addScaledVector(_n, -_fw.dot(_n));
          if (_fw.lengthSq() < 1e-6) _fw.set(0, 0, 1); else _fw.normalize();
          _rt.crossVectors(_n, _fw).normalize();

          _basis.makeBasis(_rt, _n, _fw);
          _basis.setPosition(
            _p.x + lightDir.x * 0.22,
            _p.y + 0.03,
            _p.z + lightDir.z * 0.22);
          _s.set(2.95 * grow, 1, 3.85 * grow);
          _m.copy(_basis).scale(_s);
          mesh.setMatrixAt(n, _m);
          n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }

      return { mesh, collect, update };
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

  const system = {
    update(dt) {
      if ((frame++ % 30) === 0) { scan(); contact?.collect(); }
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
