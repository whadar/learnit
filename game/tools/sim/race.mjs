/**
 * Headless race bench. No rendering: a full 12-kart, 3-lap race on the real terrain, driven by
 * the real src/game/ai.js against the real src/physics/vehicle.js, printing hard numbers.
 *
 *   node tools/sim/race.mjs             # the full race + the racing-line report
 *   node tools/sim/race.mjs line        # racing line / speed profile only
 *   node tools/sim/race.mjs solo        # one Ace alone: lap-time consistency
 *   node tools/sim/race.mjs tiers       # 8 laps per difficulty tier
 *   SIM_ITEMS=1 node tools/sim/race.mjs # with the item game switched on
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createVehicle, makeFallbackTrack } from '../../src/physics/vehicle.js';
import { createCollisionWorld } from '../../src/physics/collision.js';
import { createAI, buildRacingLine, TIERS } from '../../src/game/ai.js';
import { createRace, fmtTime } from '../../src/game/race.js';
import { clamp } from '../../src/core/mathx.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const FPS = +(process.env.SIM_HZ || 60);
const DT = 1 / FPS;
const only = process.argv[2] || 'all';
const B = s => `\x1b[1m${s}\x1b[0m`;
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2, w = 7) => String(Number.isFinite(v) ? v.toFixed(n) : '—').padStart(w);

/* ---------------------------------------------------------------- world ---- */
async function loadWorld() {
  try {
    const { WorldData } = await import('../../src/world/worldData.js');
    const base = fs.existsSync(path.join(ROOT, 'public/data/amikam.json'))
      ? path.join(ROOT, 'public/data') : path.join(ROOT, 'dist/data');
    const json = JSON.parse(fs.readFileSync(path.join(base, 'amikam.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(base, 'amikam-height.bin'));
    const heights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const w = new WorldData(json, heights);
    if (!Number.isFinite(w.heightAt(0, 0))) throw new Error('bad heightfield');
    return w;
  } catch (e) {
    console.log('! real world unavailable (' + e.message + ') — synthetic heightfield');
    const res = 512, extent = 3072, step = extent / res, half = extent / 2;
    const heights = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = -half + i * step, z = -half + j * step;
      heights[j * res + i] = 100 + 8 * Math.sin(x / 260) * Math.cos(z / 310) + 3 * Math.sin(x / 70);
    }
    const gridH = (i, j) => heights[clamp(j, 0, res - 1) * res + clamp(i, 0, res - 1)];
    return {
      res, extent, step, half, minH: 80, maxH: 130, buildings: [], roads: [], landuse: [], landcover: [], water: [],
      heightAt(x, z) {
        const fx = (x + half) / step, fz = (z + half) / step;
        const i = Math.floor(fx), j = Math.floor(fz), sx = fx - i, sz = fz - j;
        return (gridH(i, j) * (1 - sx) + gridH(i + 1, j) * sx) * (1 - sz) + (gridH(i, j + 1) * (1 - sx) + gridH(i + 1, j + 1) * sx) * sz;
      },
      normalAt(x, z, o = {}) { const d = step; const nx = this.heightAt(x - d, z) - this.heightAt(x + d, z), nz = this.heightAt(x, z - d) - this.heightAt(x, z + d), ny = 2 * d; const l = Math.hypot(nx, ny, nz); o.x = nx / l; o.y = ny / l; o.z = nz / l; return o; },
      inBounds(x, z) { return Math.abs(x) < half && Math.abs(z) < half; },
    };
  }
}

async function loadTrack(world) {
  try {
    const m = await import('../../src/track/track.js');
    const t = m.buildTrack(world, {});
    t.sample(0); t.nearest({ x: 0, y: 0, z: 0 });
    console.log('  track: src/track/track.js   length=' + t.length.toFixed(0) + ' m  cps=' + (t.checkpoints?.length ?? 0));
    return t;
  } catch (e) {
    const t = makeFallbackTrack(world, { seed: 7 });
    console.log('  track: fallback loop        length=' + t.length.toFixed(0) + ' m  (src/track/track.js not ready)');
    return t;
  }
}

async function loadRoster() {
  try { const m = await import('../../src/characters/roster.js'); return m.createRoster(); }
  catch (e) { return null; }
}
async function loadItems(world, track) {
  if (!process.env.SIM_ITEMS) return null;
  try {
    const m = await import('../../src/game/items.js');
    return m.createItemSystem(world, track, { visuals: false, scene: null, seed: 4242 });
  } catch (e) { console.log('! items unavailable: ' + e.message); return null; }
}

/* ------------------------------------------------------------------ line --- */
function reportLine(line, track) {
  console.log(B('\nRACING LINE'));
  const st = line.stats;
  console.log('  samples                          ' + num(line.N, 0, 8));
  console.log('  centre length                    ' + num(line.length, 1, 8) + ' m');
  console.log('  line length                      ' + num(line.lineLength, 1, 8) + ' m   ' +
    ((line.lineLength - line.length) >= 0 ? '+' : '') + (line.lineLength - line.length).toFixed(1) + ' m vs centre');
  console.log('  max lateral offset               ' + num(st.maxOffset, 2, 8) + ' m');
  console.log('  tightest radius                  ' + num(st.minRadius, 1, 8) + ' m');
  console.log('  profile speed  min/mean/max      ' + num(st.minSpeed * 3.6, 1, 6) + ' /' + num(st.meanSpeed * 3.6, 1, 7) + ' /' + num(st.maxSpeed * 3.6, 1, 7) + ' km/h');
  console.log('  ideal lap (profile)              ' + num(st.estLap, 2, 8) + ' s');

  // how much of the lap is spent off the centreline — a centreline "racing line" would be ~0
  let outIn = 0, n = 0;
  for (let i = 0; i < line.N; i++) { outIn += Math.abs(line.offset[i]); n++; }
  console.log('  mean |offset| from centre        ' + num(outIn / n, 2, 8) + ' m  (0 = centreline)');
  // the five slowest corners
  const corners = [];
  for (let i = 0; i < line.N; i++) {
    const k = Math.abs(line.curvature[i]);
    if (k > 0.012) corners.push({ s: i * line.ds, k, v: line.speed[i], off: line.offset[i] });
  }
  corners.sort((a, b) => a.v - b.v);
  const picked = [];
  for (const c of corners) {
    if (picked.some(p => Math.abs(p.s - c.s) < 60 || Math.abs(p.s - c.s) > line.length - 60)) continue;
    picked.push(c); if (picked.length >= 5) break;
  }
  console.log('  slowest corners:');
  for (const c of picked) {
    console.log(`    s=${pad(c.s.toFixed(0) + ' m', 8)} R=${pad((1 / c.k).toFixed(1) + ' m', 9)} v=${pad((c.v * 3.6).toFixed(1) + ' km/h', 12)} apex offset ${c.off.toFixed(2)} m`);
  }
  void track;
}

/* ------------------------------------------------------------------ race --- */
async function runRace(world, track, opts = {}) {
  const roster = await loadRoster();
  const items = await loadItems(world, track);
  const race = createRace(world, track, {
    field: 12, laps: opts.laps ?? 3, seed: opts.seed ?? 5150,
    playerIndex: 0, autopilot: true,
    difficulty: opts.difficulty ?? 150,
    roster, items,
    introTime: 0, countdownTime: 3.6,
  });
  const events = { laps: 0, shortcuts: 0, wrongway: 0, rockets: {}, overtakes: 0 };
  race.on('shortcut', () => events.shortcuts++);
  race.on('wrongway', e => { if (e.on) events.wrongway++; });
  race.on('rocket', e => { events.rockets[e.kind] = (events.rockets[e.kind] || 0) + 1; });
  race.on('position', () => events.overtakes++);
  race.start(true);

  const stuck = race.racers.map(() => ({ last: 0, t: 0, worst: 0 }));
  let t = 0, guard = 0;
  const limit = opts.limit ?? 420;
  while (t < limit && race.state.phase !== 'results' && guard++ < limit * FPS + 10) {
    race.update(DT);
    t += DT;
    if (race.state.phase === 'racing' || race.state.phase === 'finished') {
      race.racers.forEach((r, i) => {
        const s = stuck[i];
        if (r.progress - s.last > 1.0) { s.last = r.progress; s.t = 0; }
        else { s.t += DT; if (s.t > s.worst) s.worst = s.t; }
      });
    }
  }
  return { race, events, stuck, wall: t, items };
}

function reportRace({ race, events, stuck }) {
  const results = race.results;
  const racers = race.racers;
  console.log(B('\nRACE — 12 karts, ' + race.laps + ' laps, ' + race.length.toFixed(0) + ' m'));
  console.log('  ' + pad('pos', 5) + pad('name', 9) + pad('tier', 8) + pad('grid', 6) + pad('total', 11) +
    pad('gap', 9) + pad('best', 9) + 'lap times');
  for (const r of results) {
    const laps = r.lapTimes.map(x => x.toFixed(2)).join('  ');
    console.log('  ' + pad(r.place, 5) + pad(r.name, 9) + pad(r.tier, 8) + pad(r.grid, 6) +
      pad(r.time ? fmtTime(r.time) : (r.dnf ? 'DNF' : '—'), 11) +
      pad(r.gap != null ? (r.gap > 0 ? '+' + r.gap.toFixed(2) : '—') : '—', 9) +
      pad(r.bestLap ? r.bestLap.toFixed(2) : '—', 9) + laps);
  }

  const finished = results.filter(r => r.time != null && !r.dnf);
  const spread = finished.length > 1 ? finished[finished.length - 1].time - finished[0].time : NaN;
  const allLaps = [];
  const perRacerSpread = [];
  for (const r of results) {
    if (r.lapTimes.length < 2) continue;
    const mn = Math.min(...r.lapTimes), mx = Math.max(...r.lapTimes);
    perRacerSpread.push(mx - mn);
    allLaps.push(...r.lapTimes);
  }
  const mean = allLaps.reduce((a, b) => a + b, 0) / Math.max(allLaps.length, 1);
  const sd = Math.sqrt(allLaps.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(allLaps.length, 1));
  const worstSpread = perRacerSpread.length ? Math.max(...perRacerSpread) : NaN;
  const meanSpread = perRacerSpread.reduce((a, b) => a + b, 0) / Math.max(perRacerSpread.length, 1);

  console.log(B('\nNUMBERS'));
  console.log('  finishers                        ' + num(finished.length, 0, 8) + ' / 12');
  console.log('  winner                           ' + pad(results[0]?.name, 10) + fmtTime(results[0]?.time));
  console.log('  1st→last spread                  ' + num(spread, 2, 8) + ' s   ' + (spread / Math.max(results[0]?.time, 1) * 100).toFixed(1) + '% of the winner');
  console.log('  mean lap                         ' + num(mean, 2, 8) + ' s   sd ' + sd.toFixed(2) + ' s');
  console.log('  per-kart lap spread  mean/worst  ' + num(meanSpread, 2, 6) + ' /' + num(worstSpread, 2, 7) + ' s   want < 1.50 s');
  console.log('  best lap of the race             ' + num(Math.min(...results.map(r => r.bestLap ?? Infinity)), 2, 8) + ' s');
  console.log('  ideal lap (speed profile)        ' + num(race.line.stats.estLap, 2, 8) + ' s');

  const offTotal = results.reduce((a, r) => a + r.offTrack, 0);
  const respawns = results.reduce((a, r) => a + r.respawns, 0);
  console.log('  off-track excursions             ' + num(offTotal, 0, 8) + '     ' + (offTotal / 12 / race.laps).toFixed(2) + ' per kart per lap');
  console.log('  respawns                         ' + num(respawns, 0, 8) + '     want 0');
  console.log('  shortcut flags                   ' + num(events.shortcuts, 0, 8));
  console.log('  wrong-way flags                  ' + num(events.wrongway, 0, 8));
  console.log('  position changes                 ' + num(events.overtakes, 0, 8));
  console.log('  rocket starts                    ' + JSON.stringify(events.rockets));
  const worstStuck = Math.max(...stuck.map(s => s.worst));
  console.log('  longest no-progress stall        ' + num(worstStuck, 2, 8) + ' s   want < 4.00');
  const dr = racers.map(r => r.ai?.stats || {});
  console.log('  drifts / mini-turbos             ' + num(dr.reduce((a, d) => a + (d.drifts || 0), 0), 0, 8) + ' /' +
    num(dr.reduce((a, d) => a + (d.miniturbos || 0), 0), 0, 6));
  console.log('  AI mistakes / catch-up boosts    ' + num(dr.reduce((a, d) => a + (d.mistakes || 0), 0), 0, 8) + ' /' +
    num(dr.reduce((a, d) => a + (d.catchBoosts || 0), 0), 0, 6));
  console.log('  items used                       ' + num(dr.reduce((a, d) => a + (d.items || 0), 0), 0, 8));
  console.log('  ghost frames (player line)       ' + num(race.ghost.frames.length, 0, 8) + '   ' + race.ghost.duration.toFixed(1) + ' s');

  console.log(B('\nPER-TIER PACE'));
  const byTier = new Map();
  for (const r of results) {
    if (!r.bestLap) continue;
    const a = byTier.get(r.tier) || []; a.push(r.bestLap); byTier.set(r.tier, a);
  }
  for (const t of TIERS) {
    const a = byTier.get(t.id); if (!a) continue;
    console.log('  ' + pad(t.name, 16) + 'n=' + a.length + '  best lap mean ' + num(a.reduce((x, y) => x + y, 0) / a.length, 2, 7) + ' s');
  }
  return { spread, worstSpread, meanSpread, respawns, offTotal, worstStuck, mean };
}

/* ------------------------------------------------------------------ solo --- */
async function runSolo(world, track, tierIdx = 3, laps = 6) {
  const collision = createCollisionWorld(world, track, {});
  const line = buildRacingLine(track, {});
  const ai = createAI(world, track, (i, o) => createVehicle(world, track, { ...o, collision }), {
    count: 1, line, tiers: [tierIdx], seed: 999, rubberBand: false, step: true,
  });
  const r = ai.racers[0];
  const slot = track.startGrid?.[0];
  if (slot) r.vehicle.reset(slot.pos, slot.rot);
  ai.setGate({ racing: true, tMinus: 0, go: true });
  const len = track.length;
  let t = 0, prevU = 0, lap = -1, lapStart = 0;
  const times = [];
  const startS = Number.isFinite(track.startS) ? track.startS : track.nearest(slot ? slot.pos : { x: 0, y: 0, z: 0 }).s;
  let offTime = 0, top = 0, respawn0 = r.vehicle.state.respawns;
  while (t < 90 + laps * 90 && times.length < laps) {
    ai.update(DT);
    t += DT;
    const st = r.vehicle.state;
    if (!st.onTrack) offTime += DT;
    top = Math.max(top, st.speed);
    const u = ((r.s - startS) % len + len) % len;
    if (u < prevU - len * 0.5) { if (lap >= 0) times.push(t - lapStart); lapStart = t; lap++; }
    prevU = u;
  }
  return { times, offTime, top, t, respawns: r.vehicle.state.respawns - respawn0, tier: TIERS[tierIdx], stats: r.stats };
}

/* ------------------------------------------------------------------ main --- */
console.log(B('SETUP'));
const world = await loadWorld();
const track = await loadTrack(world);
console.log('  sim rate: ' + FPS + ' Hz frames, 200 Hz physics' + (process.env.SIM_ITEMS ? ', items ON' : ''));

const line = buildRacingLine(track, {});
if (only === 'all' || only === 'line') reportLine(line, track);

if (only === 'solo' || only === 'all') {
  console.log(B('\nSOLO HOT LAPS (Ace, no rubber band)'));
  const s = await runSolo(world, track, 3, 5);
  const mn = Math.min(...s.times), mx = Math.max(...s.times);
  s.times.forEach((x, i) => console.log('  lap ' + (i + 1) + '                            ' + num(x, 2, 8) + ' s'));
  console.log('  spread                           ' + num(mx - mn, 2, 8) + ' s   want < 1.50');
  console.log('  top speed                        ' + num(s.top * 3.6, 1, 8) + ' km/h');
  console.log('  off-track                        ' + num(s.offTime, 2, 8) + ' s of ' + s.t.toFixed(0) + ' s');
  console.log('  respawns                         ' + num(s.respawns, 0, 8));
  console.log('  drifts / mini-turbos             ' + num(s.stats.drifts, 0, 8) + ' /' + num(s.stats.miniturbos, 0, 6));
}

if (only === 'tiers') {
  console.log(B('\nTIER PACE (4 laps each, solo)'));
  for (let i = 0; i < TIERS.length; i++) {
    const s = await runSolo(world, track, i, 4);
    const mean = s.times.reduce((a, b) => a + b, 0) / Math.max(s.times.length, 1);
    console.log('  ' + pad(TIERS[i].name, 16) + 'mean ' + num(mean, 2, 7) + ' s   best ' + num(Math.min(...s.times), 2, 7) +
      ' s   spread ' + num(Math.max(...s.times) - Math.min(...s.times), 2, 6) + ' s   off ' + num(s.offTime, 1, 5) + ' s');
  }
}

if (only === 'all' || only === 'race') {
  const out = await runRace(world, track, {});
  reportRace(out);
}
