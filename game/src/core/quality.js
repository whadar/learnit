/**
 * Kat Racing — quality tiers and GPU detection.
 *
 * The review harness renders under SwiftShader (pure software), a phone renders under a tile
 * GPU and a desktop renders under a discrete card. One build has to be usable on all three, so
 * every expensive system takes its budget from here instead of hard-coding one.
 *
 *   import { createQuality } from './core/quality.js';
 *   const quality = createQuality(engine, { override: 'auto' });
 *   quality.settings.vegetation      // 0..1 density/detail knob passed to createVegetation()
 *   quality.set('high');             // live-apply what can be applied without a rebuild
 *   quality.onChange(s => …);
 *
 * `detectTier()` never throws: if WEBGL_debug_renderer_info is unavailable it falls back to a
 * conservative middle tier, and a `?q=` query parameter always wins so the harness and the
 * settings menu can pin a tier.
 */

/** Names in renderer strings that mean "there is no GPU behind this context". */
const SOFTWARE_RE = /swiftshader|software|llvmpipe|softpipe|mesa offscreen|basic render|microsoft basic|warp/i;
/** Low-power integrated / mobile parts that should not be handed the full stack. */
const WEAK_RE = /(intel.*(hd|uhd) graphics)|apple a\d|adreno [1-5]\d\d|mali-[tg]?\d{2,3}\b|powervr|videocore/i;
/** Parts that can take everything. */
const STRONG_RE = /(rtx|radeon rx|geforce (gtx )?(9|10|16|20|30|40|50)\d\d)|(apple m[1-9])|(arc a\d{3})|(quadro (rtx|p[45678]))/i;

export const TIER_IDS = ['potato', 'low', 'medium', 'high'];
export const TIER_NAMES = ['Potato', 'Low', 'Medium', 'High'];

/**
 * Every tunable the game reads. Tiers are authored as full settings objects rather than diffs
 * so a reader can see exactly what each level costs.
 */
export const TIERS = [
  {
    id: 'potato', name: 'Potato', index: 0,
    pixelRatio: 1.0,
    shadows: false, shadowMapSize: 1024, cascades: 2, shadowFar: 420,
    terrainQuality: 0.35, terrainTex: 512, terrainChunks: 16,
    vegetation: 0.22, vegetationShadows: false,
    buildings: 0.45, buildingShadows: false,
    roads: true, furniture: true, decals: true,
    post: false, postTier: 0,
    vfx: 0.30, vfxSoft: false, vfxAmbience: false,
    field: 8, aniso: 1, fogFar: 1400,
    label: 'Software renderer — geometry only, no post',
  },
  {
    id: 'low', name: 'Low', index: 1,
    pixelRatio: 1.0,
    shadows: true, shadowMapSize: 1024, cascades: 2, shadowFar: 600,
    terrainQuality: 0.5, terrainTex: 512, terrainChunks: 24,
    vegetation: 0.45, vegetationShadows: false,
    buildings: 0.7, buildingShadows: true,
    roads: true, furniture: true, decals: true,
    post: true, postTier: 1,
    vfx: 0.5, vfxSoft: false, vfxAmbience: true,
    field: 8, aniso: 4, fogFar: 1800,
    label: 'Shadows + bloom',
  },
  {
    id: 'medium', name: 'Medium', index: 2,
    pixelRatio: 1.25,
    shadows: true, shadowMapSize: 2048, cascades: 3, shadowFar: 900,
    terrainQuality: 0.8, terrainTex: 1024, terrainChunks: 32,
    vegetation: 0.8, vegetationShadows: true,
    buildings: 1.0, buildingShadows: true,
    roads: true, furniture: true, decals: true,
    post: true, postTier: 2,
    vfx: 0.8, vfxSoft: true, vfxAmbience: true,
    field: 8, aniso: 8, fogFar: 2400,
    label: 'Cascaded shadows, AO, depth of field',
  },
  {
    id: 'high', name: 'High', index: 3,
    pixelRatio: 1.5,
    shadows: true, shadowMapSize: 2048, cascades: 3, shadowFar: 1100,
    terrainQuality: 1.0, terrainTex: 1024, terrainChunks: 32,
    vegetation: 1.0, vegetationShadows: true,
    buildings: 1.0, buildingShadows: true,
    roads: true, furniture: true, decals: true,
    post: true, postTier: 3,
    vfx: 1.0, vfxSoft: true, vfxAmbience: true,
    field: 8, aniso: 16, fogFar: 3000,
    label: 'Everything on',
  },
];

export const tierByIndex = i => TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.round(i || 0)))];
export const tierById = id => TIERS.find(t => t.id === id) || null;

/** Read the unmasked GPU strings out of a live renderer. Returns empty strings on failure. */
export function gpuInfo(renderer) {
  const out = { vendor: '', renderer: '', software: false, weak: false, strong: false };
  try {
    const gl = renderer?.getContext?.();
    if (!gl) return out;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      out.vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
      out.renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    if (!out.renderer) out.renderer = String(gl.getParameter(gl.RENDERER) || '');
    if (!out.vendor) out.vendor = String(gl.getParameter(gl.VENDOR) || '');
  } catch (e) { /* a locked-down context tells us nothing; assume the middle */ }
  const s = out.vendor + ' ' + out.renderer;
  out.software = SOFTWARE_RE.test(s);
  out.weak = !out.software && WEAK_RE.test(s);
  out.strong = !out.software && STRONG_RE.test(s);
  return out;
}

/**
 * Pick a tier index for this machine.
 *   software renderer          -> 0   (the screenshot harness lands here)
 *   integrated / mobile        -> 1
 *   unknown                    -> 2
 *   known discrete / Apple si  -> 3
 * `deviceMemory` and `hardwareConcurrency` nudge the unknown case.
 */
export function detectTier(renderer) {
  const info = gpuInfo(renderer);
  let idx = 2;
  if (info.software) idx = 0;
  else if (info.weak) idx = 1;
  else if (info.strong) idx = 3;
  else {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
    if (cores <= 4 || mem <= 4) idx = 1;
    if (cores >= 12 && mem >= 8) idx = 3;
  }
  return { index: idx, info };
}

/** `?q=high` / `?q=0` / localStorage override, or null. */
function readOverride() {
  let want = null;
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q) want = q;
  } catch (e) { /* no location */ }
  if (!want) {
    try { want = localStorage.getItem('kat.quality'); } catch (e) { /* no storage */ }
  }
  if (!want || want === 'auto') return null;
  if (/^\d+$/.test(want)) return Math.max(0, Math.min(3, +want));
  const t = tierById(want.toLowerCase());
  return t ? t.index : null;
}

/**
 * @param {Engine} engine
 * @param {{override?:string|number, min?:number, max?:number, persist?:boolean}} [opts]
 */
export function createQuality(engine, opts = {}) {
  const det = detectTier(engine?.renderer);
  const forced = opts.override != null && opts.override !== 'auto'
    ? (typeof opts.override === 'number' ? opts.override : (tierById(String(opts.override))?.index ?? null))
    : readOverride();

  const min = opts.min ?? 0, max = opts.max ?? 3;
  let auto = forced == null;
  let index = Math.max(min, Math.min(max, forced == null ? det.index : forced));

  const listeners = [];
  /** Systems that can be re-tuned live register themselves here. */
  const live = { post: null, vfx: null, vegetation: null, lighting: null, terrain: null };

  function settings() { return TIERS[index]; }

  function applyRenderer() {
    const s = settings();
    const r = engine?.renderer;
    if (!r) return;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    r.setPixelRatio(Math.min(dpr, s.pixelRatio));
    r.shadowMap.enabled = s.shadows;
    r.shadowMap.needsUpdate = true;
    engine.resize?.();
  }

  /** Apply what can change without rebuilding the world. */
  function apply() {
    const s = settings();
    applyRenderer();
    try { live.post?.setQuality(s.postTier); } catch (e) { /* keep the frame */ }
    try { live.vfx?.setQuality(s.vfx); } catch (e) { /* keep the frame */ }
    try { live.vegetation?.setQuality?.(s.vegetation); } catch (e) { /* keep the frame */ }
    if (live.post) live.post.enabled = s.post;
    for (const cb of listeners) { try { cb(s, index); } catch (e) { /* a listener never breaks a frame */ } }
  }

  const api = {
    get index() { return index; },
    get id() { return settings().id; },
    get name() { return settings().name; },
    get settings() { return settings(); },
    get auto() { return auto; },
    get gpu() { return det.info; },
    get detected() { return det.index; },
    tiers: TIERS,
    /** Software rasteriser — the harness, or a machine with no GPU at all. */
    get software() { return !!det.info.software; },
    set(t, { persist = true } = {}) {
      const want = typeof t === 'number' ? t : (t === 'auto' ? det.index : (tierById(String(t))?.index ?? index));
      auto = t === 'auto';
      const next = Math.max(min, Math.min(max, want));
      if (next === index) { if (persist) save(); return api; }
      index = next;
      if (persist) save();
      apply();
      return api;
    },
    step(dir) { return api.set(Math.max(0, Math.min(3, index + Math.sign(dir)))); },
    register(systems) { Object.assign(live, systems); apply(); return api; },
    onChange(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
    apply,
    describe() {
      return `${settings().name} (${settings().label}) — ${det.info.renderer || 'unknown GPU'}`
        + (auto ? ' [auto]' : ' [manual]');
    },
  };

  function save() {
    try { localStorage.setItem('kat.quality', auto ? 'auto' : settings().id); } catch (e) { /* private mode */ }
  }

  applyRenderer();
  return api;
}

export default createQuality;
