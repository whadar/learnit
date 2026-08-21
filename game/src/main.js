/**
 * Kat Racing — the game.
 *
 * Boot → loading screen → title → character select → course select → race → results.
 * This module owns nothing but the wiring: every system here is built by its own module and
 * is expected to survive its neighbours failing, because the review harness must always reach
 * `window.__game.ready`.
 *
 * Automation surface (see docs/CONTRACT.md):
 *   window.__game = { engine, world, ready, error, views, setView(name), renderOnce() }
 * plus, for the review harness and the scripted drive test:
 *   .race .camera .quality .systems .scenario(name) .drive(inputs, seconds) .simulate(seconds)
 *   .setFixedStep(dt) .snapshot()
 */
import * as THREE from 'three';

import { Engine } from './core/engine.js';
import { createQuality } from './core/quality.js';
import { createInput } from './core/input.js';
import { clamp, lerp } from './core/mathx.js';

import { WorldData } from './world/worldData.js';
import { createSky } from './world/sky.js';
import { createTerrain } from './world/terrain.js';
import { createRoads } from './world/roads.js';
import { createBuildings } from './world/buildings.js';
import { createVegetation } from './world/vegetation.js';

import { buildTrack } from './track/track.js';
import { createTrackMesh } from './track/trackMesh.js';

import { createCollisionWorld } from './physics/collision.js';
import { createRace, fmtTime } from './game/race.js';
import { createItemSystem } from './game/items.js';
import { createCamera } from './game/camera.js';
import { createRoster, createRacer } from './characters/roster.js';

import { createVFX } from './render/particles.js';
import { createPostFX } from './render/post.js';

import { createHUD } from './ui/hud.js';
import { createMenu } from './ui/menu.js';

/* ------------------------------------------------------------------ setup -- */

const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const flag = (k, d = false) => { const v = Q.get(k); return v == null ? d : !(v === '0' || v === 'false' || v === 'off'); };
const num = (k, d) => { const v = +Q.get(k); return Number.isFinite(v) && Q.get(k) != null ? v : d; };

const app = (typeof document !== 'undefined' && document.getElementById('app')) || document.body;
const engine = new Engine(app);
// The Israeli midsummer sun plus bright limestone dust puts the ground at the top of the ACES
// curve; 0.85 keeps the dry farm tracks off pure white without crushing the village.
engine.renderer.toneMappingExposure = num('exposure', 0.72);

const S = {                                   // every subsystem, once it exists
  world: null, quality: null, input: null, menu: null, hud: null,
  sky: null, lighting: null, terrain: null, roads: null, buildings: null, vegetation: null,
  track: null, trackMesh: null, collision: null,
  race: null, items: null, camera: null, vfx: null, post: null, audio: null,
  racers: [],                                  // visual cat+kart rigs, index-matched to race.racers
};

const game = (typeof window !== 'undefined' ? window : globalThis).__game = {
  engine, world: null, ready: false, error: null, views: {},
  systems: S,
  setView, renderOnce,
};

/* ---------------------------------------------------------------- app fsm -- */

const RUSH_MAX = 0.30;   // ceiling on the screen-space speed-line overlay
const APP = { mode: 'boot', paused: false, review: flag('review', false), fixedStep: 0, viewLock: null };
let lastDt = 1 / 60;
let attractT = 0;

/* ================================================================== boot === */

const REVIEW = APP.review;
const quality = S.quality = createQuality(engine, { override: Q.get('q') || undefined });
const QS = () => quality.settings;

const menu = S.menu = createMenu({
  mount: app,
  roster: [],                                   // filled once the roster is known (below)
  courses: [],
  quality,
});

/** Yield to the browser so the loading screen can actually paint between build steps. */
const frame = () => new Promise(r => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

let bootStep = 0;
const BOOT_STEPS = 12;
async function step(msg) {
  menu.setLoading(Math.min(0.98, ++bootStep / BOOT_STEPS), msg);
  await frame();
}

/** Never let one system take the whole game down. */
function guard(label, fn, fallback = null) {
  try { return fn(); }
  catch (e) {
    console.error('[kat] ' + label + ' failed:', e);
    (game.warnings || (game.warnings = [])).push(label + ': ' + (e && e.message || e));
    return fallback;
  }
}

async function boot() {
  const t0 = performance.now();
  const mark = m => console.log(`[kat] ${m} ${Math.round(performance.now() - t0)} ms`);

  menu.show('loading');
  menu.setLoading(0.02, 'reading Amikam');
  await frame();

  /* ---- real world data ---- */
  // 'data/' is right for the built game at the site root; the /preview/ page (and any
  // sub-path deploy) needs the absolute one. Try both rather than guess.
  const world = S.world = game.world = await WorldData.load('data/')
    .catch(() => WorldData.load('/data/'));
  mark('worldData');
  await step('draping the circuit');

  /* ---- the circuit ---- */
  S.track = guard('track', () => buildTrack(world, { laps: num('laps', 3) }));
  if (!S.track) throw new Error('the circuit could not be built');
  // …and make the landscape agree with it. See conformWorldToTrack().
  guard('conform', () => conformWorldToTrack(world, S.track));
  S.collision = guard('collision', () => createCollisionWorld(world, S.track, {}));
  mark('track');
  await step('raising the sun');

  /* ---- sky + lighting (createSky owns the lighting rig) ---- */
  S.sky = guard('sky', () => createSky(engine, world, {
    hour: num('hour', 15.4),   // mid-afternoon: long enough shadows to read, white enough sun
                               // that tarmac is grey and the groves are green
    shadows: QS().shadows,
    shadowMapSize: QS().shadowMapSize,
    cascades: QS().cascades,
    shadowFar: QS().shadowFar,
  }));
  S.lighting = S.sky?.lighting || engine.lighting || null;
  mark('sky');
  await step('carving the hills');

  /* ---- terrain ---- */
  S.terrain = guard('terrain', () => createTerrain(engine, world, {
    quality: QS().terrainQuality, texSize: QS().terrainTex, chunks: QS().terrainChunks,
  }));
  mark('terrain');
  await step('paving the streets');

  S.roads = guard('roads', () => createRoads(engine, world, {
    track: S.track, shadows: QS().shadows,
  }));
  mark('roads');
  await step('building the moshav');

  S.buildings = guard('buildings', () => createBuildings(engine, world, {
    quality: QS().buildings, shadows: QS().buildingShadows,
  }));
  mark('buildings');
  await step('planting the groves');

  S.vegetation = guard('vegetation', () => createVegetation(engine, world, {
    quality: QS().vegetation, shadows: QS().vegetationShadows,
    // vegetation.js masks itself off the real road network, but the circuit crosses open
    // orchard and bare hillside where no OSM road exists — hand it the corridor explicitly
    // or olive trees grow in the middle of the racing line.
    blockers: trackBlockers(S.track),
  }));
  mark('vegetation');
  await step('laying the tarmac');

  /* ---- the racing surface, kerbs, furniture ---- */
  S.trackMesh = guard('trackMesh', () => createTrackMesh(engine, world, S.track, {
    shadows: QS().shadows, furniture: QS().furniture, itemBoxes: false,
  }));
  mark('trackMesh');
  await step('unpacking the item boxes');

  /* ---- effects ---- */
  S.vfx = guard('vfx', () => createVFX(engine, world, {
    quality: QS().vfx, soft: QS().vfxSoft, ambience: QS().vfxAmbience,
    sunDirection: S.sky?.sunDir,
  }));
  if (S.vfx && S.sky?.sunDir) guard('vfx.sun', () => S.vfx.setSunDirection(S.sky.sunDir));
  mark('vfx');
  await step('waking the cats');

  /* ---- the field ---- */
  const roster = createRoster();
  S.roster = roster;
  buildMenuData(roster);

  S.items = guard('items', () => createItemSystem(world, S.track, {
    scene: engine.scene, visuals: true, seed: 4242,
  }));
  mark('items');
  await step('lining up the grid');

  buildRace(0, { skipIntro: true, autopilot: true });
  mark('race');
  await step('rolling camera');

  /* ---- camera, HUD, input ---- */
  S.camera = createCamera(engine, world, { track: S.track });
  S.hud = guard('hud', () => createHUD({
    mount: app, track: S.track, world, field: 8, laps: S.race?.laps ?? 3,
    minimapSize: 190, trackName: S.track.name,
  }));
  S.hud?.hide();

  S.input = guard('input', () => createInput({ element: engine.renderer.domElement, touch: 'auto' }));

  /* ---- post ---- */
  if (QS().post && flag('post', true)) attachPost();
  mark('post');
  await step('tuning the engines');

  /* ---- audio (silent until a user gesture; a no-op in the harness) ---- */
  if (flag('audio', true)) {
    S.audio = await guard('audio', async () => {
      const { createAudio } = await import('./audio/audio.js');
      const a = createAudio({ character: roster[0].id });
      a.init(engine.camera);
      return a;
    }, null);
  }
  mark('audio');

  quality.register({ post: S.post, vfx: S.vfx, vegetation: S.vegetation, lighting: S.lighting });
  quality.onChange(applyQualityLive);

  buildViews();
  engine.add({ update: tick, resize: onResize });
  engine.start();

  menu.setLoading(1, 'ready');
  menu.setGPU(quality.describe());

  if (REVIEW || flag('auto', false)) {
    // The harness and the scripted drive test skip the front end entirely.
    menu.hide();
    APP.mode = 'race';
    APP.fixedStep = 1 / 60;
    startRace(menu.state.character, { skipIntro: true, autopilot: true });
  } else {
    APP.mode = 'menu';
    menu.show('title');
    S.camera.setMode('fixed');
    // Attract mode: a real race runs on autopilot under the title card, so the fly-over is
    // looking at eight karts actually racing rather than an empty circuit.
    guard('attract', () => { S.race.reset(); S.race.start(true); });
  }

  game.ready = true;
  mark('ready');
}



/** The circuit centreline as a road-shaped feature, for anything that masks against roads. */
function trackBlockers(track) {
  const paths = [];
  let cur = [];
  let maxW = 12;
  const N = track.points ? track.points.length : 0;
  for (let i = 0; i < N; i += 2) {
    const p = track.points[i];
    cur.push([p.x, p.z]);
  }
  if (N) { cur.push([track.points[0].x, track.points[0].z]); paths.push(cur); }
  for (const sec of (track.sectors || [])) maxW = Math.max(maxW, sec.w || 12);
  return [{ paths, width: maxW + 3.5 }];
}

/* ======================================================= terrain conform === */

/**
 * Make the heightfield agree with the circuit.
 *
 * `track.js` drapes the racing line over the DEM and then *smooths* it hard, because a kart
 * cannot drive over 3 m SRTM stair-steps. `collision.js` drives on that smoothed ribbon. But
 * `terrain.js` renders the raw heightfield, which it must — it knows nothing about a circuit —
 * so wherever the raw ground sits above the smoothed ribbon the hillside is drawn straight
 * through the tarmac: the road disappears, the karts look buried, and any camera that keeps
 * itself above the ground gets shoved into the air.
 *
 * Rather than edit somebody else's module, this wraps `world.heightAt` once, before anything
 * has sampled it, with a corridor raster: inside the ribbon the ground *is* the ribbon (a
 * couple of centimetres under it, so the road mesh always wins the depth test), and it fades
 * back to the real SRTM surface over a 14 m shoulder. Terrain, roads, vegetation, buildings
 * and the physics all read `heightAt`, so all of them conform to the circuit together —
 * exactly what a real road cutting does to a hillside.
 */
function conformWorldToTrack(world, track, opts = {}) {
  const CELL = opts.cell ?? 1.5;
  const FALL = opts.falloff ?? 14.0;      // metres of shoulder back to the raw terrain
  const SINK = opts.sink ?? 0.20;         // how far under the ribbon the ground is cut

  const pts = track.points && track.points.length
    ? track.points
    : (() => { const a = []; for (let s = 0; s < track.length; s += 2) a.push(track.sample(s).pos); return a; })();

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxW = 12;
  const N = pts.length;
  const samples = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    const sm = track.sample((i / N) * track.length);
    const w = sm.width || 12;
    maxW = Math.max(maxW, w);
    samples[i] = {
      x: p.x, y: p.y, z: p.z, hw: w * 0.5,
      nx: sm.normal.x, nz: sm.normal.z, tb: Math.tan(sm.banking || 0),
    };
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const pad = maxW * 0.5 + FALL + CELL * 2;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const NX = Math.ceil((maxX - minX) / CELL) + 1;
  const NZ = Math.ceil((maxZ - minZ) / CELL) + 1;
  if (NX * NZ > 4e6) return null;                     // absurd track: leave the world alone

  const wt = new Float32Array(NX * NZ);
  const ty = new Float32Array(NX * NZ);
  const bd = new Float32Array(NX * NZ).fill(Infinity);

  // Nearest centreline wins, *by distance* — not by weight. The circuit doubles back on
  // itself down The Nose and round the wadi hairpin, and those two passes are 1.5 m apart
  // vertically: picking by weight lets whichever was stamped first own the cell and leaves
  // the other pass buried under its neighbour's embankment.
  for (const s of samples) {
    const R = s.hw + FALL;
    const i0 = Math.max(0, Math.floor((s.x - R - minX) / CELL));
    const i1 = Math.min(NX - 1, Math.ceil((s.x + R - minX) / CELL));
    const j0 = Math.max(0, Math.floor((s.z - R - minZ) / CELL));
    const j1 = Math.min(NZ - 1, Math.ceil((s.z + R - minZ) / CELL));
    for (let j = j0; j <= j1; j++) {
      const cz = minZ + j * CELL, dz = cz - s.z;
      for (let i = i0; i <= i1; i++) {
        const cx = minX + i * CELL, dx = cx - s.x;
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const k = j * NX + i;
        if (d >= bd[k]) continue;
        bd[k] = d;
        // 1 across the ribbon, smoothly back to 0 at the outside of the shoulder
        wt[k] = 1 - smoothstepLocal(0, 1, clamp((d - s.hw - 0.4) / FALL, 0, 1));
        const lateral = dx * s.nx + dz * s.nz;         // + is left of travel
        ty[k] = s.y + s.tb * clamp(lateral, -s.hw, s.hw) - SINK;
      }
    }
  }

  const raw = world.heightAt.bind(world);
  world.rawHeightAt = raw;
  world.trackCorridor = { minX, minZ, NX, NZ, CELL, wt, ty };

  world.heightAt = function conformedHeightAt(x, z) {
    const h = raw(x, z);
    const fx = (x - minX) / CELL, fz = (z - minZ) / CELL;
    const i = fx | 0, j = fz | 0;
    if (i < 0 || j < 0 || i >= NX - 1 || j >= NZ - 1) return h;
    const sx = fx - i, sz = fz - j;
    const k00 = j * NX + i, k10 = k00 + 1, k01 = k00 + NX, k11 = k01 + 1;
    const w = (wt[k00] * (1 - sx) + wt[k10] * sx) * (1 - sz) + (wt[k01] * (1 - sx) + wt[k11] * sx) * sz;
    if (w <= 0.0015) return h;
    const t = (ty[k00] * (1 - sx) + ty[k10] * sx) * (1 - sz) + (ty[k01] * (1 - sx) + ty[k11] * sx) * sz;
    return h + (t - h) * w;
  };
  return world.trackCorridor;
}
const smoothstepLocal = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* ================================================================ menus === */

function buildMenuData(roster) {
  const preview = [];
  try {
    const L = S.track.length;
    for (let s = 0; s < L; s += L / 128) { const p = S.track.sample(s); preview.push([p.pos.x, p.pos.z]); }
  } catch (e) { /* the card just draws a plain plate */ }

  const courses = [
    {
      id: 'amikam', name: S.track.name || 'Amikam Village Circuit',
      blurb: 'The real streets, farm tracks and olive groves of Moshav Amikam — a climb to the ridge, a hairpin at the summit and a plunge back to the fields.',
      laps: S.track.laps ?? 3, lengthM: S.track.length, surface: 'Tarmac & dirt', preview,
    },
    { id: 'amikam-reverse', name: 'Amikam Reverse', blurb: 'Coming soon.', laps: 3, lengthM: S.track.length, preview, locked: true },
  ];

  menu.setData({ roster, courses });
  menu.on('start', e => { menu.hide(); startRace(e.characterIndex, { skipIntro: false, autopilot: false }); });
  menu.on('resume', () => resumeRace());
  menu.on('restart', () => { menu.hide(); startRace(lastCharacter, { skipIntro: true, autopilot: false }); });
  menu.on('quit', () => quitToTitle());
  menu.on('photo', () => { menu.hide(); enterPhoto(); });
  menu.on('setting', e => applySetting(e));
  menu.setGPU(quality.describe());
}

function applySetting(e) {
  if (e.key === 'music') S.audio?.setVolume?.('music', e.value);
  if (e.key === 'sfx') { S.audio?.setVolume?.('sfx', e.value); S.audio?.setVolume?.('engine', e.value * 0.5); }
  if (e.key === 'minimap') S.hud?.setMinimapMode(e.value);
  if (e.key === 'difficulty') S.race?.setDifficulty(e.value);
}

function applyQualityLive() {
  const s = QS();
  if (s.post && !S.post) attachPost();
  if (!s.post && S.post) { engine.composer = null; }
  else if (s.post && S.post) engine.composer = composerAdapter;
  engine.renderer.shadowMap.enabled = s.shadows;
  engine.renderer.shadowMap.needsUpdate = true;
}

/* ================================================================== post === */

let composerAdapter = null;
function attachPost() {
  S.post = guard('post', () => createPostFX(engine.renderer, engine.scene, engine.camera, {
    width: engine.renderer.domElement.clientWidth || 1280,
    height: engine.renderer.domElement.clientHeight || 720,
    quality: QS().postTier,
    // A kart game puts additive drift smoke, sparks and boost flame two metres from the lens,
    // and the stock shutter smears the road to mush at 90 km/h. The bloom trims that used to
    // live here (0.42 / 8.2 / 1.5) were the cause of the white hole they were meant to
    // prevent — post.js now ships the kart-safe numbers as its defaults, so only the shutter
    // and the lens fringe need trimming from the call site.
    motionShutter: 0.45, motionMax: 0.0085,
    chromatic: 0.0026,
  }));
  if (!S.post) return;
  guard('post.quality', () => S.post.setQuality(QS().postTier));
  composerAdapter = {
    render: () => S.post.render(lastDt),
    setSize: (w, h) => S.post.setSize(w, h),
  };
  // The post stack deliberately renders the scene *exactly* as it would have gone to the
  // canvas — renderer ACES tone mapping on, target tagged sRGB — and grades that. Turning the
  // renderer's tone mapping off here would blend lighting.js's aerial perspective in the wrong
  // space and turn the whole distance milky. See the header of render/materials/postShaders.js.
  engine.composer = composerAdapter;
}

/* ================================================================== race === */

let lastCharacter = 0;
let raceUnsub = [];
/** true once a human (or the scripted drive test) has taken the player's kart. */
let humanDriving = false;

function buildRace(characterIndex, { skipIntro = false, autopilot = true } = {}) {
  for (const u of raceUnsub) { try { u(); } catch (e) { /* ignore */ } }
  raceUnsub = [];

  const roster = S.roster;
  const field = 8;
  // The chosen cat always drives kart 0 (pole is decided on the grid, not in the menu).
  const chosen = roster[clamp(characterIndex | 0, 0, roster.length - 1)];
  const rest = roster.filter(r => r.id !== chosen.id);
  const entries = [chosen, ...rest].slice(0, field);
  lastCharacter = characterIndex | 0;

  S.items?.reset?.();

  const race = S.race = createRace(S.world, S.track, {
    field, laps: S.track.laps ?? 3, roster: entries, items: S.items,
    difficulty: S.menu?.settings?.difficulty ?? 150,
    playerIndex: 0, autopilot,
    collision: S.collision,
    introTime: skipIntro ? 0.01 : num('intro', 7.0),
    countdownTime: 3.6,
    seed: 5150,
  });

  buildRacerVisuals(entries, race);
  wireRaceEvents(race);
  return race;
}

/** One cat-in-a-kart rig per entry, plus its VFX emitter rig bound to that kart's physics. */
function buildRacerVisuals(entries, race) {
  for (const r of S.racers) {
    try { r.vfx?.detach(); } catch (e) { /* ignore */ }
    try { engine.scene.remove(r.rig.object3D); r.rig.dispose(); } catch (e) { /* ignore */ }
  }
  S.racers = [];
  const detail = QS().index <= 0 ? 'low' : QS().index === 1 ? 'med' : 'high';
  const env = S.sky?.envMap || null;

  entries.forEach((entry, i) => {
    const rig = guard('racer:' + entry.id, () => createRacer(entry.id, {
      detail, shadows: QS().shadows, env,
    }));
    if (!rig) return;
    engine.scene.add(rig.object3D);
    const rec = { rig, entry, index: i, vfx: null, hitT: 0 };
    if (S.vfx && race.vehicles[i]) {
      rec.vfx = guard('vfxRig', () => S.vfx.attach(race.vehicles[i], { seed: 900 + i * 31 }));
    }
    S.racers.push(rec);
  });
}

function wireRaceEvents(race) {
  const push = u => raceUnsub.push(u);
  push(race.on('phase', e => {
    const p = e.phase;
    // A pinned review view owns the camera and the screen; phase changes must not steal them.
    if (!APP.viewLock) {
      if (p === 'intro') S.camera?.setMode('intro', { snap: true });
      if (p === 'countdown' || p === 'racing') {
        S.camera?.setMode('chase', { snap: race.state.phase === 'countdown' });
        S.hud?.show(true);
      }
      if (p === 'results') showResults();
    }
    const cue = p === 'racing' ? 'go' : p === 'results' ? 'finish' : null;
    if (cue) guard('audio.cue', () => S.audio?.play?.(cue));
  }));
  push(race.on('lap', e => {
    if (e.racer.isPlayer) { S.hud?.flashBoost(0.4); S.audio?.play?.('lap_chime'); }
  }));
  push(race.on('rocket', e => { if (e.racer.isPlayer && e.kind !== 'none') S.hud?.flashBoost(0.9); }));
  push(race.on('finish', e => { if (e.racer.isPlayer) S.hud?.flashBoost(0.6); }));

  if (S.items) {
    push(S.items.onHit(e => {
      if (e.type === 'use' || e.type === 'draw') {
        if (e.type === 'use') guard('audio.item', () => S.audio?.play?.(e.item, { pos: e.victimRec?.pos }));
        return;
      }
      if (e.type !== 'hit' && e.type !== 'block') return;
      const v = e.victim;
      const idx = race.racers.findIndex(r => r.vehicle === v);
      const rec = idx >= 0 ? S.racers[idx] : null;
      if (rec) rec.hitT = 0.9;
      const isPlayer = idx >= 0 && race.racers[idx].isPlayer;
      if (isPlayer) { S.hud?.shakeHit(e.type === 'hit' ? 1 : 0.4); S.camera?.addShake(e.type === 'hit' ? 0.8 : 0.35); }
      const p = e.pos || (v && v.state && v.state.pos);
      if (p && S.vfx) guard('hitBurst', () => S.vfx.emit(e.type === 'hit' ? 'spinOut' : 'railSparks', {
        pos: _hit.set(p.x, p.y + 0.55, p.z), scale: 1.4,
      }));
      guard('audio.hit', () => S.audio?.play?.(e.kind === 'slip' ? 'hit_slip' : 'hit_spin', { pos: p }));
    }));
  }
}

function startRace(characterIndex = lastCharacter, opts = {}) {
  APP.viewLock = null;
  const race = buildRace(characterIndex, opts);
  race.reset();
  race.start(!!opts.skipIntro);
  humanDriving = opts.autopilot === false;
  if (humanDriving) race.setInput(playerInput);
  S.hud?.show(true);
  S.camera?.setTarget(race.state.player?.vehicle || race.vehicles[0]);
  S.camera?.setMode(opts.skipIntro ? 'chase' : 'intro', { snap: true });
  APP.mode = 'race'; APP.paused = false;
  S.menu?.hide();
  syncRacerVisuals(0, true);
  return race;
}

function showResults() {
  if (APP.viewLock || APP.mode === 'menu') return;
  const rows = S.race.results.map(r => ({
    place: r.place, name: r.name, time: r.time, bestLap: r.bestLap, isPlayer: r.isPlayer, dnf: r.dnf,
  }));
  S.menu.setResults(rows, { format: fmtTime, course: S.track.name });
  S.menu.show('results');
  S.hud?.show(false);
  S.camera?.setMode('results');
  APP.mode = 'results';
}

function pauseRace() {
  if (APP.mode !== 'race' || APP.paused) return;
  APP.paused = true;
  S.menu.show('pause');
  S.audio?.duck?.(0.4);
}
function resumeRace() {
  APP.paused = false;
  S.menu.hide();
  S.hud?.show(true);
  S.audio?.duck?.(1);
  APP.mode = 'race';
}
function quitToTitle() {
  APP.viewLock = null;
  APP.mode = 'menu'; APP.paused = false;
  S.hud?.show(false);
  S.menu.show('title');
  S.camera?.setMode('fixed');
}
function enterPhoto() {
  APP.viewLock = null;
  APP.mode = 'photo';
  S.hud?.show(false);
  S.camera?.setMode('photo');
}

/* =============================================================== the loop == */

const playerInput = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
const photoInput = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0, fast: false, fov: 0 };
let pausePrev = false, photoPrev = false, resetPrev = false;
/** Scripted input for the headless drive test; overrides the human when set. */
let scripted = null;

function readInput(dt) {
  const raw = S.input ? S.input.poll(dt) : null;
  if (!raw) return null;

  // pause / photo / respawn edges
  if (raw.pause && !pausePrev) {
    if (APP.mode === 'race' && !APP.paused) pauseRace();
    else if (APP.paused) resumeRace();
    else if (APP.mode === 'photo') { APP.mode = 'race'; S.camera.setMode('chase', { snap: true }); S.hud?.show(true); }
  }
  pausePrev = raw.pause;
  const pKey = S.input.keyHeld?.('KeyF');
  if (pKey && !photoPrev) { if (APP.mode === 'photo') { APP.mode = 'race'; S.camera.setMode('chase', { snap: true }); S.hud?.show(true); } else enterPhoto(); }
  photoPrev = pKey;
  if (raw.reset && !resetPrev && APP.mode === 'race') { try { S.race.state.player?.vehicle.respawn(); } catch (e) { /* ignore */ } }
  resetPrev = raw.reset;

  return raw;
}

function fillPlayerInput(raw) {
  const src = scripted || raw;
  if (!src) return playerInput;
  playerInput.throttle = clamp(src.throttle ?? 0, 0, 1);
  playerInput.brake = clamp(src.brake ?? 0, 0, 1);
  playerInput.steer = clamp(src.steer ?? 0, -1, 1);
  playerInput.drift = (src.drift ?? 0) > 0.5 ? 1 : 0;
  playerInput.item = (src.item ?? 0) > 0.5 ? 1 : 0;
  // input.js reports look-back as +1; the item system and the camera both read "backwards"
  // as a negative look axis, which is also how the AI signs it.
  playerInput.look = (src.look ?? 0) > 0.5 ? -1 : 0;
  // the khamsin scrambles your steering
  if (S.items && S.race?.state.player) {
    const b = S.items.steerBias(S.race.state.player.vehicle);
    if (b) playerInput.steer = clamp(playerInput.steer + b, -1, 1);
  }
  return playerInput;
}

function fillPhotoInput(raw) {
  const k = c => (S.input?.keyHeld?.(c) ? 1 : 0);
  photoInput.forward = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
  photoInput.right = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
  photoInput.up = k('KeyE') + k('Space') - k('KeyQ') - k('ShiftLeft');
  photoInput.yaw = k('KeyL') - k('KeyJ');
  photoInput.pitch = k('KeyI') - k('KeyK');
  photoInput.fov = k('BracketRight') - k('BracketLeft');
  photoInput.fast = !!S.input?.keyHeld?.('ShiftRight');
  void raw;
  return photoInput;
}

function tick(dt) {
  lastDt = dt = APP.fixedStep > 0 ? APP.fixedStep : clamp(dt, 1 / 240, 1 / 12);
  const raw = readInput(dt);

  /* ---- menus ---- */
  if (S.menu?.visible) {
    S.menu.update(dt, S.input?.menu(dt));
  }

  /* ---- attract camera on the title screen ---- */
  if (APP.mode === 'menu') {
    attractT += dt;
    attractCamera(attractT);
    if (S.race?.state.over) guard('attract', () => { S.race.reset(); S.race.start(true); });
  }

  /* ---- the race ---- */
  const race = S.race;
  if (race && (APP.mode === 'race' || APP.mode === 'results' || APP.mode === 'photo' || APP.mode === 'menu') && !APP.paused) {
    // The kart is driven by the human only when someone actually asked for it; otherwise the
    // race's own autopilot keeps the field complete (attract mode, review shots, demo).
    if (scripted) race.setInput(fillPlayerInput(null));
    else if (humanDriving && APP.mode === 'race') race.setInput(fillPlayerInput(raw));
    race.update(dt);
    // let the intro be skipped
    if (race.state.phase === 'intro' && raw && (raw.throttle > 0.5 || raw.item > 0.5)) race.skipIntro();
  }

  syncRacerVisuals(dt, false);

  /* ---- camera ---- */
  if (S.camera && APP.mode !== 'menu') {
    // A view pinned by setView() owns the camera until something else takes it back, so the
    // harness's cinematic plates are not stolen by the chase rig on the very next frame.
    if (!APP.viewLock) {
      const ph = race ? race.state.phase : 'idle';
      const mode = APP.mode === 'photo' ? 'photo'
        : ph === 'intro' ? 'intro' : ph === 'results' ? 'results' : 'chase';
      if (S.camera.mode !== mode && !(APP.mode === 'photo')) S.camera.setMode(mode, { snap: mode === 'chase' });
    }
    S.camera.update(dt, {
      phaseTime: race ? race.state.phaseTime : 0,
      introTime: race ? 7.0 : 0,
      winner: race?.state.winner?.vehicle || null,
      lookBack: playerInput.look < -0.5,
      photoInput: APP.mode === 'photo' ? fillPhotoInput(raw) : null,
    });
  }

  // The screen-space rush lines live on the camera and only make sense behind a kart; a
  // cinematic plate or the photo camera must not be streaked by the player's speed. At full
  // strength the additive overlay also blows the middle of the frame to white, so it is
  // capped here to the hint of speed it is meant to be.
  if (S.vfx) {
    if (S.camera && S.camera.mode !== 'chase') S.vfx.speed = 0;
    else if (S.vfx.speed > RUSH_MAX) S.vfx.speed = RUSH_MAX;
  }

  updateHUD(dt);
  updateAudio(dt);
  updatePost(dt);
}

/* --------------------------------------------------------- attract mode --- */

const _av = new THREE.Vector3();
function attractCamera(t) {
  const trk = S.track;
  if (!trk) return;
  const s = (t * 26) % trk.length;
  let a, b;
  try { a = trk.sample(s); b = trk.sample(s + 70); } catch (e) { return; }
  const swing = Math.sin(t * 0.21) * 26;
  _av.set(a.pos.x + a.normal.x * (34 + swing), a.pos.y + 26 + Math.sin(t * 0.33) * 7, a.pos.z + a.normal.z * (34 + swing));
  const gy = S.world.heightAt(_av.x, _av.z) + 14;
  if (_av.y < gy) _av.y = gy;
  S.camera.setFixed([_av.x, _av.y, _av.z], [b.pos.x, b.pos.y + 2, b.pos.z], 52);
}

/* ------------------------------------------------------- racer visuals ---- */

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _u = new THREE.Vector3();
const _hit = new THREE.Vector3();

function syncRacerVisuals(dt, snap) {
  const race = S.race;
  if (!race) return;
  for (let i = 0; i < S.racers.length; i++) {
    const rec = S.racers[i];
    const r = race.racers[i];
    if (!rec || !r) continue;
    const v = r.vehicle, st = v.state;
    const P = v.params;

    // suspension-aware drop: the kart mesh's y = 0 plane is the wheel contact plane
    let susp = 0;
    for (const w of v.wheels) susp += w.susp;
    susp /= Math.max(1, v.wheels.length);
    const drop = P.comHeight + susp + P.wheelRadius;

    _q.set(st.quat.x, st.quat.y, st.quat.z, st.quat.w);
    _u.set(0, 1, 0).applyQuaternion(_q);
    _p.set(st.pos.x - _u.x * drop, st.pos.y - _u.y * drop, st.pos.z - _u.z * drop);

    const o = rec.rig.object3D;
    o.position.copy(_p);
    o.quaternion.copy(_q);

    rec.hitT = Math.max(0, rec.hitT - dt);
    rec.rig.update(snap ? 0.016 : dt, {
      speed: st.speed, speedMax: P.topSpeed,
      steer: st.steer, drift: st.drift.active ? (st.drift.dir || 0) : 0,
      airborne: !st.grounded, boosting: st.boost.time > 0,
      hit: rec.hitT > 0.55, place: r.place,
      finished: race.state.phase === 'results' ? true : undefined,
    });

    // VFX rig reads the physics handle directly
    if (rec.vfx) rec.vfx.target = v;
  }
}

/* ------------------------------------------------------------------ hud --- */

const mapData = { racers: [], items: [], player: null };
function updateHUD(dt) {
  const hud = S.hud, race = S.race;
  if (!hud || !race) return;
  if (APP.mode !== 'race' || APP.paused) { return; }
  const p = race.state.player;
  const h = race.hud();
  const st = p?.vehicle.state;

  mapData.racers.length = 0;
  for (const r of race.racers) {
    const s = r.vehicle.state;
    mapData.racers.push({ x: s.pos.x, z: s.pos.z, yaw: s.yaw, place: r.place, player: r.isPlayer, finished: r.finished });
  }
  mapData.player = mapData.racers.find(r => r.player) || null;
  if (S.items) {
    mapData.items.length = 0;
    for (const b of S.items.boxes) mapData.items.push({ x: b.pos.x, z: b.pos.z, active: b.active });
  }

  // race.js leaves `message` and `rocket` latched at their last value; the HUD wants them as
  // events, so they are aged out here rather than shouting GO! for the whole race.
  const sinceGo = race.state.phase === 'racing' ? race.state.phaseTime : 99;
  const banner = race.state.phase === 'countdown' ? ''
    : (race.state.phase === 'racing' && sinceGo > 1.3) ? '' : h.message;
  hud.update(dt, {
    phase: h.phase, message: banner,
    countdown: h.countdown, sinceGo,
    lapAge: p ? race.state.raceTime - p.lapStart : 99,
    lap: h.lap, laps: h.laps, place: h.place, field: h.field,
    time: h.time, lapTime: h.lapTime, bestLap: h.bestLap,
    lastLap: p?.lapTimes.length ? p.lapTimes[p.lapTimes.length - 1] : undefined,
    lapCount: p?.lap,
    speedKmh: h.speedKmh, topSpeedKmh: (p?.vehicle.params.topSpeed ?? 25) * 3.6 * 1.45,
    item: h.item, wrongWay: h.wrongWay,
    rocket: (sinceGo < 2.8 && (p?.lap ?? 0) === 0) ? p.rocket : null,
    drift: st ? { active: st.drift.active, charge: st.drift.charge, tier: st.drift.tier } : null,
    boost: st ? st.boost : null,
    standings: race.standings.map(r => ({ place: r.place, name: r.name, player: r.isPlayer, gap: null })),
    minimap: mapData,
  });
}

/* ---------------------------------------------------------------- audio --- */

const audioCtx = { listener: null, vehicle: null, rivals: [], race: null };
function updateAudio(dt) {
  const a = S.audio, race = S.race;
  if (!a || !race) return;
  const p = race.state.player;
  if (!p) return;
  audioCtx.listener = engine.camera;
  audioCtx.vehicle = p.vehicle;
  audioCtx.rivals.length = 0;
  for (const r of race.racers) {
    if (r.isPlayer) continue;
    audioCtx.rivals.push({ id: r.id, pos: r.vehicle.state.pos, vel: r.vehicle.state.vel, state: r.vehicle.state });
  }
  audioCtx.race = {
    phase: race.state.phase, countdown: race.state.countdown,
    lap: p.lap + 1, laps: race.laps, lapProgress: p.u / race.length,
    place: p.place, field: race.racers.length,
  };
  guard('audio.update', () => a.update(dt, audioCtx));
}

/* ----------------------------------------------------------------- post --- */

// Smoothed 0..1 "punch" handed to the post stack. Kept across frames so a 0.6 s mini-turbo
// ramps in and out instead of switching the whole grade on for exactly as long as it lasts.
let postPunch = 0;

function updatePost(dt) {
  const post = S.post, race = S.race;
  if (!post) return;
  const p = race?.state.player;
  const st = p?.vehicle.state;
  const kmh = st ? st.speed * 3.6 : 0;

  // Scale by how strong the boost actually is. This used to be `boost.time > 0 ? 1 : 0`,
  // which drove the rush blur, the speed lines, the bloom kick and the saturation push at
  // full intensity for *every* boost in the game — including a tier-1 mini-turbo (power
  // 0.18, the mildest kick there is) and a pad (0.30). That is why review plates shot at an
  // ordinary 58-62 km/h came back smeared to the edges with speed lines over the sky.
  // vehicle.js's boostPower ladder is [0.18, 0.27, 0.37]; map it onto 0.20 .. 1.0 so a
  // tier-1 charge is a whisper and only a tier-3 or a mushroom earns the full effect.
  const b = st?.boost;
  let punch = 0;
  if (b && b.time > 0) {
    punch = 0.20 + 0.80 * clamp((b.power - 0.18) / (0.37 - 0.18), 0, 1);
    punch *= clamp(b.time / 0.20, 0, 1);            // ease out over the last fifth of a second
  }
  // The rush is a driver's-eye effect: it belongs to the chase camera and nowhere else.
  // A fixed cinematic plate looking down at the pack must never get radial speed lines.
  if (!S.camera || S.camera.mode !== 'chase') punch = 0;

  const k = 1 - Math.exp(-clamp(dt || 1 / 60, 0, 0.25) * (punch > postPunch ? 11 : 8));
  postPunch += (punch - postPunch) * k;
  if (postPunch < 1e-3) postPunch = 0;

  post.setSpeed(kmh, postPunch);
}

/* --------------------------------------------------------------- resize --- */

function onResize(w, h) {
  S.post?.setSize(w, h);
  S.hud?.resize();
}

/* ================================================================ views === */

/**
 * The canonical review set. Each entry seeds a genuine race state (real physics, real AI,
 * real items) and then aims the real camera at it — these are gameplay frames, not debug views.
 */
const SCENARIOS = {};

function buildViews() {
  const trk = S.track, L = trk.length, S0 = trk.startS;
  const at = f => ((S0 + f * L) % L + L) % L;

  const scen = (name, def) => { SCENARIOS[name] = def; };

  scen('gridStart', {
    doc: 'the eight-kart grid, engines lit, one beat before the lights go out',
    setup(r) {
      r.reset(); r.start(true);
      simulate(2.35);                       // into the countdown, "1" showing
      S.camera.setMode('chase', { snap: true });
    },
    camera() {
      // low and central behind the last row, looking up the grid to the start gantry
      const a = S.track.sample(S.track.startS - 56);
      const b = S.track.sample(S.track.startS - 14);
      return { fixed: [a.pos.x + a.normal.x * 2.2, a.pos.y + 3.35, a.pos.z + a.normal.z * 2.2],
        look: [b.pos.x + b.normal.x * 0.4, b.pos.y + 1.05, b.pos.z + b.normal.z * 0.4], fov: 44 };
    },
  });

  scen('villageStreet', {
    doc: 'the pack threading Rehov Rakefet between the houses — chase camera on the player',
    setup(r) {
      raceUpToRacing(r);
      packRunTo(at(0.972), 20.5, { spread: 14 });
    },
    chase: 0,
  });

  scen('oliveGrove', {
    doc: 'ridge road along the plateau, olive groves either side',
    setup(r) {
      raceUpToRacing(r);
      packRunTo(at(0.345), 19.0, { spread: 13 });
    },
    chase: 0,
  });

  scen('hilltopVista', {
    doc: 'the summit at Pisgat Amikam looking back down the Menashe climb',
    setup(r) {
      raceUpToRacing(r);
      packRunTo(at(0.398), 17.5, { spread: 7, lead: 62, settle: 3.2 });
    },
    camera() {
      // high above the summit, looking back down The Nose to the village and the plain beyond
      const a = S.track.sample(at(0.418)), b = S.track.sample(at(0.487));
      const cx = a.pos.x + a.normal.x * 46, cz = a.pos.z + a.normal.z * 46;
      // clear the pines: 30 m above whatever ground is actually under the lens
      const cy = Math.max(a.pos.y + 40, S.world.heightAt(cx, cz) + 34);
      return { fixed: [cx, cy, cz], look: [b.pos.x, b.pos.y + 4, b.pos.z], fov: 54 };
    },
  });

  scen('driftCorner', {
    doc: 'the player mid-drift through the Kalanit sweeper, mini-turbo charging',
    setup(r) {
      raceUpToRacing(r);
      packRunTo(at(0.845), 21.0, { spread: 12, lead: 74, settle: 3.6 });
      drive({ throttle: 1, steer: 0.62, drift: 1 }, 1.15);
    },
    chase: 0,
  });

  scen('itemChaos', {
    doc: 'item scrap through a box row: three Jaffas orbiting the player, a pan out behind, '
      + 'a sabra homing in and a khamsin devil crossing the road',
    setup(r) {
      raceUpToRacing(r);
      // arrive just short of the item-box row at 0.225 of a lap, pack still nose to tail
      packRunTo(at(0.218), 20.0, { spread: 7.0, lead: 74, settle: 3.7 });
      const items = S.items;
      if (items) {
        const give = (i, id) => { try { items.setItem(r.vehicles[i], id); } catch (e) { /* ignore */ } };
        give(0, 'jaffa3');            // orbits the player — reads instantly in a chase shot
        give(1, 'pan'); give(2, 'sabra'); give(3, 'khamsin'); give(4, 'falafel');
        simulate(0.3);
        for (const i of [1, 2, 3, 4]) { try { items.useItem(r.vehicles[i]); } catch (e) { /* ignore */ } }
      }
      simulate(0.55);
    },
    chase: 0,
  });

  scen('photoFinish', {
    doc: 'last lap, two karts side by side under the chequered gantry',
    setup(r) {
      raceUpToRacing(r);
      for (const rc of r.racers) { rc.lap = r.laps - 1; rc.cpIndex = r.checkpoints.length; rc.lapStart = r.state.raceTime - 148; }
      packRunTo(S.track.startS - 3, 23.5, { spread: 3.4, tight: true, lead: 46, settle: 2.0 });
    },
    camera() {
      // on the tarmac just past the line, low, looking back at the karts coming at the lens
      const a = S.track.sample(S.track.startS + 15);
      const b = S.track.sample(S.track.startS - 4);
      return { fixed: [a.pos.x + a.normal.x * 3.0, a.pos.y + 1.15, a.pos.z + a.normal.z * 3.0],
        look: [b.pos.x + b.normal.x * 0.8, b.pos.y + 0.75, b.pos.z + b.normal.z * 0.8], fov: 40 };
    },
  });

  scen('introFlythrough', {
    doc: 'the cinematic run over the village that plays before the countdown',
    setup(r) { r.reset(); r.start(false); simulate(2.0); S.camera.setMode('intro', { snap: true }); },
    intro: 2.6,
  });

  /* Static plates kept for continuity with the earlier review rounds. */
  const h = (x, z) => S.world.heightAt(x, z);
  game.views = {
    overview: { pos: [-620, h(-620, 620) + 320, 620], look: [0, h(0, 0), 0], fov: 55 },
    village: { pos: [120, h(120, 180) + 45, 180], look: [-40, h(-40, 20) + 6, 20], fov: 50 },
    street: { pos: [-20, h(-20, 40) + 3.2, 40], look: [60, h(60, 10) + 2, 10], fov: 65 },
    ridge: { pos: [500, h(500, -500) + 90, -500], look: [0, h(0, 0), 0], fov: 48 },
  };
  for (const k in SCENARIOS) game.views[k] = { scenario: k };
  game.scenarios = SCENARIOS;
}

/** Run the race forward to the green flag without rendering. */
function raceUpToRacing(r) {
  r.reset();
  r.start(true);
  simulate(3.75);
}

/** Deterministic headless advance of the whole game state. */
function simulate(seconds, dt = 1 / 60) {
  const race = S.race;
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) {
    race.update(dt);
    syncRacerVisuals(dt, false);
    if (S.camera && S.camera.mode === 'chase') S.camera.update(dt, {});
  }
}

/** Simulate with a fixed player input (the scripted drive test and the drift plate). */
function drive(input, seconds, dt = 1 / 60) {
  const prev = scripted;
  scripted = input;
  S.race.setInput(fillPlayerInput(null));
  simulate(seconds, dt);
  scripted = prev;
  if (!prev) S.race.setInput(humanDriving ? playerInput : null);
}

/**
 * Teleport the field onto the circuit at arc-length `s`, in place order, at `speed` m/s.
 * The physics is genuinely re-seeded (wheel speeds, body velocity, suspension) so the karts
 * are *driving*, not sliding: one settle frame later they behave exactly as if they had
 * arrived there under power.
 */
function packAt(s, speed, { spread = 8, tight = false } = {}) {
  const race = S.race, trk = S.track, L = trk.length;
  race.racers.forEach((r, i) => {
    const back = tight ? (i >> 1) * spread : i * spread;
    const ss = ((s - back) % L + L) % L;
    const sm = trk.sample(ss);
    const lane = (i % 2 ? 1 : -1) * Math.min(sm.width * 0.24, tight ? 2.6 : 3.1);
    const pos = { x: sm.pos.x + sm.normal.x * lane, y: sm.pos.y + 0.05, z: sm.pos.z + sm.normal.z * lane };
    const rot = Math.atan2(sm.tangent.x, sm.tangent.z);
    const v = r.vehicle;
    v.reset(pos, rot);
    const sp = speed * (1 - i * 0.012);
    v.state.vel.x = sm.tangent.x * sp;
    v.state.vel.y = sm.tangent.y * sp;
    v.state.vel.z = sm.tangent.z * sp;
    v.state.speed = sp;
    for (const w of v.wheels) w.omega = sp / w.radius;
    // keep the lap bookkeeping consistent with where they now are
    const n = trk.nearest(v.state.pos);
    const u = ((n.s - race.startS) % L + L) % L;
    r.s = n.s; r.u = u; r.prevU = u; r.progressInit = false; r.distSinceCp = 0;
  });
  S.camera?.snap();
}


/**
 * Put the field on the circuit a little short of `s` and let it *drive* to the mark. Teleporting
 * straight onto the camera mark leaves a frame of spawn artefacts — suspension settling, a skid
 * decal under every wheel — so every review plate arrives under power with the tyres rolling,
 * the AI back on the racing line and real dust in the air.
 */
function packRunTo(s, speed, { lead = 88, settle = 4.6, spread = 8, tight = false } = {}) {
  const L = S.track.length;
  packAt(((s - lead) % L + L) % L, speed, { spread, tight });
  simulate(settle);
}

/* ------------------------------------------------------------- setView ---- */

function setView(name) {
  const v = game.views[name];
  if (!v) throw new Error('unknown view: ' + name);

  if (v.scenario) {
    const sc = SCENARIOS[v.scenario];
    APP.mode = 'race'; APP.paused = false; APP.fixedStep = 1 / 60;
    APP.viewLock = sc.chase != null ? 'chase' : sc.intro != null ? 'intro' : 'fixed';
    S.menu?.hide();
    S.hud?.show(true);
    S.camera.setTarget(S.race.state.player?.vehicle || S.race.vehicles[0]);
    sc.setup(S.race);
    if (sc.chase != null) {
      S.camera.setTarget(S.race.vehicles[sc.chase] || S.race.vehicles[0]);
      S.camera.setMode('chase');
      S.camera.update(1 / 60, {});
    } else if (sc.intro != null) {
      S.camera.setMode('intro', { snap: true });
      S.camera.update(1 / 60, { phaseTime: sc.intro, introTime: 7.0 });
    } else if (sc.camera) {
      const c = sc.camera();
      S.camera.setFixed(c.fixed, c.look, c.fov);
    }
    updateHUD(1 / 60);
    return;
  }

  // a plain cinematic plate
  APP.viewLock = 'fixed';
  S.camera?.setFixed(v.pos, v.look, v.fov ?? 62);
  APP.mode = 'race';
  S.hud?.show(false);
}

function renderOnce() { engine.render(); }

/* ============================================================ automation == */

// NB: Object.assign would *evaluate* these getters and assign their (null) values, so the
// automation surface has to be defined, not assigned.
Object.defineProperties(game, {
  race: { get: () => S.race, enumerable: true },
  camera: { get: () => S.camera, enumerable: true },
  quality: { get: () => quality, enumerable: true },
  menu: { get: () => S.menu, enumerable: true },
  track: { get: () => S.track, enumerable: true },
  mode: { get: () => APP.mode, enumerable: true },
});
Object.assign(game, {
  THREE,
  setFixedStep(v) { APP.fixedStep = v || 0; },
  /** Time of day, 0..24 or a TIME_PRESETS name. Rebuilds the sun, sky palette and env map. */
  setTime(h) { guard('setTime', () => { S.sky?.setTimeOfDay(h); S.lighting?.refresh(true); }); },
  setExposure(e) { engine.renderer.toneMappingExposure = e; },
  get exposure() { return engine.renderer.toneMappingExposure; },
  setViewLock(v) { APP.viewLock = v || null; },
  setQuality(t) { quality.set(t); },
  simulate, drive, packAt,
  startRace, pauseRace, resumeRace, quitToTitle, enterPhoto,
  setScripted(inp) {
    scripted = inp;
    if (S.race) S.race.setInput(inp ? fillPlayerInput(null) : (humanDriving ? playerInput : null));
  },
  showHUD(v) { S.hud?.show(v); },
  /** Compact state dump for the drive test. */
  snapshot() {
    const r = S.race;
    if (!r) return null;
    const p = r.state.player;
    return {
      phase: r.state.phase, raceTime: r.state.raceTime, over: r.state.over,
      lap: p?.lap, place: p?.place, speed: p ? p.vehicle.state.speed : 0,
      camera: S.camera?.pose(), mode: APP.mode,
      standings: r.standings.map(x => ({ place: x.place, name: x.name, lap: x.lap, finished: x.finished })),
      results: r.state.over ? r.results.map(x => ({ place: x.place, name: x.name, time: x.time, best: x.bestLap, dnf: x.dnf, laps: x.laps })) : null,
    };
  },
});

/* ================================================================== go ==== */

boot().catch(e => {
  game.error = String((e && e.stack) || e);
  console.error('[kat] boot failed', e);
  try {
    S.menu?.setLoading(1, 'boot failed — see console');
  } catch (e2) { /* the console already has it */ }
});
