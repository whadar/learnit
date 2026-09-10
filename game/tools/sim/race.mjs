/**
 * Headless race bench. No rendering: a full 12-kart, 3-lap race on the real terrain, driven by
 * the real src/game/ai.js against the real src/physics/vehicle.js, printing hard numbers.
 *
 *   node tools/sim/race.mjs             # the full race + the racing-line report
 *   node tools/sim/race.mjs line        # racing line / speed profile only
 *   node tools/sim/race.mjs solo        # one Ace alone: lap-time consistency
 *   node tools/sim/race.mjs tiers       # 4 laps per difficulty tier
 *   node tools/sim/race.mjs drift       # does the mini-turbo pay on a tight loop?
 *   node tools/sim/race.mjs checks      # wrong-way / shortcut / ghost / camera checks
 *   node tools/sim/race.mjs grip        # skidpad: where the line's grip budget comes from
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
/** Which circuit to bench. `SIM_COURSE=dogpatch node tools/sim/race.mjs` */
const COURSE = process.env.SIM_COURSE || 'amikam';
const B = s => `\x1b[1m${s}\x1b[0m`;
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2, w = 7) => String(Number.isFinite(v) ? v.toFixed(n) : '—').padStart(w);

/* ---------------------------------------------------------------- world ---- */
async function loadWorld() {
  try {
    const { WorldData } = await import('../../src/world/worldData.js');
    const base = fs.existsSync(path.join(ROOT, `public/data/${COURSE}.json`))
      ? path.join(ROOT, 'public/data') : path.join(ROOT, 'dist/data');
    const json = JSON.parse(fs.readFileSync(path.join(base, `${COURSE}.json`), 'utf8'));
    const buf = fs.readFileSync(path.join(base, `${COURSE}-height.bin`));
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
    const t = m.buildTrack(world, { course: COURSE });
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

  const stuck = race.racers.map(r => ({ last: r.progress, t: 0, worst: 0, at: 0 }));
  const offLog = [];
  const wasOff = race.racers.map(() => false);
  let t = 0, guard = 0;
  const limit = opts.limit ?? 420;
  while (t < limit && race.state.phase !== 'results' && guard++ < limit * FPS + 10) {
    race.update(DT);
    t += DT;
    if (race.state.phase === 'racing' || race.state.phase === 'finished') {
      race.racers.forEach((r, i) => {
        if (r.finished) return;
        const s = stuck[i];
        if (!s.init) { s.init = true; s.last = r.progress; }
        if (r.progress - s.last > 1.0) { s.last = r.progress; s.t = 0; }
        else { s.t += DT; if (s.t > s.worst) { s.worst = s.t; s.at = t; } }
        const off = r.vehicle.state.onTrack === false;
        if (off && !wasOff[i]) offLog.push({ name: r.name, lap: r.lap + 1, t, s: r.s, kmh: r.vehicle.state.speed * 3.6, lat: r.lateral });
        wasOff[i] = off;
      });
    }
  }
  return { race, events, stuck, offLog, wall: t, items };
}

function reportRace({ race, events, stuck, offLog }) {
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
  // lap 1 starts from a standing grid in traffic, so judge consistency on the flying laps
  const flySpread = [];
  for (const r of results) { const f = r.lapTimes.slice(1); if (f.length > 1) flySpread.push(Math.max(...f) - Math.min(...f)); }
  const flyMean = flySpread.reduce((a, b) => a + b, 0) / Math.max(flySpread.length, 1);
  const flyWorst = flySpread.length ? Math.max(...flySpread) : NaN;

  console.log(B('\nNUMBERS'));
  console.log('  finishers                        ' + num(finished.length, 0, 8) + ' / 12');
  console.log('  winner                           ' + pad(results[0]?.name, 10) + fmtTime(results[0]?.time));
  console.log('  1st→last spread                  ' + num(spread, 2, 8) + ' s   ' + (spread / Math.max(results[0]?.time, 1) * 100).toFixed(1) + '% of the winner');
  console.log('  mean lap                         ' + num(mean, 2, 8) + ' s   sd ' + sd.toFixed(2) + ' s');
  console.log('  per-kart lap spread  mean/worst  ' + num(meanSpread, 2, 6) + ' /' + num(worstSpread, 2, 7) + ' s   (all laps)');
  console.log('  flying-lap spread    mean/worst  ' + num(flyMean, 2, 6) + ' /' + num(flyWorst, 2, 7) + ' s   want < 1.50 s');
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
  console.log('  biggest gap to the leader        ' + num(Math.max(...dr.map(d => d.maxBehind || 0)), 0, 8) + ' m');
  if (process.env.SIM_DIAG) {
    const byLap = {};
    for (const o of offLog) byLap[o.lap] = (byLap[o.lap] || 0) + 1;
    console.log('  off-track by lap                 ' + JSON.stringify(byLap));
    const hot = {};
    for (const o of offLog) { const k = Math.round(o.s / 100) * 100; hot[k] = (hot[k] || 0) + 1; }
    console.log('  off-track by track position (m)  ' + JSON.stringify(hot));
    console.log('  first 12 excursions:');
    for (const o of offLog.slice(0, 12)) console.log(`    t=${o.t.toFixed(1)}s ${pad(o.name, 8)} lap ${o.lap} s=${o.s.toFixed(0)}m ${o.kmh.toFixed(0)} km/h lat ${o.lat.toFixed(1)}`);
    console.log('  worst stall at t=' + stuck.map(s => s.at.toFixed(0)).join(','));
  }
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
async function runSolo(world, track, tierIdx = 3, laps = 6, extra = {}) {
  const collision = createCollisionWorld(world, track, {});
  const line = extra.line || buildRacingLine(track, {});
  const ai = createAI(world, track, (i, o) => createVehicle(world, track, { ...o, collision }), Object.assign({
    count: 1, line, tiers: [tierIdx], seed: 999, rubberBand: false, step: true,
  }, extra));
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

if (only === 'drift' || only === 'all') {
  console.log(B('\nDRIFT BENCH (a deliberately tight loop: does the mini-turbo pay?)'));
  const tight = makeFallbackTrack(world, { seed: 7, radius: +(process.env.SIM_TIGHT || 85), width: 13.5, samples: 320 });
  const tl = buildRacingLine(tight, {});
  console.log('  tight loop                       ' + num(tight.length, 0, 8) + ' m   min radius ' +
    num(tl.stats.minRadius, 1, 6) + ' m   slowest corner ' + num(tl.stats.minSpeed * 3.6, 1, 6) + ' km/h');
  for (const skill of [0, 1]) {
    const s = await runSolo(world, tight, 3, 4, { driftSkill: skill, line: tl });
    const mean = s.times.reduce((a, b) => a + b, 0) / Math.max(s.times.length, 1);
    console.log('  drift ' + (skill ? 'ON ' : 'OFF') + '                        mean lap ' + num(mean, 2, 7) +
      ' s   best ' + num(Math.min(...s.times), 2, 6) + ' s   drifts ' + s.stats.drifts + '  mini-turbos ' + s.stats.miniturbos +
      '  off ' + num(s.offTime, 1, 5) + ' s');
  }
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

if (only === 'grip') {
  // where buildRacingLine()'s latGrip comes from: hold a steady steer at a held speed and read
  // back the lateral acceleration the kart actually sustains on tarmac
  console.log(B('\nSKIDPAD (steady-state lateral grip)'));
  for (const steer of [0.3, 0.45, 0.6]) {
    for (const target of [12, 16, 20, 24]) {
      const v = createVehicle(world, track, { seed: 3 });
      const g = track.startGrid?.[0];
      if (g) v.reset(g.pos, g.rot);
      let t = 0, sum = 0, n = 0, peak = 0;
      while (t < 12) {
        const st = v.state;
        v.update(DT, { throttle: st.forwardSpeed < target ? 1 : 0, brake: st.forwardSpeed > target + 1.5 ? 0.4 : 0, steer, drift: 0 });
        t += DT;
        if (t > 5 && st.grounded && st.onTrack) { const a = Math.abs(st.angVel.y) * st.speed; sum += a; n++; peak = Math.max(peak, a); }
      }
      if (n > 30) console.log(`  steer ${steer.toFixed(2)}  hold ${String(target).padStart(2)} m/s   aLat mean ${num(sum / n, 2, 6)}  peak ${num(peak, 2, 6)} m/s²  (${(sum / n / 9.81).toFixed(2)} g)`);
    }
  }
}

if (only === 'checks' || only === 'all') {
  console.log(B('\nRULE CHECKS (wrong way, shortcut, ghost, results)'));
  const race = createRace(world, track, { field: 6, laps: 3, seed: 11, playerIndex: 0, autopilot: true, introTime: 0, countdownTime: 1.0 });
  race.start(true);
  for (let i = 0; i < 12 * FPS; i++) race.update(DT);
  // spin the player's kart round and hold the throttle: the AI would just turn back, so this
  // has to be the human-driven one
  const a = race.player;
  race.setInput({ throttle: 1, brake: 0, steer: 0, drift: 0, item: 0, look: 0 });
  a.vehicle.reset({ ...a.vehicle.state.pos }, a.vehicle.state.yaw + Math.PI);
  for (let i = 0; i < 4 * FPS; i++) race.update(DT);
  console.log('  wrong-way detected               ' + pad(a.wrongWay ? 'YES' : 'no', 8) + ' after 4 s facing backwards');
  race.setInput(null);

  // teleport another kart a third of a lap up the road: gates it never reached
  const b = race.racers[4];
  const before = { cp: b.cpIndex, cuts: b.shortcuts, lap: b.lap };
  const jump = track.sample((b.s + track.length * 0.33) % track.length);
  b.vehicle.reset({ ...jump.pos }, Math.atan2(jump.tangent.x, jump.tangent.z));
  for (let i = 0; i < 8 * FPS; i++) race.update(DT);
  console.log('  shortcut flagged                 ' + pad(b.shortcuts > before.cuts ? 'YES' : 'no', 8) +
    ' (' + before.cp + ' -> ' + b.cpIndex + ' gates, ' + (b.shortcuts - before.cuts) + ' cuts)');
  console.log('  ghost recording                  ' + pad(race.ghost.frames.length, 8) + ' frames, ' + race.ghost.duration.toFixed(1) + ' s');
  const g = race.ghost.sample(race.ghost.duration * 0.5);
  console.log('  ghost sample at half distance    ' + (g ? `(${g.x.toFixed(1)}, ${g.y.toFixed(1)}, ${g.z.toFixed(1)}) ${(g.speed * 3.6).toFixed(0)} km/h` : 'none'));
  console.log('  phase / standings                ' + race.state.phase + ' / ' + race.standings.map(r => r.place + ':' + r.name).join(' '));
  console.log('  camera modes                     ' + ['intro', 'chase', 'results'].map(m => {
    const c = m === 'intro' ? race.introCamera(2) : m === 'results' ? race.resultsCamera(2) : race.cameraSuggestion();
    return m + '=' + (c && Number.isFinite(c.pos[0]) ? 'ok' : 'BAD');
  }).join(' '));
}

if (only === 'all' || only === 'race') {
  const out = await runRace(world, track, {});
  reportRace(out);
}
