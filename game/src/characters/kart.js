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
  citrus:  { paint: 0xdda85a, trim: 0xc94a1c, accent: 0x2f6d35, seat: 0x5a3c22, name: 'Citrus Crate' },
  olive:   { paint: 0x4c6a30, trim: 0xd9a441, accent: 0x2c3a20, seat: 0x3a4426, name: 'Olive Tin' },
  sabra:   { paint: 0x2f6b48, trim: 0xc7276b, accent: 0x8fbf5a, seat: 0x243d2c, name: 'Sabra' },
  bauhaus: { paint: 0xe9e2d2, trim: 0x27333c, accent: 0xd8d2c4, seat: 0x2b3540, name: 'Bauhaus TLV' },
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
function plateTexture(num) {
  const W = 256, H = 128, cv = cvs(W, H), c = cv.getContext('2d');
  c.fillStyle = '#f2df3a'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#1a1a1a'; c.lineWidth = 8; c.strokeRect(6, 6, W - 12, H - 12);
  c.fillStyle = '#14315e'; c.fillRect(10, 10, 34, H - 20);
  c.fillStyle = '#1a1a1a'; c.font = 'bold 72px Helvetica, Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('KAT ' + num, W / 2 + 16, H / 2 + 4);
  return tex(cv);
}
function treadTextures() {
  const W = 128, H = 128, cv = cvs(W, H), c = cv.getContext('2d');
  const hm = cvs(W, H), hc = hm.getContext('2d');
  c.fillStyle = '#1b1b1e'; c.fillRect(0, 0, W, H);
  hc.fillStyle = '#808080'; hc.fillRect(0, 0, W, H);
  // sidewalls (v 0..0.26 and 0.74..1)
  c.fillStyle = '#232327'; c.fillRect(0, 0, W, 34); c.fillRect(0, H - 34, W, 34);
  hc.fillStyle = '#6a6a6a'; hc.fillRect(0, 0, W, 34); hc.fillRect(0, H - 34, W, 34);
  c.fillStyle = '#3a3a40'; c.font = 'bold 11px Helvetica, Arial, sans-serif'; c.textAlign = 'center';
  c.fillText('KAT SLICK', W * 0.5, 22); c.fillText('KAT SLICK', W * 0.5, H - 14);
  // tread blocks
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 4; i++) {
      const x = i * 32 + (r % 2 ? 8 : 0), y = 36 + r * 14;
      c.fillStyle = '#2c2c31'; c.fillRect(x + 2, y, 24, 11);
      hc.fillStyle = '#f0f0f0'; hc.fillRect(x + 2, y, 24, 11);
    }
  }
  const map = tex(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(10, 1);
  // height -> normal
  const nv = cvs(W, H), nc = nv.getContext('2d');
  const src = hc.getImageData(0, 0, W, H).data;
  const out = nc.createImageData(W, H), d = out.data;
  const at = (x, y) => src[((((y % H) + H) % H) * W + (((x % W) + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1);
    const nx = -gx * 3, ny = -gy * 3, nz = 1, l = Math.hypot(nx, ny, nz);
    const i = (y * W + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  nc.putImageData(out, 0, 0);
  const nrm = tex(nv, false);
  nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.repeat.set(10, 1);
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

/* ------------------------------------------------------------------ wheels */
function makeWheel(radius, width, M, seg) {
  const g = new THREE.Group();
  const hw = width * 0.5;
  const prof = [
    [radius * 0.52, -hw], [radius * 0.80, -hw * 1.00], [radius * 0.93, -hw * 0.92],
    [radius * 0.995, -hw * 0.60], [radius, 0], [radius * 0.995, hw * 0.60],
    [radius * 0.93, hw * 0.92], [radius * 0.80, hw * 1.00], [radius * 0.52, hw],
  ].map(p => new THREE.Vector2(p[0], p[1]));
  const tyre = new THREE.LatheGeometry(prof, Math.round(20 * seg) + 8);
  tyre.rotateZ(-Math.PI / 2);
  const tm = new THREE.Mesh(tyre, M.rubber);
  tm.castShadow = true;
  g.add(tm);
  // rim: barrel + spokes + hub + chrome ring
  const parts = [];
  const barrel = new THREE.CylinderGeometry(radius * 0.60, radius * 0.60, width * 0.86, Math.round(16 * seg) + 6, 1, false);
  parts.push(xf(barrel, { rot: [0, 0, Math.PI / 2] }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const sp = new THREE.BoxGeometry(width * 0.30, radius * 0.62, radius * 0.16);
    parts.push(xf(sp, { pos: [0, Math.cos(a) * radius * 0.30, Math.sin(a) * radius * 0.30], rot: [-a, 0, 0] }));
  }
  parts.push(xf(new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, width * 0.95, 10), { rot: [0, 0, Math.PI / 2] }));
  const rim = new THREE.Mesh(mergeSimple(parts), M.rim);
  rim.castShadow = false;
  g.add(rim);
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(xf(new THREE.CylinderGeometry(radius * 0.17, radius * 0.13, width * 0.10, 10), { pos: [s * hw * 0.9, 0, 0], rot: [0, 0, Math.PI / 2] }), M.chrome);
    g.add(cap);
  }
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

function buildStandard(G, M, add, seg) {
  add(G, xf(plate(rr(0.98, 1.80, 0.30), 0.09), { pos: [0, 0.105, -0.02] }), M.dark);
  // main tub + cowl in front of the cockpit
  add(G, xf(box(0.84, 0.32, 1.24, 0.13), { pos: [0, 0.290, -0.14] }), M.paint);
  add(G, xf(box(0.74, 0.30, 0.54, 0.16), { pos: [0, 0.395, 0.42] }), M.paint);
  add(G, xf(box(0.62, 0.10, 0.40, 0.05), { pos: [0, 0.545, 0.44], rot: [-0.12, 0, 0] }), M.trim);
  // nose
  add(G, xf(box(0.76, 0.28, 0.52, 0.18), { pos: [0, 0.300, 0.80] }), M.paint);
  add(G, xf(box(0.60, 0.16, 0.20, 0.07), { pos: [0, 0.250, 1.02] }), M.trim);
  add(G, xf(new THREE.CapsuleGeometry(0.058, 0.86, 4, 10), { pos: [0, 0.215, 1.06], rot: [0, 0, Math.PI / 2] }), M.chrome);
  // side pods
  for (const s of [-1, 1]) {
    add(G, xf(box(0.28, 0.36, 1.06, 0.14), { pos: [s * 0.480, 0.300, -0.06] }), M.paint);
    add(G, xf(box(0.30, 0.09, 1.10, 0.045), { pos: [s * 0.480, 0.500, -0.06] }), M.trim);
    add(G, xf(box(0.06, 0.20, 0.62, 0.03), { pos: [s * 0.625, 0.270, -0.06] }), M.dark, false);
  }
  // engine + airbox
  add(G, xf(box(0.64, 0.42, 0.44, 0.09), { pos: [0, 0.380, -0.80] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.13, 0.15, 0.20, 12), { pos: [0.13, 0.640, -0.78] }), M.chrome);
  add(G, xf(box(0.30, 0.16, 0.24, 0.06), { pos: [-0.17, 0.610, -0.80] }), M.trim);
  seatAndHoop(G, M, add, 0.345, -0.10, 0.60, seg);
  for (const s of [-1, 1]) add(G, xf(box(0.06, 0.34, 0.07, 0.02), { pos: [s * 0.30, 0.66, -1.02], rot: [-0.28, 0, 0] }), M.chrome);
  add(G, xf(box(0.98, 0.05, 0.32, 0.03), { pos: [0, 0.845, -1.07], rot: [-0.20, 0, 0] }), M.paint);
  add(G, xf(box(0.98, 0.09, 0.05, 0.02), { pos: [0, 0.895, -1.19], rot: [-0.20, 0, 0] }), M.trim);
  exhausts(G, M, add, -0.86, 0.46);
  headlights(G, M, add, 1.01, 0.34, 0.25);
  return { deck: 0.44, sideX: 0.625, sideY: 0.33, sideZ: -0.06, sideW: 0.92, sideH: 0.32 };
}
function buildSport(G, M, add, seg) {
  add(G, xf(plate(rr(1.04, 1.94, 0.36), 0.08), { pos: [0, 0.090, -0.02] }), M.dark);
  add(G, xf(box(0.88, 0.30, 1.30, 0.16), { pos: [0, 0.255, -0.16] }), M.paint);
  // sculpted nose: three tapering blocks
  add(G, xf(box(0.80, 0.28, 0.58, 0.20), { pos: [0, 0.290, 0.44] }), M.paint);
  add(G, xf(box(0.64, 0.24, 0.52, 0.20), { pos: [0, 0.268, 0.90] }), M.paint);
  add(G, xf(box(0.40, 0.17, 0.28, 0.13), { pos: [0, 0.250, 1.20] }), M.trim);
  add(G, xf(box(0.96, 0.045, 0.26, 0.022), { pos: [0, 0.128, 1.06], rot: [0.05, 0, 0] }), M.dark);
  add(G, xf(box(0.54, 0.10, 0.36, 0.05), { pos: [0, 0.430, 0.48], rot: [-0.16, 0, 0] }), M.trim);
  for (const s of [-1, 1]) {
    add(G, xf(box(0.28, 0.30, 1.12, 0.13), { pos: [s * 0.500, 0.270, -0.10] }), M.paint);
    add(G, xf(box(0.30, 0.07, 1.16, 0.035), { pos: [s * 0.500, 0.440, -0.10] }), M.trim);
    add(G, xf(box(0.30, 0.16, 0.52, 0.07), { pos: [s * 0.585, 0.415, 0.70] }), M.paint);
    add(G, xf(box(0.34, 0.18, 0.60, 0.08), { pos: [s * 0.615, 0.460, -0.66] }), M.paint);
  }
  add(G, xf(box(0.66, 0.36, 0.46, 0.09), { pos: [0, 0.330, -0.86] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.11, 0.13, 0.18, 12), { pos: [0, 0.560, -0.84] }), M.chrome);
  seatAndHoop(G, M, add, 0.315, -0.14, 0.62, seg);
  for (const s of [-1, 1]) add(G, xf(box(0.055, 0.46, 0.08, 0.02), { pos: [s * 0.36, 0.64, -1.08], rot: [-0.18, 0, 0] }), M.chrome);
  add(G, xf(box(1.18, 0.045, 0.34, 0.02), { pos: [0, 0.880, -1.12], rot: [-0.24, 0, 0] }), M.paint);
  add(G, xf(box(1.18, 0.11, 0.05, 0.02), { pos: [0, 0.945, -1.24], rot: [-0.24, 0, 0] }), M.trim);
  exhausts(G, M, add, -0.92, 0.42);
  headlights(G, M, add, 1.32, 0.28, 0.17);
  return { deck: 0.40, sideX: 0.645, sideY: 0.28, sideZ: -0.12, sideW: 0.96, sideH: 0.28 };
}
function buildBuggy(G, M, add, seg) {
  add(G, xf(plate(rr(1.00, 1.72, 0.24), 0.10), { pos: [0, 0.185, -0.02] }), M.dark);
  add(G, xf(box(0.94, 0.36, 1.10, 0.10), { pos: [0, 0.400, -0.14] }), M.paint);
  add(G, xf(box(0.80, 0.24, 0.52, 0.12), { pos: [0, 0.400, 0.72] }), M.paint);
  add(G, xf(box(1.00, 0.10, 0.22, 0.05), { pos: [0, 0.340, 0.96] }), M.trim);
  for (const s of [-1, 1]) {
    add(G, xf(box(0.16, 0.26, 0.90, 0.06), { pos: [s * 0.545, 0.430, -0.10] }), M.trim);
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
  add(G, xf(box(1.02, 0.05, 0.62, 0.04), { pos: [0, 1.055, -0.18] }), M.trim);
  add(G, xf(box(0.66, 0.40, 0.42, 0.08), { pos: [0, 0.470, -0.84] }), M.dark);
  seatAndHoop(G, M, add, 0.430, -0.10, 0.66, seg, true);
  // light bar
  add(G, xf(new THREE.CylinderGeometry(0.028, 0.028, 0.92, 6), { pos: [0, 0.905, 0.34], rot: [0, 0, Math.PI / 2] }), M.chrome);
  for (const s of [-1, 1]) {
    add(G, xf(new THREE.CylinderGeometry(0.085, 0.075, 0.09, 12), { pos: [s * 0.22, 0.905, 0.38], rot: [Math.PI / 2, 0, 0] }), M.chrome);
    add(G, xf(new THREE.CircleGeometry(0.078, 12), { pos: [s * 0.22, 0.905, 0.435] }), M.lamp);
  }
  exhausts(G, M, add, -0.92, 0.62);
  headlights(G, M, add, 0.98, 0.44, 0.26);
  return { deck: 0.60, sideX: 0.64, sideY: 0.45, sideZ: -0.10, sideW: 0.86, sideH: 0.30 };
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
  for (const s of [-1, 1]) add(G, xf(box(0.22, 0.32, 0.86, 0.09), { pos: [s * 0.545, 0.330, -0.02] }), M.paint);
  add(G, xf(box(0.62, 0.24, 0.46, 0.15), { pos: [0, 0.300, 0.70] }), M.paint);
  add(G, xf(box(0.48, 0.10, 0.30, 0.05), { pos: [0, 0.420, 0.52], rot: [-0.18, 0, 0] }), M.trim);
  add(G, xf(box(0.52, 0.30, 0.36, 0.07), { pos: [0.20, 0.400, -0.76] }), M.dark);
  add(G, xf(new THREE.CylinderGeometry(0.10, 0.10, 0.30, 12), { pos: [0.20, 0.560, -0.74], rot: [0, 0, 0.2] }), M.chrome);
  add(G, xf(box(0.36, 0.30, 0.34, 0.06), { pos: [-0.24, 0.360, -0.76] }), M.trim);
  seatAndHoop(G, M, add, 0.330, -0.08, 0.56, seg);
  add(G, xf(box(0.80, 0.05, 0.26, 0.03), { pos: [0, 0.690, -0.98], rot: [-0.22, 0, 0] }), M.paint);
  for (const s of [-1, 1]) add(G, xf(box(0.05, 0.26, 0.06, 0.02), { pos: [s * 0.24, 0.565, -0.95], rot: [-0.22, 0, 0] }), M.chrome);
  exhausts(G, M, add, -0.84, 0.46);
  headlights(G, M, add, 1.00, 0.28, 0.20);
  return { deck: 0.42, sideX: 0.66, sideY: 0.36, sideZ: -0.02, sideW: 0.72, sideH: 0.24 };
}
function seatAndHoop(G, M, add, y, z, back, seg, tall) {
  add(G, xf(box(0.56, 0.09, 0.46, 0.07), { pos: [0, y - 0.02, z + 0.02] }), M.seat);
  add(G, xf(box(0.54, back, 0.11, 0.09), { pos: [0, y + back * 0.46, z - 0.24], rot: [0.20, 0, 0] }), M.seat);
  for (const s of [-1, 1]) add(G, xf(box(0.09, back * 0.8, 0.30, 0.05), { pos: [s * 0.245, y + back * 0.42, z - 0.16], rot: [0.16, 0, 0] }), M.seat);
  const hy = y + back + (tall ? 0.14 : 0.06);
  add(G, tube([[-0.30, y + 0.10, z - 0.30], [-0.34, hy, z - 0.34], [0, hy + 0.10, z - 0.36], [0.34, hy, z - 0.34], [0.30, y + 0.10, z - 0.30]], 0.030, 6), M.chrome);
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

  const M = {
    paint: new THREE.MeshPhysicalMaterial({ color: liv.paint, roughness: 0.34, metalness: 0.10, clearcoat: 1.0, clearcoatRoughness: 0.07, envMap: env, envMapIntensity: 0.65 }),
    trim: new THREE.MeshPhysicalMaterial({ color: liv.trim, roughness: 0.36, metalness: 0.08, clearcoat: 0.9, clearcoatRoughness: 0.10, envMap: env, envMapIntensity: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x25262b, roughness: 0.55, metalness: 0.35, envMap: env, envMapIntensity: 0.5 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb6bdc4, roughness: 0.16, metalness: 1.0, envMap: env, envMapIntensity: 1.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x35353a, roughness: 0.92, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: liv.trim, roughness: 0.26, metalness: 0.75, envMap: env, envMapIntensity: 0.8 }),
    seat: new THREE.MeshPhysicalMaterial({ color: liv.seat, roughness: 0.62, metalness: 0.0, sheen: 0.5, sheenColor: new THREE.Color(0xffffff), envMap: env, envMapIntensity: 0.4 }),
    lamp: new THREE.MeshPhysicalMaterial({ color: 0xfff3d0, emissive: 0xffe6a8, emissiveIntensity: 0.55, roughness: 0.05, metalness: 0, clearcoat: 1, envMap: env }),
    spring: new THREE.MeshStandardMaterial({ color: 0xc8352f, roughness: 0.4, metalness: 0.5, envMap: env }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x25313d, roughness: 0.05, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.5, envMap: env }),
  };
  if (DOM && !TREAD) TREAD = treadTextures();
  if (TREAD) { M.rubber.map = TREAD.map; M.rubber.normalMap = TREAD.nrm; M.rubber.normalScale = new THREE.Vector2(1.1, 1.1); }

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
    const pm = new THREE.MeshStandardMaterial({ map: plateTexture(num), roughness: 0.4, metalness: 0.1, envMap: env });
    const pl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.17, 0.02), pm);
    pl.position.set(0, metrics.deck * 0.55, -1.06);
    pl.rotation.y = Math.PI;
    chassis.add(pl);
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
