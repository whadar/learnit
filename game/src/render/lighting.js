import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { clamp, lerp as lerpN } from '../core/mathx.js';

/**
 * Lighting rig for Kat Racing: cascaded shadow maps, sky IBL and physically flavoured
 * aerial perspective. Driven by `src/world/sky.js` (which owns the atmosphere itself).
 *
 *   const lighting = createLighting(engine, world, skyState);
 *
 * The rig patches materials so that (a) directional light is evaluated through the CSM
 * cascade selector instead of summing all cascade lights, and (b) fog becomes a
 * height-aware, sun-tinted aerial-perspective term. Patching composes with any
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

  const useCSM = opts.shadows !== false;
  const cascades = opts.cascades ?? 3;
  const shadowMapSize = opts.shadowMapSize ?? 2048;
  const shadowFar = opts.shadowFar ?? 1000;
  // Depth bias, expressed in **metres** rather than in normalised shadow-map depth. The old
  // form (`shadowBias: -0.00008`) is a fraction of the light camera's near..far span, and
  // that span was 3499 m — so the real bias was 28 cm and every kart, item box and traffic
  // cone lost its contact shadow to peter-panning. `tuneCascades()` below converts this to
  // per-cascade normalised units after every frustum update.
  const biasMetres = opts.shadowBiasMetres ?? 0.030;
  const lightMargin = opts.lightMargin ?? 150;
  // three's 'practical' split (lambda 0.5) spends far too much of cascade 0 on empty
  // distance; at kart height that shows up as stair-stepped eaves. Bias hard toward the
  // logarithmic split so the first cascade is a tight ~50 m box.
  const splitLambda = opts.splitLambda ?? 0.90;
  const customSplits = (amount, near, far, target) => {
    for (let i = 1; i < amount; i++) {
      const uni = (near + (far - near) * i / amount) / far;
      const log = (near * (far / near) ** (i / amount)) / far;
      target.push(lerpN(uni, log, splitLambda));
    }
    target.push(1);
  };

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
  const csmUniforms = {
    CSM_cascades: { value: [] },
    cameraNear:   { value: engine.camera.near },
    shadowFar:    { value: shadowFar },
  };

  // ---- CSM -----------------------------------------------------------------------------
  let csm = null;

  /**
   * Fit each cascade's light camera depth range to the cascade it actually covers, then
   * derive the depth/normal bias from that range.
   *
   * three's CSM gives every cascade the same `lightNear`/`lightFar`, so the near box that
   * holds the karts was sharing a 3500 m depth range with the 1 km distance cascade. Two
   * things go wrong: normalised bias becomes a huge distance, and the 24-bit depth buffer
   * spends its precision on empty air. Sizing per cascade lets the contact shadow sit
   * 3 cm from the tyre instead of 28 cm away from it.
   */
  function tuneCascades() {
    if (!csm) return;
    for (const l of csm.lights) {
      const cam = l.shadow.camera;
      const w = Math.max(cam.right - cam.left, 1);
      cam.near = 1;
      cam.far = lightMargin + w * 1.6 + 60;
      cam.updateProjectionMatrix();
      const span = cam.far - cam.near;
      l.shadow.bias = -(biasMetres / span);
      // Slope/texel term: enough to kill acne on the terrain, small enough that a 1 m object
      // still meets its own shadow. One shadow texel is w / shadowMapSize metres.
      l.shadow.normalBias = opts.normalBias ?? Math.max(0.02, 1.7 * (w / shadowMapSize));
      // three's PCF filter is a 5-tap Vogel disk scaled by `shadow.radius` *in texels*, with
      // a per-pixel rotation. At the default radius of 1 the disk collapses onto one texel
      // and every shadow boundary is a hard stair-step — which is what the review saw on the
      // olive canopies. 2.6 texels gives a real penumbra at every cascade scale for free
      // (the taps are hardware-filtered), and the rotation is a deterministic function of
      // gl_FragCoord, so screenshots stay reproducible.
      l.shadow.radius = opts.shadowRadius ?? 2.6;
    }
  }
  const lightDir = new THREE.Vector3().copy(sky.sunDir).negate(); // from sun toward ground
  if (useCSM) {
    try {
      csm = new CSM({
        parent: scene,
        camera: engine.camera,
        cascades,
        maxFar: shadowFar,
        mode: 'custom',
        customSplitsCallback: customSplits,
        shadowMapSize,
        shadowBias: 0,          // set per cascade by tuneCascades()
        lightDirection: lightDir.clone(),
        lightIntensity: pal.sunIntensity,
        lightNear: 1,
        lightFar: 3500,
        lightMargin,
      });
      csm.fade = true;
      csm.updateFrustums();
      for (const l of csm.lights) l.color.copy(pal.sunColor);
      tuneCascades();
    } catch (e) {
      console.warn('[lighting] CSM unavailable, falling back to a single shadow map:', e);
      csm = null;
    }
  }

  // The canonical sun handle other systems read. With CSM active the cascade lights do the
  // actual lighting, so this one is kept out of the scene graph (intensity contributed once).
  const sun = new THREE.DirectionalLight(pal.sunColor.clone(), pal.sunIntensity);
  sun.position.copy(sky.sunDir).multiplyScalar(2000);
  sun.target.position.set(0, 0, 0);
  if (!csm) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.normalBias = opts.normalBias ?? 0.05;
    sun.shadow.bias = opts.shadowBias ?? -(biasMetres / 3999);
    const c = sun.shadow.camera;
    c.left = -260; c.right = 260; c.top = 260; c.bottom = -260; c.near = 1; c.far = 4000;
    c.updateProjectionMatrix();
    scene.add(sun, sun.target);
  }

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
    // Opt a custom ShaderMaterial in only when its source actually includes the chunks we
    // rewrote — otherwise the defines would reference uniforms it never declares.
    const vs = mat.vertexShader || '', fs = mat.fragmentShader || '';
    return {
      csm: mat.lights === true && fs.includes('lights_fragment_begin'),
      ap: vs.includes('project_vertex') && vs.includes('fog_vertex') && fs.includes('fog_fragment'),
    };
  }

  function setupMaterial(mat) {
    if (!mat || mat.isSpriteMaterial || mat.isPointsMaterial || mat.isLineBasicMaterial ||
        mat.isLineDashedMaterial || mat.isShadowMaterial) return;

    let wantCSM = !!csm && LIT(mat);
    let wantAP = LIT(mat) || !!mat.isMeshBasicMaterial;

    if (mat.isShaderMaterial || mat.isRawShaderMaterial) {
      const w = shaderMaterialWants(mat);
      wantCSM = !!csm && w.csm; wantAP = w.ap;
      if (mat.isRawShaderMaterial) { wantCSM = false; wantAP = false; }
    }
    if (!wantCSM && !wantAP) return;

    const ud = mat.userData;
    if (ud.__ktLightFn && mat.onBeforeCompile === ud.__ktLightFn) return; // already ours, untouched

    // Compose with whatever hook is installed right now (ours from a previous pass excluded).
    const prev = (mat.onBeforeCompile && mat.onBeforeCompile !== ud.__ktLightFn)
      ? mat.onBeforeCompile : (ud.__ktLightPrev || null);
    ud.__ktLightPrev = prev;

    const fn = function (shader, r) {
      ud.__ktLightPrev?.call(this, shader, r);
      if (wantAP) Object.assign(shader.uniforms, apUniforms);
      if (wantCSM) Object.assign(shader.uniforms, csmUniforms);
    };
    ud.__ktLightFn = fn;
    mat.onBeforeCompile = fn;

    mat.defines = mat.defines || {};
    if (wantAP) mat.defines.AERIAL_PERSPECTIVE = '';
    if (wantCSM) {
      mat.defines.USE_CSM = 1;
      mat.defines.CSM_CASCADES = cascades;
      if (csm.fade) mat.defines.CSM_FADE = '';
    }
    mat.needsUpdate = true;
    adopted.add(mat);
  }

  // Landscape self-shadowing is most of what sells a low sun, but terrain systems often
  // ship with castShadow off (it costs nothing when the sun is overhead). Opt them in here,
  // where the lighting decision belongs; `terrainShadows: false` restores their choice.
  const terrainShadows = opts.terrainShadows !== false;
  const TERRAIN_RE = /terrain|ground|hill|apron|plateau/i;

  let dirty = false;
  function scan(root = scene) {
    root.traverse(o => {
      if (terrainShadows && o.isMesh && o.receiveShadow && !o.castShadow && TERRAIN_RE.test(o.name)) {
        o.castShadow = true; dirty = true;
      }
      const m = o.material; if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) { const b = adopted.has(mm); setupMaterial(mm); if (!b) dirty = true; } }
      else { const b = adopted.has(m); setupMaterial(m); if (!b) dirty = true; }
    });
  }

  function refreshCSMUniforms() {
    if (!csm) return;
    const t = csmUniforms.CSM_cascades.value;
    while (t.length < csm.breaks.length) t.push(new THREE.Vector2());
    t.length = csm.breaks.length;
    for (let i = 0; i < csm.cascades; i++) {
      t[i].x = csm.breaks[i - 1] || 0;
      t[i].y = csm.breaks[i];
    }
    csmUniforms.cameraNear.value = engine.camera.near;
    csmUniforms.shadowFar.value = Math.min(engine.camera.far, csm.maxFar);
  }
  refreshCSMUniforms();

  // ---- sun / palette application --------------------------------------------------------
  function applyPalette() {
    lightDir.copy(sky.sunDir).negate().normalize();
    sun.position.copy(sky.sunDir).multiplyScalar(2000);
    sun.color.copy(pal.sunColor);
    sun.intensity = pal.sunIntensity;
    if (csm) {
      csm.lightDirection.copy(lightDir);
      csm.lightIntensity = pal.sunIntensity;
      for (const l of csm.lights) { l.color.copy(pal.sunColor); l.intensity = pal.sunIntensity; }
    }
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
  if (opts.lazyShadows !== false) renderer.shadowMap.autoUpdate = false;
  let frame = 0;

  const system = {
    update(dt) {
      if ((frame++ % 30) === 0) scan();
      if (csm) { csm.update(); }
      const cam = engine.camera;
      const moved = cam.position.distanceToSquared(lastCamPos) > 2.5e-3 ||
                    Math.abs(cam.quaternion.dot(lastCamQuat)) < 0.99999;
      if (!renderer.shadowMap.autoUpdate && (moved || dirty || (frame % 30) === 0)) {
        renderer.shadowMap.needsUpdate = true;
      }
      if (moved) { lastCamPos.copy(cam.position); lastCamQuat.copy(cam.quaternion); }
      dirty = false;
    },
    resize() { if (csm) { csm.updateFrustums(); tuneCascades(); refreshCSMUniforms(); dirty = true; } },
  };
  engine.add(system);

  scan();
  const env = buildEnv();

  const api = {
    sun, hemi, bounce, csm, fog,
    envMap: env,
    apUniforms,
    setupMaterial,
    scan,
    /** Re-read sky.palette / sky.sunDir after a time-of-day change. */
    refresh(rebuildEnv = true) {
      applyPalette();
      if (csm) { csm.updateFrustums(); tuneCascades(); refreshCSMUniforms(); }
      if (rebuildEnv) api.envMap = buildEnv();
      // Nothing to recompile: every patched shader holds the *same* uniform objects.
    },
    dispose() {
      csm?.remove?.(); csm?.dispose?.();
      envRT?.dispose?.(); pmrem?.dispose?.();
    },
    update: system.update,
  };
  engine.lighting = api;   // discovery hook for other systems (no engine.js edit needed)
  return api;
}
