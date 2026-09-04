/**
 * Dogpatch Kart — boot, frame loop, wiring.
 *
 * Load the world, build the circuit, put eight karts on the grid, and run. Everything a test
 * needs is on `window.__game`: `stepFrame(dt)` runs ONE real frame including the input poll,
 * because a harness cannot wait for requestAnimationFrame — headless Chromium never schedules it.
 */
import * as THREE from 'three';
import { World } from './world/world.js';
import { buildTrack } from './track/track.js';
import { createTerrain } from './world/terrain.js';
import { createTrackMesh } from './track/trackMesh.js';
import { createBuildings } from './world/buildings.js';
import { createProps } from './world/props.js';
import { createSky } from './world/sky.js';
import { createKart, DRIVERS, tuneFor } from './render/kart.js';
import { createCamera } from './render/camera.js';
import { createVFX } from './render/vfx.js';
import { createInput } from './core/input.js';
import { createRace } from './game/race.js';
import { createHUD } from './ui/hud.js';
import { createMenu } from './ui/menu.js';
import { createAudio } from './audio/audio.js';
import { clamp } from './core/math.js';

const Q = new URLSearchParams(location.search);
const flag = (k, d = false) => { const v = Q.get(k); return v == null ? d : !(v === '0' || v === 'false'); };
const num = (k, d) => { const v = +Q.get(k); return Q.get(k) != null && Number.isFinite(v) ? v : d; };

const game = (window.__game = { ready: false, error: null, THREE });
const APP = { mode: 'menu', paused: false, fixedStep: 0 };
const S = {};

/* ------------------------------------------------------------------- renderer --- */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = flag('shadows', true);
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1.05);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.4, 3000);
function resize() {
  const w = app.clientWidth || innerWidth, h = app.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/* ----------------------------------------------------------------------- boot --- */
async function boot() {
  const menu = S.menu = createMenu(app);
  menu.loading('Reading the waterfront');

  S.world = game.world = await World.load('data/').catch(() => World.load('./data/'));
  menu.loading('Draping the circuit');
  S.track = game.track = buildTrack(S.world, { laps: num('laps', 3) });
  S.world.carve(S.track);          // grade the ground to the road before anything is built from it

  menu.loading('Pouring concrete');
  S.sky = createSky(scene, { shadows: renderer.shadowMap.enabled });
  S.terrain = createTerrain(S.world, { shadows: renderer.shadowMap.enabled });
  scene.add(S.terrain.object3D);
  S.circuit = createTrackMesh(S.track, S.world, { shadows: renderer.shadowMap.enabled });
  scene.add(S.circuit.object3D);

  menu.loading('Raising the warehouses');
  S.buildings = createBuildings(S.world, S.track, { shadows: renderer.shadowMap.enabled });
  scene.add(S.buildings.object3D);
  S.props = createProps(S.world, S.track, { shadows: renderer.shadowMap.enabled });
  scene.add(S.props.object3D);

  menu.loading('Warming the grid');
  S.input = createInput({ touch: 'auto' });
  S.cam = createCamera(camera, S.world);
  S.vfx = createVFX(scene);
  S.hud = createHUD(app);
  S.audio = createAudio({ enabled: flag('audio', true) });

  buildRace(num('kat', 0));
  resize();

  game.ready = true;
  if (flag('go', false)) startRace(num('kat', 0));
  else { APP.mode = 'menu'; menu.title(DRIVERS); }
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------------- race --- */
let rigs = [];
function buildRace(playerIndex) {
  for (const r of rigs) { scene.remove(r.object3D); r.dispose(); }
  rigs = [];
  const chosen = DRIVERS[clamp(playerIndex | 0, 0, DRIVERS.length - 1)];
  const field = [chosen, ...DRIVERS.filter(d => d.id !== chosen.id)].slice(0, 8);

  S.race = game.race = createRace(S.world, S.track, {
    drivers: field, playerIndex: 0, laps: S.track.laps,
    difficulty: num('ai', 1), seed: 5150, tuneFor,
  });
  for (const d of field) {
    const rig = createKart(d, { shadows: renderer.shadowMap.enabled });
    scene.add(rig.object3D); rigs.push(rig);
  }
  S.race.on('lap', e => { if (e.racer.isPlayer) S.hud.flash(); });
  S.race.on('hit', e => { if (e.racer.isPlayer) S.cam.hit(0.8); });
  S.race.on('phase', e => {
    S.audio.cue(e.phase === 'racing' ? 'go' : e.phase === 'countdown' ? 'light' : null);
    if (e.phase === 'results') showResults();
  });
}

function startRace(playerIndex = 0) {
  buildRace(playerIndex);
  S.race.start();
  S.race.setInput(S.input.out);
  S.menu.hide(); S.hud.show(true);
  S.cam.snap();
  APP.mode = 'race'; APP.paused = false;
  S.audio.resume();
}

function showResults() {
  APP.mode = 'results';
  S.hud.show(false);
  S.menu.results(S.race.results, () => startRace(S.race.playerIndex));
}

/* ----------------------------------------------------------------------- loop --- */
let last = performance.now();
function frame(now) {
  const dt = APP.fixedStep || clamp((now - last) / 1000, 1 / 240, 1 / 12);
  last = now;
  tick(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function tick(dt) {
  const raw = S.input.poll(dt);

  if (raw.pause && APP.mode === 'race') { APP.paused = !APP.paused; S.menu.pause(APP.paused, () => startRace(S.race.playerIndex)); }
  if (raw.reset && APP.mode === 'race' && !APP.paused) S.race.player?.vehicle.respawn();

  if (S.race && !APP.paused && APP.mode !== 'menu') {
    S.race.update(dt);
    const p = S.race.player;
    S.race.racers.forEach((r, i) => rigs[i]?.sync(r.vehicle.state, dt));
    S.cam.update(dt, p.vehicle, S.race.racers.map(r => r.vehicle));
    S.sky.follow(p.vehicle.state.pos);
    S.vfx.update(dt, S.race.racers.map(r => r.vehicle));
    S.hud.update(S.race.hud());
    S.audio.update(dt, p.vehicle.state, S.race.state.phase);
  } else if (S.race) {
    // attract: the field laps behind the title card so the menu is never a still image
    S.race.update(dt, { autopilot: true });
    S.race.racers.forEach((r, i) => rigs[i]?.sync(r.vehicle.state, dt));
    S.cam.update(dt, S.race.racers[0].vehicle, S.race.racers.map(r => r.vehicle));
    S.sky.follow(S.race.racers[0].vehicle.state.pos);
  }
}

/* ----------------------------------------------------------------- debug hooks --- */
Object.assign(game, {
  startRace, get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; },
  /** One REAL frame, input poll included — nothing reached through tick() is testable otherwise. */
  stepFrame(dt = 1 / 60) { tick(dt); },
  render() { renderer.render(scene, camera); },
  setFixedStep(v) { APP.fixedStep = v || 0; },
  snapshot() {
    const r = S.race; if (!r) return null;
    const p = r.player;
    return { phase: r.state.phase, time: r.state.time, mode: APP.mode,
      lap: p.lap + 1, laps: r.laps, place: p.place, speed: p.vehicle.state.speed,
      track: S.track.name, length: S.track.length,
      standings: r.standings.map(x => ({ place: x.place, name: x.driver.name, lap: x.lap })) };
  },
});

boot().catch(e => {
  game.error = String(e && (e.stack || e.message) || e);
  console.error('[dogpatch] boot failed', e);
  S.menu?.loading('Boot failed — see console');
});
