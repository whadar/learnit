/**
 * The race: grid, lights, laps, places, results.
 *
 * Two things here are scar tissue and are written down so they are not undone.
 *
 * 1. The grid is PINNED, not braked. A brake held at a standstill is how you ask the vehicle to
 *    reverse, so expressing the hold as `brake: 1` puts the whole field under rearward drive for
 *    the length of the countdown — it once measured -1.04 m/s of backward creep with the lights
 *    still red. The karts are simply held at their slot until the flag.
 *
 * 2. `autopilot` means "drive the PLAYER's kart for them" — attract mode, a demo, a screenshot.
 *    It must never gate the opponents. Gating the whole field froze every rival the moment a
 *    human took the wheel, and every headless bench missed it because they all ran autopilot on.
 */
import { createVehicle } from '../physics/vehicle.js';
import { createAI, buildLine } from './ai.js';
import { createItems } from './items.js';
import { clamp, rng } from '../core/math.js';

const ZERO = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0 };

export function createRace(world, track, opts = {}) {
  const drivers = opts.drivers;
  const laps = opts.laps ?? 3;
  const playerIndex = opts.playerIndex ?? 0;
  const rand = rng(opts.seed ?? 5150);
  const line = buildLine(track);
  const items = createItems(track, { seed: opts.seed ?? 5150 });

  const racers = drivers.map((d, i) => {
    const v = createVehicle(world, track, { seed: (opts.seed ?? 1) + i * 7919, ...(opts.tuneFor?.(d) ?? {}) });
    const slot = track.startGrid[i] ?? track.startGrid[0];
    v.reset(slot.pos, slot.rot);
    return {
      driver: d, index: i, isPlayer: i === playerIndex, vehicle: v,
      ai: createAI(track, line, { tier: i === playerIndex ? 2 : 2 - (i % 3), skill: opts.difficulty ?? 1,
                                  wobble: (rand() - 0.5) * 0.04 }),
      anchor: { x: slot.pos.x, z: slot.pos.z },
      lap: 0, cp: 0, s: 0, prog: 0, place: i + 1, grid: i + 1,
      lapStart: 0, best: Infinity, times: [], finished: false, finishTime: 0,
      wrongWay: false, item: null,
    };
  });

  const state = { phase: 'idle', time: 0, phaseT: 0, countdown: 3, over: false, message: '' };
  const listeners = new Map();
  const on = (k, f) => { (listeners.get(k) ?? listeners.set(k, []).get(k)).push(f); return () => off(k, f); };
  const off = (k, f) => { const a = listeners.get(k); const i = a?.indexOf(f) ?? -1; if (i >= 0) a.splice(i, 1); };
  const emit = (k, e) => { for (const f of listeners.get(k) ?? []) { try { f(e); } catch { /* a listener must not break the race */ } } };

  let human = null;
  const setInput = i => { human = i || null; };
  const setPhase = p => { state.phase = p; state.phaseT = 0; emit('phase', { phase: p }); };

  function start() {
    state.time = 0; state.over = false;
    for (const r of racers) {
      const slot = track.startGrid[r.index] ?? track.startGrid[0];
      r.vehicle.reset(slot.pos, slot.rot);
      r.anchor = { x: slot.pos.x, z: slot.pos.z };
      Object.assign(r, { lap: 0, cp: 0, prog: 0, finished: false, finishTime: 0, best: Infinity, times: [], lapStart: 0 });
    }
    items.reset();
    setPhase('countdown');
    state.countdown = 3;
  }

  /** Hold a kart in its slot. Height is left free so the suspension still settles. */
  function pin(r) {
    const s = r.vehicle.state;
    s.pos.x = r.anchor.x; s.pos.z = r.anchor.z;
    s.vel.x = 0; s.vel.z = 0;
    s.speed = Math.abs(s.vel.y); s.forwardSpeed = 0;
    for (const w of r.vehicle.wheels) w.spin = 0;
  }

  const revInput = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0 };

  function update(dt, o = {}) {
    const autopilot = o.autopilot === true;
    state.phaseT += dt;

    if (state.phase === 'countdown') {
      state.countdown = Math.max(0, 3 - Math.floor(state.phaseT));
      state.message = state.countdown > 0 ? String(state.countdown) : 'GO';
      for (const r of racers) {
        // revving on the line is allowed; moving is not
        revInput.throttle = r.isPlayer && human ? human.throttle : 0;
        r.vehicle.update(dt, revInput);
        pin(r);
      }
      if (state.phaseT > 3.6) { setPhase('racing'); state.message = ''; }
      return;
    }
    if (state.phase === 'idle') { for (const r of racers) pin(r); return; }

    state.time += dt;
    const vehicles = racers.map(r => r.vehicle);

    for (const r of racers) {
      let inp;
      if (r.finished) inp = r.ai.control(r.vehicle, dt, vehicles);
      else if (r.isPlayer && human && !autopilot) inp = human;
      else inp = r.ai.control(r.vehicle, dt, vehicles);
      r.vehicle.update(dt, inp);
      if (inp.item) items.use(r, racers, emit);
      progress(r);
    }
    items.update(dt, racers, emit);
    order();

    if (!state.over && racers.every(r => r.finished)) {
      state.over = true;
      setTimeout(() => setPhase('results'), 0);
    }
  }

  function progress(r) {
    const n = track.nearest(r.vehicle.state.pos);
    const prev = r.s;
    r.s = n.s;
    const d = track.delta(prev, r.s);
    r.wrongWay = d < -1.5 && r.vehicle.state.speed > 4;
    if (Math.abs(d) < track.length * 0.5) r.prog += d;

    // a lap only counts if the checkpoints were taken in order
    const cpEvery = track.length / track.checkpoints.length;
    const want = (r.cp % track.checkpoints.length) * cpEvery;
    if (Math.abs(track.delta(r.s, want)) < 12 || (r.s > want && r.s - want < cpEvery * 0.9)) r.cp++;

    if (r.cp >= track.checkpoints.length && r.s < 20 && prev > track.length - 40) {
      r.cp = 0;
      const t = state.time - r.lapStart;
      if (r.lap > 0 || t > 5) { r.times.push(t); r.best = Math.min(r.best, t); }
      r.lapStart = state.time;
      r.lap++;
      emit('lap', { racer: r, lap: r.lap, time: t });
      if (r.lap >= laps && !r.finished) {
        r.finished = true; r.finishTime = state.time;
        emit('finish', { racer: r });
      }
    }
  }

  function order() {
    const sorted = racers.slice().sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return (b.lap * track.length + b.s) - (a.lap * track.length + a.s);
    });
    sorted.forEach((r, i) => { r.place = i + 1; });
    return sorted;
  }

  const api = {
    state, racers, laps, track, line, items, playerIndex,
    on, off, start, update, setInput,
    get player() { return racers[playerIndex]; },
    get standings() { return order(); },
    get results() {
      return order().map(r => ({ place: r.place, name: r.driver.name, isPlayer: r.isPlayer,
        time: r.finishTime, best: Number.isFinite(r.best) ? r.best : null, laps: r.lap }));
    },
    hud() {
      const p = racers[playerIndex];
      return { phase: state.phase, message: state.message,
        lap: Math.min(p.lap + 1, laps), laps, place: p.place, field: racers.length,
        speed: p.vehicle.state.speed * 3.6, time: state.time,
        best: Number.isFinite(p.best) ? p.best : null,
        item: p.item, wrongWay: p.wrongWay, boost: p.vehicle.state.boost.time > 0,
        drift: p.vehicle.state.drift.tier, sector: track.nearest(p.vehicle.state.pos) };
    },
    reset: start,
  };
  void clamp;
  return api;
}
