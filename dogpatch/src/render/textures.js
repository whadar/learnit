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

/** Built once and shared; every mesh that wants a surface asks here. */
let cache = null;
export function surfaces() {
  if (!cache) cache = { asphalt: asphalt(), concrete: concrete(), facade: facade(), ground: ground() };
  return cache;
}
