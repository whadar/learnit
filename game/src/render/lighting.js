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

const LIT = m => !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial ||
                    m.isMeshPhongMaterial || m.isMeshToonMaterial);

/**
 * @param {Engine} engine
 * @param {WorldData} world
 * @param {object} sky  state from createSky: { sunDir, palette, envScene }
 */
export function createLighting(engine, world, sky, opts = {}) {
  installFogChunks();

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
  //   the map at the right depth, which is the actual fix and is applied in setupMaterial()
  //   below to every material this rig adopts.
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
    // three's PCF filter is a 5-tap Vogel disk scaled by `shadow.radius` *in texels*, with a
    // per-pixel rotation. At the default radius of 1 the disk collapses onto one texel and
    // every boundary is a hard stair-step. 2.2 texels gives a real penumbra for free (the
    // taps are hardware-compared), and the rotation is a deterministic function of
    // gl_FragCoord, so screenshots stay reproducible.
    sun.shadow.radius = opts.shadowRadius ?? 2.2;
  }

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
    // Slope term, in metres: enough to kill acne on the terrain now that casters render
    // their FRONT faces, small enough that a 1 m object still meets its own shadow.
    sun.shadow.normalBias = opts.normalBias ?? Math.max(0.05, 1.8 * texel);
  }
  fitShadow();

  // ---- ambient: sky/ground hemisphere + a terra-rossa bounce --------------------------
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
      // Sky IBL is the other half of the ambient-fill problem (see sky.js's hemiIntensity
      // note): at 0.45 the shaded side of every object was lit almost as brightly as the
      // sunlit side and cast shadows read as a faint blue smudge. 0.24 keeps the bounce
      // colour without eating the sun's contrast.
      scene.environmentIntensity = opts.envIntensity ?? 0.35;
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

    // THE contact-shadow fix. three defaults a FrontSide material's shadow pass to BackSide
    // (see WebGLShadowMap.getDepthMaterial), which is only safe for closed solids. Karts,
    // cats, item boxes, signage and every foliage card here are open single-sided shells, so
    // their back faces do not exist and they wrote nothing at all into the shadow map — the
    // whole field floated. Rendering the FRONT faces records the surface the sun actually
    // hits, at the height it actually is, which is what a contact shadow is made of.
    // `shadowSide` is honoured per draw, so a material that has deliberately chosen one is
    // left alone.
    if (shadows && mat.shadowSide == null && !mat.isShadowMaterial) {
      mat.shadowSide = THREE.FrontSide;
    }

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

  let dirty = false;
  function scan(root = scene) {
    root.traverse(o => {
      if (o.isMesh) {
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
    hemi.color.copy(pal.skyAmbient);
    hemi.groundColor.copy(pal.groundAmbient);
    hemi.intensity = pal.hemiIntensity;
    bounce.color.copy(pal.bounceColor);
    bounce.intensity = pal.bounceIntensity;
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
      if ((frame++ % 30) === 0) scan();
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
