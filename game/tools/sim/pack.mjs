/**
 * Headless pack bench — reproduces the review harness's scenario seeding (main.js packAt /
 * packRunTo) without a renderer, and reports where the eight karts actually are when the
 * shutter opens.
 *
 *   node tools/sim/pack.mjs                # every canonical chase view
 *   node tools/sim/pack.mjs villageStreet
 *
 * For each view it prints, per kart: gap to the player along the track (+ = ahead of the
 * player), lateral offset, speed — and then how many rivals would be inside the chase
 * camera's frustum, which is the only number the review frames actually care about.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { WorldData } from '../../src/world/worldData.js';
import { buildTrack } from '../../src/track/track.js';
import { createRace } from '../../src/game/race.js';
import { createRoster } from '../../src/characters/roster.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const DT = 1 / 60;

const base = fs.existsSync(path.join(ROOT, 'public/data/amikam.json'))
  ? path.join(ROOT, 'public/data') : path.join(ROOT, 'dist/data');
const json = JSON.parse(fs.readFileSync(path.join(base, 'amikam.json'), 'utf8'));
const buf = fs.readFileSync(path.join(base, 'amikam-height.bin'));
const heights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const world = new WorldData(json, heights);
const track = buildTrack(world, { laps: 3 });
conformWorldToTrack(world, track);      // main.js does this before anything samples the world
const roster = createRoster();
const L = track.length;

// AI_<opt>=value overrides any createAI option, for tuning runs:  AI_leadDrag=0 node tools/sim/pack.mjs
const aiOpts = {};
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("AI_") && Number.isFinite(+v)) aiOpts[k.slice(3)] = +v;
if (Object.keys(aiOpts).length) console.log('ai overrides:', aiOpts);

const race = createRace(world, track, {
  field: 8, laps: 3, roster: roster.slice(0, 8), difficulty: 150,
  playerIndex: 0, autopilot: true, introTime: 0.01, countdownTime: 3.6, seed: 5150,
  aiOpts,
});

const simulate = (sec, dt = DT) => { const n = Math.max(1, Math.round(sec / dt)); for (let i = 0; i < n; i++) race.update(dt); };

function packAt(s, speed, { spread = 8, tight = false } = {}) {
  race.racers.forEach((r, i) => {
    const back = tight ? (i >> 1) * spread : i * spread;
    const ss = ((s - back) % L + L) % L;
    const sm = track.sample(ss);
    const lane = (i % 2 ? 1 : -1) * Math.min(sm.width * 0.24, tight ? 2.6 : 3.1);
    const pos = { x: sm.pos.x + sm.normal.x * lane, y: sm.pos.y + 0.05, z: sm.pos.z + sm.normal.z * lane };
    const rot = Math.atan2(sm.tangent.x, sm.tangent.z);
    const v = r.vehicle;
    v.reset(pos, rot);
    const sp = speed * (1 - i * 0.012);
    v.state.vel.x = sm.tangent.x * sp; v.state.vel.y = sm.tangent.y * sp; v.state.vel.z = sm.tangent.z * sp;
    v.state.speed = sp;
    for (const w of v.wheels) w.omega = sp / w.radius;
    const n = track.nearest(v.state.pos);
    const u = ((n.s - race.startS) % L + L) % L;
    r.s = n.s; r.u = u; r.prevU = u; r.progressInit = false; r.distSinceCp = 0;
  });
}
function packRunTo(s, speed, { lead = 88, settle = 4.6, spread = 8, tight = false } = {}) {
  packAt(((s - lead) % L + L) % L, speed, { spread, tight });
  simulate(settle);
}
function raceUpToRacing() { race.reset(); race.start(true); simulate(3.75); }
const at = f => ((track.startS + f * L) % L + L) % L;

/* ------------------------------------------------------------------ views -- */
const VIEWS = {
  villageStreet: () => { raceUpToRacing(); packRunTo(at(0.972), 20.5, { spread: 14 }); },
  oliveGrove: () => { raceUpToRacing(); packRunTo(at(0.345), 19.0, { spread: 13 }); },
  driftCorner: () => { raceUpToRacing(); packRunTo(at(0.845), 21.0, { spread: 12, lead: 74, settle: 3.6 }); },
  itemChaos: () => { raceUpToRacing(); packRunTo(at(0.218), 20.0, { spread: 7.0, lead: 74, settle: 3.7 }); },
  photoFinish: () => {
    raceUpToRacing();
    for (const rc of race.racers) { rc.lap = race.laps - 1; rc.cpIndex = race.checkpoints.length; rc.lapStart = race.state.raceTime - 148; }
    packRunTo(track.startS - 3, 23.5, { spread: 3.4, tight: true, lead: 46, settle: 2.0 });
  },
  hilltopVista: () => { raceUpToRacing(); packRunTo(at(0.398), 17.5, { spread: 7, lead: 62, settle: 3.2 }); },
};


/**
 * A copy of main.js's terrain conform, so the bench drives the same ground the game does:
 * inside the ribbon the heightfield *is* the smoothed racing surface, fading back to raw SRTM
 * over a 14 m shoulder. Without it the karts drive on 3 m DEM stair-steps and every gap
 * measured here is fiction.
 */
function conformWorldToTrack(world, track, opts = {}) {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
  const CELL = opts.cell ?? 1.5, FALL = opts.falloff ?? 14.0, SINK = opts.sink ?? 0.20;
  const pts = track.points;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxW = 12;
  const N = pts.length;
  const samples = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    const sm = track.sample((i / N) * track.length);
    const w = sm.width || 12;
    maxW = Math.max(maxW, w);
    samples[i] = { x: p.x, y: p.y, z: p.z, hw: w * 0.5, nx: sm.normal.x, nz: sm.normal.z, tb: Math.tan(sm.banking || 0) };
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const pad = maxW * 0.5 + FALL + CELL * 2;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const NX = Math.ceil((maxX - minX) / CELL) + 1, NZ = Math.ceil((maxZ - minZ) / CELL) + 1;
  const wt = new Float32Array(NX * NZ), ty = new Float32Array(NX * NZ);
  const bd = new Float32Array(NX * NZ).fill(Infinity);
  for (const s of samples) {
    const R = s.hw + FALL;
    const i0 = Math.max(0, Math.floor((s.x - R - minX) / CELL)), i1 = Math.min(NX - 1, Math.ceil((s.x + R - minX) / CELL));
    const j0 = Math.max(0, Math.floor((s.z - R - minZ) / CELL)), j1 = Math.min(NZ - 1, Math.ceil((s.z + R - minZ) / CELL));
    for (let j = j0; j <= j1; j++) {
      const cz = minZ + j * CELL, dz = cz - s.z;
      for (let i = i0; i <= i1; i++) {
        const cx = minX + i * CELL, dx = cx - s.x;
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const k = j * NX + i;
        if (d >= bd[k]) continue;
        bd[k] = d;
        wt[k] = 1 - smooth(clamp((d - s.hw - 0.4) / FALL, 0, 1));
        const lateral = dx * s.nx + dz * s.nz;
        ty[k] = s.y + s.tb * clamp(lateral, -s.hw, s.hw) - SINK;
      }
    }
  }
  const raw = world.heightAt.bind(world);
  world.rawHeightAt = raw;
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
}

const dS = (a, b) => { let d = a - b; while (d > L * 0.5) d -= L; while (d < -L * 0.5) d += L; return d; };

/** Rough stand-in for the chase rig: 3.9 m behind the kart, 1.5 m up, 55 deg lens. */
function inFrame(p, o) {
  const yaw = p.vehicle.state.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const ex = p.vehicle.state.pos.x - fx * 3.9, ez = p.vehicle.state.pos.z - fz * 3.9;
  const dx = o.vehicle.state.pos.x - ex, dz = o.vehicle.state.pos.z - ez;
  const ahead = dx * fx + dz * fz, side = dx * fz - dz * fx;
  if (ahead < 1.5 || ahead > 95) return false;
  return Math.abs(Math.atan2(side, ahead)) < 0.55;          // ~63 deg horizontal fov
}

const names = process.argv.slice(2).filter(a => VIEWS[a]);
const list = names.length ? names : Object.keys(VIEWS);
for (const name of list) {
  VIEWS[name]();
  const p = race.racers[0];
  const rows = race.racers.map(r => ({
    name: r.name, gap: dS(r.s, p.s), lat: r.lateral, kmh: r.vehicle.state.speed * 3.6,
    place: r.place, frame: r !== p && inFrame(p, r),
  })).sort((a, b) => b.gap - a.gap);
  const shown = rows.filter(r => r.frame).length;
  const spread = rows[0].gap - rows[rows.length - 1].gap;
  console.log(`\n${name}   t=${race.state.raceTime.toFixed(2)}s  player P${p.place}  ` +
    `field spread ${spread.toFixed(1)} m  rivals in frame: ${shown}`);
  for (const r of rows) {
    console.log(`   ${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(1).padStart(6)} m  lat ${r.lat.toFixed(1).padStart(5)}  ` +
      `${r.kmh.toFixed(0).padStart(3)} km/h  P${r.place}  ${r.name}${r.frame ? '   <-- in frame' : ''}`);
  }
}
