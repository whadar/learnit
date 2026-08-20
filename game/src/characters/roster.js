/**
 * Kat Racing — the roster: which cat drives which kart, in which livery, with what stats.
 *
 *   import { createRoster, createRacer } from './roster.js';
 *   const roster = createRoster();                       // [{ id, name, cat, kartId, stats }]
 *   const racer  = createRacer('mitzi');                 // cat seated in its kart, wired up
 *   scene.add(racer.object3D);
 *   racer.update(dt, { speed, steer, drift, airborne, boosting, hit, place });
 */
import * as THREE from 'three';
import { createCat, CAT_SPECS } from './cat.js';
import { createKart, KART_SPECS, LIVERIES } from './kart.js';

const ENTRIES = [
  { id: 'mitzi',  kartId: 'standard', livery: 'citrus',  stats: { speed: 3.5, accel: 3.5, weight: 3.0, handling: 4.0, drift: 3.5, offroad: 3.0 }, blurb: 'Village tabby, textbook lines.' },
  { id: 'shuki',  kartId: 'sport',    livery: 'bauhaus', stats: { speed: 4.5, accel: 3.0, weight: 3.0, handling: 3.0, drift: 3.5, offroad: 2.5 }, blurb: 'Tuxedo showboat from the boulevard.' },
  { id: 'yaffa',  kartId: 'standard', livery: 'sabra',   stats: { speed: 3.0, accel: 4.0, weight: 2.5, handling: 4.5, drift: 4.0, offroad: 3.5 }, blurb: 'Calico, corners like she owns them.' },
  { id: 'kobi',   kartId: 'buggy',    livery: 'citrus',  stats: { speed: 3.5, accel: 3.0, weight: 4.0, handling: 3.0, drift: 3.0, offroad: 5.0 }, blurb: 'Ginger farm cat, lives off-road.' },
  { id: 'layla',  kartId: 'sport',    livery: 'olive',   stats: { speed: 5.0, accel: 2.5, weight: 3.5, handling: 2.5, drift: 3.0, offroad: 2.0 }, blurb: 'Night-black speed demon.' },
  { id: 'shelly', kartId: 'standard', livery: 'bauhaus', stats: { speed: 3.0, accel: 4.5, weight: 2.0, handling: 5.0, drift: 4.0, offroad: 3.0 }, blurb: 'Featherweight, all handling.' },
  { id: 'dror',   kartId: 'pipe',     livery: 'olive',   stats: { speed: 4.0, accel: 3.5, weight: 3.0, handling: 3.5, drift: 4.5, offroad: 2.5 }, blurb: 'Grey point, drift specialist.' },
  { id: 'tamar',  kartId: 'pipe',     livery: 'sabra',   stats: { speed: 3.5, accel: 4.0, weight: 2.5, handling: 4.0, drift: 5.0, offroad: 3.0 }, blurb: 'Siamese, never lifts off.' },
  { id: 'boaz',   kartId: 'buggy',    livery: 'olive',   stats: { speed: 4.0, accel: 2.0, weight: 5.0, handling: 2.5, drift: 2.5, offroad: 4.5 }, blurb: 'Heavyweight, shunts for fun.' },
  { id: 'nofar',  kartId: 'sport',    livery: 'citrus',  stats: { speed: 3.5, accel: 4.0, weight: 2.5, handling: 4.0, drift: 4.0, offroad: 3.0 }, blurb: 'Rookie with the curled ear.' },
];

/** @returns {Array<{id,name,cat,kartId,livery,number,stats,blurb}>} */
export function createRoster() {
  return ENTRIES.map((e, i) => {
    const cat = Object.assign({ id: e.id }, CAT_SPECS[e.id]);
    return {
      id: e.id, name: cat.name, cat, kartId: e.kartId, livery: e.livery,
      number: cat.num, index: i, stats: { ...e.stats }, blurb: e.blurb,
      kartName: KART_SPECS[e.kartId]?.name, liveryName: LIVERIES[e.livery]?.name,
    };
  });
}
export function rosterEntry(id) { return createRoster().find(r => r.id === id) || createRoster()[0]; }

/** Cat + kart assembled and wired: hands on the wheel, wheels on the ground at y = 0. */
export function createRacer(id, opts = {}) {
  const entry = rosterEntry(id);
  const kart = createKart(opts.kartId || entry.kartId, {
    livery: opts.livery || entry.livery, number: entry.number,
    detail: opts.detail, shadows: opts.shadows, seed: (entry.index + 1) * 137, env: opts.env,
  });
  const cat = createCat(entry.id, {
    detail: opts.detail, shadows: opts.shadows, env: opts.env,
    grip: kart.gripForDriver(), spec: opts.spec, seatY: kart.seat[1],
  });
  const root = new THREE.Group();
  root.name = 'racer:' + entry.id;
  root.add(kart.object3D);
  cat.object3D.position.set(kart.seat[0], kart.seat[1], kart.seat[2]);   // y is re-driven by seatY
  kart.chassis.add(cat.object3D);              // rides with the body so lean/pitch carry through
  cat.object3D.userData.seatY = kart.seat[1];

  function update(dt, st = {}) {
    kart.update(dt, st);
    cat.update(dt, st);
  }
  update(0.016, {});
  return {
    id: entry.id, entry, object3D: root, cat, kart, update,
    setPose: (n, w) => cat.setPose(n, w),
    dispose() { cat.dispose(); kart.dispose(); },
  };
}

export default { createRoster, createRacer, rosterEntry };
