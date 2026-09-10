/**
 * Items — San Francisco, and deliberately few.
 *
 * Six do the job of twelve: something to throw, something to drop, something to take, a shield,
 * a boost and a leader-seeker. Every one is a plain state change on a racer; there are no
 * projectiles with their own physics, because at 1.7 km a lap nobody sees them fly.
 */
import { rng, clamp01 } from '../core/math.js';

export const ITEMS = {
  sourdough: { name: 'Sourdough Roll', kind: 'throw',  hit: 'spin',  reach: 34, weight: [5, 4, 3, 2] },
  latte:     { name: 'Spilled Latte',  kind: 'drop',   hit: 'slip',  life: 14,  weight: [4, 4, 3, 2] },
  coldbrew:  { name: 'Cold Brew',      kind: 'boost',  dur: 1.2,     power: 0.34, weight: [4, 4, 4, 3] },
  firewall:  { name: 'Firewall',       kind: 'shield', dur: 8,       weight: [3, 3, 4, 4] },
  fog:       { name: 'Karl the Fog',   kind: 'blind',  dur: 3.2,     weight: [1, 2, 4, 5] },
  robotaxi:  { name: 'Robotaxi',       kind: 'seek',   hit: 'spin',  weight: [0, 1, 3, 6] },
};
const KEYS = Object.keys(ITEMS);

export function createItems(track, opts = {}) {
  const rand = rng(opts.seed ?? 4242);
  const fx = new Map();                     // racer -> effects

  const eff = r => {
    if (!fx.has(r)) fx.set(r, { spin: 0, slip: 0, blind: 0, shield: 0, cool: 0, roulette: 0 });
    return fx.get(r);
  };
  const reset = () => { fx.clear(); for (const r of []) void r; };

  /** Weighted by place: the leader gets defence, the back gets something to close with. */
  function roll(place, field) {
    const band = Math.min(3, Math.floor((place - 1) / Math.max(1, field / 4)));
    const bag = [];
    for (const k of KEYS) for (let i = 0; i < ITEMS[k].weight[band]; i++) bag.push(k);
    return bag[Math.floor(rand() * bag.length)] || 'coldbrew';
  }

  function update(dt, racers, emit) {
    for (const r of racers) {
      const e = eff(r);
      for (const k of ['spin', 'slip', 'blind', 'shield', 'cool']) e[k] = Math.max(0, e[k] - dt);
      const s = r.vehicle.state;

      if (e.spin > 0) { s.yawRate += 9 * dt; s.vel.x *= 0.985; s.vel.z *= 0.985; }
      if (e.slip > 0) { s.yawRate += Math.sin(e.slip * 11) * 3.4 * dt; }

      // hand out an item when empty, on a short cooldown
      if (!r.item && e.cool <= 0 && r.lap >= 0) {
        e.roulette += dt;
        if (e.roulette > 0.8) { r.item = roll(r.place, racers.length); e.roulette = 0; emit?.('item', { racer: r, item: r.item }); }
      }
    }
    void clamp01;
  }

  function hit(target, kind, from, emit) {
    const e = eff(target);
    if (e.shield > 0) { e.shield = 0; emit?.('block', { racer: target }); return false; }
    if (kind === 'slip') e.slip = 1.6; else e.spin = 1.5;
    target.vehicle.state.boost.time = 0;
    emit?.('hit', { racer: target, from, kind });
    return true;
  }

  function use(r, racers, emit) {
    const e = eff(r);
    if (!r.item || e.cool > 0) return;
    const def = ITEMS[r.item];
    r.item = null; e.cool = 0.7;

    if (def.kind === 'boost') { r.vehicle.state.boost.time = def.dur; r.vehicle.state.boost.power = def.power; }
    else if (def.kind === 'shield') e.shield = def.dur;
    else if (def.kind === 'blind') { for (const o of racers) if (o !== r && o.place < r.place) eff(o).blind = def.dur; }
    else if (def.kind === 'seek') { const lead = racers.find(o => o.place === 1); if (lead && lead !== r) hit(lead, def.hit, r, emit); }
    else if (def.kind === 'throw') {
      let best = null, bd = def.reach;
      for (const o of racers) {
        if (o === r) continue;
        const d = track.delta(r.s, o.s);
        if (d > 0 && d < bd) { bd = d; best = o; }
      }
      if (best) hit(best, def.hit, r, emit);
    } else if (def.kind === 'drop') {
      // a drop is a trap behind you: the nearest kart within a few metres behind takes it
      for (const o of racers) {
        if (o === r) continue;
        const d = track.delta(o.s, r.s);
        if (d > 0 && d < 12) { hit(o, def.hit, r, emit); break; }
      }
    }
    emit?.('use', { racer: r, item: def.name });
  }

  return { update, use, reset, effects: eff, ITEMS,
    blinded: r => eff(r).blind > 0, shielded: r => eff(r).shield > 0 };
}
