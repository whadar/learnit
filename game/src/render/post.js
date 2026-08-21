import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { clamp, smoothstep } from '../core/mathx.js';
import { BloomPrefilterFrag, BlurShader, makeCompositeShader, makeGradeLUT } from './materials/postShaders.js';

/**
 * Kat Racing post-processing stack.
 *
 *   const fx = createPostFX(engine.renderer, engine.scene, engine.camera, { quality: 2 });
 *   engine.composer = fx;                       // Engine.render() will call fx.render()
 *   fx.setSpeed(kmh, boostAmount);              // per frame, from the vehicle
 *
 * Pipeline:
 *
 *   scene -> rtScene (+depth)   full-res forward render, renderer ACES, sRGB-encoded
 *     -> GTAO                   horizon-based AO, normals reconstructed from our depth
 *     -> UnrealBloom            threshold bloom, thresholded in reconstructed HDR
 *     -> half-res gaussian      the blur source for depth of field and the CA fringe
 *     -> composite              motion blur + rush blur + DoF + CA + LUT grade +
 *                               speed-driven sat/contrast + speed lines + vignette + dither
 *     -> SMAA                   anti-aliasing, last, on the finished perceptual image
 *
 * ## Colour management
 *
 * This stack does **not** take tone mapping over from the renderer, and that is deliberate.
 * three applies `fog_fragment` *after* `tonemapping_fragment` and `colorspace_fragment`, so
 * `src/render/lighting.js`'s aerial perspective — which is most of what you see past 200 m
 * on this course — is blended in display space against display-referred haze colours. Tone
 * mapping in the composer instead would blend every hazy pixel in the wrong space; measured
 * on the `lane` view it took the far pine ridge from RGB 134 to RGB 195 and turned it into
 * white milk. So the scene target is tagged `SRGBColorSpace`, the renderer keeps its ACES
 * curve, and the composer grades the display-referred image exactly as it would have
 * reached the canvas. Nothing here can change a colour another module tuned.
 *
 * Bloom still gets a physically meaningful threshold: its prefilter inverts the tone curve
 * to reconstruct how far over white a pixel was (see `postShaders.js`).
 *
 * ## Quality
 *
 * `setQuality(t)` takes a tier 0..3 (a fraction in 0..1 is accepted and scaled):
 *
 *   0  SMAA + grade + vignette                       - software raster / weak GPUs
 *   1  + bloom
 *   2  + GTAO, depth of field, motion blur, chromatic aberration, boost rush   (default)
 *   3  + more AO and motion-blur samples
 */

const TIER_MAX = 3;

/** Renders the scene once into our own target so the depth texture is never ping-ponged. */
class ScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene; this.camera = camera; this.target = target;
    this.needsSwap = false;
  }
  render(renderer) {
    const auto = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }
}

/** Copies our scene target into the composer chain (used when AO is off). */
class SourcePass extends Pass {
  constructor(target) {
    super();
    this.target = target;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer) {
    this.material.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._quad.render(renderer);
  }
  dispose() { this._quad.dispose(); this.material.dispose(); }
}

/** Feeds our scene target to GTAOPass as its read buffer, so no extra full-screen copy. */
class AOPass extends Pass {
  constructor(gtao, source, scale = 0.5) { super(); this.gtao = gtao; this.source = source; this.scale = scale; }
  render(renderer, writeBuffer) {
    this.gtao.renderToScreen = this.renderToScreen;
    this.gtao.render(renderer, writeBuffer, this.source);
  }
  setSize(w, h) {
    // AO runs at half resolution and is upsampled by the blend: at our contact-shadow
    // radius the extra resolution buys nothing and it is the most expensive pass here.
    const k = this.scale;
    this.gtao.setSize(Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k)));
  }
  dispose() { this.gtao.dispose(); }
}

/** Half-res gaussian of the composited beauty; the depth-of-field far field reads from it. */
class DofBlurPass extends Pass {
  constructor(w, h) {
    super();
    this.needsSwap = false;
    const o = { type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, o);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, o);
    this.rtA.texture.name = 'KatPost.dofA';
    this.rtB.texture.name = 'KatPost.dofB';
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BlurShader.uniforms),
      vertexShader: BlurShader.vertexShader,
      fragmentShader: BlurShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.material);
    this.setSize(w, h);
  }
  get texture() { return this.rtB.texture; }
  setSize(w, h) {
    this.w = Math.max(2, Math.floor(w / 2)); this.h = Math.max(2, Math.floor(h / 2));
    this.rtA.setSize(this.w, this.h); this.rtB.setSize(this.w, this.h);
    this.material.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    // pass 1: downsample + horizontal
    u.tDiffuse.value = readBuffer.texture;
    u.uDir.value.set(1, 0);
    renderer.setRenderTarget(this.rtA); this._quad.render(renderer);
    // pass 2: vertical
    u.tDiffuse.value = this.rtA.texture;
    u.uDir.value.set(0, 1);
    renderer.setRenderTarget(this.rtB); this._quad.render(renderer);
  }
  dispose() { this.rtA.dispose(); this.rtB.dispose(); this.material.dispose(); this._quad.dispose(); }
}

// ---------------------------------------------------------------------------------------

export function createPostFX(renderer, scene, camera, opts = {}) {
  const size = renderer.getSize(new THREE.Vector2());
  let width = Math.max(2, Math.round(opts.width || size.x || 1280));
  let height = Math.max(2, Math.round(opts.height || size.y || 720));

  const params = {
    exposure:        opts.exposure ?? 1.0,
    // Bloom. The threshold is in *reconstructed* HDR units (see the prefilter): sunlit
    // white plaster comes back at ~4, the solar disc and boost flames at hundreds. 6.5 is
    // therefore comfortably above the village walls and well below anything that glows.
    bloomStrength:   opts.bloomStrength ?? 0.62,
    bloomRadius:     opts.bloomRadius ?? 0.68,
    bloomThreshold:  opts.bloomThreshold ?? 6.5,
    bloomKnee:       opts.bloomKnee ?? 5.0,
    bloomClamp:      opts.bloomClamp ?? 2.2,
    // Ambient occlusion.
    aoIntensity:     opts.aoIntensity ?? 1.0,
    aoRadius:        opts.aoRadius ?? 1.1,
    aoScale:         opts.aoScale ?? 1.0,
    aoThickness:     opts.aoThickness ?? 1.4,
    aoDistanceExponent: opts.aoDistanceExponent ?? 1.4,
    // Depth of field: metres. Karts live inside focusNear, the horizon melts past focusFar.
    focusNear:       opts.focusNear ?? 420,
    focusFar:        opts.focusFar ?? 2600,
    dofMax:          opts.dofMax ?? 0.34,
    // Motion blur: fraction of a frame of camera movement smeared across the image.
    motionShutter:   opts.motionShutter ?? 0.72,
    motionMax:       opts.motionMax ?? 0.013,
    motionNear:      opts.motionNear ?? 2.5,
    motionFull:      opts.motionFull ?? 14,
    // Grade.
    contrast:        opts.contrast ?? 1.0,
    saturation:      opts.saturation ?? 1.0,
    lutMix:          opts.lutMix ?? 1.0,
    vignette:        opts.vignette ?? 0.28,
    chromatic:       opts.chromatic ?? 0.0038,
    // Boost rush.
    rushStrength:    opts.rushStrength ?? 0.024,
    rushLines:       opts.rushLines ?? 0.42,
    speedRef:        opts.speedRef ?? 110,     // km/h that counts as "full speed"
  };

  // ---- targets ------------------------------------------------------------------------
  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.format = THREE.DepthStencilFormat;
  depthTexture.type = THREE.UnsignedInt248Type;
  depthTexture.name = 'KatPost.depth';

  const rtScene = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture,
  });
  rtScene.texture.name = 'KatPost.scene';
  // Canvas parity. `WebGLRenderer.setProgram()` silently disables tone mapping whenever it
  // is drawing into a render target, and `WebGLPrograms` forces the output colour space to
  // the working (linear) space there too. So *any* EffectComposer changes this engine's
  // look: `fog_fragment` runs after both of those chunks, and lighting.js's aerial
  // perspective ends up blended in linear space against display-referred haze colours.
  // Measured on the `lane` view that took the far pine ridge from RGB 134 to RGB 195 and
  // turned the whole distance into milk.
  //
  // `isXRRenderTarget` is the one flag that puts both switches back: with it set, three
  // tone-maps in-material and encodes with `texture.colorSpace`, exactly as it would for
  // the canvas. In the WebGLRenderer path the flag is read in only three places
  // (WebGLRenderer.setProgram, WebGLPrograms.getParameters, WebGLTextures' internal-format
  // choice, where it just forces a linear transfer function — which is what we want, since
  // a half-float target must not be allocated as SRGB8_ALPHA8 and auto-decoded on sampling).
  rtScene.texture.colorSpace = THREE.SRGBColorSpace;
  rtScene.isXRRenderTarget = true;

  const composer = new EffectComposer(renderer);
  composer.setSize(width, height);

  // ---- passes -------------------------------------------------------------------------
  const scenePass = new ScenePass(scene, camera, rtScene);
  const sourcePass = new SourcePass(rtScene);

  let gtao = null, aoPass = null;
  try {
    gtao = new GTAOPass(scene, camera, width, height);
    // Swap in our scene depth and drop GTAO's own normal G-buffer pass: with no normal
    // texture the shader reconstructs normals from depth, which saves a second full scene
    // rasterisation — the single most expensive thing in the stack under software raster.
    gtao.setGBuffer(depthTexture, undefined);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = params.aoIntensity;
    gtao.updateGtaoMaterial({
      radius: params.aoRadius, scale: params.aoScale, thickness: params.aoThickness,
      distanceExponent: params.aoDistanceExponent, distanceFallOff: 1.0,
      screenSpaceRadius: false, samples: 16,
    });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });
    aoPass = new AOPass(gtao, rtScene, opts.aoResScale ?? 0.5);
  } catch (e) {
    console.warn('[post] GTAO unavailable, continuing without AO:', e.message);
  }

  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height),
    params.bloomStrength, params.bloomRadius, params.bloomThreshold);
  // A soft knee makes the threshold forgiving: highlights ease into the bloom instead of
  // popping, which is what keeps sunlit plaster from suddenly glowing when it tips over 1.
  bloomPass.highPassUniforms.smoothWidth.value = params.bloomKnee;
  // Swap in our energy-conserving, clamped prefilter (see postShaders.js). The uniforms
  // object is the same one UnrealBloomPass writes tDiffuse/threshold into every frame.
  bloomPass.highPassUniforms.bloomClamp = { value: params.bloomClamp };
  const _hpVert = bloomPass.materialHighPassFilter.vertexShader;
  bloomPass.materialHighPassFilter.dispose();
  bloomPass.materialHighPassFilter = new THREE.ShaderMaterial({
    name: 'KatBloomPrefilter',
    uniforms: bloomPass.highPassUniforms,
    vertexShader: _hpVert,
    fragmentShader: BloomPrefilterFrag,
    depthTest: false, depthWrite: false,
  });

  const dofPass = new DofBlurPass(width, height);

  const compositeShader = makeCompositeShader();
  const compositePass = new ShaderPass(compositeShader);
  compositePass.material.depthTest = false;
  compositePass.material.depthWrite = false;
  const cu = compositePass.uniforms;
  const lut = makeGradeLUT(opts.lut);
  cu.tLut.value = lut;
  cu.tDepth.value = depthTexture;
  cu.tBlur.value = dofPass.texture;
  cu.uResolution.value.set(width, height);

  const smaaPass = new SMAAPass();

  composer.addPass(scenePass);
  composer.addPass(sourcePass);
  if (aoPass) composer.addPass(aoPass);
  composer.addPass(bloomPass);
  composer.addPass(dofPass);
  composer.addPass(compositePass);
  composer.addPass(smaaPass);

  // ---- state ---------------------------------------------------------------------------
  let tier = -1;
  let speedN = 0, boost = 0, gradeOn = true, vignetteScale = 1;
  const prevViewProj = new THREE.Matrix4();
  const curViewProj = new THREE.Matrix4();
  let havePrev = false;

  function setQuality(t) {
    let next = t;
    if (typeof next !== 'number' || !isFinite(next)) next = 2;
    if (next > 0 && next < 1) next = Math.round(next * TIER_MAX);      // accept a 0..1 knob
    next = clamp(Math.round(next), 0, TIER_MAX);
    if (next === tier) return;
    tier = next;

    const wantBloom  = tier >= 1;
    const wantAO     = tier >= 2;
    const wantDof    = tier >= 2;
    const wantMotion = tier >= 2;
    const wantCA     = tier >= 2;   // the fringe is sampled from the DoF blur target
    const wantRush   = tier >= 2;

    bloomPass.enabled = wantBloom;
    if (aoPass) aoPass.enabled = wantAO;
    sourcePass.enabled = !(aoPass && aoPass.enabled);
    dofPass.enabled = wantDof;

    if (gtao) {
      gtao.updateGtaoMaterial({ samples: tier >= 3 ? 16 : 8 });
      gtao.updatePdMaterial({ samples: tier >= 3 ? 16 : 8 });
    }

    const d = compositePass.material.defines;
    d.USE_MOTION = wantMotion ? 1 : 0;
    d.USE_DOF    = wantDof ? 1 : 0;
    d.USE_CA     = wantCA ? 1 : 0;
    d.USE_RUSH   = wantRush ? 1 : 0;
    d.USE_LUT    = 1;
    d.MB_TAPS    = tier >= 3 ? 12 : 8;
    compositePass.material.needsUpdate = true;

    vignetteScale = tier >= 1 ? 1 : 0.6;   // without bloom a full vignette reads heavy
    havePrev = false;
  }

  /**
   * @param {number} kmh   current kart ground speed
   * @param {number} boostAmount 0..1 — mushroom / mini-turbo intensity
   */
  function setSpeed(kmh, boostAmount = 0) {
    speedN = clamp((kmh || 0) / params.speedRef, 0, 1.35);
    boost = clamp(boostAmount || 0, 0, 1);
  }

  function setSize(w, h) {
    width = Math.max(2, Math.round(w)); height = Math.max(2, Math.round(h));
    const pr = renderer.getPixelRatio() || 1;
    const pw = Math.max(2, Math.round(width * pr)), ph = Math.max(2, Math.round(height * pr));
    rtScene.setSize(pw, ph);
    composer.setSize(width, height);          // composer applies the pixel ratio itself
    cu.uResolution.value.set(pw, ph);
    cu.tBlur.value = dofPass.texture;
    havePrev = false;
  }

  const _tmp = new THREE.Matrix4();

  function render(dt = 1 / 60) {
    const step = clamp(dt || 1 / 60, 1 / 240, 1 / 12);

    camera.updateMatrixWorld();
    curViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!havePrev) { prevViewProj.copy(curViewProj); havePrev = true; }

    // ---- exposure + grade, driven by speed / boost ------------------------------------
    const punch = boost;
    // A display-space gain, not an exposure control — `renderer.toneMappingExposure` still
    // owns real exposure, so other systems' tuning keeps working. This is only the small
    // brightness kick that comes with a boost.
    cu.uExposure.value = params.exposure * (1 + 0.05 * punch);
    cu.uSaturation.value = params.saturation * (1 + 0.22 * punch + 0.05 * speedN);
    cu.uContrast.value = params.contrast * (1 + 0.10 * punch);
    cu.uLutMix.value = gradeOn ? params.lutMix : 0;
    cu.uLift.value = 0.02 * punch;
    cu.uVignette.value = vignetteScale *
      (params.vignette + 0.20 * punch + 0.05 * smoothstep(0.6, 1.2, speedN));
    // CA scales only gently with boost: past ~4 px of separation the fringe stops reading
    // as a lens and starts reading as a bug.
    cu.uCA.value = params.chromatic * (1 + 0.7 * punch + 0.15 * speedN);

    // ---- camera reprojection motion blur ------------------------------------------------
    _tmp.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert();
    cu.uInvViewProj.value.copy(_tmp);
    cu.uPrevViewProj.value.copy(prevViewProj);
    cu.uCameraNear.value = camera.near;
    cu.uCameraFar.value = camera.far;
    // Blur represents shutter-open time. The reprojection vector already spans one frame,
    // so scaling by the shutter fraction keeps blur frame-rate independent; the clamp then
    // stops a hitched frame from smearing the whole screen.
    cu.uMotionScale.value = params.motionShutter * (0.45 + 0.75 * speedN + 1.10 * punch);
    cu.uMotionMax.value = params.motionMax * (0.55 + 0.55 * speedN + 0.9 * punch);
    cu.uMotionNear.value.set(params.motionNear, params.motionFull);

    // ---- boost rush ---------------------------------------------------------------------
    const rush = smoothstep(0.05, 1.0, punch);
    cu.uRush.value = params.rushStrength * rush + 0.0035 * smoothstep(0.72, 1.25, speedN);
    cu.uRushLines.value = params.rushLines * smoothstep(0.18, 0.95, punch);

    // ---- depth of field ------------------------------------------------------------------
    cu.uFocus.value.set(params.focusNear, params.focusFar);
    cu.uDofMax.value = params.dofMax;
    cu.tBlur.value = dofPass.texture;

    // ---- bloom -----------------------------------------------------------------------------
    bloomPass.strength = params.bloomStrength * (1 + 0.55 * punch);
    bloomPass.threshold = params.bloomThreshold;
    bloomPass.radius = params.bloomRadius;

    if (gtao) gtao.blendIntensity = params.aoIntensity;

    composer.render(step);

    prevViewProj.copy(curViewProj);
  }

  function dispose() {
    for (const p of composer.passes) p.dispose?.();
    composer.passes.length = 0;
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    rtScene.dispose();
    depthTexture.dispose();
    lut.dispose();
  }

  setQuality(opts.quality ?? 2);
  setSize(width, height);

  return {
    composer, render, setSize, setQuality, setSpeed, dispose,
    params, lut,
    get quality() { return tier; },
    passes: { scenePass, sourcePass, aoPass, bloomPass, dofPass, compositePass, smaaPass },
    /** Toggle the grade LUT off for A/B comparisons; the rest of the stack keeps running. */
    setGradeEnabled(on) { gradeOn = !!on; cu.uLutMix.value = gradeOn ? params.lutMix : 0; },
  };
}

export default createPostFX;
