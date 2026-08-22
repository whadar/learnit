import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { clamp, smoothstep } from '../core/mathx.js';
import { BloomPrefilterFrag, BlurShader, makeCompositeShader, makeGradeLUT,
  ResolveShader, KeyDownShader, KeyReduceShader } from './materials/postShaders.js';

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

/**
 * Supersample resolve. The whole chain runs at `renderScale` times the canvas resolution and
 * this filters it back down as the last pass, straight to the screen.
 */
class ResolvePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.material = new THREE.ShaderMaterial({
      name: ResolveShader.name,
      uniforms: THREE.UniformsUtils.clone(ResolveShader.uniforms),
      vertexShader: ResolveShader.vertexShader,
      fragmentShader: ResolveShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.material);
  }
  setDestination(w, h) {
    this.material.uniforms.uDstTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }
  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._quad.render(renderer);
  }
  dispose() { this._quad.dispose(); this.material.dispose(); }
}

/**
 * Auto-key probe. Reduces the finished composite to a single mean-luma texel that the
 * composite reads back on the next frame (see `uKeyTarget` there). Two passes, 145 pixels
 * in total; it never touches the composer's own buffers.
 */
class KeyProbePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.blend = 1;
    const o = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.rtDown = new THREE.WebGLRenderTarget(16, 9, o);
    this.rtA = new THREE.WebGLRenderTarget(1, 1, o);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, o);
    this.rtDown.texture.name = 'KatPost.keyDown';
    const mk = (sh) => new THREE.ShaderMaterial({
      name: sh.name,
      uniforms: THREE.UniformsUtils.clone(sh.uniforms),
      vertexShader: sh.vertexShader, fragmentShader: sh.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.matDown = mk(KeyDownShader);
    this.matReduce = mk(KeyReduceShader);
    this._qDown = new FullScreenQuad(this.matDown);
    this._qReduce = new FullScreenQuad(this.matReduce);
  }
  /** The most recently written 1x1 measurement. */
  get texture() { return this.rtA.texture; }
  render(renderer, writeBuffer, readBuffer) {
    this.matDown.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rtDown);
    this._qDown.render(renderer);
    this.matReduce.uniforms.tDiffuse.value = this.rtDown.texture;
    this.matReduce.uniforms.tPrev.value = this.rtA.texture;
    this.matReduce.uniforms.uBlend.value = this.blend;
    renderer.setRenderTarget(this.rtB);
    this._qReduce.render(renderer);
    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;   // ping-pong
  }
  dispose() {
    this.rtDown.dispose(); this.rtA.dispose(); this.rtB.dispose();
    this._qDown.dispose(); this._qReduce.dispose();
    this.matDown.dispose(); this.matReduce.dispose();
  }
}

// ---------------------------------------------------------------------------------------

export function createPostFX(renderer, scene, camera, opts = {}) {
  const size = renderer.getSize(new THREE.Vector2());
  let width = Math.max(2, Math.round(opts.width || size.x || 1280));
  let height = Math.max(2, Math.round(opts.height || size.y || 720));

  const params = {
    exposure:        opts.exposure ?? 1.0,
    // Supersampling. SMAA is morphological: it straightens edges it can *see*, and a 2 px
    // marker post, an olive canopy or a bunting line that falls between samples never makes
    // an edge for it to find. Round-4 review named whole-image shimmer the second-loudest
    // "not shipped" tell in the game. The quality tiers ask for a 1.5 device pixel ratio at
    // High, but `quality.js` clamps that with `Math.min(devicePixelRatio, tier.pixelRatio)`,
    // so on any ordinary 1x display — and in the review harness, which runs at
    // --force-device-scale-factor=1 — it silently resolves to 1.0 and no supersampling ever
    // happens. Owning the sample rate here instead is also simply better: the DOM HUD stays
    // crisp at native resolution and only the 3D image pays.
    renderScale:     opts.renderScale ?? 1.5,
    // Bloom. The threshold is in *reconstructed* HDR units (see the prefilter): display
    // 0.90 comes back at ~3.4, sunlit white plaster at 0.95 at ~7, display white at ~17,
    // and a genuinely over-range additive flame in the 30..80 range. 12 with a 6-wide knee
    // therefore leaves the village walls and the sky completely alone and only lifts the
    // things that are actually emitting.
    //
    // The strength number looks tiny because UnrealBloomPass applies a hidden `3.0 *
    // bloomStrength * sum(mipFactors)`, and that factor sum is ~3.0 — so the real gain on
    // the prefiltered image is about 9x this value. At 0.18 and a 0.60 energy clamp the
    // most a saturated highlight can add is ~0.97 at its core and a few hundredths out in
    // the halo: a punchy glow that cannot swallow the kart. The old 0.42/1.5/0.68 trio
    // worked out to a gain of ~5.7 and turned the `driftCorner` boost flame into a
    // 600 px white hole with the kart nowhere inside it.
    bloomStrength:   opts.bloomStrength ?? 0.18,
    bloomRadius:     opts.bloomRadius ?? 0.40,   // low mips dominate at high radius = giant halo
    bloomThreshold:  opts.bloomThreshold ?? 12.0,
    bloomKnee:       opts.bloomKnee ?? 6.0,
    bloomClamp:      opts.bloomClamp ?? 0.52,
    // Ambient occlusion. The radius is world-space metres: 1.1 m is a room-scale radius
    // that misses the thing it is most needed for here — the wedge of darkness where a tyre
    // meets the road. 0.55 m hugs contacts, which is what glues a kart to the ground.
    aoIntensity:     opts.aoIntensity ?? 1.15,
    aoRadius:        opts.aoRadius ?? 0.55,
    aoScale:         opts.aoScale ?? 1.0,
    aoThickness:     opts.aoThickness ?? 1.4,
    aoDistanceExponent: opts.aoDistanceExponent ?? 1.4,
    // Depth of field: metres. Karts live inside focusNear, the horizon melts past focusFar.
    focusNear:       opts.focusNear ?? 420,
    focusFar:        opts.focusFar ?? 2600,
    dofMax:          opts.dofMax ?? 0.34,
    // Motion blur: fraction of a frame of camera movement smeared across the image.
    //
    // `motionNear`/`motionFull` are the distances over which the blur fades in. They used to
    // be 2.5 m and 14 m — which is *exactly* the band of road the chase camera looks at, so
    // every gameplay frame had its aggregate, seams, racing line and decals smeared into a
    // directional mush. Mario Kart keeps the track surface razor sharp at 200cc because
    // readability at speed is the whole point; the speed cue comes from the scenery
    // streaming past, not from the tarmac dissolving. 14 m to 70 m puts the fade-in beyond
    // the road the player is reading and onto the trees and buildings going by.
    motionShutter:   opts.motionShutter ?? 0.55,
    motionMax:       opts.motionMax ?? 0.011,
    motionNear:      opts.motionNear ?? 14,
    motionFull:      opts.motionFull ?? 70,
    // Grade. `saturation` is a display-space trim on top of the LUT's own 1.28 push; it
    // exists so the base look can carry the Mario Kart punch on its own. It used to sit at
    // 1.0 and the frames only looked saturated because a wrongly-binary boost flag was
    // multiplying it by 1.22 nearly all the time — when that bug went, so did the punch.
    contrast:        opts.contrast ?? 1.0,
    saturation:      opts.saturation ?? 1.50,
    lutMix:          opts.lutMix ?? 1.0,
    // Neutral chroma. A saturation control multiplies the chroma a pixel already has, and
    // the wide grey asphalt ribbon that fills half of `villageStreet` has none — which is
    // why that plate measured 0.264 mean chroma against a Mario Kart band of 0.45-0.60 while
    // the frames full of foliage and liveries passed. This gives the achromatic mass a
    // direction instead: cool sky-fill in the shade, warm key where the sun reaches, which
    // is both what really lights a road and the complementary accent the tan-and-green
    // palette was missing. Shaped in the composite; see `uShadeTint` / `uSunTint`.
    neutral:         opts.neutral ?? 1.65,
    // The tonal anchor. One black and one white for the whole game, applied after the
    // vignette so nothing downstream can move them.
    black:           opts.black ?? 0.062,
    toePivot:        opts.toePivot ?? 0.22,
    toeGamma:        opts.toeGamma ?? 1.30,
    whiteKnee:       opts.whiteKnee ?? 0.92,
    whiteCeil:       opts.whiteCeil ?? 1.02,
    // Auto-key. Bounded hard: this is a stabiliser that stops one corner of the course
    // reading two stops darker than the next, not a light meter. `keyStrength` 0 turns it
    // off entirely and the stack falls back to a fixed exposure.
    keyTarget:       opts.keyTarget ?? 0.405,
    keyStrength:     opts.keyStrength ?? 0.55,
    keyMin:          opts.keyMin ?? 0.87,
    keyMax:          opts.keyMax ?? 1.17,
    keyRate:         opts.keyRate ?? 4.5,      // 1/s; how fast the measurement follows
    // The vignette was measured crushing the corner mid-tones and adding to the milky
    // reading; a Mario Kart frame is evenly lit corner to corner.
    vignette:        opts.vignette ?? 0.17,
    chromatic:       opts.chromatic ?? 0.0038,
    // Boost rush. `rushOn`/`rushLinesOn` are the *boost* levels at which each half of the
    // effect starts to appear. They sit high on purpose: the rush is the reward for a fat
    // mini-turbo, so a tier-1 charge (which reaches ~0.20 of full punch) must leave the
    // frame completely clean, and only a tier-3 or a mushroom pushes it to the top.
    // The speed lines in particular have to be *rare*. Review round 1 found a faint diagonal
    // streak veil over the whole of photoFinish — a plate in which the player kart is not
    // even on screen — because a mid-range boost was enough to switch them on and the broad
    // edge flare that comes with them reads as haze rather than as speed.
    //
    // Round 4 found them again, over the pine canopy in `itemChaos`, over the sky in
    // `driftCorner` and across `hilltopVista`'s horizon: evenly spaced screen-space diagonals
    // that are the radial streaks seen off-centre. Two things were wrong. The threshold at
    // 0.58 sat exactly *below* a tier-2 mini-turbo (main.js maps power 0.27 to a punch of
    // 0.58), which is the most common boost in the game, so the lines were on most of the
    // time; and the streaks reached from r = 0.30 — the middle of the frame — to the corner,
    // with a broad edge flare over everything past r = 0.62 that read as haze. 0.76 puts the
    // threshold above a tier-2 charge so only a tier-3 or a mushroom earns them, and the
    // shader now keeps them in the outer ring.
    rushStrength:    opts.rushStrength ?? 0.024,
    rushLines:       opts.rushLines ?? 0.26,
    rushOn:          opts.rushOn ?? 0.34,
    rushLinesOn:     opts.rushLinesOn ?? 0.76,
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
  // The LUT is where most of the punch lives: it works in linear light, before the
  // display-space trims above, so it can push chroma without tearing the terracotta roofs.
  // Round 1 measured a mean chroma of 0.19 against Mario Kart's 0.33-0.42 with the LUT at
  // 1.28 / 1.10; this pushes both and deepens the cool-shade split so the warm sun reads
  // as warm against it.
  const lut = makeGradeLUT({ saturation: 1.42, contrast: 1.10, shadeTint: 1.15, warmth: 0.97,
    ...(opts.lut || {}) });
  cu.tLut.value = lut;
  cu.tDepth.value = depthTexture;
  cu.tBlur.value = dofPass.texture;
  cu.uResolution.value.set(width, height);

  const smaaPass = new SMAAPass();
  const keyPass = new KeyProbePass();
  const resolvePass = new ResolvePass();
  cu.tKey.value = keyPass.texture;
  // Allocate the probe's two 1x1 targets up front so the composite's very first frame samples
  // a real (cleared) texture rather than an unbound one. The shader treats the zero it reads
  // back as "no measurement yet" and runs at unit gain, so this is belt and braces.
  try { renderer.initRenderTarget?.(keyPass.rtA); renderer.initRenderTarget?.(keyPass.rtB); }
  catch (e) { /* older three: the guard in the shader covers it */ }

  composer.addPass(scenePass);
  composer.addPass(sourcePass);
  if (aoPass) composer.addPass(aoPass);
  composer.addPass(bloomPass);
  composer.addPass(dofPass);
  composer.addPass(compositePass);
  composer.addPass(keyPass);        // measures what the composite just produced
  composer.addPass(smaaPass);
  composer.addPass(resolvePass);    // supersample -> canvas; disabled at scale 1

  // ---- state ---------------------------------------------------------------------------
  let tier = -1;
  let speedN = 0, boost = 0, gradeOn = true, vignetteScale = 1;
  let superSample = 1;
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

    // Supersampling is the one thing in this stack that costs in proportion to itself, so it
    // is the first thing a lower tier gives up. `Everything on` gets the full rate.
    const wantScale = tier >= 3 ? params.renderScale
      : tier >= 2 ? Math.min(params.renderScale, 1.25)
      : 1;
    if (Math.abs(wantScale - superSample) > 1e-3) {
      superSample = wantScale;
      setSize(width, height);
    }
    havePrev = false;
  }

  /**
   * @param {number} kmh   current kart ground speed
   * @param {number} boostAmount 0..1 — mushroom / mini-turbo *intensity*, not a flag. Pass
   *   the boost's power scaled onto 0..1 and smoothed; a binary 1 for any active boost
   *   pins the rush blur and speed lines on through ordinary driving.
   */
  function setSpeed(kmh, boostAmount = 0) {
    speedN = clamp((kmh || 0) / params.speedRef, 0, 1.35);
    boost = clamp(boostAmount || 0, 0, 1);
  }

  function setSize(w, h) {
    width = Math.max(2, Math.round(w)); height = Math.max(2, Math.round(h));
    const pr = renderer.getPixelRatio() || 1;
    // The canvas the browser actually shows.
    const cw = Math.max(2, Math.round(width * pr)), ch = Math.max(2, Math.round(height * pr));
    // ...and the rate this stack samples at. A HiDPI display already supersamples, so the
    // two are not multiplied: the total sample rate is max(devicePixelRatio, renderScale),
    // never their product, or a 2x phone would be asked for nine times the pixels.
    const ss = Math.max(1, superSample / pr);
    const pw = Math.max(2, Math.round(cw * ss)), ph = Math.max(2, Math.round(ch * ss));

    rtScene.setSize(pw, ph);
    // Drive the composer in device pixels directly. Its own pixel-ratio multiply would put a
    // fractional size on every internal target once renderScale is not an integer, and a
    // render target rounded differently from our scene target puts a half-texel shear
    // between the composite's colour and its depth.
    composer.setPixelRatio(1);
    composer.setSize(pw, ph);
    cu.uResolution.value.set(pw, ph);
    cu.tBlur.value = dofPass.texture;
    resolvePass.setDestination(cw, ch);
    resolvePass.enabled = ss > 1.001;
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
    // The boost/speed trims are small now that the base sits at 1.50: multiplying an
    // already-strong grade by another 27% during a mini-turbo tears the liveries.
    cu.uSaturation.value = params.saturation * (1 + 0.10 * punch + 0.03 * speedN);
    cu.uContrast.value = params.contrast * (1 + 0.10 * punch);
    cu.uLutMix.value = gradeOn ? params.lutMix : 0;
    cu.uLift.value = 0.02 * punch;
    cu.uVignette.value = vignetteScale *
      (params.vignette + 0.20 * punch + 0.05 * smoothstep(0.6, 1.2, speedN));
    // CA scales only gently with boost: past ~4 px of separation the fringe stops reading
    // as a lens and starts reading as a bug.
    cu.uCA.value = params.chromatic * (1 + 0.7 * punch + 0.15 * speedN);
    cu.uNeutral.value = params.neutral;

    // ---- the fixed tonal anchor --------------------------------------------------------
    // These are constants on purpose. They are the one thing in the frame that must not move
    // with speed, boost, time of day or which corner the camera is in.
    cu.uBlack.value = params.black;
    cu.uToePivot.value = params.toePivot;
    cu.uToeGamma.value = params.toeGamma;
    cu.uWhiteKnee.value = params.whiteKnee;
    cu.uWhiteCeil.value = params.whiteCeil;

    // ---- auto-key ------------------------------------------------------------------------
    // The composite reads the measurement the probe wrote last frame; the probe then measures
    // what the composite just produced. It is a damped negative feedback loop, so it settles
    // in a handful of frames and settles on the same value every time — which is what keeps
    // review screenshots reproducible.
    cu.tKey.value = keyPass.texture;
    cu.uKeyTarget.value = params.keyTarget;
    cu.uKeyStrength.value = params.keyStrength;
    cu.uKeyRange.value.set(params.keyMin, params.keyMax);
    keyPass.blend = 1 - Math.exp(-step * params.keyRate);

    // ---- camera reprojection motion blur ------------------------------------------------
    _tmp.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert();
    cu.uInvViewProj.value.copy(_tmp);
    cu.uPrevViewProj.value.copy(prevViewProj);
    cu.uCameraNear.value = camera.near;
    cu.uCameraFar.value = camera.far;
    // Blur represents shutter-open time. The reprojection vector already spans one frame,
    // so scaling by the shutter fraction keeps blur frame-rate independent; the clamp then
    // stops a hitched frame from smearing the whole screen.
    cu.uMotionScale.value = params.motionShutter * (0.22 + 0.62 * speedN + 1.00 * punch);
    cu.uMotionMax.value = params.motionMax * (0.40 + 0.55 * speedN + 0.9 * punch);
    cu.uMotionNear.value.set(params.motionNear, params.motionFull);

    // ---- boost rush ---------------------------------------------------------------------
    // Both halves start well up the boost range. The old thresholds (0.05 for the radial
    // blur, 0.18 for the lines) meant *any* boost at all — a pad, the weakest mini-turbo —
    // engaged the whole effect, which is why review plates taken at an ordinary 58-62 km/h
    // came back with smeared edges and speed lines across the sky.
    const rush = smoothstep(params.rushOn, 1.0, punch);
    cu.uRush.value = params.rushStrength * rush + 0.0035 * smoothstep(0.88, 1.3, speedN);
    cu.uRushLines.value = params.rushLines * smoothstep(params.rushLinesOn, 1.0, punch);

    // ---- depth of field ------------------------------------------------------------------
    cu.uFocus.value.set(params.focusNear, params.focusFar);
    cu.uDofMax.value = params.dofMax;
    cu.tBlur.value = dofPass.texture;

    // ---- bloom -----------------------------------------------------------------------------
    // A modest kick only. Scaling strength hard with boost compounds with the extra light
    // the flame itself puts into the frame, so the one moment the kart most needs to stay
    // readable is the moment bloom is loudest.
    bloomPass.strength = params.bloomStrength * (1 + 0.30 * punch);
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
    passes: { scenePass, sourcePass, aoPass, bloomPass, dofPass, compositePass,
      keyPass, smaaPass, resolvePass },
    get renderScale() { return superSample; },
    /** Toggle the grade LUT off for A/B comparisons; the rest of the stack keeps running. */
    setGradeEnabled(on) { gradeOn = !!on; cu.uLutMix.value = gradeOn ? params.lutMix : 0; },
  };
}

export default createPostFX;
