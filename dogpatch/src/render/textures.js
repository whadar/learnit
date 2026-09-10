/**
 * Procedural surface detail, drawn once into canvases at boot.
 *
 * Three critics independently said the same thing about round one: every surface is a flat
 * constant colour, so nothing has material identity. The fix has to survive the single-file
 * build, which rules out shipping image files — 4.65 MB of that page is already the
 * neighbourhood. So these are drawn with 2D canvas at startup: a few hundred lines of arithmetic
 * instead of a few megabytes of PNG, and the whole set costs about a frame.
 *
 * The facade and ground maps are GREYSCALE and sit near white on purpose. They multiply the colour
 * that is already there — seven building materials, and the terrain's own height-and-slope ramp —
 * so one texture gives detail to all of them without flattening the palette chosen for each. Sit
 * them at mid grey instead and every surface in the game loses a third of its brightness: the
 * first cut of this file did exactly that and pushed the frames from 9% to 15.5% near-black.
 *
 * The asphalt and concrete maps are the opposite: they CARRY the surface colour, so the meshes
 * that use them set a white material colour and let the texture decide.
 */
import * as THREE from 'three';

const canvas = size => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
};

/** Deterministic value noise; a texture that changes between reloads is not a texture. */
function noise(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const finish = (c, repeat) => {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  if (repeat) t.repeat.set(repeat, repeat);
  return t;
};

/** Speckled aggregate over worn tarmac, with faint lighter patching. */
export function asphalt(size = 512) {
  const [c, g] = canvas(size), r = noise(11);
  g.fillStyle = '#31343a'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 14; i++) {                 // aggregate
    const v = 40 + r() * 90;
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.25 + r() * 0.5})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 1.6, 1 + r() * 1.6);
  }
  for (let i = 0; i < 26; i++) {                        // patches and repairs
    g.fillStyle = `rgba(${70 + r() * 40},${72 + r() * 40},${78 + r() * 40},${0.05 + r() * 0.07})`;
    g.beginPath();
    g.ellipse(r() * size, r() * size, 18 + r() * 70, 12 + r() * 50, r() * 6.3, 0, 6.3);
    g.fill();
  }
  return finish(c);
}

/** Poured concrete: fine grain plus the slab joints a sidewalk actually has. */
export function concrete(size = 512) {
  const [c, g] = canvas(size), r = noise(29);
  g.fillStyle = '#9a9c9b'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 10; i++) {
    const v = 130 + r() * 80;
    g.fillStyle = `rgba(${v},${v},${v - 4},${0.10 + r() * 0.28})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
  }
  // Faint and wide, not crisp and thin. A 2 px joint at 55% contrast turns the sidewalk into a
  // moire fence the moment the camera looks down it at a grazing angle, which is most of a lap.
  g.strokeStyle = 'rgba(122,124,124,0.22)'; g.lineWidth = 4;
  for (const p of [0, 0.5]) {                            // one joint each way per tile
    g.beginPath(); g.moveTo(0, p * size); g.lineTo(size, p * size); g.stroke();
    g.beginPath(); g.moveTo(p * size, 0); g.lineTo(p * size, size); g.stroke();
  }
  return finish(c);
}

/**
 * A wall of windows, greyscale, four bays by four storeys per tile.
 *
 * Tiled at one bay per 4 m and one storey per 3.4 m by the UVs the building extruder writes, so
 * the openings land at a believable size whatever the footprint. Bays vary — some blank, some
 * dark glass, some with a lit interior — so a long warehouse elevation does not read as one
 * rubber-stamped cell repeated down the street.
 */
export function facade(size = 512) {
  const [c, g] = canvas(size), r = noise(7);
  const cell = size / 4;
  g.fillStyle = '#dedede'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 8; i++) {                   // wall grain, kept subtle
    const v = 190 + r() * 60;
    g.fillStyle = `rgba(${v},${v},${v},0.16)`;
    g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
  }
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const k = r();
      if (k < 0.16) continue;                            // blank bay: a pier or a blind wall
      const x = sx * cell, y = sy * cell;
      const w = cell * 0.54, h = cell * 0.46;
      const ox = x + (cell - w) / 2, oy = y + cell * 0.20;
      g.fillStyle = '#6d7176'; g.fillRect(ox - 2, oy - 2, w + 4, h + 4);   // reveal
      g.fillStyle = k > 0.86 ? '#d8d2b8' : k > 0.55 ? '#4b5560' : '#3a424b';
      g.fillRect(ox, oy, w, h);
      g.strokeStyle = 'rgba(150,152,155,0.85)'; g.lineWidth = 1.5;         // mullion
      g.beginPath(); g.moveTo(ox + w / 2, oy); g.lineTo(ox + w / 2, oy + h); g.stroke();
    }
    g.fillStyle = 'rgba(120,122,124,0.5)';                                 // floor band
    g.fillRect(0, sy * cell + cell - 3, size, 3);
  }
  return finish(c);
}

/**
 * Wooden cottage siding: narrow horizontal clapboard, tall sash windows, a door on the ground bay.
 *
 * Dogpatch is a designated historic district of about a hundred workers' flats and cottages built
 * 1870-1910 — Italianate, Eastlake, Queen Anne — standing between the warehouses. They are the
 * reason the neighbourhood looks like nowhere else on the Central Waterfront, and a city of
 * uniform window-grid boxes has none of them in it.
 */
export function clapboard(size = 512) {
  const [c, g] = canvas(size), r = noise(19);
  const cell = size / 4;
  g.fillStyle = '#e2e0da'; g.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 7) {                    // lap siding
    g.fillStyle = `rgba(120,118,112,${0.10 + r() * 0.06})`;
    g.fillRect(0, y + 5, size, 1.5);
  }
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = sx * cell, y = sy * cell;
      const w = cell * 0.30, h = cell * 0.52;            // tall and narrow, not the shop grid
      const ox = x + (cell - w) / 2, oy = y + cell * 0.20;
      g.fillStyle = '#f4f2ec'; g.fillRect(ox - 5, oy - 6, w + 10, h + 10);  // moulded surround
      g.fillStyle = r() > 0.8 ? '#cfd3cb' : '#41484f';
      g.fillRect(ox, oy, w, h);
      g.strokeStyle = 'rgba(240,238,232,0.9)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(ox, oy + h * 0.48); g.lineTo(ox + w, oy + h * 0.48); g.stroke();
      g.fillStyle = 'rgba(90,88,84,0.30)';               // cornice line over each storey
      g.fillRect(x, y + cell - 5, cell, 5);
    }
  }
  return finish(c);
}

/** Corrugated industrial sheeting — the Pier 70 and shipyard vocabulary, vertical ribs. */
export function corrugated(size = 512) {
  const [c, g] = canvas(size), r = noise(37);
  g.fillStyle = '#c2c6c8'; g.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += 11) {
    g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(x, 0, 3, size);
    g.fillStyle = 'rgba(88,94,98,0.26)'; g.fillRect(x + 6, 0, 3, size);
  }
  for (let i = 0; i < 40; i++) {                         // rust and staining down the sheets
    g.fillStyle = `rgba(${130 + r() * 40},${88 + r() * 30},${62 + r() * 24},${0.05 + r() * 0.08})`;
    g.fillRect(r() * size, r() * size, 3 + r() * 9, 20 + r() * 90);
  }
  g.fillStyle = 'rgba(70,76,80,0.35)';                   // eaves band
  g.fillRect(0, 0, size, 7);
  return finish(c);
}

/** Ground grain — greyscale, multiplies the terrain's own height-and-slope colour ramp. */
export function ground(size = 256) {
  const [c, g] = canvas(size), r = noise(53);
  g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 30; i++) {
    const v = 175 + r() * 80;
    g.fillStyle = `rgba(${v},${v},${v},${0.10 + r() * 0.30})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 3, 1 + r() * 3);
  }
  for (let i = 0; i < 90; i++) {                         // coarser clumping over the grain
    g.fillStyle = `rgba(${195 + r() * 55},${195 + r() * 55},${195 + r() * 55},0.06)`;
    g.beginPath(); g.ellipse(r() * size, r() * size, 4 + r() * 20, 3 + r() * 14, r() * 6.3, 0, 6.3);
    g.fill();
  }
  return finish(c);
}

/**
 * A soft round puff for the particle pool.
 *
 * Points are squares. Without a sprite with an alpha falloff, tyre smoke is a cloud of little
 * grey tiles, which is worse than no smoke at all — round one shipped half-metre white squares
 * for exactly this reason.
 */
export function puff(size = 64) {
  const [c, g] = canvas(size);
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Built once and shared; every mesh that wants a surface asks here. */
let cache = null;
export function surfaces() {
  if (!cache) cache = { asphalt: asphalt(), concrete: concrete(), facade: facade(),
                        clapboard: clapboard(), corrugated: corrugated(),
                        ground: ground(), puff: puff() };
  return cache;
}
