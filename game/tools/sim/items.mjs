/**
 * Headless item-game simulation — no renderer, no DOM.
 *
 *   node tools/sim/items.mjs [races] [seed]
 *
 * Drives a full 12-kart field around the course with a simple longitudinal model, lets the
 * item system do the rest, and prints:
 *   - the draw distribution per finishing-order bucket (does the leader really get scraps?)
 *   - what every item actually did (hits, blocks, self-boosts)
 *   - comeback numbers: where the back of the grid finishes with items on vs off
 */
import { createItemSystem, fallbackTrack, ITEMS, ITEM_IDS, itemOdds } from '../../src/game/items.js';
import { rng, clamp, lerp } from '../../src/core/mathx.js';

const RACES = +(process.argv[2] || 12);
const SEED0 = +(process.argv[3] || 20260820);
const LAPS = 3;
const DT = 1 / 60;
const FIELD = 12;

/* A stand-in for WorldData: gentle rolling hills, deterministic. */
const world = {
  heightAt: (x, z) => 92 + Math.sin(x * 0.0042) * 11 + Math.cos(z * 0.0037) * 9 + Math.sin((x + z) * 0.0011) * 5,
};
const track = fallbackTrack(world, { seed: 1337, radius: 205, width: 12.5 });
const LEN = track.length;

const fmt = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/* --------------------------------------------------------------- a racer */
/* Grid index 0 starts last. Pace is stacked *with* the grid — the pole kart is genuinely the
   fastest — so climbing from the back is a real fight and the comeback numbers mean something. */
function makeRacer(i, seed) {
  const r = rng(seed + i * 977);
  const skill = lerp(0.972, 1.028, i / (FIELD - 1)) + (r() - 0.5) * 0.008;
  return {
    id: 'kart' + i, index: i, skill,
    base: 24.4 * skill,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0,
    s: 0, lateral: 0, targetLat: 0, speed: 12, progress: 0, laps: 0,
    finished: false, finishT: 0, useDelay: 0.4 + r() * 1.2, hold: 0,
    rand: r,
  };
}

function place(racers) {
  return racers.slice().sort((a, b) => b.progress - a.progress);
}

function runRace(seed, { items: itemsOn = true } = {}) {
  const racers = [];
  for (let i = 0; i < FIELD; i++) {
    const rc = makeRacer(i, seed);
    // grid: fastest karts start at the back so the field has something to prove
    const gridS = -(FIELD - 1 - i) * 5.5;
    rc.progress = gridS;
    rc.s = ((gridS % LEN) + LEN) % LEN;
    rc.lateral = (i % 2 ? 1 : -1) * 2.6;
    racers.push(rc);
  }
  const sys = createItemSystem(world, track, { seed: seed ^ 0x5f3a, visuals: false, scene: null });

  const stats = {
    draws: {}, uses: {}, hits: {}, blocks: 0, drops: 0, hitsBy: {}, hitsOn: new Array(FIELD).fill(0),
    drawsByBucket: {}, boxPickups: 0, leaderHits: 0, lastPlaceItems: {},
  };
  for (const id of ITEM_IDS) {
    stats.draws[id] = 0; stats.uses[id] = 0; stats.hits[id] = 0;
    stats.drawsByBucket[id] = new Array(FIELD).fill(0);
  }
  sys.onHit(e => {
    if (e.type === 'draw') {
      stats.draws[e.item]++;
      stats.drawsByBucket[e.item][clamp(e.place - 1, 0, FIELD - 1)]++;
      stats.boxPickups++;
    } else if (e.type === 'use') stats.uses[e.item]++;
    else if (e.type === 'hit') {
      const key = e.from || e.item;
      stats.hits[key] = (stats.hits[key] || 0) + 1;
      const vi = racers.indexOf(e.victim);
      if (vi >= 0) stats.hitsOn[vi]++;
      if (e.victimRec?.place === 1) stats.leaderHits++;
    } else if (e.type === 'block') stats.blocks++;
    else if (e.type === 'drop') stats.drops++;
  });

  let t = 0, finished = 0;
  const finishOrder = [];
  const posChanges = [];
  let prevOrder = place(racers).map(r => r.index);

  while (t < 400 && finished < FIELD) {
    // 1) advance every kart along the spline
    const order = place(racers);
    for (let k = 0; k < order.length; k++) order[k].place = k + 1;

    for (const rc of racers) {
      if (rc.finished) continue;
      const fx = itemsOn ? sys.effects(rc) : null;
      const mul = itemsOn ? sys.speedMultiplier(rc) : 1;
      // simple first-order approach to the target speed
      const target = rc.base * mul;
      const rate = target > rc.speed ? 7.5 : 12.0;
      rc.speed += (target - rc.speed) * clamp(rate * DT, 0, 1);
      rc.progress += rc.speed * DT;
      rc.s = ((rc.progress % LEN) + LEN) % LEN;

      // lateral: seek an item box when empty, otherwise hold a racing line
      let want = rc.targetLat;
      if (itemsOn && !sys.hud(rc).item && !sys.hud(rc).spinning) {
        let best = null, bd = 1e9;
        for (const b of sys.boxes) {
          if (!b.active) continue;
          let d = b.s - rc.s;
          while (d < -LEN / 2) d += LEN; while (d > LEN / 2) d -= LEN;
          if (d > 0 && d < bd) { bd = d; best = b; }
        }
        if (best && bd < 55) want = best.lateral;
      } else if (rc.rand() < 0.01) {
        want = (rc.rand() - 0.5) * 6;
      }
      // a scrambled kart cannot hold its line
      const bias = itemsOn ? sys.steerBias(rc) : 0;
      rc.targetLat = want;
      rc.lateral += clamp(want + bias * 6 - rc.lateral, -1, 1) * 3.2 * DT;
      rc.lateral = clamp(rc.lateral, -5.6, 5.6);

      const sm = track.sample(rc.s);
      rc.pos.x = sm.pos.x + sm.normal.x * rc.lateral;
      rc.pos.y = sm.pos.y;
      rc.pos.z = sm.pos.z + sm.normal.z * rc.lateral;
      rc.yaw = Math.atan2(sm.tangent.x, sm.tangent.z);
      rc.vel.x = sm.tangent.x * rc.speed; rc.vel.z = sm.tangent.z * rc.speed;

      if (rc.progress >= LEN * LAPS && !rc.finished) {
        rc.finished = true; rc.finishT = t; finished++;
        finishOrder.push(rc);
      }
    }

    // 2) items
    if (itemsOn) {
      sys.update(DT, racers.filter(r => !r.finished));
      for (const rc of racers) {
        if (rc.finished) continue;
        const h = sys.hud(rc);
        if (!h.item) { rc.hold = 0; continue; }
        rc.hold += DT;
        const def = ITEMS[h.item];
        // hold defensive kit while someone is close behind, then use it
        const behind = racers.some(o => !o.finished && o !== rc && rc.progress - o.progress > 0 && rc.progress - o.progress < 22);
        const defensive = def.kind === 'shield' || (def.kind === 'shot' && def.orbit === 1) || def.kind === 'drop';
        const wait = defensive && behind ? 0.8 : rc.useDelay;
        if (rc.hold > wait) {
          const backwards = defensive && !behind ? true : (def.kind === 'drop');
          sys.useItem(rc, backwards);
          rc.hold = 0;
        }
      }
    }

    // 3) bookkeeping
    const now = place(racers).map(r => r.index);
    let changes = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== prevOrder[i]) changes++;
    posChanges.push(changes);
    prevOrder = now;
    t += DT;
  }

  for (const rc of racers) if (!rc.finished) finishOrder.push(rc);
  const result = {
    stats, t,
    finish: finishOrder.map(r => r.index),
    finishTime: finishOrder.map(r => r.finishT),
    overtakes: posChanges.reduce((a, b) => a + b, 0) / 2,
    spread: (Math.max(...racers.map(r => r.progress)) - Math.min(...racers.map(r => r.progress))),
  };
  sys.dispose?.();
  return result;
}

/* ================================================================= report */
console.log('KAT RACING — item system simulation');
console.log('track length ' + fmt(LEN, 1) + ' m, ' + LAPS + ' laps, ' + FIELD + ' karts, ' + RACES + ' races, dt=' + fmt(DT, 4));
console.log('items: ' + ITEM_IDS.length + '  (' + ITEM_IDS.join(', ') + ')\n');

/* --- 1. the odds table itself ------------------------------------------- */
console.log('DRAW ODDS BY PLACE (%%) — rows are items, columns are places 1..12');
console.log(pad('item', 10) + Array.from({ length: FIELD }, (_, i) => lpad(i + 1, 5)).join(''));
for (const id of ITEM_IDS) {
  let row = pad(id, 10);
  for (let p = 1; p <= FIELD; p++) {
    const o = itemOdds(p, FIELD).find(x => x.id === id);
    row += lpad(o ? fmt(o.p * 100, 1) : '.', 5);
  }
  console.log(row);
}
const leaderOdds = itemOdds(1, FIELD), lastOdds = itemOdds(FIELD, FIELD);
const aggressive = ['sabra', 'catnap', 'duchifat', 'khamsin', 'hamsa', 'avatiach', 'falafel3'];
const leadAgg = leaderOdds.filter(o => aggressive.includes(o.id)).reduce((a, b) => a + b.p, 0);
const lastAgg = lastOdds.filter(o => aggressive.includes(o.id)).reduce((a, b) => a + b.p, 0);
console.log('\nleader P(power item) = ' + fmt(leadAgg * 100, 1) + '%   last P(power item) = ' + fmt(lastAgg * 100, 1) + '%');
console.log('leader distinct items = ' + leaderOdds.length + '   last distinct items = ' + lastOdds.length);

/* --- 2. simulated races -------------------------------------------------- */
const agg = {
  draws: {}, uses: {}, hits: {}, blocks: 0, drops: 0, pickups: 0, leaderHits: 0,
  drawsByBucket: {},
};
for (const id of ITEM_IDS) { agg.draws[id] = 0; agg.uses[id] = 0; agg.hits[id] = 0; agg.drawsByBucket[id] = new Array(FIELD).fill(0); }

const finishOfLast = [], finishOfLastNoItems = [];
/* grid index i starts (FIELD - i)th, so index 0 is on the last row and index FIELD-1 on pole */
const gridPlaceOf = i => FIELD - i;
const backFinish = [], backFinishNo = [], frontFinish = [], frontFinishNo = [];
let rankCorr = 0, rankCorrNo = 0;
let overtakes = 0, overtakesNo = 0, raceTime = 0, raceTimeNo = 0;

const spearman = (finish) => {
  // finish[k] = kart index finishing kth; correlate grid place with finish place
  let sum = 0;
  for (let k = 0; k < finish.length; k++) {
    const d = gridPlaceOf(finish[k]) - (k + 1);
    sum += d * d;
  }
  const n = finish.length;
  return 1 - 6 * sum / (n * (n * n - 1));
};

for (let r = 0; r < RACES; r++) {
  const seed = SEED0 + r * 7919;
  const on = runRace(seed, { items: true });
  const off = runRace(seed, { items: false });
  for (const id of ITEM_IDS) {
    agg.draws[id] += on.stats.draws[id];
    agg.uses[id] += on.stats.uses[id];
    agg.hits[id] += on.stats.hits[id] || 0;
    for (let i = 0; i < FIELD; i++) agg.drawsByBucket[id][i] += on.stats.drawsByBucket[id][i];
  }
  agg.blocks += on.stats.blocks; agg.drops += on.stats.drops;
  agg.pickups += on.stats.boxPickups; agg.leaderHits += on.stats.leaderHits;
  finishOfLast.push(on.finish.indexOf(0) + 1);
  finishOfLastNoItems.push(off.finish.indexOf(0) + 1);
  for (let i = 0; i < FIELD; i++) {
    const fOn = on.finish.indexOf(i) + 1, fOff = off.finish.indexOf(i) + 1;
    if (gridPlaceOf(i) > FIELD / 2) { backFinish.push(fOn); backFinishNo.push(fOff); }
    else { frontFinish.push(fOn); frontFinishNo.push(fOff); }
  }
  rankCorr += spearman(on.finish); rankCorrNo += spearman(off.finish);
  overtakes += on.overtakes; overtakesNo += off.overtakes;
  raceTime += on.t; raceTimeNo += off.t;
}

console.log('\nDRAWS ACTUALLY TAKEN (' + RACES + ' races, ' + agg.pickups + ' box pickups)');
console.log(pad('item', 10) + lpad('draws', 7) + lpad('used', 7) + lpad('hits', 7) + lpad('hit/use', 9) + '   place histogram (1..12)');
for (const id of ITEM_IDS) {
  const b = agg.drawsByBucket[id];
  const maxb = Math.max(1, ...b);
  const spark = b.map(v => ' .:-=+*#%@'[Math.min(9, Math.round(v / maxb * 9))]).join('');
  console.log(pad(id, 10) + lpad(agg.draws[id], 7) + lpad(agg.uses[id], 7) + lpad(agg.hits[id], 7)
    + lpad(agg.uses[id] ? fmt(agg.hits[id] / agg.uses[id], 2) : '-', 9) + '   ' + spark);
}
console.log('shield blocks: ' + agg.blocks + '   items knocked out of karts: ' + agg.drops + '   hits on the race leader: ' + agg.leaderHits);

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const best = a => Math.min(...a);
const top3 = a => a.filter(v => v <= 3).length / a.length * 100;
const top6 = a => a.filter(v => v <= 6).length / a.length * 100;

console.log('\nCOMEBACK CHECK — mean finishing place of the six karts starting 7th-12th (' + backFinish.length + ' samples)');
console.log('  with items:    ' + fmt(mean(backFinish), 2) + '   top-6 ' + fmt(top6(backFinish), 0) + '%   top-3 ' + fmt(top3(backFinish), 0) + '%');
console.log('  items off:     ' + fmt(mean(backFinishNo), 2) + '   top-6 ' + fmt(top6(backFinishNo), 0) + '%   top-3 ' + fmt(top3(backFinishNo), 0) + '%');
console.log('FRONT HALF (karts starting 1st-6th)');
console.log('  with items:    ' + fmt(mean(frontFinish), 2) + '   items off: ' + fmt(mean(frontFinishNo), 2));
console.log('DEAD LAST STARTER');
console.log('  with items:    mean finish ' + fmt(mean(finishOfLast), 2) + '   best ' + best(finishOfLast)
  + '   top-6 ' + fmt(top6(finishOfLast), 0) + '%');
console.log('  items off:     mean finish ' + fmt(mean(finishOfLastNoItems), 2) + '   best ' + best(finishOfLastNoItems)
  + '   top-6 ' + fmt(top6(finishOfLastNoItems), 0) + '%');
console.log('grid-to-finish rank correlation: items ' + fmt(rankCorr / RACES, 3) + '   no items ' + fmt(rankCorrNo / RACES, 3) + '   (lower = more shuffling)');
console.log('\nposition changes per race: items ' + fmt(overtakes / RACES, 1) + '   no items ' + fmt(overtakesNo / RACES, 1));
console.log('race duration: items ' + fmt(raceTime / RACES, 1) + ' s   no items ' + fmt(raceTimeNo / RACES, 1) + ' s');

const gain = mean(backFinishNo) - mean(backFinish);
const verdict = [];
verdict.push([leadAgg < 0.10, 'leader draws almost no power items (' + fmt(leadAgg * 100, 1) + '% < 10%)']);
verdict.push([lastAgg > 0.55, 'last place draws mostly comeback items (' + fmt(lastAgg * 100, 1) + '% > 55%)']);
verdict.push([gain > 0.35, 'items lift the back half by ' + fmt(gain, 2) + ' places on average']);
verdict.push([top6(finishOfLast) >= 40, 'the kart starting last reaches the top 6 in ' + fmt(top6(finishOfLast), 0) + '% of races']);
verdict.push([rankCorr / RACES < rankCorrNo / RACES - 0.05, 'items break up the grid order (rho ' + fmt(rankCorr / RACES, 2) + ' vs ' + fmt(rankCorrNo / RACES, 2) + ')']);
verdict.push([agg.leaderHits >= RACES, 'the leader gets punished at least once per race (' + fmt(agg.leaderHits / RACES, 1) + '/race)']);
verdict.push([overtakes > overtakesNo * 1.2, 'items create more position changes (' + fmt(overtakes / RACES, 1) + ' vs ' + fmt(overtakesNo / RACES, 1) + ')']);
verdict.push([Object.values(agg.hits).reduce((a, b) => a + b, 0) > RACES * 10, 'items connect often enough to matter']);
console.log('\nCHECKS');
let ok = true;
for (const [pass, msg] of verdict) { console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + msg); ok = ok && pass; }
console.log('\n' + (ok ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'));
process.exit(ok ? 0 : 1);
