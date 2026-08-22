/**
 * Kat Racing — procedural karts.
 *
 * Four chassis families (standard, sport, buggy, pipe) with automotive paint,
 * chrome, rubber and glass, four Israeli-flavoured liveries (citrus crate,
 * olive-oil tin, sabra prickly pear, Bauhaus Tel Aviv), turning steering wheel,
 * visible suspension travel and wheels that sit exactly on y = 0.
 *
 *   const kart = createKart('sport', { livery: 'bauhaus', number: 7 });
 *   scene.add(kart.object3D);
 *   kart.update(dt, { speed, steer, drift, airborne, boosting, hit });
 */
import * as THREE from 'three';
import { rng } from '../core/mathx.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const TAU = Math.PI * 2;
/** How far the steering wheel (and therefore the driver's paws) sweeps at full lock. */
export const WHEEL_TURN = 0.78;
const DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/* ------------------------------------------------------------ environment */
let ENV = null;
/** Tiny procedural cube env so chrome and clearcoat read even with no scene.environment. */
export function kartEnv() {
  if (!DOM || ENV) return ENV;
  const S = 64, faces = [];
  for (let f = 0; f < 6; f++) {
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d');
    if (f === 2) {                                     // +Y sky with a sun
      const g = c.createRadialGradient(S * 0.32, S * 0.34, 2, S * 0.32, S * 0.34, S * 0.9);
      g.addColorStop(0, '#fffdf2'); g.addColorStop(0.10, '#cfe0f5'); g.addColorStop(1, '#5d92d8');
      c.fillStyle = g; c.fillRect(0, 0, S, S);
    } else if (f === 3) {                              // -Y ground
      c.fillStyle = '#4a4436'; c.fillRect(0, 0, S, S);
      c.fillStyle = '#5d553f'; c.fillRect(0, 0, S, S * 0.5);
    } else {
      const g = c.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0.00, '#5d92d8'); g.addColorStop(0.44, '#bcd4ee');
      g.addColorStop(0.50, '#f4ead2'); g.addColorStop(0.53, '#8d8467'); g.addColorStop(1, '#413d31');
      c.fillStyle = g; c.fillRect(0, 0, S, S);
    }
    faces.push(cv);
  }
  ENV = new THREE.CubeTexture(faces);
  ENV.colorSpace = THREE.SRGBColorSpace;
  ENV.needsUpdate = true;
  return ENV;
}

/* --------------------------------------------------------------- liveries */
export const LIVERIES = {
  citrus:  { paint: 0xf2a026, trim: 0xd8401a, accent: 0x3f8f45, seat: 0x6b4526, name: 'Citrus Crate' },
  olive:   { paint: 0x8bbd33, trim: 0xf0c04a, accent: 0x36502a, seat: 0x44502c, name: 'Olive Tin' },
  sabra:   { paint: 0x18b07a, trim: 0xe0357c, accent: 0xa8e05f, seat: 0x2c4a38, name: 'Sabra' },
  bauhaus: { paint: 0xf1ece0, trim: 0x2b3b48, accent: 0xe2dccd, seat: 0x33404c, name: 'Bauhaus TLV' },
};

/**
 * Per-racing-number bodywork colour. Eight karts share four liveries, so the livery alone
 * cannot tell them apart at 40 m; the number is unique per roster entry, so it is what the
 * paint hue keys off. Every entry is a high-chroma, mid-to-light value that separates from
 * the sand, the olive canopy and the sky. Unknown numbers fall back to the livery paint.
 *
 * No. 7 is the player. It used to be racing red — but Mitzi is a ginger tabby in a red-orange
 * race suit and helmet, so at chase distance driver and vehicle fused into one red mass with no
 * figure-ground separation at all (R4). Azure is the complement of her fur and suit, it holds a
 * warm sun specular better than any red, and it is the one hue on the roster that reads against
 * both the sand shoulders and the blue-grey asphalt. No. 9 moved off royal blue to keep clear.
 */
export const NUMBER_PAINT = {
  1: 0x2ec4d6,   // Shelly  — cyan
  3: 0xf1ece0,   // Shuki   — Bauhaus cream
  4: 0xe0357c,   // Tamar   — magenta
  5: 0xf5901c,   // Kobi    — orange
  6: 0xf2556e,   // Nofar   — coral
  7: 0x1b63dc,   // Mitzi   — azure (see note: her fur and race suit are both red-orange)
  8: 0x8bd23a,   // Dror    — lime
  9: 0x6a3ad4,   // Layla   — indigo (kept clear of Mitzi's azure)
  12: 0x18b07a,  // Yaffa   — jade
  22: 0x9a5ae0,  // Boaz    — violet
};

function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(cv, srgb = true) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}
function orange(c, x, y, r) {
  const g = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
  g.addColorStop(0, '#ffc04a'); g.addColorStop(0.6, '#f08a1c'); g.addColorStop(1, '#c95c0c');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  c.fillStyle = '#2f7a3a';
  c.beginPath(); c.ellipse(x + r * 0.55, y - r * 0.75, r * 0.42, r * 0.19, -0.5, 0, TAU); c.fill();
  c.beginPath(); c.ellipse(x + r * 0.15, y - r * 0.95, r * 0.34, r * 0.16, 0.35, 0, TAU); c.fill();
}
function oliveSprig(c, x, y, s) {
  c.strokeStyle = '#3d5c26'; c.lineWidth = s * 0.06; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x - s, y + s * 0.35); c.quadraticCurveTo(x, y - s * 0.15, x + s, y - s * 0.5); c.stroke();
  for (let i = 0; i < 5; i++) {
    const t = i / 4, px = lerp(x - s, x + s, t), py = lerp(y + s * 0.35, y - s * 0.5, t) - s * 0.08;
    c.fillStyle = '#4e7a2e';
    c.save(); c.translate(px, py); c.rotate(-0.6 + i * 0.18);
    c.beginPath(); c.ellipse(0, -s * 0.22, s * 0.30, s * 0.11, 0, 0, TAU); c.fill(); c.restore();
  }
  for (let i = 0; i < 3; i++) {
    const px = x - s * 0.45 + i * s * 0.45, py = y + s * 0.16 - i * s * 0.20;
    const g = c.createRadialGradient(px - s * 0.05, py - s * 0.06, s * 0.03, px, py, s * 0.17);
    g.addColorStop(0, '#7a8f3c'); g.addColorStop(1, '#33471c');
    c.fillStyle = g; c.beginPath(); c.arc(px, py, s * 0.16, 0, TAU); c.fill();
  }
}
function cactusPad(c, x, y, w, h) {
  c.fillStyle = '#4e9a5c';
  c.beginPath(); c.ellipse(x, y, w, h, 0, 0, TAU); c.fill();
  c.strokeStyle = '#2f6b40'; c.lineWidth = w * 0.07; c.stroke();
  const R = rng(77);
  c.strokeStyle = '#e9e5cf'; c.lineWidth = Math.max(1, w * 0.028);
  for (let i = 0; i < 26; i++) {
    const a = R() * TAU, rr = Math.sqrt(R()) * 0.82;
    const px = x + Math.cos(a) * w * rr, py = y + Math.sin(a) * h * rr;
    c.fillStyle = '#d8d6b8'; c.beginPath(); c.arc(px, py, w * 0.035, 0, TAU); c.fill();
    for (let k = 0; k < 2; k++) {
      const ang = R() * TAU;
      c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(ang) * w * 0.12, py + Math.sin(ang) * w * 0.12); c.stroke();
    }
  }
  for (let i = 0; i < 2; i++) {
    const px = x + (i - 0.5) * w * 0.9, py = y - h * 0.92;
    const g = c.createLinearGradient(px, py - h * 0.2, px, py + h * 0.2);
    g.addColorStop(0, '#e0417f'); g.addColorStop(1, '#a81c56');
    c.fillStyle = g; c.beginPath(); c.ellipse(px, py, w * 0.16, h * 0.26, 0, 0, TAU); c.fill();
  }
}

function liverySide(name, num) {
  const W = 512, H = 256, cv = cvs(W, H), c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  if (name === 'citrus') {
    c.fillStyle = 'rgba(120,84,44,0.30)';
    for (let i = 0; i < 5; i++) c.fillRect(0, 8 + i * 50, W, 5);          // crate slat shadows
    c.fillStyle = '#f7efdc'; roundRect(c, 96, 34, 320, 188, 26); c.fill();
    c.lineWidth = 9; c.strokeStyle = '#d94a1e'; c.stroke();
    c.lineWidth = 3; c.strokeStyle = '#2f7a3a'; roundRect(c, 110, 48, 292, 160, 20); c.stroke();
    orange(c, 176, 132, 52);
    c.fillStyle = '#c3451a'; c.font = 'bold 58px Georgia, "Times New Roman", serif';
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText('JAFFA', 244, 118);
    c.fillStyle = '#3d6b32'; c.font = 'bold 24px Georgia, serif'; c.fillText('SHAMOUTI  No.' + num, 244, 168);
  } else if (name === 'olive') {
    c.fillStyle = '#d9a441'; roundRect(c, 60, 26, 392, 204, 30); c.fill();
    c.fillStyle = '#4a6329'; roundRect(c, 74, 40, 364, 176, 24); c.fill();
    c.lineWidth = 5; c.strokeStyle = '#e8c473'; roundRect(c, 86, 52, 340, 152, 18); c.stroke();
    oliveSprig(c, 150, 128, 62);
    c.fillStyle = '#f0dfae'; c.font = 'bold 40px Georgia, serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('OLIVE OIL', 232, 108);
    c.fillStyle = '#d9a441'; c.font = 'italic 24px Georgia, serif'; c.fillText('cold pressed · ' + num, 232, 152);
  } else if (name === 'sabra') {
    cactusPad(c, 150, 138, 92, 108);
    c.fillStyle = '#eaf3df'; c.font = 'bold 52px Helvetica, Arial, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('SABRA', 262, 112);
    c.strokeStyle = '#c7276b'; c.lineWidth = 8;
    c.beginPath(); c.moveTo(264, 146); c.lineTo(452, 146); c.stroke();
    c.fillStyle = '#c7276b'; c.font = 'bold 30px Helvetica, Arial, sans-serif'; c.fillText('PRICKLY & FAST', 264, 182);
  } else { // bauhaus
    c.fillStyle = '#e6e0d2'; c.fillRect(40, 60, 432, 24);
    c.fillStyle = '#27333c'; c.fillRect(40, 92, 432, 10);
    c.fillStyle = '#e6e0d2'; c.fillRect(40, 152, 432, 24);
    c.fillStyle = '#27333c'; c.fillRect(40, 184, 432, 10);
    c.strokeStyle = '#27333c'; c.lineWidth = 10;
    c.beginPath(); c.arc(120, 128, 44, 0, TAU); c.stroke();
    c.fillStyle = '#9fb7c4'; c.beginPath(); c.arc(120, 128, 34, 0, TAU); c.fill();
    c.fillStyle = '#27333c'; c.font = 'bold 62px Helvetica, Arial, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('TLV', 214, 126);
    c.font = 'bold 22px Helvetica, Arial, sans-serif'; c.fillText('BAUHAUS ' + num, 214, 172);
  }
  return tex(cv);
}
/**
 * Israeli registration plate: saturated chrome yellow, black digits in the real 00-000-00 group
 * form, and the narrow blue IL strip Israeli plates actually carry (it is not an EU band). The
 * old fill was #f2df3a, which the tonemapper pulled to olive-green in shade — R4 read it as a
 * green plate. #ffd400 with a light emissive keeps it yellow in shadow as well as sun.
 */
function plateTexture(num) {
  const W = 256, H = 128, cv = cvs(W, H), c = cv.getContext('2d');
  c.fillStyle = '#ffd400'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#141414'; c.lineWidth = 9; c.strokeRect(7, 7, W - 14, H - 14);
  c.fillStyle = '#12377a'; c.fillRect(11, 11, 30, H - 22);
  c.fillStyle = '#ffffff'; c.font = 'bold 17px Helvetica, Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('IL', 26, H - 26);
  c.strokeStyle = '#ffffff'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(17, 30); c.lineTo(35, 30); c.moveTo(17, 44); c.lineTo(35, 44); c.stroke();
  const n = String(num).padStart(2, '0');
  c.fillStyle = '#141414'; c.font = 'bold 54px Helvetica, Arial, sans-serif';
  c.fillText('42-' + n + '-7', (W + 41) / 2 + 3, H / 2 + 3);
  return tex(cv);
}
/**
 * Racing-number badge for the top of the rear wing. The chase camera spends the whole race
 * looking straight down at that panel, and it was the one big surface with nothing on it — so
 * the R1 critics could not tell eight karts apart at 40 m. The canvas is cut to the plate's
 * aspect so the glyph is never stretched, and it is drawn upside-down because the plane is
 * laid flat with its texture +V pointing forward along the kart.
 */
function roundelTexture(num, ringHex, aspect = 1) {
  const H = 192, W = Math.max(64, Math.round(H * aspect));
  const cv = cvs(W, H), c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  c.save();
  c.translate(W / 2, H / 2); c.rotate(Math.PI); c.translate(-W / 2, -H / 2);
  const ring = '#' + (ringHex >>> 0).toString(16).padStart(6, '0');
  const m = H * 0.07, r = H * 0.26;
  c.fillStyle = 'rgba(18,20,24,0.45)';
  roundRect(c, m, m + H * 0.035, W - m * 2, H - m * 2, r); c.fill();
  c.fillStyle = '#f7f3e7';
  roundRect(c, m, m, W - m * 2, H - m * 2, r); c.fill();
  c.lineWidth = H * 0.085; c.strokeStyle = ring; c.stroke();
  c.lineWidth = H * 0.022; c.strokeStyle = 'rgba(22,24,28,0.9)';
  roundRect(c, m + H * 0.055, m + H * 0.055, W - m * 2 - H * 0.11, H - m * 2 - H * 0.11, r * 0.7); c.stroke();
  c.fillStyle = '#15171b';
  c.font = 'bold ' + Math.round(H * 0.62) + 'px Helvetica, Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(num), W / 2, H / 2 + H * 0.035);
  c.restore();
  return tex(cv);
}
/**
 * Tyre map + normal. Read at race distance, not in a texture viewer: the old one was a near-black
 * carcass with 11 px tread blocks, so the tyres resolved as "brown-black rubber-band donuts".
 * This one is a mid-grey carcass (the material colour is white so the map alone sets value),
 * with high-contrast shoulder lugs that carry over the crown of the tread — which is the part
 * you actually see on a forward-facing tyre — circumferential grooves, a rim-protector rib and
 * embossed sidewall lettering.
 */
function treadTextures() {
  const W = 256, H = 128, cv = cvs(W, H), c = cv.getContext('2d');
  const hm = cvs(W, H), hc = hm.getContext('2d');
  c.fillStyle = '#5e5e68'; c.fillRect(0, 0, W, H);
  hc.fillStyle = '#8a8a8a'; hc.fillRect(0, 0, W, H);
  // --- sidewalls (v 0..0.23 and 0.77..1): slightly lighter, with a rim-protector rib
  const SW = Math.round(H * 0.23);
  c.fillStyle = '#54545e'; c.fillRect(0, 0, W, SW); c.fillRect(0, H - SW, W, SW);
  hc.fillStyle = '#6e6e6e'; hc.fillRect(0, 0, W, SW); hc.fillRect(0, H - SW, W, SW);
  for (const y of [6, H - 10]) {
    c.fillStyle = '#6f6f7b'; c.fillRect(0, y, W, 4);
    hc.fillStyle = '#c8c8c8'; hc.fillRect(0, y, W, 4);
  }
  c.fillStyle = '#a29e90'; c.font = 'bold 13px Helvetica, Arial, sans-serif'; c.textAlign = 'center';
  hc.fillStyle = '#dedede'; hc.font = c.font; hc.textAlign = 'center';
  for (let k = 0; k < 4; k++) {
    const x = W * (0.125 + k * 0.25);
    c.fillText('KAT SLICK', x, 21); c.fillText('KAT SLICK', x, H - 11);
    hc.fillText('KAT SLICK', x, 21); hc.fillText('KAT SLICK', x, H - 11);
  }
  // --- crown: two circumferential grooves, angled centre blocks, shoulder lugs
  const g0 = Math.round(H * 0.40), g1 = Math.round(H * 0.58);
  c.fillStyle = '#2c2c34'; c.fillRect(0, g0, W, 6); c.fillRect(0, g1, W, 6);
  hc.fillStyle = '#2a2a2a'; hc.fillRect(0, g0, W, 6); hc.fillRect(0, g1, W, 6);
  for (let i = 0; i < 16; i++) {
    const x = i * 16;
    // centre blocks between the grooves
    c.fillStyle = i % 2 ? '#6c6c77' : '#63636e';
    c.fillRect(x + 2, g0 + 8, 12, g1 - g0 - 10);
    hc.fillStyle = '#f2f2f2'; hc.fillRect(x + 2, g0 + 8, 12, g1 - g0 - 10);
    // shoulder lugs: run right up over the crown so they read head-on
    for (const [yy, hh] of [[SW - 4, g0 - SW + 2], [g1 + 8, H - SW - g1 - 4]]) {
      c.save(); c.beginPath(); c.rect(x + (i % 2 ? 8 : 0), yy, 13, hh); c.clip();
      c.fillStyle = '#6e6e78'; c.fillRect(x - 4, yy - 2, 22, hh + 6); c.restore();
      hc.fillStyle = '#ffffff'; hc.fillRect(x + (i % 2 ? 8 : 0), yy, 13, hh);
      c.fillStyle = '#2e2e36'; c.fillRect(x + (i % 2 ? 8 : 0) + 13, yy, 3, hh);
      hc.fillStyle = '#1e1e1e'; hc.fillRect(x + (i % 2 ? 8 : 0) + 13, yy, 3, hh);
    }
  }
  const map = tex(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(6, 1);
  // height -> normal
  const nv = cvs(W, H), nc = nv.getContext('2d');
  const src = hc.getImageData(0, 0, W, H).data;
  const out = nc.createImageData(W, H), d = out.data;
  const at = (x, y) => src[((((y % H) + H) % H) * W + (((x % W) + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1);
    const nx = -gx * 3.4, ny = -gy * 3.4, nz = 1, l = Math.hypot(nx, ny, nz);
    const i = (y * W + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  nc.putImageData(out, 0, 0);
  const nrm = tex(nv, false);
  nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.repeat.set(6, 1);
  return { map, nrm };
}
let TREAD = null;

/* ------------------------------------------------------------- geometry kit */
function rr(w, h, r) {
  const s = new THREE.Shape();
  r = Math.min(r, Math.min(w, h) * 0.49);
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}
/** rounded box: w along X, h along Y, d along Z, corner radius r, chamfer b */
function box(w, h, d, r = 0.04, b = 0.025) {
  const g = new THREE.ExtrudeGeometry(rr(w - b * 2, h - b * 2, r), {
    depth: d - b * 2, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 2, curveSegments: 5,
  });
  g.translate(0, 0, -(d - b * 2) / 2);
  return g;
}
/** flat plan-view plate: shape in XZ (x lateral, z forward), thickness along Y */
function plate(shape, th, b = 0.02) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: th - b * 2, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 2, curveSegments: 6 });
  g.rotateX(Math.PI / 2);
  g.translate(0, th - b, 0);
  return g;
}
function xf(geo, { pos, rot, scale } = {}) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(pos?.[0] || 0, pos?.[1] || 0, pos?.[2] || 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot?.[0] || 0, rot?.[1] || 0, rot?.[2] || 0)),
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1));
  geo.applyMatrix4(m);
  return geo;
}
function tube(pts, radius, seg = 6) {
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, Math.max(6, pts.length * 3), radius, seg, false);
}

/**
 * Moulded panel: a superellipsoid (rounded box with C1-continuous curvature *everywhere*).
 *
 * This is the fix for "flat slabs with no clearcoat lobe". ExtrudeGeometry — what the bodywork
 * used to be built from — triangulates its caps straight off the outline, so a panel's top face
 * has no interior vertices and is dead flat: a clearcoat lobe either misses it entirely or
 * flashes the whole face at once. There is no highlight *travelling* across the panel, which is
 * the single thing that says "lacquered metal" instead of "coloured cardboard". A superellipsoid
 * curves continuously, so every panel carries a moving specular streak and a Fresnel edge.
 *
 *   n ~ 3  pillow      n ~ 4-5  automotive bodywork      n ~ 8  nearly a box
 *
 * `taperF`/`taperB` pinch the +Z / -Z ends (noses, tails); `ky` is how much of that taper the
 * height takes (0 = width only, 1 = uniform).
 */
function sbox(w, h, d, n = 4.5, seg = 1, opt = {}) {
  const su = Math.max(10, Math.round(18 * seg)), sv = Math.max(7, Math.round(11 * seg));
  const g = new THREE.SphereGeometry(1, su, sv);
  const p = g.attributes.position;
  const tf = opt.taperF ?? 1, tb = opt.taperB ?? 1, ky = opt.ky ?? 0.55;
  const inv = 1 / n;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const q = Math.pow(Math.abs(x) ** n + Math.abs(y) ** n + Math.abs(z) ** n, inv) || 1;
    x /= q; y /= q; z /= q;
    const k = lerp(tb, tf, (z + 1) * 0.5);
    p.setXYZ(i, x * k * w * 0.5, y * (1 - (1 - k) * ky) * h * 0.5, z * d * 0.5);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Rear wing as a real aerofoil rather than a 5 cm slab: cambered upper surface, thick leading
 * edge, thin trailing edge. The slab version read as a stair-stepped highlight because a flat
 * plate seen near edge-on has exactly one lit scanline; a cambered section spreads that into a
 * gradient that survives at 40 m and does not alias.
 * Span runs along X, chord along Z (+Z forward = leading edge), thickness along Y.
 */
function wingGeo(span, chord, thick, camber = 0.55, seg = 1) {
  const N = Math.max(9, Math.round(15 * seg));
  const sh = new THREE.Shape();
  const half = t => thick * 0.5 * Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.62));
  const pt = [];
  for (let i = 0; i <= N; i++) {                       // upper: leading edge -> trailing edge
    const t = i / N;
    pt.push([lerp(chord * 0.5, -chord * 0.5, t), half(t) * (1 + camber)]);
  }
  for (let i = N; i >= 0; i--) {                       // lower: back to the leading edge
    const t = i / N;
    pt.push([lerp(chord * 0.5, -chord * 0.5, t), -half(t) * (1 - camber * 0.55)]);
  }
  sh.moveTo(pt[0][0], pt[0][1]);
  for (let i = 1; i < pt.length; i++) sh.lineTo(pt[i][0], pt[i][1]);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: true, bevelSize: thick * 0.16, bevelThickness: thick * 0.16, bevelSegments: 2, curveSegments: 2, steps: 1 });
  g.rotateY(Math.PI / 2);                              // shape X (chord) -> -Z, extrude -> +X
  g.translate(-span * 0.5, 0, 0);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ wheels */
/**
 * Wheel geometry, cached by (radius, width, detail) so 8 karts x 4 wheels build 4 rims, not 32.
 *
 * The old rim was a *solid closed* cylinder of 0.60 r with the five spokes buried inside it at
 * 0.30 r — so every wheel presented a plain flat disc to camera, and the only thing on it was
 * the livery-coloured centre cap. That is the "flat beige disc with a red dot" the R4 critic
 * saw, and why the karts read as wooden toys. The rim is now a real one: an open barrel, a
 * bright J-lip at each outer edge, five tapered spokes standing in the *face plane* with open
 * daylight between them, a vented brake disc visible through those gaps, a domed centre cap and
 * a chrome lug ring.
 */
const WHEEL_CACHE = new Map();
function wheelGeoms(radius, width, seg) {
  const key = radius.toFixed(3) + '|' + width.toFixed(3) + '|' + seg;
  const hit = WHEEL_CACHE.get(key);
  if (hit) return hit;
  const r = radius, hw = width * 0.5;
  const rs = Math.max(12, Math.round(20 * seg));

  /* ---- tyre: bead, sidewall bulge, square shoulder, crowned tread ---- */
  const prof = [
    [r * 0.560, -hw * 0.90], [r * 0.640, -hw * 1.00], [r * 0.790, -hw * 1.03],
    [r * 0.895, -hw * 1.00], [r * 0.958, -hw * 0.88], [r * 0.994, -hw * 0.60],
    [r * 1.000, -hw * 0.22], [r * 1.000, hw * 0.22], [r * 0.994, hw * 0.60],
    [r * 0.958, hw * 0.88], [r * 0.895, hw * 1.00], [r * 0.790, hw * 1.03],
    [r * 0.640, hw * 1.00], [r * 0.560, hw * 0.90],
  ].map(q => new THREE.Vector2(q[0], q[1]));
  const tyre = new THREE.LatheGeometry(prof, rs);
  tyre.rotateZ(-Math.PI / 2);

  /* ---- rim: barrel + J-lips + face spokes + lug ring ---- */
  const rimParts = [];
  rimParts.push(xf(new THREE.CylinderGeometry(r * 0.545, r * 0.545, width * 0.92, Math.round(rs * 0.7), 1, true), { rot: [0, 0, Math.PI / 2] }));
  for (const s2 of [-1, 1]) {
    rimParts.push(xf(new THREE.TorusGeometry(r * 0.552, r * 0.046, 6, Math.round(rs * 0.7)),
      { pos: [s2 * hw * 0.70, 0, 0], rot: [0, Math.PI / 2, 0] }));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.31;
      rimParts.push(xf(new THREE.CylinderGeometry(r * 0.050, r * 0.088, r * 0.42, 7),
        { pos: [s2 * hw * 0.56, Math.cos(a) * r * 0.335, Math.sin(a) * r * 0.335], rot: [a, 0, 0], scale: [0.62, 1, 1] }));
    }
    rimParts.push(xf(new THREE.CylinderGeometry(r * 0.205, r * 0.235, hw * 0.62, 12),
      { pos: [s2 * hw * 0.60, 0, 0], rot: [0, 0, Math.PI / 2] }));
    for (let i = 0; i < 5; i++) {          // lug nuts, merged into the rim to keep draw calls flat
      const a = (i / 5) * TAU + 0.62;
      rimParts.push(xf(new THREE.CylinderGeometry(r * 0.030, r * 0.030, hw * 0.16, 6),
        { pos: [s2 * hw * 0.84, Math.cos(a) * r * 0.132, Math.sin(a) * r * 0.132], rot: [0, 0, Math.PI / 2] }));
    }
  }
  const rim = mergeSimple(rimParts);

  /* ---- what you see through the spokes: brake disc + hat, and a solid centre web ---- */
  const brakeParts = [];
  brakeParts.push(xf(new THREE.CylinderGeometry(r * 0.505, r * 0.505, width * 0.20, Math.round(rs * 0.6)), { rot: [0, 0, Math.PI / 2] }));
  for (const s2 of [-1, 1]) {
    brakeParts.push(xf(new THREE.CylinderGeometry(r * 0.435, r * 0.435, width * 0.09, Math.round(rs * 0.55)),
      { pos: [s2 * hw * 0.34, 0, 0], rot: [0, 0, Math.PI / 2] }));
    brakeParts.push(xf(new THREE.CylinderGeometry(r * 0.255, r * 0.255, hw * 0.70, 12),
      { pos: [s2 * hw * 0.36, 0, 0], rot: [0, 0, Math.PI / 2] }));
  }
  const brake = mergeSimple(brakeParts);

  /* ---- domed centre cap in the livery colour ---- */
  const capParts = [];
  for (const s2 of [-1, 1]) {
    capParts.push(xf(new THREE.SphereGeometry(r * 0.185, 12, 6, 0, TAU, 0, Math.PI * 0.52),
      { pos: [s2 * hw * 0.83, 0, 0], rot: [0, 0, -s2 * Math.PI / 2], scale: [0.62, 1, 1] }));
  }
  const cap = mergeSimple(capParts);

  const out = { tyre, rim, brake, cap };
  WHEEL_CACHE.set(key, out);
  return out;
}
function makeWheel(radius, width, M, seg) {
  const g = new THREE.Group();
  const P = wheelGeoms(radius, width, seg);
  const tm = new THREE.Mesh(P.tyre, M.rubber); tm.castShadow = true; g.add(tm);
  g.add(new THREE.Mesh(P.brake, M.brake));
  const rm = new THREE.Mesh(P.rim, M.rim); rm.castShadow = true; g.add(rm);
  g.add(new THREE.Mesh(P.cap, M.hub));
  return g;
}
function mergeSimple(list) {
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of parts) {
    const p = g.attributes.position, nn = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      if (nn) { nor[(o + i) * 3] = nn.getX(i); nor[(o + i) * 3 + 1] = nn.getY(i); nor[(o + i) * 3 + 2] = nn.getZ(i); }
      if (u) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
    }
    o += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/* -------------------------------------------------------------- kart specs */
export const KART_SPECS = {
  standard: { name: 'Moshav Standard', wf: 0.235, wr: 0.285, ww: [0.20, 0.26], track: [1.18, 1.24], wb: [0.66, -0.62], seat: [0, 0.345, -0.10], hub: [0, 0.678, 0.175], tilt: 0.60 },
  sport:    { name: 'Carmel Sport',    wf: 0.225, wr: 0.300, ww: [0.20, 0.30], track: [1.22, 1.30], wb: [0.70, -0.66], seat: [0, 0.315, -0.14], hub: [0, 0.648, 0.150], tilt: 0.72 },
  buggy:    { name: 'Wadi Buggy',      wf: 0.290, wr: 0.345, ww: [0.24, 0.32], track: [1.24, 1.32], wb: [0.68, -0.64], seat: [0, 0.430, -0.10], hub: [0, 0.773, 0.168], tilt: 0.52 },
  pipe:     { name: 'Pipe Frame',      wf: 0.230, wr: 0.290, ww: [0.19, 0.28], track: [1.16, 1.26], wb: [0.68, -0.60], seat: [0, 0.330, -0.08], hub: [0, 0.663, 0.188], tilt: 0.64 },
};

/**
 * Rear wing: cambered aerofoil + endplates + a flat number tablet on the crown.
 * Replaces a 5 cm painted slab plus a 5 cm trim strip whose rivet line aliased into a one-pixel
 * dotted stripe at race distance (R4). Mutates and returns `W` so the caller can hang the
 * racing-number roundel on the tablet.
 */
function rearWing(G, M, add, seg, W) {
  const ct = Math.cos(W.tilt), st = Math.sin(W.tilt);
  const at = (dy, dz) => [0, W.y + dy * ct - dz * st, W.z + dy * st + dz * ct];
  add(G, xf(wingGeo(W.w, W.d, W.t, 0.55, seg), { pos: [0, W.y, W.z], rot: [W.tilt, 0, 0] }), M.paint);
  for (const s of [-1, 1]) {
    add(G, xf(sbox(0.032, W.t * 2.6, W.d * 1.06, 5.0, seg),
      { pos: [s * W.w * 0.5, W.y, W.z], rot: [W.tilt, 0, 0] }), M.paint2);
  }
  W.top = W.t * 0.5 * 1.55;
  const tabD = W.d * 0.72, tabH = 0.022;
  const c = at(W.top + tabH * 0.5, W.d * 0.06);
  add(G, xf(sbox(W.w * 0.50, tabH, tabD, 7.0, seg), { pos: c, rot: [W.tilt, 0, 0] }), M.paint2);
  W.plate = { y: c[1], z: c[2], up: tabH * 0.5 + 0.004, sx: W.w * 0.46, sz: tabD * 0.90 };
  return W;
}

function buildStandard(G, M, add, seg) {
  add(G, xf(plate(rr(0.98, 1.80, 0.30), 0.09), { pos: [0, 0.105, -0.02] }), M.dark);
  // main tub + cowl, as moulded crowned volumes: a superellipsoid carries the clearcoat lobe
  // across the panel instead of flashing one flat face at a time
  add(G, xf(sbox(0.86, 0.36, 1.30, 4.4, seg), { pos: [0, 0.285, -0.14] }), M.paint);
  add(G, xf(sbox(0.76, 0.34, 0.58, 3.6, seg, { taperF: 0.88 }), { pos: [0, 0.388, 0.42] }), M.paint);
  add(G, xf(sbox(0.62, 0.11, 0.46, 3.2, seg), { pos: [0, 0.548, 0.44], rot: [-0.12, 0, 0] }), M.paint2);
  // nose
  add(G, xf(sbox(0.78, 0.31, 0.64, 3.6, seg, { taperF: 0.68, ky: 0.40 }), { pos: [0, 0.300, 0.79] }), M.paint);
  add(G, xf(sbox(0.64, 0.115, 0.24, 5.5, seg), { pos: [0, 0.243, 1.02] }), M.trim);
  add(G, xf(new THREE.CapsuleGeometry(0.055, 0.84, 4, 10), { pos: [0, 0.212, 1.05], rot: [0, 0, Math.PI / 2] }), M.chrome);
  // side pods: flat outer face so the livery decal sits on bodywork, fat chamfer, crowned rail
  for (const s of [-1, 1]) {
    add(G, xf(box(0.30, 0.38, 1.08, 0.14, 0.055), { pos: [s * 0.475, 0.300, -0.06] }), M.paint);
    add(G, xf(sbox(0.300, 0.100, 1.075, 9.0, seg), { pos: [s * 0.475, 0.455, -0.06] }), M.paint2);
    add(G, xf(box(0.06, 0.20, 0.62, 0.03), { pos: [s * 0.630, 0.270, -0.06] }), M.dark, false);
  }
  // engine + airbox
  add(G, xf(sbox(0.66, 0.44, 0.48, 5.0, seg), { pos: [0, 0.380, -0.80] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.13, 0.15, 0.20, 12), { pos: [0.13, 0.640, -0.78] }), M.chrome);
  add(G, xf(sbox(0.30, 0.17, 0.26, 4.0, seg), { pos: [-0.17, 0.610, -0.80] }), M.trim);
  seatAndHoop(G, M, add, 0.345, -0.10, 0.60, seg);
  for (const s of [-1, 1]) add(G, xf(box(0.06, 0.34, 0.07, 0.02), { pos: [s * 0.30, 0.66, -1.02], rot: [-0.28, 0, 0] }), M.chrome);
  const wing = rearWing(G, M, add, seg, { y: 0.850, z: -1.07, w: 0.98, d: 0.34, t: 0.080, tilt: -0.20 });
  exhausts(G, M, add, -0.86, 0.46);
  headlights(G, M, add, 1.01, 0.34, 0.25);
  return { deck: 0.44, sideX: 0.632, sideY: 0.32, sideZ: -0.06, sideW: 0.92, sideH: 0.30, wing };
}
function buildSport(G, M, add, seg) {
  add(G, xf(plate(rr(1.04, 1.94, 0.36), 0.08), { pos: [0, 0.090, -0.02] }), M.dark);
  add(G, xf(sbox(0.90, 0.34, 1.34, 4.6, seg), { pos: [0, 0.252, -0.16] }), M.paint);
  // sculpted nose: three tapering moulded volumes, each crowned
  add(G, xf(sbox(0.82, 0.30, 0.62, 4.0, seg, { taperF: 0.92 }), { pos: [0, 0.290, 0.44] }), M.paint);
  add(G, xf(sbox(0.66, 0.26, 0.56, 3.6, seg, { taperF: 0.80, ky: 0.45 }), { pos: [0, 0.268, 0.90] }), M.paint);
  add(G, xf(sbox(0.50, 0.125, 0.30, 5.0, seg, { taperF: 0.74 }), { pos: [0, 0.243, 1.20] }), M.trim);
  add(G, xf(sbox(0.98, 0.05, 0.28, 5.0, seg), { pos: [0, 0.126, 1.06], rot: [0.05, 0, 0] }), M.dark);
  add(G, xf(sbox(0.56, 0.11, 0.38, 3.4, seg), { pos: [0, 0.432, 0.48], rot: [-0.16, 0, 0] }), M.paint2);
  for (const s of [-1, 1]) {
    add(G, xf(box(0.30, 0.32, 1.14, 0.13, 0.055), { pos: [s * 0.495, 0.270, -0.10] }), M.paint);
    add(G, xf(sbox(0.300, 0.092, 1.135, 9.0, seg), { pos: [s * 0.495, 0.396, -0.10] }), M.paint2);
    add(G, xf(sbox(0.32, 0.18, 0.54, 4.0, seg, { taperF: 0.78 }), { pos: [s * 0.585, 0.415, 0.70] }), M.paint);
    add(G, xf(sbox(0.36, 0.20, 0.62, 4.2, seg, { taperB: 0.80 }), { pos: [s * 0.615, 0.460, -0.66] }), M.paint);
  }
  add(G, xf(sbox(0.68, 0.38, 0.48, 5.0, seg), { pos: [0, 0.330, -0.86] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.11, 0.13, 0.18, 12), { pos: [0, 0.560, -0.84] }), M.chrome);
  seatAndHoop(G, M, add, 0.315, -0.14, 0.62, seg);
  for (const s of [-1, 1]) add(G, xf(box(0.055, 0.46, 0.08, 0.02), { pos: [s * 0.36, 0.64, -1.08], rot: [-0.18, 0, 0] }), M.chrome);
  const wing = rearWing(G, M, add, seg, { y: 0.885, z: -1.12, w: 1.18, d: 0.36, t: 0.078, tilt: -0.24 });
  exhausts(G, M, add, -0.92, 0.42);
  headlights(G, M, add, 1.32, 0.28, 0.17);
  return { deck: 0.40, sideX: 0.652, sideY: 0.27, sideZ: -0.12, sideW: 0.96, sideH: 0.26, wing };
}
function buildBuggy(G, M, add, seg) {
  add(G, xf(plate(rr(1.00, 1.72, 0.24), 0.10), { pos: [0, 0.185, -0.02] }), M.dark);
  add(G, xf(sbox(0.96, 0.40, 1.14, 4.6, seg), { pos: [0, 0.396, -0.14] }), M.paint);
  add(G, xf(sbox(0.82, 0.26, 0.56, 3.6, seg, { taperF: 0.80 }), { pos: [0, 0.400, 0.72] }), M.paint);
  add(G, xf(sbox(1.00, 0.095, 0.24, 5.5, seg), { pos: [0, 0.334, 0.96] }), M.trim);
  for (const s of [-1, 1]) {
    add(G, xf(box(0.18, 0.28, 0.92, 0.07, 0.04), { pos: [s * 0.545, 0.430, -0.10] }), M.paint);
    add(G, xf(sbox(0.180, 0.082, 0.915, 9.0, seg), { pos: [s * 0.545, 0.534, -0.10] }), M.paint2);
    // exposed A-arms
    for (const z of [0.68, -0.64]) {
      add(G, xf(new THREE.CylinderGeometry(0.028, 0.028, 0.42, 6), { pos: [s * 0.42, 0.26, z], rot: [0, 0, Math.PI / 2 + s * 0.22] }), M.chrome);
      add(G, xf(new THREE.CylinderGeometry(0.036, 0.036, 0.32, 8), { pos: [s * 0.46, 0.46, z], rot: [0.0, 0, s * 0.42] }), M.dark);
      add(G, xf(new THREE.CylinderGeometry(0.048, 0.048, 0.26, 8), { pos: [s * 0.46, 0.46, z], rot: [0.0, 0, s * 0.42] }), M.spring);
    }
  }
  // roll cage
  const cage = [];
  for (const s of [-1, 1]) {
    cage.push(tube([[s * 0.44, 0.42, 0.66], [s * 0.50, 0.90, 0.30], [s * 0.50, 1.02, -0.20], [s * 0.46, 0.86, -0.72], [s * 0.42, 0.46, -0.86]], 0.030, 6));
  }
  cage.push(tube([[-0.50, 1.00, 0.05], [0, 1.06, 0.05], [0.50, 1.00, 0.05]], 0.030, 6));
  cage.push(tube([[-0.50, 0.98, -0.42], [0, 1.04, -0.42], [0.50, 0.98, -0.42]], 0.030, 6));
  add(G, mergeSimple(cage), M.chrome);
  add(G, xf(sbox(0.70, 0.42, 0.44, 5.0, seg), { pos: [0, 0.470, -0.84] }), M.dark);
  seatAndHoop(G, M, add, 0.430, -0.10, 0.66, seg, true);
  // light bar
  add(G, xf(new THREE.CylinderGeometry(0.028, 0.028, 0.92, 6), { pos: [0, 0.905, 0.34], rot: [0, 0, Math.PI / 2] }), M.chrome);
  for (const s of [-1, 1]) {
    add(G, xf(new THREE.CylinderGeometry(0.085, 0.075, 0.09, 12), { pos: [s * 0.22, 0.905, 0.38], rot: [Math.PI / 2, 0, 0] }), M.chrome);
    add(G, xf(new THREE.CircleGeometry(0.078, 12), { pos: [s * 0.22, 0.905, 0.435] }), M.lamp);
  }
  const wing = rearWing(G, M, add, seg, { y: 1.058, z: -0.30, w: 1.02, d: 0.50, t: 0.070, tilt: 0 });
  exhausts(G, M, add, -0.92, 0.62);
  headlights(G, M, add, 0.98, 0.44, 0.26);
  return { deck: 0.60, sideX: 0.646, sideY: 0.44, sideZ: -0.10, sideW: 0.86, sideH: 0.26, wing };
}
function buildPipe(G, M, add, seg) {
  add(G, xf(plate(rr(0.86, 1.62, 0.18), 0.05), { pos: [0, 0.115, -0.02] }), M.dark);
  const frame = [];
  for (const s of [-1, 1]) {
    frame.push(tube([[s * 0.20, 0.16, 0.92], [s * 0.40, 0.20, 0.55], [s * 0.44, 0.22, -0.10], [s * 0.40, 0.24, -0.62], [s * 0.22, 0.26, -0.86]], 0.034, 7));
    frame.push(tube([[s * 0.42, 0.22, 0.30], [s * 0.60, 0.30, 0.28]], 0.026, 6));
    frame.push(tube([[s * 0.42, 0.22, -0.34], [s * 0.60, 0.30, -0.32]], 0.026, 6));
    frame.push(tube([[s * 0.20, 0.18, 0.90], [s * 0.16, 0.44, 0.62], [s * 0.14, 0.62, 0.34]], 0.028, 6));
  }
  frame.push(tube([[-0.42, 0.20, 0.62], [0, 0.22, 0.66], [0.42, 0.20, 0.62]], 0.028, 6));
  frame.push(tube([[-0.44, 0.24, -0.50], [0, 0.26, -0.52], [0.44, 0.24, -0.50]], 0.028, 6));
  frame.push(tube([[-0.30, 0.18, 0.94], [0, 0.24, 1.02], [0.30, 0.18, 0.94]], 0.030, 6));
  add(G, mergeSimple(frame), M.chrome);
  for (const s of [-1, 1]) {
    add(G, xf(box(0.24, 0.34, 0.88, 0.10, 0.05), { pos: [s * 0.545, 0.330, -0.02] }), M.paint);
    add(G, xf(sbox(0.240, 0.086, 0.875, 9.0, seg), { pos: [s * 0.545, 0.462, -0.02] }), M.paint2);
  }
  add(G, xf(sbox(0.64, 0.26, 0.50, 3.6, seg, { taperF: 0.78 }), { pos: [0, 0.300, 0.70] }), M.paint);
  add(G, xf(sbox(0.50, 0.11, 0.32, 3.2, seg), { pos: [0, 0.422, 0.52], rot: [-0.18, 0, 0] }), M.paint2);
  add(G, xf(sbox(0.54, 0.32, 0.38, 5.0, seg), { pos: [0.20, 0.400, -0.76] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.10, 0.10, 0.30, 12), { pos: [0.20, 0.560, -0.74], rot: [0, 0, 0.2] }), M.chrome);
  add(G, xf(sbox(0.36, 0.31, 0.36, 4.4, seg), { pos: [-0.24, 0.360, -0.76] }), M.trim);
  seatAndHoop(G, M, add, 0.330, -0.08, 0.56, seg);
  const wing = rearWing(G, M, add, seg, { y: 0.695, z: -0.98, w: 0.80, d: 0.28, t: 0.070, tilt: -0.22 });
  for (const s of [-1, 1]) add(G, xf(box(0.05, 0.26, 0.06, 0.02), { pos: [s * 0.24, 0.565, -0.95], rot: [-0.22, 0, 0] }), M.chrome);
  exhausts(G, M, add, -0.84, 0.46);
  headlights(G, M, add, 1.00, 0.28, 0.20);
  return { deck: 0.42, sideX: 0.670, sideY: 0.35, sideZ: -0.02, sideW: 0.72, sideH: 0.24, wing };
}
/**
 * Bucket seat: a moulded shell in the light secondary colour with a charcoal cushion inside it.
 * Two jobs — it stops reading as the woven grey block the R4 critic saw, and it puts a light
 * halo directly behind the driver so a ginger cat never dissolves into its own bodywork.
 */
function seatAndHoop(G, M, add, y, z, back, seg, tall) {
  add(G, xf(sbox(0.60, 0.12, 0.50, 4.0, seg), { pos: [0, y - 0.03, z + 0.02] }), M.paint2);
  add(G, xf(sbox(0.50, 0.08, 0.40, 3.4, seg), { pos: [0, y + 0.025, z + 0.03] }), M.seat);
  add(G, xf(sbox(0.58, back, 0.15, 4.2, seg, { taperF: 0.86 }), { pos: [0, y + back * 0.46, z - 0.245], rot: [0.20, 0, 0] }), M.paint2);
  add(G, xf(sbox(0.44, back * 0.86, 0.10, 3.4, seg), { pos: [0, y + back * 0.44, z - 0.195], rot: [0.20, 0, 0] }), M.seat);
  for (const s of [-1, 1]) {
    add(G, xf(sbox(0.10, back * 0.80, 0.32, 3.6, seg), { pos: [s * 0.252, y + back * 0.42, z - 0.16], rot: [0.16, 0, 0] }), M.paint);
  }
  // headrest
  add(G, xf(sbox(0.32, 0.16, 0.13, 3.2, seg), { pos: [0, y + back + 0.05, z - 0.30], rot: [0.20, 0, 0] }), M.seat);
  const hy = y + back + (tall ? 0.18 : 0.11);
  add(G, tube([[-0.30, y + 0.10, z - 0.32], [-0.34, hy, z - 0.36], [0, hy + 0.10, z - 0.38], [0.34, hy, z - 0.36], [0.30, y + 0.10, z - 0.32]], 0.030, 6), M.chrome);
}
function exhausts(G, M, add, z, y) {
  for (const s of [-1, 1]) {
    G.add(mesh(tube([[s * 0.16, y - 0.06, z + 0.18], [s * 0.22, y, z - 0.06], [s * 0.26, y + 0.06, z - 0.22]], 0.036, 8), M.chrome));
    G.add(mesh(xf(new THREE.CylinderGeometry(0.052, 0.044, 0.10, 10), { pos: [s * 0.27, y + 0.075, z - 0.26], rot: [1.35, 0, 0] }), M.chrome));
  }
}
function headlights(G, M, add, z, y, sx) {
  for (const s of [-1, 1]) {
    add(G, xf(new THREE.SphereGeometry(0.072, 12, 8, 0, TAU, 0, 1.5), { pos: [s * sx, y, z - 0.02], rot: [Math.PI / 2, 0, 0], scale: [1, 0.85, 1] }), M.chrome, false);
    add(G, xf(new THREE.SphereGeometry(0.066, 12, 8, 0, TAU, 0, 1.1), { pos: [s * sx, y, z + 0.005], rot: [Math.PI / 2, 0, 0], scale: [1, 0.7, 1] }), M.lamp, false);
  }
}
function mesh(g, m) { const o = new THREE.Mesh(g, m); o.castShadow = true; o.userData.merge = true; return o; }
/** Collapse pre-baked static children into one mesh per material — keeps draw calls down. */
function mergeByMaterial(parent) {
  const buckets = new Map();
  for (const c of parent.children.slice()) {
    if (!c.isMesh || !c.userData.merge) continue;
    if (c.position.lengthSq() > 0 || c.rotation.x || c.rotation.y || c.rotation.z) continue;
    const b = buckets.get(c.material) || [];
    b.push(c); buckets.set(c.material, b);
  }
  for (const [mat, list] of buckets) {
    if (list.length < 2) continue;
    const geo = mergeSimple(list.map(m => m.geometry));
    for (const m of list) { parent.remove(m); m.geometry.dispose(); }
    const merged = new THREE.Mesh(geo, mat);
    merged.castShadow = list.some(m => m.castShadow);
    parent.add(merged);
  }
}

/* ------------------------------------------------------------- createKart */
export function createKart(id, opts = {}) {
  const K = KART_SPECS[id] ? id : 'standard';
  const spec = KART_SPECS[K];
  const liv = LIVERIES[opts.livery] ? LIVERIES[opts.livery] : LIVERIES.citrus;
  const num = opts.number ?? 7;
  const detail = opts.detail || 'high';
  const seg = detail === 'high' ? 1 : detail === 'med' ? 0.75 : 0.55;
  const shadows = opts.shadows !== false;
  const env = opts.env !== undefined ? opts.env : kartEnv();
  const R = rng((opts.seed | 0) || 1234);

  // Automotive paint = pigment layer + hard lacquer on top, and it has to be built as two
  // layers or it is not paint. R4: "broad soft diffuse highlight but no tight clearcoat lobe,
  // no rim light, no lacquer... reads as felt". Three things were wrong:
  //   * `sheen` is a *fabric* BRDF. At 0.30 with a warm sheen colour it puts a soft retro-
  //     reflective bloom over the whole panel — literally the terry-cloth/knit look the critics
  //     named. It is gone; the grazing-angle rim it was faking is now the clearcoat's own
  //     Fresnel picking up the sky out of the PMREM env, which is what actually happens on a car.
  //   * `emissive` at 22 % of the base hue is unlit constant colour smeared over every pixel —
  //     it flattens the value range until nothing on the panel is a highlight. Down to 5 %,
  //     just enough to keep the shadow side chromatic rather than black.
  //   * base roughness was 0.21, i.e. the *pigment* was glossy. Real candy paint scatters; the
  //     gloss belongs to the clearcoat alone. 0.34 base under a 0.03 clearcoat gives a soft
  //     body plus one tight travelling lobe, instead of one broad mushy one.
  const paintCol = new THREE.Color(NUMBER_PAINT[num] ?? liv.paint);
  const paintLum = paintCol.r * 0.30 + paintCol.g * 0.59 + paintCol.b * 0.11;
  const sec2 = new THREE.Color(paintLum > 0.52 ? 0x363b45 : 0xf4f1e8);
  const M = {
    paint: new THREE.MeshPhysicalMaterial({
      color: paintCol, roughness: 0.34, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.030, envMap: env, envMapIntensity: 1.55,
      emissive: paintCol.clone().multiplyScalar(0.05), emissiveIntensity: 1.0,
      specularIntensity: 1.0, specularColor: new THREE.Color(0xffffff),
    }),
    // Secondary bodywork. MK8 karts are never one colour: there is always a second volume
    // breaking the saturated mass up, and it is also what stops the driver merging into the
    // vehicle. It has to be picked *against* the paint, not fixed — a cream secondary on
    // Shuki's Bauhaus-cream kart makes the whole vehicle one white lump, so a light body gets a
    // graphite secondary and everything else gets pearl.
    paint2: new THREE.MeshPhysicalMaterial({
      color: sec2, roughness: 0.32, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.035, envMap: env, envMapIntensity: 1.5,
      emissive: sec2.clone().multiplyScalar(0.05),
    }),
    trim: new THREE.MeshPhysicalMaterial({
      color: liv.trim, roughness: 0.32, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.045,
      envMap: env, envMapIntensity: 1.5, emissive: new THREE.Color(liv.trim).multiplyScalar(0.05),
    }),
    // Floorpan, engine, rear bumper. Cool graphite carrying a *trace* of the body hue reads as
    // machined metal; at the old 13 % lerp a red kart got a maroon underside that fought the paint.
    dark: new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x34383f).lerp(paintCol, 0.05),
      roughness: 0.38, metalness: 0.66, envMap: env, envMapIntensity: 1.6,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd6dce2, roughness: 0.13, metalness: 1.0, envMap: env, envMapIntensity: 2.0 }),
    // The map now carries the tyre's value (mid-grey carcass, dark grooves), so the material
    // colour stays white and the tread pattern is what you read rather than a flat black blob.
    rubber: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0.0, envMap: env, envMapIntensity: 1.05 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.22, metalness: 0.95, envMap: env, envMapIntensity: 1.75 }),
    // Seen through the spokes. Dark enough to be a hole at distance, metallic enough to glint.
    brake: new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.45, metalness: 0.85, envMap: env, envMapIntensity: 1.2 }),
    // Moulded composite bucket, not upholstery: the old seat ran sheen 1.0 with a white sheen
    // colour, which is a velvet lobe, and duly rendered as "a woven grey block". Charcoal with a
    // half-strength clearcoat reads as a vacuum-formed shell and gives every cat, whatever its
    // fur, a dark field to sit against.
    seat: new THREE.MeshPhysicalMaterial({
      color: paintLum > 0.52 ? 0xe9e3d4 : 0x2b2f36, roughness: 0.40, metalness: 0.0,
      clearcoat: 0.55, clearcoatRoughness: 0.22, envMap: env, envMapIntensity: 1.25,
    }),
    lamp: new THREE.MeshPhysicalMaterial({ color: 0xfff3d0, emissive: 0xffe6a8, emissiveIntensity: 1.1, roughness: 0.05, metalness: 0, clearcoat: 1, envMap: env }),
    // Rear lamps. The chase camera stares at the back of the kart for the entire race and the
    // only thing there was a yellow plate; two hot red lenses give the tail a focal point and
    // read at any distance, the way every MK8 kart's rear cluster does.
    tail: new THREE.MeshPhysicalMaterial({ color: 0xff2a1e, emissive: 0xff2416, emissiveIntensity: 2.2, roughness: 0.10, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMap: env }),
    hub: new THREE.MeshPhysicalMaterial({ color: liv.trim, roughness: 0.16, metalness: 0.55, clearcoat: 1.0, clearcoatRoughness: 0.05, envMap: env, envMapIntensity: 1.7 }),
    spring: new THREE.MeshStandardMaterial({ color: 0xc8352f, roughness: 0.4, metalness: 0.5, envMap: env }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x25313d, roughness: 0.05, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.5, envMap: env }),
  };
  if (DOM && !TREAD) TREAD = treadTextures();
  if (TREAD) { M.rubber.map = TREAD.map; M.rubber.normalMap = TREAD.nrm; M.rubber.normalScale = new THREE.Vector2(1.5, 1.5); }

  const root = new THREE.Group(); root.name = 'kart:' + K + ':' + (opts.livery || 'citrus');
  const chassis = new THREE.Group(); chassis.name = 'chassis'; root.add(chassis);

  const add = (parent, geo, mat, cast = shadows) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = false;
    m.userData.merge = true;                 // geometry is already baked in body space
    parent.add(m); return m;
  };
  const metrics = (K === 'sport' ? buildSport : K === 'buggy' ? buildBuggy : K === 'pipe' ? buildPipe : buildStandard)(chassis, M, add, seg);

  /* livery decals */
  if (DOM) {
    const sideTex = liverySide(opts.livery || 'citrus', num);
    const dm = new THREE.MeshStandardMaterial({ map: sideTex, transparent: true, alphaTest: 0.02, roughness: 0.28, metalness: 0.1, envMap: env, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(metrics.sideW, metrics.sideH), dm);
      p.position.set(s * metrics.sideX, metrics.sideY, metrics.sideZ);
      p.rotation.y = s * Math.PI / 2;
      chassis.add(p);
    }
    if (metrics.wing && metrics.wing.plate) {
      // The roundel lands on the flat tablet moulded into the crown of the aerofoil, so it is a
      // decal on bodywork rather than a card floating over a curved surface.
      const w = metrics.wing, pl = w.plate;
      const rm = new THREE.MeshStandardMaterial({
        map: roundelTexture(num, NUMBER_PAINT[num] ?? liv.paint, pl.sx / pl.sz), transparent: true, alphaTest: 0.08,
        roughness: 0.24, metalness: 0.05, envMap: env, envMapIntensity: 1.2, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const rd = new THREE.Mesh(new THREE.PlaneGeometry(pl.sx, pl.sz), rm);
      const ct = Math.cos(w.tilt), st = Math.sin(w.tilt);
      rd.position.set(0, pl.y + pl.up * ct, pl.z + pl.up * st);
      rd.rotation.x = Math.PI / 2 + w.tilt;
      chassis.add(rd);
    }
    const pm = new THREE.MeshStandardMaterial({ map: plateTexture(num), roughness: 0.42, metalness: 0.05, envMap: env,
      emissive: 0xffffff, emissiveMap: plateTexture(num), emissiveIntensity: 0.16 });
    const pl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.02), pm);
    pl.position.set(0, metrics.deck * 0.55, -1.06);
    pl.rotation.y = Math.PI;
    chassis.add(pl);
    const lensParts = [];
    for (const s2 of [-1, 1]) {
      lensParts.push(xf(box(0.17, 0.085, 0.05, 0.028, 0.014),
        { pos: [s2 * 0.315, metrics.deck * 0.55 + 0.03, -1.055] }));
      lensParts.push(xf(box(0.20, 0.115, 0.03, 0.035, 0.012),
        { pos: [s2 * 0.315, metrics.deck * 0.55 + 0.03, -1.035] }));
    }
    add(chassis, mergeSimple(lensParts), M.tail, false);
  }

  mergeByMaterial(chassis);                  // one draw call per material for the static body

  /* steering column + wheel */
  const hub = new THREE.Group();
  hub.position.set(spec.hub[0], spec.hub[1], spec.hub[2]);
  hub.rotation.x = -spec.tilt;
  chassis.add(hub);
  const swheel = new THREE.Group(); hub.add(swheel);
  add(swheel, new THREE.TorusGeometry(0.132, 0.023, 8, Math.round(20 * seg) + 8), M.dark, false);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * (TAU / 3);
    add(swheel, xf(box(0.026, 0.132, 0.032, 0.008, 0.006), { pos: [Math.cos(a) * 0.068, Math.sin(a) * 0.068, 0], rot: [0, 0, a - Math.PI / 2] }), M.chrome, false);
  }
  add(swheel, xf(new THREE.CylinderGeometry(0.040, 0.044, 0.036, 12), { rot: [Math.PI / 2, 0, 0] }), M.trim, false);
  add(swheel, xf(new THREE.CircleGeometry(0.028, 12), { pos: [0, 0, 0.020] }), M.chrome, false);
  add(chassis, xf(new THREE.CylinderGeometry(0.024, 0.024, 0.17, 8), { pos: [spec.hub[0], spec.hub[1] - 0.075, spec.hub[2] - 0.055], rot: [-spec.tilt, 0, 0] }), M.chrome, false);

  /* wheels */
  const wheels = [];
  const steerPivot = new THREE.Group(); root.add(steerPivot);
  for (const front of [true, false]) {
    const rad = front ? spec.wf : spec.wr;
    const wid = front ? spec.ww[0] : spec.ww[1];
    const tw = front ? spec.track[0] : spec.track[1];
    const z = front ? spec.wb[0] : spec.wb[1];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * tw * 0.5, rad, z);
      (front ? steerPivot : root).add(pivot);
      const spin = makeWheel(rad, wid, M, seg);
      pivot.add(spin);
      // hub carrier + suspension link back to the chassis
      add(pivot, xf(new THREE.CylinderGeometry(0.030, 0.030, 0.24, 6), { pos: [-s * 0.10, 0.02, 0], rot: [0, 0, Math.PI / 2] }), M.chrome, false);
      wheels.push({ object3D: pivot, spin, radius: rad, front, side: s, z });
    }
  }

  /* boost flames */
  const flames = [];
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.30, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    f.position.set(s * 0.27, 0.44, -1.02);
    f.rotation.x = Math.PI / 2 - 0.2;
    f.visible = false;
    chassis.add(f);
    flames.push(f);
  }

  const S = { t: R() * 5, speed: 0, steer: 0, drift: 0, air: 0, boost: 0, hit: 0, prevSpeed: 0, prevHit: false, spin: 0 };
  const baseY = chassis.position.y;

  function update(dt, st = {}) {
    dt = clamp(dt || 0, 0, 0.1);
    S.t += dt;
    const sp = st.speed || 0;
    const accel = clamp((sp - S.prevSpeed) / Math.max(dt, 1e-3) / 12, -1, 1);
    S.prevSpeed = sp;
    S.speed = damp(S.speed, sp, 10, dt);
    S.steer = damp(S.steer, clamp(st.steer || 0, -1, 1), 10, dt);
    S.drift = damp(S.drift, clamp(st.drift || 0, -1, 1), 8, dt);
    S.air = damp(S.air, st.airborne ? 1 : 0, 7, dt);
    S.boost = damp(S.boost, st.boosting ? 1 : 0, 9, dt);
    const hit = !!st.hit;
    if (hit && !S.prevHit) S.hit = 1;
    S.prevHit = hit;
    S.hit = Math.max(0, S.hit - dt * 2.2);

    S.spin += (sp / 0.28) * dt;
    for (const w of wheels) {
      w.spin.rotation.x = S.spin * (0.28 / w.radius);
    }
    // vehicle.js signs steer so that +1 yaws the kart to the right (yaw = atan2(fwd.x, fwd.z),
    // and rotation.y = +theta is exactly that yaw), so the front wheels and the rim turn with
    // the sign, not against it.
    steerPivot.rotation.y = S.steer * 0.44 + S.drift * 0.10;
    swheel.rotation.z = S.steer * WHEEL_TURN;

    const rollAmt = clamp(S.steer * (0.35 + Math.min(1, Math.abs(S.speed) / 18) * 0.65), -1, 1);
    const pitch = -accel * 0.055 + S.air * 0.05;
    const jolt = Math.sin(S.t * 55) * S.hit * S.hit * 0.05;
    chassis.rotation.x = damp(chassis.rotation.x, pitch, 12, dt) + jolt;
    chassis.rotation.z = damp(chassis.rotation.z, rollAmt * 0.075 + S.drift * 0.045, 9, dt);
    const bump = Math.sin(S.t * 17.3) * 0.004 * Math.min(1, S.speed / 8);
    chassis.position.y = baseY + damp(0, S.air * 0.055 - Math.abs(accel) * 0.012, 10, dt) + bump + S.hit * 0.02;
    chassis.position.x = jolt * 0.4;

    const fl = S.boost > 0.05;
    for (let i = 0; i < flames.length; i++) {
      flames[i].visible = fl;
      if (fl) {
        const w = 0.6 + Math.abs(Math.sin(S.t * 30 + i)) * 0.6;
        flames[i].scale.set(S.boost * w, S.boost * (0.8 + w * 0.5), S.boost * w);
      }
    }
  }

  update(0.016, {});
  return {
    id: K, kind: K, name: spec.name, livery: opts.livery || 'citrus', number: num,
    object3D: root, chassis, wheels, steeringWheel: swheel, hubGroup: hub, materials: M, state: S,
    seat: spec.seat.slice(),
    hub: { center: spec.hub.slice(), radius: 0.132, tilt: spec.tilt },
    /** Grip config in the driver's local space (cat root sits at `seat`). */
    gripForDriver() {
      // expressed in the CHASSIS frame: the paws stay bolted to the rim while the driver leans
      return { center: spec.hub.slice(), radius: 0.132, tilt: spec.tilt, maxTurn: WHEEL_TURN };
    },
    update,
    dispose() {
      root.traverse(o => { if (o.isMesh) o.geometry.dispose?.(); });
      for (const k in M) M[k].dispose?.();
    },
  };
}

export default { createKart, KART_SPECS, LIVERIES, kartEnv };
