/**
 * Kat Racing — the race itself.
 *
 * A twelve-kart, three-lap grand prix state machine: intro flythrough, countdown with a
 * rocket-start window, racing, chequered flag, results. It owns the field (one
 * `createVehicle()` per racer, one shared collision world), the AI, lap counting against
 * `track.checkpoints` with wrong-way and shortcut detection, live positions, lap and best-lap
 * times, the finishing order, and a ghost recording of the player's line.
 *
 *   import { createRace } from './game/race.js';
 *   const race = createRace(world, track, { field: 12, laps: 3, items, scene });
 *   race.start();
 *   race.setInput({ throttle: 1, steer: -0.4, drift: 1 });   // the human's kart
 *   race.update(dt);
 *   race.standings[0].name;   // who is winning
 *
 * `state` is a live object (phase, clock, countdown, lap, flags) so the HUD can read it every
 * frame without allocating. No Three.js import: this runs headless in tools/sim/race.mjs.
 */
import { clamp, lerp, smoothstep } from '../core/mathx.js';
import { createVehicle, makeFallbackTrack, DEFAULTS } from '../physics/vehicle.js';
import { createCollisionWorld } from '../physics/collision.js';
import { createAI, buildRacingLine, resolveTrack, applyItemEffects, DIFFICULTY } from './ai.js';

const PHASES = ['idle', 'intro', 'countdown', 'racing', 'finished', 'results'];

const FALLBACK_NAMES = ['Mitzi', 'Shuki', 'Yaffa', 'Kobi', 'Layla', 'Shelly', 'Dror', 'Tamar', 'Boaz', 'Nofar', 'Pinchas', 'Zohar'];

const fmtTime = t => {
  if (!Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};

/* ==================================================================== race == */

export function createRace(world, track, opts = {}) {
  const O = Object.assign({
    field: 12,
    laps: null,                 // default: track.laps ?? 3
    seed: 5150,
    playerIndex: 0,             // -1 for a full AI demo field
    autopilot: true,            // drive the player's kart with the AI until setInput() is used
    difficulty: 150,
    items: null,                // createItemSystem() instance (optional)
    roster: null,               // [{ id, name, stats }] from src/characters/roster.js
    vehicleOpts: {},
    collision: null,
    line: null, lineOpts: null,
    introTime: 6.0,
    countdownTime: 3.6,
    rocket: { open: 0.75, perfect: 0.34, close: 0.05, burnout: 1.30, power: 0.34, dur: 1.35 },
    postRaceTime: 6.0,
    finishTimeout: 45,          // seconds after the winner before stragglers are timed out
    ghostHz: 20,
    bump: true,
    wrongWayTime: 0.7,
    shortcutFactor: 0.55,       // travelled/expected below this between checkpoints = a cut
  }, opts);

  const trk = resolveTrack(world, track, { seed: O.seed }) || makeFallbackTrack(world, { seed: O.seed });
  const len = trk.length;
  const laps = O.laps ?? trk.laps ?? 3;
  const line = O.line || buildRacingLine(trk, O.lineOpts || {});
  const mod = v => ((v % len) + len) % len;

  /* ---------------------------------------------------------- checkpoints -- */
  const startS = Number.isFinite(trk.startS) ? trk.startS
    : (trk.startGrid?.[0] ? safeNearest(trk.startGrid[0].pos).s : 0);
  function safeNearest(p) {
    try { const n = trk.nearest(p); return { s: n.s, lateral: n.lateral, onTrack: n.onTrack !== false }; }
    catch (e) { return { s: 0, lateral: 0, onTrack: true }; }
  }
  const cps = [];
  {
    const raw = Array.isArray(trk.checkpoints) ? trk.checkpoints : [];
    const rels = [];
    for (const c of raw) {
      let s = null;
      if (typeof c === 'number') s = c;
      else if (Number.isFinite(c?.s)) s = c.s;
      else if (c?.pos) s = safeNearest(c.pos).s;
      if (s === null) continue;
      rels.push(mod(s - startS));
    }
    rels.sort((a, b) => a - b);
    const out = [];
    for (const r of rels) if (!out.length || r - out[out.length - 1] > 4) out.push(r);
    if (!out.length || out[0] > 4) out.unshift(0);
    else out[0] = 0;
    // a sanity floor: never fewer than 6 gates, or a shortcut is impossible to see
    if (out.length < 6) {
      out.length = 0;
      for (let i = 0; i < 12; i++) out.push(i / 12 * len);
    }
    for (let i = 0; i < out.length; i++) {
      const s = mod(startS + out[i]);
      let pos = null;
      try { pos = { ...trk.sample(s).pos }; } catch (e) { pos = null; }
      cps.push({ index: i, rel: out[i], s, pos, gap: 0 });
    }
    for (let i = 0; i < cps.length; i++) {
      const nx = cps[(i + 1) % cps.length];
      cps[i].gap = mod(nx.rel - cps[i].rel) || len;
    }
  }

  /* ------------------------------------------------------------- the field -- */
  const collision = O.collision || createCollisionWorld(world, trk, opts.collisionOpts || {});
  const roster = Array.isArray(O.roster) && O.roster.length ? O.roster : null;
  const grid = (trk.startGrid && trk.startGrid.length) ? trk.startGrid : buildGrid();
  function buildGrid() {
    const g = [];
    for (let i = 0; i < O.field; i++) {
      const s = startS - 6 - Math.floor(i / 2) * 7;
      let sm; try { sm = trk.sample(s); } catch (e) { break; }
      const side = (i % 2 ? 1 : -1) * 2.7;
      g.push({ pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y, z: sm.pos.z + sm.normal.z * side }, rot: Math.atan2(sm.tangent.x, sm.tangent.z) });
    }
    return g;
  }
  /** The track may only publish an eight-car grid; a twelve-kart field extends it backwards. */
  function gridSlot(i) {
    if (grid.length >= O.field) return grid[i];
    try {
      const sm = trk.sample(startS - 6 - Math.floor(i / 2) * 7);
      const side = (i % 2 ? 1 : -1) * 2.7;
      return { pos: { x: sm.pos.x + sm.normal.x * side, y: sm.pos.y, z: sm.pos.z + sm.normal.z * side }, rot: Math.atan2(sm.tangent.x, sm.tangent.z) };
    } catch (e) { return grid[grid.length - 1] || { pos: { x: 0, y: 0, z: 0 }, rot: 0 }; }
  }

  const vehicles = [];
  const racers = [];
  for (let i = 0; i < O.field; i++) {
    const entry = roster ? roster[i % roster.length] : null;
    const v = createVehicle(world, trk, Object.assign({
      seed: (O.seed + i * 7919) >>> 0, collision,
    }, O.vehicleOpts, tuneFor(entry)));
    const slot = gridSlot(i);
    try { v.reset(slot.pos, slot.rot); } catch (e) { /* the vehicle already reset itself */ }
    vehicles.push(v);
    racers.push({
      index: i,
      id: entry?.id || ('kart' + i),
      name: entry?.name || FALLBACK_NAMES[i % FALLBACK_NAMES.length],
      entry, vehicle: v, isPlayer: i === O.playerIndex,
      grid: i + 1, place: i + 1, prevPlace: i + 1,
      lap: 0, cpIndex: 1, u: 0, prevU: 0, s: 0, lateral: 0, progress: 0, progressInit: false, distSinceCp: 0,
      lapTimes: [], bestLap: Infinity, lapStart: 0, totalTime: 0,
      finished: false, finishTime: 0, finishPlace: 0, dnf: false,
      wrongWay: false, wrongWayT: 0, shortcuts: 0, lapCuts: 0, missedCp: false,
      offTrack: 0, offTrackTime: 0, offTrackTrip: 0, respawns: 0, prevRespawns: 0,
      launchHold: 0, launchStart: -1, rocket: 'none', burnout: 0,
      itemsUsed: 0, hitCount: 0, ai: null,
      speedSum: 0, speedN: 0, topSpeed: 0,
    });
  }
  /** Roster stats (0..5) become tiny physics deltas so karts differ like they look. */
  function tuneFor(entry) {
    if (!entry || !entry.stats) return {};
    const st = entry.stats;
    const d = (v, k) => (v - 3.25) * k;
    return {
      topSpeed: DEFAULTS.topSpeed * (1 + d(st.speed, 0.012)),
      maxDriveForce: DEFAULTS.maxDriveForce * (1 + d(st.accel, 0.030)),
      mass: DEFAULTS.mass * (1 + d(st.weight, 0.035)),
      gripBase: DEFAULTS.gripBase * (1 + d(st.handling, 0.014)),
      driftTiers: DEFAULTS.driftTiers.map(t => t * (1 - d(st.drift, 0.030))),
    };
  }
  for (const v of vehicles) v.setRivals(vehicles.filter(o => o !== v));

  /* -------------------------------------------------------------- the AI --- */
  const tierPlan = DIFFICULTY[O.difficulty] || DIFFICULTY[150];
  const ai = createAI(world, trk, null, {
    seed: O.seed ^ 0x51ed,
    count: O.field,
    vehicles,
    line,
    items: O.items,
    difficulty: O.difficulty,
    tiers: tierPlan,
    ids: racers.map(r => r.id),
    names: racers.map(r => r.name),
    stats: racers.map(r => r.entry?.stats || null),
    step: false,                        // race.js owns the integration order
  });
  ai.racers.forEach((a, i) => { a.isPlayer = racers[i].isPlayer; racers[i].ai = a; });

  /* --------------------------------------------------------------- state --- */
  const state = {
    phase: 'idle', time: 0, raceTime: 0, phaseTime: 0,
    countdown: O.countdownTime, light: 0, go: false,
    laps, field: O.field, lapsLeft: laps,
    playerIndex: O.playerIndex, player: racers[O.playerIndex] || null,
    finishedCount: 0, winner: null, leader: null,
    started: false, over: false, message: '',
  };
  const listeners = new Map();
  const on = (type, cb) => { (listeners.get(type) || listeners.set(type, []).get(type)).push(cb); return () => off(type, cb); };
  const off = (type, cb) => { const a = listeners.get(type); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } };
  const emit = (type, e) => { const a = listeners.get(type); if (a) for (const cb of a) { try { cb(e); } catch (err) { /* a listener must never break the race */ } } };

  /* --------------------------------------------------------- player input -- */
  let humanInput = null, humanSeen = false;
  const playerInput = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
  /** Hand the player's kart to a human. `setInput(null)` gives it back to the autopilot. */
  function setInput(inp) {
    humanInput = inp || null;
    humanSeen = !!inp;
    return api;
  }
  function readPlayerInput() {
    const src = (typeof O.input === 'function' ? O.input() : humanInput);
    if (!src) return null;
    playerInput.throttle = clamp(src.throttle ?? 0, 0, 1);
    playerInput.brake = clamp(src.brake ?? 0, 0, 1);
    playerInput.steer = clamp(src.steer ?? 0, -1, 1);
    playerInput.drift = clamp(src.drift ?? 0, 0, 1);
    playerInput.item = clamp(src.item ?? 0, 0, 1);
    playerInput.look = clamp(src.look ?? 0, -1, 1);
    return playerInput;
  }

  /* --------------------------------------------------------------- ghost --- */
  const ghost = { hz: O.ghostHz, frames: [], t: 0, lap: [] };
  function recordGhost(dt) {
    const p = state.player;
    if (!p || p.finished) return;
    ghost.t += dt;
    const step = 1 / ghost.hz;
    if (ghost.t < step) return;
    ghost.t -= step;
    const tf = p.vehicle.getTransform();
    ghost.frames.push({
      t: state.raceTime, x: tf.position.x, y: tf.position.y, z: tf.position.z,
      qx: tf.quaternion.x, qy: tf.quaternion.y, qz: tf.quaternion.z, qw: tf.quaternion.w,
      speed: p.vehicle.state.speed, lap: p.lap,
    });
    if (ghost.frames.length > 60 * 60 * ghost.hz) ghost.frames.shift();
  }
  const ghostApi = {
    get frames() { return ghost.frames; },
    get duration() { return ghost.frames.length ? ghost.frames[ghost.frames.length - 1].t : 0; },
    sample(t) {
      const f = ghost.frames;
      if (!f.length) return null;
      if (t <= f[0].t) return f[0];
      if (t >= f[f.length - 1].t) return f[f.length - 1];
      let lo = 0, hi = f.length - 1;
      while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (f[m].t <= t) lo = m; else hi = m; }
      const a = f[lo], b = f[hi], k = (t - a.t) / ((b.t - a.t) || 1);
      return {
        t, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k),
        qx: lerp(a.qx, b.qx, k), qy: lerp(a.qy, b.qy, k), qz: lerp(a.qz, b.qz, k), qw: lerp(a.qw, b.qw, k),
        speed: lerp(a.speed, b.speed, k), lap: b.lap,
      };
    },
    clear() { ghost.frames.length = 0; ghost.t = 0; },
  };

  /* ------------------------------------------------------------ lap logic -- */
  function crossed(prevU, u, target) {
    let travel = u - prevU; if (travel < -len * 0.5) travel += len;
    if (travel <= 0 || travel > len * 0.5) return false;
    let d = target - prevU; if (d < 0) d += len;
    return d > 0 && d <= travel + 1e-9;
  }

  function trackProgress(r, dt) {
    const st = r.vehicle.state;
    const nr = safeNearest(st.pos);
    r.s = nr.s; r.lateral = nr.lateral;
    const onTrack = st.onTrack !== false;
    if (!onTrack) {
      r.offTrackTime += dt;
      if (r.offTrackTrip === 0 && r.offTrackTime > 0.35) { r.offTrack++; r.offTrackTrip = 1; }
    } else { r.offTrackTrip = 0; }
    if (st.respawns !== r.prevRespawns) { r.respawns = st.respawns; r.prevRespawns = st.respawns; }

    const u = mod(nr.s - startS);
    const step3d = Math.hypot(st.vel.x, st.vel.z) * dt;
    r.distSinceCp += step3d;
    r.speedSum += st.speed; r.speedN++;
    if (st.speed > r.topSpeed) r.topSpeed = st.speed;

    // wrong way
    let tan = null;
    try { tan = trk.sample(nr.s).tangent; } catch (e) { tan = null; }
    if (tan && (state.phase === 'racing' || state.phase === 'finished')) {
      const dot = (st.vel.x * tan.x + st.vel.z * tan.z);
      if (st.speed > 4 && dot < -0.25 * st.speed) r.wrongWayT += dt;
      else r.wrongWayT = Math.max(0, r.wrongWayT - dt * 2);
      const ww = r.wrongWayT > O.wrongWayTime;
      if (ww !== r.wrongWay) { r.wrongWay = ww; emit('wrongway', { racer: r, on: ww }); }
    }

    if (state.phase === 'racing' || state.phase === 'finished') {
      let guard = 0;
      while (guard++ < cps.length + 1) {
        // gates 1..n-1 are the intermediates; gate n is the start/finish line itself (rel 0)
        const goal = r.cpIndex >= cps.length ? 0 : cps[r.cpIndex].rel;
        if (!crossed(r.prevU, u, goal)) break;
        const prev = cps[(r.cpIndex - 1 + cps.length) % cps.length];
        const expected = prev.gap;
        const cut = r.distSinceCp < expected * O.shortcutFactor;
        if (cut) {
          r.shortcuts++; r.lapCuts++;
          emit('shortcut', { racer: r, checkpoint: r.cpIndex, travelled: r.distSinceCp, expected });
        }
        r.distSinceCp = 0;
        r.cpIndex++;
        if (r.cpIndex > cps.length) {
          r.cpIndex = 1;
          completeLap(r);
          break;
        }
      }
    }
    // Progress is integrated, not derived from (lap, u): karts start *behind* the line, so a
    // lap*len + u formula would jump backwards by a whole lap the first time they cross it.
    if (r.progressInit) {
      let d = u - r.prevU;
      if (d > len * 0.5) d -= len; else if (d < -len * 0.5) d += len;
      r.progress += d;
    } else { r.progress = u > len * 0.5 ? u - len : u; r.progressInit = true; }
    r.prevU = u;
    r.u = u;
  }

  function completeLap(r) {
    const t = state.raceTime;
    const lapTime = t - r.lapStart;
    r.lapStart = t;
    r.lap++;
    const clean = r.lapCuts === 0;
    r.lapCuts = 0;
    if (r.lap > 0 && Number.isFinite(lapTime) && lapTime > 3) {
      r.lapTimes.push(lapTime);
      // a lap with a cut in it still counts for position, but never for the record books
      if (clean && lapTime < r.bestLap) r.bestLap = lapTime;
      emit('lap', { racer: r, lap: r.lap, time: lapTime, best: r.bestLap, clean });
    }
    if (r.lap >= laps && !r.finished) finish(r);
    if (r.isPlayer) state.lapsLeft = Math.max(0, laps - r.lap);
  }

  function finish(r) {
    r.finished = true;
    r.finishTime = state.raceTime;
    r.totalTime = state.raceTime;
    state.finishedCount++;
    r.finishPlace = state.finishedCount;
    if (r.finishPlace === 1) { state.winner = r; emit('win', { racer: r }); }
    emit('finish', { racer: r, place: r.finishPlace, time: r.finishTime });
    if (r.isPlayer && state.phase === 'racing') setPhase('finished');
    if (state.finishedCount >= racers.length) setPhase('results');
  }

  /* ------------------------------------------------------------ positions -- */
  const order = racers.slice();
  function updatePositions() {
    order.sort((a, b) => {
      if (a.finished || b.finished) {
        if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
        return a.finished ? -1 : 1;
      }
      if (a.lap !== b.lap) return b.lap - a.lap;
      if (a.cpIndex !== b.cpIndex) return b.cpIndex - a.cpIndex;
      // same gate: whoever has less of it left is ahead
      const ca = cps[a.cpIndex % cps.length], cb = cps[b.cpIndex % cps.length];
      const da = mod((ca.rel || len) - a.u), db = mod((cb.rel || len) - b.u);
      return da - db;
    });
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      if (r.place !== i + 1) { r.prevPlace = r.place; r.place = i + 1; emit('position', { racer: r, place: r.place, from: r.prevPlace }); }
      else r.place = i + 1;
    }
    state.leader = order[0] || null;
  }

  /* --------------------------------------------------------------- phases -- */
  function setPhase(p) {
    if (state.phase === p) return;
    state.phase = p; state.phaseTime = 0;
    if (p === 'countdown') { state.countdown = O.countdownTime; state.message = 'Ready'; }
    if (p === 'racing') { state.go = true; state.message = 'GO!'; applyRocketStarts(); }
    if (p === 'finished') state.message = 'Finish!';
    if (p === 'results') { state.over = true; state.message = 'Results'; buildResults(); }
    emit('phase', { phase: p });
  }

  function start(skipIntro = false) {
    state.started = true;
    state.time = 0; state.raceTime = 0;
    setPhase(skipIntro ? 'countdown' : 'intro');
    emit('start', { phase: state.phase });
    return api;
  }

  /* -------------------------------------------------------- rocket starts -- */
  function trackLaunch(r, inp, dt) {
    const t = clamp(inp?.throttle ?? 0, 0, 1);
    if (t > 0.5) {
      if (r.launchStart < 0) r.launchStart = state.countdown;
      r.launchHold += dt;
    } else if (state.countdown > 0.15) {
      r.launchStart = -1; r.launchHold = 0;
    }
  }
  function applyRocketStarts() {
    const R = O.rocket;
    for (const r of racers) {
      const held = r.launchStart >= 0 ? r.launchStart : -1;
      if (held < 0) { r.rocket = 'none'; continue; }
      if (held > R.burnout) {
        r.rocket = 'burnout'; r.burnout = 1.1;
        emit('rocket', { racer: r, kind: 'burnout' });
      } else if (held <= R.open && held >= R.close) {
        const q = 1 - clamp(Math.abs(held - R.perfect) / Math.max(R.open - R.perfect, 0.1), 0, 1);
        r.rocket = q > 0.72 ? 'perfect' : 'good';
        try { r.vehicle.addBoost(R.dur * lerp(0.6, 1, q), R.power * lerp(0.55, 1, q), 'rocket'); } catch (e) { /* ignore */ }
        emit('rocket', { racer: r, kind: r.rocket, quality: q });
      } else r.rocket = 'none';
    }
  }

  /* --------------------------------------------------------------- update -- */
  const zeroInput = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
  const holdInput = { throttle: 0, brake: 0.35, steer: 0, drift: 0, item: 0, look: 0 };
  let itemPressed = false;

  function update(dt) {
    dt = clamp(dt || 0, 0, 0.1);
    state.time += dt; state.phaseTime += dt;

    if (state.phase === 'idle') return api;

    if (state.phase === 'intro') {
      if (state.phaseTime >= O.introTime) setPhase('countdown');
      // karts idle on the grid: step the physics so they settle onto their suspension, on the
      // brakes so a sloping grid does not roll the field into the first corner before the lights
      for (const r of racers) r.vehicle.update(dt, holdInput);
      return api;
    }

    const racing = state.phase === 'racing' || state.phase === 'finished';
    if (state.phase === 'countdown') {
      state.countdown = Math.max(0, state.countdown - dt);
      state.light = state.countdown > 2.4 ? 0 : state.countdown > 1.6 ? 1 : state.countdown > 0.8 ? 2 : 3;
      state.message = state.countdown > 2.4 ? '3' : state.countdown > 1.6 ? '2' : state.countdown > 0.8 ? '1' : 'GO!';
    } else if (racing) {
      state.raceTime += dt;
    }

    if (state.phase === 'countdown' && state.countdown <= 0) { setPhase('racing'); }
    const nowRacing = state.phase === 'racing' || state.phase === 'finished';

    // AI context: everyone's progress, so opponents can see the player too. The AI's own
    // racer objects *are* the field entries, so `o === r` self-exclusion keeps working.
    for (const r of racers) {
      const a = r.ai; if (!a) continue;
      a.s = r.s; a.lateral = r.lateral; a.progress = r.progress; a.place = r.place;
    }
    ai.setField(ai.racers);
    ai.setLeaderProgress(state.leader ? state.leader.progress : 0);
    ai.setGate({ racing: nowRacing, tMinus: state.countdown, go: state.go });

    for (const r of racers) {
      let inp;
      if (r.isPlayer && (humanSeen || typeof O.input === 'function')) {
        inp = readPlayerInput() || zeroInput;
      } else if (r.ai && O.autopilot !== false) {
        inp = ai.control(r.ai, dt);      // the same controller the opponents use
      } else inp = zeroInput;

      if (!nowRacing) {
        trackLaunch(r, inp, dt);
        if (state.phase === 'countdown') {
          const gated = { throttle: inp.throttle, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
          // holding the throttle on the grid revs but never moves the kart
          r.vehicle.update(dt, holdInput);
          void gated;
          continue;
        }
      }

      if (r.burnout > 0) { r.burnout -= dt; inp = { ...inp, throttle: 0, brake: 0 }; }
      if (r.finished) {
        // cool-down lap: ease off, keep them on the road so the results camera has karts in it
        inp = { ...inp, throttle: inp.throttle * 0.55, brake: 0, item: 0 };
      }
      if (O.items) applyItemEffects(O.items, r.vehicle, dt, inp);
      if (r.isPlayer && O.items && inp.item > 0.5 && !itemPressed) { try { O.items.useItem(r.vehicle, inp.look < -0.5); r.itemsUsed++; } catch (e) { /* ignore */ } }
      if (r.isPlayer) itemPressed = inp.item > 0.5;

      r.vehicle.update(dt, inp);
    }

    if (O.bump) {
      for (let i = 0; i < racers.length; i++) {
        for (let j = i + 1; j < racers.length; j++) {
          const a = racers[i].vehicle.state.pos, b = racers[j].vehicle.state.pos;
          const dx = a.x - b.x, dz = a.z - b.z;
          if (dx * dx + dz * dz < 9) { try { racers[i].vehicle.bump(racers[j].vehicle); } catch (e) { /* ignore */ } }
        }
      }
    }

    if (O.items) {
      try { O.items.update(dt, vehicles); } catch (e) { /* the race outlives a bad item frame */ }
    }

    for (const r of racers) trackProgress(r, dt);
    updatePositions();

    if (nowRacing) {
      recordGhost(dt);
      for (const r of racers) if (!r.finished) r.totalTime = state.raceTime;
    }

    if (state.phase === 'finished' && state.phaseTime > O.finishTimeout) {
      for (const r of racers) if (!r.finished) { r.dnf = true; finish(r); }
      setPhase('results');
    }
    if (state.phase === 'results' && state.phaseTime > O.postRaceTime) state.over = true;
    return api;
  }

  /* -------------------------------------------------------------- results -- */
  let results = [];
  function buildResults() {
    const lead = order.find(r => r.finishPlace === 1) || order[0];
    results = order.map(r => ({
      place: r.finished ? r.finishPlace : r.place,
      id: r.id, name: r.name, grid: r.grid,
      time: r.finished ? r.finishTime : null,
      gap: r.finished && lead?.finishTime ? r.finishTime - lead.finishTime : null,
      bestLap: Number.isFinite(r.bestLap) ? r.bestLap : null,
      lapTimes: r.lapTimes.slice(),
      laps: r.lap, dnf: !!r.dnf,
      shortcuts: r.shortcuts, offTrack: r.offTrack, respawns: r.respawns,
      tier: r.ai?.tier?.id || 'player', isPlayer: r.isPlayer,
      topSpeed: r.topSpeed, meanSpeed: r.speedN ? r.speedSum / r.speedN : 0,
    })).sort((a, b) => a.place - b.place);
    emit('results', { results });
    return results;
  }

  /* --------------------------------------------------------------- cameras - */
  /** Intro flythrough: sweeps the lap backwards and settles behind the grid. */
  function introCamera(t) {
    const k = clamp(t / Math.max(O.introTime, 0.01), 0, 1);
    const e = smoothstep(0, 1, k);
    const s = startS + lerp(len * 0.42, -12, e);
    let a, b;
    try { a = trk.sample(s); b = trk.sample(s + 26); } catch (e2) { return { pos: [0, 60, 0], look: [0, 0, 0], fov: 55 }; }
    const h = lerp(46, 7.5, e);
    const sideAmt = Math.sin(k * 5.2) * lerp(28, 5, e);
    return {
      pos: [a.pos.x + a.normal.x * sideAmt, a.pos.y + h, a.pos.z + a.normal.z * sideAmt],
      look: [b.pos.x, b.pos.y + 1.4, b.pos.z],
      fov: lerp(64, 52, e),
    };
  }
  /** Results: a slow orbit of whoever won. */
  function resultsCamera(t) {
    const r = state.winner || order[0];
    const p = r ? r.vehicle.state.pos : { x: 0, y: 0, z: 0 };
    const a = t * 0.45;
    return { pos: [p.x + Math.cos(a) * 9, p.y + 4.2, p.z + Math.sin(a) * 9], look: [p.x, p.y + 1.1, p.z], fov: 46 };
  }
  function cameraSuggestion(t = state.phaseTime) {
    if (state.phase === 'intro') return { mode: 'intro', ...introCamera(t) };
    if (state.phase === 'results') return { mode: 'results', ...resultsCamera(t) };
    const r = state.player || order[0];
    if (!r) return { mode: 'chase', pos: [0, 40, 0], look: [0, 0, 0], fov: 55 };
    const tf = r.vehicle.getTransform();
    const back = state.phase === 'countdown' ? 6.5 : 7.2;
    return {
      mode: 'chase',
      pos: [tf.position.x - tf.forward.x * back, tf.position.y + 3.0, tf.position.z - tf.forward.z * back],
      look: [tf.position.x + tf.forward.x * 8, tf.position.y + 1.1, tf.position.z + tf.forward.z * 8],
      fov: 58,
    };
  }

  /* ------------------------------------------------------------------ api -- */
  function reset() {
    state.phase = 'idle'; state.time = 0; state.raceTime = 0; state.phaseTime = 0;
    state.countdown = O.countdownTime; state.go = false; state.over = false;
    state.finishedCount = 0; state.winner = null; state.lapsLeft = laps;
    ghostApi.clear();
    results = [];
    racers.forEach((r, i) => {
      const slot = gridSlot(i);
      try { r.vehicle.reset(slot.pos, slot.rot); } catch (e) { /* ignore */ }
      r.lap = 0; r.cpIndex = 1; r.lapTimes.length = 0; r.bestLap = Infinity; r.lapStart = 0;
      r.finished = false; r.finishTime = 0; r.finishPlace = 0; r.dnf = false;
      r.place = i + 1; r.prevPlace = i + 1; r.progress = 0; r.progressInit = false; r.distSinceCp = 0;
      r.wrongWay = false; r.wrongWayT = 0; r.shortcuts = 0; r.lapCuts = 0; r.offTrack = 0; r.offTrackTime = 0;
      r.launchHold = 0; r.launchStart = -1; r.rocket = 'none'; r.burnout = 0;
      r.speedSum = 0; r.speedN = 0; r.topSpeed = 0;
      const n = safeNearest(r.vehicle.state.pos);
      r.s = n.s; r.u = mod(n.s - startS); r.prevU = r.u;
    });
    try { O.items?.reset(); } catch (e) { /* ignore */ }
    return api;
  }
  // seed prevU so the first frame cannot register a phantom checkpoint
  for (const r of racers) { const n = safeNearest(r.vehicle.state.pos); r.s = n.s; r.u = mod(n.s - startS); r.prevU = r.u; }

  const api = {
    state, racers, vehicles, ai, line, track: trk, checkpoints: cps, collision,
    laps, length: len, startS, ghost: ghostApi,
    update, start, reset, setInput, on, off,
    get phase() { return state.phase; },
    get standings() { return order.slice(); },
    get results() { return results.length ? results : buildResults(); },
    get player() { return state.player; },
    get leader() { return order[0]; },
    setDifficulty(d) { ai.setDifficulty(d); return api; },
    setItems(sys) { O.items = sys; ai.setItems(sys); return api; },
    skipIntro() { if (state.phase === 'intro') setPhase('countdown'); return api; },
    introCamera, resultsCamera, cameraSuggestion,
    hud() {
      const p = state.player;
      return {
        phase: state.phase, message: state.message, countdown: state.countdown,
        lap: p ? Math.min(p.lap + 1, laps) : 1, laps,
        place: p ? p.place : 1, field: racers.length,
        time: state.raceTime, lapTime: p ? state.raceTime - p.lapStart : 0,
        bestLap: p && Number.isFinite(p.bestLap) ? p.bestLap : null,
        speedKmh: p ? p.vehicle.state.speed * 3.6 : 0,
        wrongWay: !!p?.wrongWay, item: O.items && p ? O.items.hud(p.vehicle) : null,
      };
    },
    format: fmtTime,
    telemetry() {
      return order.map(r => ({
        place: r.place, name: r.name, lap: r.lap + 1, cp: r.cpIndex,
        kmh: +(r.vehicle.state.speed * 3.6).toFixed(1),
        best: Number.isFinite(r.bestLap) ? +r.bestLap.toFixed(2) : null,
        tier: r.ai?.tier?.id, wrongWay: r.wrongWay, off: r.offTrack,
      }));
    },
  };
  return api;
}

export { fmtTime, PHASES };
export default createRace;
