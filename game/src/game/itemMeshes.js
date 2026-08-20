/**
 * Kat Racing — item meshes.
 *
 * Every racing item is a real little 3D object: strong silhouette, one dominant colour,
 * readable at 40 m in a rear-view camera and charming at 1 m in the pickup roulette.
 * Textures are generated in-canvas (guarded so the module also loads under node for the
 * headless item sim).
 *
 *   import { createItemMesh, createItemBoxMesh, createPickupBurst } from './itemMeshes.js';
 *   const sabra = createItemMesh('sabra');      // Object3D, ~0.7 m tall, origin at its centre
 *   scene.add(sabra);
 */
import * as THREE from 'three';
import { rng, clamp, lerp, TAU } from '../core/mathx.js';

const DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/* ------------------------------------------------------------------ helpers */

const TEX = new Map();
function tex(key, size, draw, { srgb = true, repeat = null, wrap = THREE.RepeatWrapping } = {}) {
  if (!DOM) return null;
  if (TEX.has(key)) return TEX.get(key);
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const c = cv.getContext('2d');
  draw(c, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = 4;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  TEX.set(key, t);
  return t;
}

const MATS = new Map();
function mat(key, make) {
  let m = MATS.get(key);
  if (!m) { m = make(); MATS.set(key, m); }
  return m;
}
/** Standard opaque material with sane defaults. */
function std(key, p) { return mat(key, () => new THREE.MeshStandardMaterial(p)); }
function phys(key, p) { return mat(key, () => new THREE.MeshPhysicalMaterial(p)); }

function mesh(geo, material, { pos, rot, scale, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  if (scale) Array.isArray(scale) ? m.scale.set(scale[0], scale[1], scale[2]) : m.scale.setScalar(scale);
  m.castShadow = shadow; m.receiveShadow = false;
  return m;
}

/** Rounded cube: a subdivided box pushed toward a sphere by `r`. */
export function roundedBoxGeometry(size = 1, r = 0.22, seg = 5) {
  const g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  const p = g.attributes.position, h = size * 0.5, inner = Math.max(h - r * size, 1e-4);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = clamp(v.x, -inner, inner), cy = clamp(v.y, -inner, inner), cz = clamp(v.z, -inner, inner);
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const l = Math.hypot(dx, dy, dz) || 1, k = (r * size) / l;
    p.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Knobbly ball (falafel, cauliflower, cloud puff) — icosahedron with deterministic noise. */
function knobbly(radius, detail, amp, seed) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const r = rng(seed), p = g.attributes.position, v = new THREE.Vector3();
  const noise = [];
  for (let i = 0; i < 24; i++) noise.push({ x: r() * 2 - 1, y: r() * 2 - 1, z: r() * 2 - 1, w: 2 + r() * 5 });
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    let d = 0;
    for (const q of noise) d += Math.sin(n.x * q.w + q.x * 3) * Math.cos(n.y * q.w + q.y * 3) * Math.sin(n.z * q.w + q.z * 3);
    v.addScaledVector(n, (d / noise.length) * amp * radius);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Merge [geometry, matrix] pairs into one indexed BufferGeometry (position/normal/uv only). */
export function mergeGeometries(list) {
  const pos = [], nor = [], uvs = [], idx = [];
  const nm = new THREE.Matrix3();
  for (const [g0, m] of list) {
    const g = g0.index ? g0 : g0.toNonIndexed();
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    const base = pos.length / 3;
    nm.getNormalMatrix(m);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      if (n) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z); }
      else nor.push(0, 1, 0);
      uvs.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(idx);
  return out;
}

/* ---------------------------------------------------------------- textures */

const citrusPeel = () => tex('citrus-peel', 128, (c, S) => {
  c.fillStyle = '#8a8a8a'; c.fillRect(0, 0, S, S);
  const r = rng(21);
  for (let i = 0; i < 1400; i++) {
    const x = r() * S, y = r() * S, rad = 0.7 + r() * 1.5;
    c.fillStyle = r() > 0.5 ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.45)';
    c.beginPath(); c.arc(x, y, rad, 0, TAU); c.fill();
  }
}, { srgb: false });

const melonSkin = () => tex('melon-skin', 256, (c, S) => {
  const g = c.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#63a03f'); g.addColorStop(0.5, '#4f8c35'); g.addColorStop(1, '#5d9a3c');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  const r = rng(9);
  for (let i = 0; i < 12; i++) {
    const x0 = (i + 0.5) / 12 * S;
    c.strokeStyle = 'rgba(24,54,22,.92)';
    c.lineWidth = 5 + r() * 7;
    c.beginPath();
    for (let y = -4; y <= S + 4; y += 6) {
      const x = x0 + Math.sin(y * 0.05 + i) * 7 + Math.sin(y * 0.13 + i * 2) * 4;
      y === -4 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    c.strokeStyle = 'rgba(30,70,26,.5)'; c.lineWidth = 2; c.stroke();
  }
  for (let i = 0; i < 600; i++) {
    c.fillStyle = 'rgba(255,255,255,.06)';
    c.fillRect(r() * S, r() * S, 2, 2);
  }
});

const woodSlat = () => tex('wood-slat', 128, (c, S) => {
  c.fillStyle = '#c9a273'; c.fillRect(0, 0, S, S);
  const r = rng(33);
  for (let i = 0; i < 90; i++) {
    c.strokeStyle = `rgba(${120 + r() * 50 | 0},${86 + r() * 40 | 0},${52 + r() * 30 | 0},${0.10 + r() * 0.30})`;
    c.lineWidth = 0.6 + r() * 2.2;
    const y = r() * S;
    c.beginPath();
    for (let x = 0; x <= S; x += 8) c.lineTo(x, y + Math.sin(x * 0.06 + i) * 2.5);
    c.stroke();
  }
});

const shakshukaTop = () => tex('shakshuka', 256, (c, S) => {
  const g = c.createRadialGradient(S / 2, S / 2, 8, S / 2, S / 2, S / 2);
  g.addColorStop(0, '#d8391d'); g.addColorStop(0.7, '#bc2d18'); g.addColorStop(1, '#8d2010');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  const r = rng(77);
  for (let i = 0; i < 130; i++) {          // tomato chunks + pepper
    const x = r() * S, y = r() * S, rad = 3 + r() * 11;
    c.fillStyle = r() > 0.72 ? 'rgba(52,120,44,.85)' : `rgba(${190 + r() * 55 | 0},${52 + r() * 45 | 0},22,.6)`;
    c.beginPath(); c.ellipse(x, y, rad, rad * (0.6 + r() * 0.6), r() * 3, 0, TAU); c.fill();
  }
  for (let i = 0; i < 40; i++) {           // parsley + oil sheen
    c.fillStyle = 'rgba(96,158,58,.9)';
    c.fillRect(r() * S, r() * S, 3 + r() * 4, 2);
  }
});

const hummusTop = () => tex('hummus', 256, (c, S) => {
  const g = c.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, '#e8d9ac'); g.addColorStop(0.62, '#dcc894'); g.addColorStop(1, '#c9b177');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  // the spoon swirl
  c.lineWidth = 13; c.lineCap = 'round';
  for (let k = 0; k < 2; k++) {
    c.strokeStyle = k ? 'rgba(255,250,225,.35)' : 'rgba(150,124,72,.45)';
    c.beginPath();
    for (let a = 0; a < 8.4; a += 0.12) {
      const rad = 12 + a * 12, x = S / 2 + Math.cos(a) * rad, y = S / 2 + Math.sin(a) * rad * 0.98;
      a === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    c.lineWidth = 6;
  }
  // olive-oil pool + paprika
  const og = c.createRadialGradient(S * 0.5, S * 0.5, 3, S * 0.5, S * 0.5, S * 0.24);
  og.addColorStop(0, 'rgba(150,160,40,.85)'); og.addColorStop(1, 'rgba(150,160,40,0)');
  c.fillStyle = og; c.beginPath(); c.arc(S / 2, S / 2, S * 0.24, 0, TAU); c.fill();
  const r = rng(5);
  for (let i = 0; i < 220; i++) {
    c.fillStyle = `rgba(${180 + r() * 50 | 0},${60 + r() * 40 | 0},20,${0.2 + r() * 0.5})`;
    c.fillRect(r() * S, r() * S, 1.6, 1.6);
  }
});

const dustSwirl = () => tex('dust-swirl', 256, (c, S) => {
  c.clearRect(0, 0, S, S);
  const r = rng(13);
  for (let i = 0; i < 190; i++) {
    const y = r() * S, x = r() * S, w = 12 + r() * 70, h = 2 + r() * 9;
    c.fillStyle = `rgba(${205 + r() * 40 | 0},${168 + r() * 40 | 0},${104 + r() * 45 | 0},${0.05 + r() * 0.30})`;
    c.beginPath(); c.ellipse(x, y, w, h, -0.5 + r() * 0.4, 0, TAU); c.fill();
  }
});

const stripeFeather = () => tex('feather-stripe', 128, (c, S) => {
  c.fillStyle = '#f6f1e6'; c.fillRect(0, 0, S, S);
  for (let i = 0; i < 7; i++) {
    c.fillStyle = '#241f1c';
    c.fillRect(0, (i + 0.35) / 7 * S, S, S / 16);
  }
});

/** Gold-on-clear Israeli motif for the item box faces: pomegranate, citrus, olive branch. */
const boxMotif = () => tex('box-motif', 256, (c, S) => {
  c.clearRect(0, 0, S, S);
  const gold = '#ffd979';
  c.strokeStyle = gold; c.fillStyle = gold; c.lineWidth = 7; c.lineJoin = 'round';
  const cx = S / 2, cy = S * 0.56, R = S * 0.24;
  // pomegranate body
  c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
  // crown
  c.beginPath();
  const cw = R * 0.42, cyt = cy - R;
  c.moveTo(cx - cw, cyt);
  for (let i = 0; i < 5; i++) {
    const x0 = cx - cw + (i / 5) * cw * 2, x1 = cx - cw + ((i + 1) / 5) * cw * 2;
    c.lineTo((x0 + x1) / 2, cyt - R * (i % 2 ? 0.30 : 0.52));
    c.lineTo(x1, cyt - R * 0.06);
  }
  c.stroke();
  // seeds
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * TAU, rr = R * 0.5;
    c.beginPath(); c.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9, R * 0.11, 0, TAU); c.fill();
  }
  // olive sprig either side
  c.lineWidth = 5;
  for (const s of [-1, 1]) {
    c.beginPath(); c.moveTo(cx + s * R * 1.35, cy + R * 0.55);
    c.quadraticCurveTo(cx + s * R * 1.7, cy - R * 0.15, cx + s * R * 1.35, cy - R * 0.85); c.stroke();
    for (let i = 0; i < 3; i++) {
      const t = 0.2 + i * 0.3, y = cy + R * 0.55 - t * R * 1.4;
      c.beginPath(); c.ellipse(cx + s * (R * 1.62), y, R * 0.16, R * 0.09, s * 0.7, 0, TAU); c.fill();
    }
  }
});

const iridescentSheen = () => tex('iridescent', 128, (c, S) => {
  const g = c.createLinearGradient(0, 0, S, S);
  const stops = ['#ffd6ec', '#d8ddff', '#c8f4ff', '#d6ffe4', '#fff6c8', '#ffd6ec'];
  stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  const r = rng(88);
  for (let i = 0; i < 40; i++) {          // faint interference banding
    c.strokeStyle = `rgba(255,255,255,${0.05 + r() * 0.14})`;
    c.lineWidth = 1 + r() * 4;
    c.beginPath(); c.moveTo(r() * S, 0); c.lineTo(r() * S, S); c.stroke();
  }
});

const glowSprite = () => tex('glow', 128, (c, S) => {
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,244,205,.75)');
  g.addColorStop(0.55, 'rgba(255,206,120,.22)');
  g.addColorStop(1, 'rgba(255,190,90,0)');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
});

const ringSprite = () => tex('ring', 128, (c, S) => {
  const g = c.createRadialGradient(S / 2, S / 2, S * 0.30, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,246,215,.95)');
  g.addColorStop(0.72, 'rgba(255,196,107,.45)');
  g.addColorStop(1, 'rgba(255,170,60,0)');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
});

const shardSprite = () => tex('shard', 64, (c, S) => {
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
});

/* ------------------------------------------------------------- item visuals */

export const ITEM_VISUALS = {
  sabra:    { name: 'Sabra Missile',    color: 0x7cad4e, glow: 0xd8ff9a },
  jaffa:    { name: 'Jaffa Orange',     color: 0xef8b1f, glow: 0xffc46b },
  jaffa3:   { name: 'Triple Jaffa',     color: 0xef8b1f, glow: 0xffc46b },
  pan:      { name: 'Shakshuka Pan',    color: 0xc0341c, glow: 0xff8f4a },
  falafel:  { name: 'Hot Falafel',      color: 0x87903a, glow: 0xffb038 },
  falafel3: { name: 'Triple Falafel',   color: 0x87903a, glow: 0xffb038 },
  hummus:   { name: 'Hummus Slick',     color: 0xdcc894, glow: 0xfff0c0 },
  pardes:   { name: 'Pardes Crate',     color: 0xc9a273, glow: 0xffcf82 },
  khamsin:  { name: 'Khamsin Devil',    color: 0xd9b374, glow: 0xffe0a8 },
  hamsa:    { name: 'Hamsa Charm',      color: 0x2b8ede, glow: 0x9fe4ff },
  avatiach: { name: 'Watermelon',       color: 0x4f8c35, glow: 0xff5f6a },
  catnap:   { name: 'Cat-Nap Cloud',    color: 0xdfe4f4, glow: 0xb9c8ff },
  duchifat: { name: 'Hoopoe Rush',      color: 0xd8a05e, glow: 0xffd08a },
  afifon:   { name: 'Kite Glide',       color: 0x2f6fd0, glow: 0x9fd0ff },
};

/* --------------------------------------------------------------- factories */

function leaf(len = 0.20, w = 0.11, color = 0x3f7a35) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(w, len * 0.42, 0, len);
  s.quadraticCurveTo(-w, len * 0.42, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -0.006);
  return mesh(g, std('leaf' + color, { color, roughness: 0.55, side: THREE.DoubleSide }));
}

/** Sabra — prickly pear: green-to-blush oval, crown, and a coat of pale spines. */
export function makeSabra() {
  const g = new THREE.Group(); g.name = 'item:sabra';
  const skin = tex('sabra-skin', 128, (c, S) => {
    const gr = c.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, '#c85a35'); gr.addColorStop(0.30, '#a8873a');
    gr.addColorStop(0.55, '#7cad4e'); gr.addColorStop(1, '#5c8f3f');
    c.fillStyle = gr; c.fillRect(0, 0, S, S);
    const r = rng(3);
    for (let i = 0; i < 260; i++) {
      c.fillStyle = `rgba(${40 + r() * 40 | 0},${70 + r() * 40 | 0},30,${0.10 + r() * 0.25})`;
      c.beginPath(); c.arc(r() * S, r() * S, 1.2 + r() * 2.4, 0, TAU); c.fill();
    }
  });
  const body = mesh(new THREE.SphereGeometry(0.26, 18, 14),
    std('sabra-body', { color: 0xffffff, map: skin, roughness: 0.62 }), { scale: [1, 1.34, 0.94] });
  g.add(body);
  // crown scar on top
  g.add(mesh(new THREE.CylinderGeometry(0.10, 0.13, 0.05, 12),
    std('sabra-crown', { color: 0x3c6a30, roughness: 0.8 }), { pos: [0, 0.335, 0] }));
  g.add(mesh(new THREE.TorusGeometry(0.10, 0.022, 6, 14),
    std('sabra-lip', { color: 0x8fbf5c, roughness: 0.7 }), { pos: [0, 0.352, 0], rot: [Math.PI / 2, 0, 0] }));
  // spines, golden-angle spread over the ellipsoid
  const spineGeo = new THREE.ConeGeometry(0.014, 0.085, 4);
  spineGeo.translate(0, 0.042, 0);
  const N = 54;
  const spines = new THREE.InstancedMesh(spineGeo,
    std('sabra-spine', { color: 0xe9dc9c, roughness: 0.45, emissive: 0x2a2410, emissiveIntensity: 0.4 }), N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N, y = 1 - 2 * t, rad = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.39996;
    nv.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
    const p = nv.clone().multiply(new THREE.Vector3(0.26, 0.348, 0.244));
    nv.set(p.x / (0.26 * 0.26), p.y / (0.348 * 0.348), p.z / (0.244 * 0.244)).normalize();
    q.setFromUnitVectors(up, nv);
    m4.compose(p, q, new THREE.Vector3(1, 0.7 + (i % 3) * 0.2, 1));
    spines.setMatrixAt(i, m4);
  }
  spines.instanceMatrix.needsUpdate = true;
  spines.castShadow = true;
  g.add(spines);
  g.userData = { id: 'sabra', radius: 0.4, spin: [0.6, 2.2, 0] };
  return g;
}

/** Jaffa orange — dimpled peel, stalk and leaf. */
export function makeJaffa(scale = 1) {
  const g = new THREE.Group(); g.name = 'item:jaffa';
  g.add(mesh(new THREE.SphereGeometry(0.28, 20, 16), std('jaffa-skin', {
    color: 0xef8b1f, roughness: 0.54, bumpMap: citrusPeel(), bumpScale: 0.42,
    emissive: 0x50210a, emissiveIntensity: 0.35,
  })));
  g.add(mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.07, 8),
    std('jaffa-stem', { color: 0x6b5230, roughness: 0.85 }), { pos: [0, 0.29, 0] }));
  const lf = leaf(0.22, 0.12);
  lf.position.set(0.02, 0.30, 0.01); lf.rotation.set(-1.15, 0.4, 0.25);
  g.add(lf);
  const lf2 = leaf(0.17, 0.09, 0x4e8c3d);
  lf2.position.set(-0.03, 0.29, -0.02); lf2.rotation.set(-1.3, 2.4, -0.3);
  g.add(lf2);
  g.scale.setScalar(scale);
  g.userData = { id: 'jaffa', radius: 0.30 * scale, spin: [0.5, 1.8, 0.3] };
  return g;
}

export function makeJaffaTriple() {
  const g = new THREE.Group(); g.name = 'item:jaffa3';
  for (let i = 0; i < 3; i++) {
    const o = makeJaffa(0.72);
    const a = i / 3 * TAU;
    o.position.set(Math.cos(a) * 0.26, (i === 2 ? 0.22 : -0.04), Math.sin(a) * 0.26);
    g.add(o);
  }
  g.userData = { id: 'jaffa3', radius: 0.5, spin: [0, 2.0, 0] };
  return g;
}

/** Shakshuka pan — cast iron, red sauce, two eggs, long handle. Reads as a shield. */
export function makePan() {
  const g = new THREE.Group(); g.name = 'item:pan';
  const iron = std('pan-iron', { color: 0x25252b, roughness: 0.42, metalness: 0.62 });
  const wall = mesh(new THREE.CylinderGeometry(0.42, 0.35, 0.13, 26, 1, true), iron, { pos: [0, 0.06, 0] });
  wall.material.side = THREE.DoubleSide;
  g.add(wall);
  g.add(mesh(new THREE.CircleGeometry(0.355, 26), iron, { rot: [-Math.PI / 2, 0, 0] }));
  g.add(mesh(new THREE.TorusGeometry(0.42, 0.028, 7, 30), iron, { pos: [0, 0.125, 0], rot: [Math.PI / 2, 0, 0] }));
  // sauce
  g.add(mesh(new THREE.CircleGeometry(0.385, 26), std('pan-sauce', {
    color: 0xffffff, map: shakshukaTop(), roughness: 0.32, emissive: 0x6b1207, emissiveIntensity: 0.55,
  }), { rot: [-Math.PI / 2, 0, 0], pos: [0, 0.075, 0] }));
  // eggs
  const white = std('egg-white', { color: 0xfaf4e4, roughness: 0.4 });
  const yolk = std('egg-yolk', { color: 0xf5a81b, roughness: 0.3, emissive: 0x5a3200, emissiveIntensity: 0.5 });
  for (const [x, z] of [[-0.14, 0.06], [0.13, -0.09]]) {
    g.add(mesh(new THREE.SphereGeometry(0.125, 14, 10), white, { pos: [x, 0.085, z], scale: [1, 0.30, 1] }));
    g.add(mesh(new THREE.SphereGeometry(0.062, 12, 9), yolk, { pos: [x, 0.10, z], scale: [1, 0.62, 1] }));
  }
  // parsley
  const herb = std('herb', { color: 0x5f9e3a, roughness: 0.7 });
  const hr = rng(41);
  for (let i = 0; i < 7; i++) {
    g.add(mesh(new THREE.BoxGeometry(0.035, 0.008, 0.02), herb,
      { pos: [(hr() - 0.5) * 0.6, 0.093, (hr() - 0.5) * 0.6], rot: [0, hr() * 3, 0] }));
  }
  // handle
  const handle = mesh(new THREE.CylinderGeometry(0.037, 0.045, 0.52, 10), iron,
    { pos: [0, 0.145, -0.62], rot: [1.36, 0, 0] });
  g.add(handle);
  g.add(mesh(new THREE.TorusGeometry(0.05, 0.016, 6, 12), iron, { pos: [0, 0.235, -0.85], rot: [0, Math.PI / 2, 0] }));
  g.userData = { id: 'pan', radius: 0.5, spin: [0, 1.2, 0], iconTilt: 0.58, iconYaw: -0.3 };
  return g;
}

/** Hot falafel — knobbly crust, herb flecks, a lick of flame. */
export function makeFalafel(scale = 1) {
  const g = new THREE.Group(); g.name = 'item:falafel';
  const crust = tex('falafel-crust', 128, (c, S) => {
    c.fillStyle = '#6f4d1f'; c.fillRect(0, 0, S, S);
    const r = rng(19);
    for (let i = 0; i < 1100; i++) {
      const v = r();
      c.fillStyle = v > 0.80 ? `rgba(${70 + r() * 45 | 0},${112 + r() * 40 | 0},${38 + r() * 25 | 0},${0.45 + r() * 0.5})`
        : `rgba(${105 + r() * 90 | 0},${68 + r() * 55 | 0},${24 + r() * 26 | 0},${0.28 + r() * 0.55})`;
      c.beginPath(); c.arc(r() * S, r() * S, 1 + r() * 3.4, 0, TAU); c.fill();
    }
    for (let i = 0; i < 60; i++) {          // sesame
      c.fillStyle = 'rgba(240,226,190,.75)';
      c.beginPath(); c.ellipse(r() * S, r() * S, 2.2, 1.4, r() * 3, 0, TAU); c.fill();
    }
  });
  g.add(mesh(knobbly(0.24, 2, 0.17, 4), std('falafel-body', {
    color: 0xffffff, map: crust, roughness: 0.82, emissive: 0x2e1204, emissiveIntensity: 0.30,
  })));
  // heat reads as a camera-facing glow; cone flames turned into white horns at icon size
  const glow = new THREE.Sprite(mat('falafel-glow', () => new THREE.SpriteMaterial({
    map: glowSprite(), color: 0xff6a10, transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  glow.scale.setScalar(0.78);
  g.add(glow);
  const spark = mat('falafel-spark', () => new THREE.SpriteMaterial({
    map: shardSprite(), color: 0xffa73a, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const fr = rng(8);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + 0.4, sp = new THREE.Sprite(spark);
    sp.position.set(Math.cos(a) * 0.20, 0.16 + fr() * 0.16, Math.sin(a) * 0.20);
    sp.scale.setScalar(0.10 + fr() * 0.06);
    g.add(sp);
  }
  g.scale.setScalar(scale);
  g.userData = { id: 'falafel', radius: 0.3 * scale, spin: [0.4, 2.6, 0] };
  return g;
}

export function makeFalafelTriple() {
  const g = new THREE.Group(); g.name = 'item:falafel3';
  for (let i = 0; i < 3; i++) {
    const o = makeFalafel(0.74);
    const a = i / 3 * TAU + 0.4;
    o.position.set(Math.cos(a) * 0.24, i === 1 ? 0.20 : -0.05, Math.sin(a) * 0.24);
    g.add(o);
  }
  g.userData = { id: 'falafel3', radius: 0.5, spin: [0, 2.2, 0] };
  return g;
}

/** Hummus in a bowl — the pickup presentation of the slick. */
export function makeHummus() {
  const g = new THREE.Group(); g.name = 'item:hummus';
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(lerp(0.12, 0.40, Math.pow(t, 0.65)), lerp(0, 0.30, t)));
  }
  pts.push(new THREE.Vector2(0.415, 0.325), new THREE.Vector2(0.385, 0.322));
  g.add(mesh(new THREE.LatheGeometry(pts, 26), std('bowl', {
    color: 0xf4f2ec, roughness: 0.30, metalness: 0.0, side: THREE.DoubleSide,
  }), { pos: [0, -0.14, 0] }));
  g.add(mesh(new THREE.TorusGeometry(0.335, 0.017, 6, 26), std('bowl-band', { color: 0x2f6fd0, roughness: 0.35 }),
    { pos: [0, 0.02, 0], rot: [Math.PI / 2, 0, 0] }));
  const dome = new THREE.SphereGeometry(0.62, 26, 8, 0, TAU, 0, 0.62);
  dome.scale(1, 0.20, 1);
  g.add(mesh(dome, std('hummus-top', {
    color: 0xffffff, map: hummusTop(), roughness: 0.24, metalness: 0.03,
  }), { pos: [0, 0.055, 0] }));
  const pea = std('chickpea', { color: 0xdcc98c, roughness: 0.45 });
  for (const [x, z] of [[0.08, 0.06], [-0.09, 0.03], [0.01, -0.11], [-0.03, 0.12]]) {
    g.add(mesh(new THREE.SphereGeometry(0.042, 10, 8), pea, { pos: [x, 0.175, z], scale: [1, 0.8, 1] }));
  }
  // a wedge of pita standing in the dip
  const wedge = new THREE.Shape();
  wedge.moveTo(0, 0); wedge.lineTo(0.30, 0.09); wedge.lineTo(0.26, 0.36); wedge.lineTo(-0.03, 0.27);
  const pg = new THREE.ExtrudeGeometry(wedge, { depth: 0.045, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.014, bevelSegments: 1 });
  g.add(mesh(pg, std('pita', { color: 0xe9d3a1, roughness: 0.88 }), { pos: [0.13, 0.10, 0.10], rot: [0.32, -0.5, 0.42] }));
  g.userData = { id: 'hummus', radius: 0.45, spin: [0, 1.4, 0], iconTilt: 0.34 };
  return g;
}

/** The hummus slick as it lies on tarmac — wobbly puddle, oil sheen, stray chickpeas. */
export function makeHummusSlick(radius = 1.7, seed = 11) {
  const g = new THREE.Group(); g.name = 'hazard:hummus';
  const r = rng(seed), N = 34, shape = new THREE.Shape();
  for (let i = 0; i <= N; i++) {
    const a = i / N * TAU;
    const rad = radius * (0.78 + 0.22 * Math.sin(a * 3 + seed) + 0.10 * Math.sin(a * 5 + seed * 2) + r() * 0.03);
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  }
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getX(i) / (radius * 2) + 0.5, pos.getZ(i) / (radius * 2) + 0.5);
  }
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: hummusTop(), roughness: 0.22, metalness: 0.04,
    transparent: true, opacity: 0.97, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const slick = mesh(geo, m, { pos: [0, 0.02, 0], shadow: false });
  slick.receiveShadow = true;
  g.add(slick);
  const pea = std('chickpea', { color: 0xd9c88d, roughness: 0.5 });
  for (let i = 0; i < 6; i++) {
    const a = r() * TAU, d = radius * (0.3 + r() * 0.6);
    g.add(mesh(new THREE.SphereGeometry(0.055, 10, 8), pea,
      { pos: [Math.cos(a) * d, 0.05, Math.sin(a) * d], scale: [1, 0.8, 1] }));
  }
  g.userData = { id: 'hummus', radius, mat: m };
  return g;
}

/** Pardes crate — slatted citrus crate with oranges spilling over the rim. */
export function makePardes() {
  const g = new THREE.Group(); g.name = 'item:pardes';
  const wood = std('crate-wood', { color: 0xffffff, map: woodSlat(), roughness: 0.86 });
  const S = 0.62, half = S / 2, th = 0.035;
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const y = -half + 0.09 + i * 0.17;
      g.add(mesh(new THREE.BoxGeometry(S, 0.13, th), wood, { pos: [0, y, s * half] }));
      g.add(mesh(new THREE.BoxGeometry(th, 0.13, S), wood, { pos: [s * half, y, 0] }));
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.06, S, 0.06), std('crate-post', { color: 0xb08b5e, roughness: 0.85 }),
      { pos: [sx * (half - 0.02), 0, sz * (half - 0.02)] }));
  }
  g.add(mesh(new THREE.BoxGeometry(S, th, S), wood, { pos: [0, -half + 0.02, 0] }));
  // painted label
  const label = tex('crate-label', 128, (c, Sz) => {
    c.fillStyle = '#e8dcc0'; c.fillRect(0, 0, Sz, Sz);
    c.fillStyle = '#2f6fd0';
    c.beginPath(); c.arc(Sz / 2, Sz * 0.46, Sz * 0.30, 0, TAU); c.fill();
    c.fillStyle = '#ef8b1f';
    c.beginPath(); c.arc(Sz / 2, Sz * 0.46, Sz * 0.22, 0, TAU); c.fill();
    c.strokeStyle = '#e8dcc0'; c.lineWidth = 4;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU;
      c.beginPath(); c.moveTo(Sz / 2, Sz * 0.46);
      c.lineTo(Sz / 2 + Math.cos(a) * Sz * 0.22, Sz * 0.46 + Math.sin(a) * Sz * 0.22); c.stroke();
    }
    c.fillStyle = '#3f7a35';
    c.fillRect(Sz * 0.18, Sz * 0.80, Sz * 0.64, Sz * 0.055);
    c.fillRect(Sz * 0.26, Sz * 0.88, Sz * 0.48, Sz * 0.04);
  });
  g.add(mesh(new THREE.PlaneGeometry(0.34, 0.30), std('crate-label-m', { color: 0xffffff, map: label, roughness: 0.8 }),
    { pos: [0, 0.02, half + 0.022] }));
  // oranges peeking out
  const or = rng(6);
  for (let i = 0; i < 5; i++) {
    const o = makeJaffa(0.52);
    o.position.set((or() - 0.5) * 0.34, half - 0.06 + or() * 0.06, (or() - 0.5) * 0.34);
    o.rotation.set(or() * 3, or() * 3, or() * 3);
    g.add(o);
  }
  g.userData = { id: 'pardes', radius: 0.5, spin: [0, 1.1, 0] };
  return g;
}

/** Khamsin dust devil — a stack of swirling ochre shells with grit orbiting it. */
export function makeKhamsin(height = 3.4, scale = 1) {
  const g = new THREE.Group(); g.name = 'item:khamsin';
  const m = mat('khamsin-shell', () => new THREE.MeshBasicMaterial({
    color: 0xe6c48c, map: dustSwirl(), transparent: true, opacity: 0.62,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const shells = [];
  // a stack of short, offset cones reads as a twisting column instead of one solid funnel
  const SEG = 6;
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG;
    const rBot = lerp(0.20, 1.75, t0 * t0 * 0.55 + t0 * 0.45);
    const rTop = lerp(0.20, 1.75, t1 * t1 * 0.55 + t1 * 0.45);
    const h = height / SEG;
    const cone = mesh(new THREE.CylinderGeometry(rTop * 1.06, rBot, h * 1.25, 16, 1, true), m,
      { pos: [Math.sin(t0 * 7) * 0.10, h * (i + 0.5), Math.cos(t0 * 7) * 0.10], shadow: false });
    cone.rotation.y = t0 * 3.4;
    cone.userData.spin = (2.4 - i * 0.22) * (i % 2 ? 1 : -1);
    shells.push(cone);
    g.add(cone);
  }
  // grit spiralling up the column
  const gr = rng(15);
  const N = 46;
  const grit = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.075, 0.05),
    std('grit', { color: 0x9c7a4c, roughness: 0.95 }), N);
  const m4 = new THREE.Matrix4();
  const gritData = [];
  for (let i = 0; i < N; i++) {
    const y = (i / N) * height * 0.98 + gr() * 0.1;
    const a = y * 2.6 + gr() * 0.8;
    const rad = lerp(0.24, 1.75, y / height) * (0.85 + gr() * 0.35);
    gritData.push({ a, y, rad, sp: 2.4 + gr() * 2.6 });
    m4.makeTranslation(Math.cos(a) * rad, y, Math.sin(a) * rad);
    grit.setMatrixAt(i, m4);
  }
  grit.instanceMatrix.needsUpdate = true;
  g.add(grit);
  // ground dust
  g.add(mesh(new THREE.CircleGeometry(2.2, 24), mat('khamsin-base', () => new THREE.MeshBasicMaterial({
    map: glowSprite(), color: 0xcfa568, transparent: true, opacity: 0.42, depthWrite: false,
  })), { rot: [-Math.PI / 2, 0, 0], pos: [0, 0.05, 0], shadow: false }));
  g.scale.setScalar(scale);
  g.userData = { id: 'khamsin', radius: 1.2 * scale, shells, grit, gritData, height, spin: [0, 0, 0], iconTilt: 0 };
  return g;
}

/** Hamsa charm — enamel-blue hand with a gold rim and a watching eye. Invincibility. */
export function makeHamsa() {
  const g = new THREE.Group(); g.name = 'item:hamsa';
  const s = new THREE.Shape();
  // palm
  s.moveTo(-0.20, -0.30);
  s.quadraticCurveTo(-0.30, -0.05, -0.26, 0.10);
  // left thumb
  s.quadraticCurveTo(-0.40, 0.10, -0.40, 0.26);
  s.quadraticCurveTo(-0.40, 0.36, -0.30, 0.36);
  s.quadraticCurveTo(-0.21, 0.36, -0.20, 0.22);
  // three fingers
  const finger = (x, top) => {
    s.lineTo(x - 0.062, 0.18);
    s.quadraticCurveTo(x - 0.072, top, x, top + 0.03);
    s.quadraticCurveTo(x + 0.072, top, x + 0.062, 0.16);
    s.quadraticCurveTo(x + 0.075, 0.13, x + 0.088, 0.155);
  };
  finger(-0.115, 0.46); finger(0.0, 0.545); finger(0.115, 0.46);
  s.lineTo(0.20, 0.22);
  // right thumb
  s.quadraticCurveTo(0.21, 0.36, 0.30, 0.36);
  s.quadraticCurveTo(0.40, 0.36, 0.40, 0.26);
  s.quadraticCurveTo(0.40, 0.10, 0.26, 0.10);
  s.quadraticCurveTo(0.30, -0.05, 0.20, -0.30);
  s.quadraticCurveTo(0.0, -0.40, -0.20, -0.30);
  const body = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 2, curveSegments: 8 });
  body.center();
  g.add(mesh(body, phys('hamsa-enamel', {
    color: 0x2b8ede, roughness: 0.18, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.15,
    emissive: 0x0a3a68, emissiveIntensity: 0.45,
  })));
  const rim = new THREE.ExtrudeGeometry(s, { depth: 0.035, bevelEnabled: true, bevelSize: 0.045, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 8 });
  rim.center();
  g.add(mesh(rim, std('hamsa-gold', { color: 0xe8bf5a, roughness: 0.24, metalness: 0.95, emissive: 0x3a2c05, emissiveIntensity: 0.4 }),
    { scale: [1.0, 1.0, 0.85] }));
  // eye
  for (const sgn of [1, -1]) {                       // both faces get an eye
    const z = sgn * 0.062;
    g.add(mesh(new THREE.SphereGeometry(0.15, 16, 11), std('eye-rim', { color: 0xe8bf5a, roughness: 0.25, metalness: 0.9 }),
      { pos: [0, 0.02, z * 0.92], scale: [1.35, 0.95, 0.24] }));
    g.add(mesh(new THREE.SphereGeometry(0.132, 16, 11), std('eye-white', { color: 0xfbf8ef, roughness: 0.22 }),
      { pos: [0, 0.02, z], scale: [1.3, 0.9, 0.30] }));
    g.add(mesh(new THREE.SphereGeometry(0.070, 13, 10), std('eye-iris', { color: 0x1552a8, roughness: 0.18, emissive: 0x0d3a7a, emissiveIntensity: 0.8 }),
      { pos: [0, 0.02, z * 1.22], scale: [1, 1, 0.42] }));
    g.add(mesh(new THREE.SphereGeometry(0.034, 10, 8), std('eye-pupil', { color: 0x101318, roughness: 0.28 }),
      { pos: [0, 0.02, z * 1.34], scale: [1, 1, 0.42] }));
  }
  // halo
  const halo = new THREE.Sprite(mat('halo', () => new THREE.SpriteMaterial({
    map: glowSprite(), color: 0x9fe4ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  halo.scale.setScalar(2.1);
  g.add(halo);
  g.userData = { id: 'hamsa', radius: 0.5, spin: [0, 2.4, 0], halo, iconTilt: 0, iconYaw: 0 };
  return g;
}

/** Watermelon — striped melon plus a cut wedge. Growth item. */
export function makeAvatiach() {
  const g = new THREE.Group(); g.name = 'item:avatiach';
  const melon = mesh(new THREE.SphereGeometry(0.40, 22, 16), std('melon', {
    color: 0xffffff, map: melonSkin(), roughness: 0.5, metalness: 0.02,
  }), { scale: [1, 0.94, 1] });
  g.add(melon);
  g.add(mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.09, 8), std('melon-stem', { color: 0x6b7a33, roughness: 0.85 }),
    { pos: [0.03, 0.39, 0], rot: [0, 0, -0.4] }));
  // wedge slice orbiting
  const sect = new THREE.Shape();
  sect.moveTo(0, 0);
  sect.absarc(0, 0, 0.30, -0.55, 0.55, false);
  sect.lineTo(0, 0);
  const flesh = new THREE.ExtrudeGeometry(sect, { depth: 0.09, bevelEnabled: false, curveSegments: 8 });
  const wedge = new THREE.Group();
  wedge.add(mesh(flesh, std('melon-flesh', { color: 0xe4444f, roughness: 0.45, emissive: 0x3a0a0e, emissiveIntensity: 0.3 })));
  const rindShape = new THREE.Shape();
  rindShape.absarc(0, 0, 0.335, -0.56, 0.56, false);
  rindShape.absarc(0, 0, 0.30, 0.56, -0.56, true);
  const rind = new THREE.ExtrudeGeometry(rindShape, { depth: 0.09, bevelEnabled: false, curveSegments: 8 });
  wedge.add(mesh(rind, std('melon-rind', { color: 0x4f8c35, roughness: 0.55 })));
  const seed = std('melon-seed', { color: 0x2a221c, roughness: 0.4 });
  const sr = rng(23);
  for (let i = 0; i < 5; i++) {
    wedge.add(mesh(new THREE.SphereGeometry(0.021, 8, 6), seed,
      { pos: [Math.cos(-0.4 + sr() * 0.8) * (0.14 + sr() * 0.12), Math.sin(-0.4 + sr() * 0.8) * (0.14 + sr() * 0.12), 0.093], scale: [1, 1.5, 0.5] }));
  }
  wedge.position.set(0.42, 0.28, 0.10);
  wedge.rotation.set(0.2, 0.3, 0.9);
  wedge.scale.setScalar(0.85);
  g.add(wedge);
  g.userData = { id: 'avatiach', radius: 0.5, spin: [0, 1.5, 0] };
  return g;
}

/** Cat-nap cloud — a fat little cloud with a sleeping street cat on top and floating Zs. */
export function makeCatnap() {
  const g = new THREE.Group(); g.name = 'item:catnap';
  const puff = phys('cloud-puff', {
    color: 0xeef1fb, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.96,
    sheen: 0.6, sheenColor: new THREE.Color(0xb9c8ff),
  });
  const cr = rng(31);
  const cloud = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + cr() * 0.4;
    const rad = 0.16 + cr() * 0.14;
    cloud.add(mesh(knobbly(rad, 1, 0.14, 100 + i), puff,
      { pos: [Math.cos(a) * 0.30, -0.02 + cr() * 0.07, Math.sin(a) * 0.22], scale: [1.15, 0.85, 1.05] }));
  }
  cloud.add(mesh(knobbly(0.28, 1, 0.12, 55), puff, { pos: [0, 0.02, 0], scale: [1.3, 0.8, 1.1] }));
  g.add(cloud);
  // sleeping ginger cat
  const fur = std('nap-fur', { color: 0xd98b46, roughness: 0.85 });
  const furLight = std('nap-fur-l', { color: 0xf3ddc0, roughness: 0.85 });
  const cat = new THREE.Group();
  cat.add(mesh(new THREE.SphereGeometry(0.20, 16, 12), fur, { pos: [0, 0.10, 0], scale: [1.25, 0.72, 0.95] }));
  cat.add(mesh(new THREE.SphereGeometry(0.125, 14, 10), fur, { pos: [-0.19, 0.15, 0.03], scale: [1, 0.94, 0.95] }));
  for (const s of [-1, 1]) {
    cat.add(mesh(new THREE.ConeGeometry(0.05, 0.09, 4), fur, { pos: [-0.20, 0.25, 0.06 * s], rot: [0, 0, 0.15 * s] }));
  }
  cat.add(mesh(new THREE.SphereGeometry(0.06, 10, 8), furLight, { pos: [-0.27, 0.12, 0.02], scale: [0.9, 0.7, 1] }));
  cat.add(mesh(new THREE.TorusGeometry(0.13, 0.035, 6, 16, 4.2), fur, { pos: [0.13, 0.07, 0.05], rot: [1.35, 0.4, 0] }));
  // closed eyes
  const line = std('nap-line', { color: 0x35271c, roughness: 0.6 });
  for (const s of [-1, 1]) {
    cat.add(mesh(new THREE.TorusGeometry(0.022, 0.006, 5, 8, Math.PI), line,
      { pos: [-0.295, 0.155, 0.045 * s], rot: [0, 1.4, Math.PI] }));
  }
  cat.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), std('nap-nose', { color: 0xe0857f, roughness: 0.5 }),
    { pos: [-0.31, 0.125, 0], scale: [0.7, 0.6, 1] }));
  cat.position.set(0, 0.10, 0);
  g.add(cat);
  // Zzz
  const zm = std('zzz', { color: 0xbcd3ff, roughness: 0.3, emissive: 0x2a4a8a, emissiveIntensity: 0.9 });
  const zs = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const sc = 0.55 + i * 0.28, z = new THREE.Group();
    const bar = (w, h, y, rot) => z.add(mesh(new THREE.BoxGeometry(w, h, 0.02), zm, { pos: [0, y, 0], rot: [0, 0, rot] }));
    bar(0.13, 0.028, 0.065, 0);
    bar(0.17, 0.028, 0, -0.72);
    bar(0.13, 0.028, -0.065, 0);
    z.scale.setScalar(sc);
    z.position.set(0.13 + i * 0.16, 0.36 + i * 0.20, 0.05 * (i % 2 ? 1 : -1));
    z.rotation.z = 0.15 * (i % 2 ? 1 : -1);
    zs.add(z);
  }
  g.add(zs);
  g.userData = { id: 'catnap', radius: 0.6, spin: [0, 0.5, 0], zs, cloud };
  return g;
}

/** Hoopoe (duchifat) — Israel's national bird: crest, stripes, dagger beak. Rank recovery. */
export function makeDuchifat() {
  const g = new THREE.Group(); g.name = 'item:duchifat';
  const body = std('hoopoe-body', { color: 0xe0a464, roughness: 0.68 });
  const dark = std('hoopoe-dark', { color: 0x201b18, roughness: 0.62 });
  const stripe = std('hoopoe-stripe', { color: 0xffffff, map: stripeFeather(), roughness: 0.66, side: THREE.DoubleSide });

  g.add(mesh(new THREE.SphereGeometry(0.22, 18, 13), body, { pos: [0, 0, -0.04], scale: [0.92, 0.88, 1.55] }));
  g.add(mesh(new THREE.SphereGeometry(0.135, 15, 11), body, { pos: [0, 0.14, 0.30] }));
  g.add(mesh(new THREE.ConeGeometry(0.032, 0.44, 8), dark, { pos: [0, 0.09, 0.56], rot: [Math.PI / 2 + 0.14, 0, 0] }));
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.SphereGeometry(0.030, 9, 7), std('bird-eye', { color: 0x14100c, roughness: 0.22 }), { pos: [sx * 0.085, 0.185, 0.355] }));
    g.add(mesh(new THREE.SphereGeometry(0.011, 6, 5), std('bird-eye-hi', { color: 0xffffff, roughness: 0.2 }), { pos: [sx * 0.098, 0.208, 0.378] }));
  }
  // the crest, fanned across the head and tipped in black
  for (let i = 0; i < 9; i++) {
    const t = i / 8, a = lerp(-0.75, 0.75, t);
    const h = 0.36 - Math.abs(t - 0.5) * 0.16;
    const f = new THREE.Group();
    f.add(mesh(new THREE.BoxGeometry(0.045, h, 0.018), std('crest', { color: 0xe8853c, roughness: 0.62 }), { pos: [0, h * 0.5, 0] }));
    f.add(mesh(new THREE.BoxGeometry(0.049, 0.06, 0.021), dark, { pos: [0, h - 0.025, 0] }));
    f.position.set(0, 0.22, 0.30 - Math.abs(a) * 0.05);
    f.rotation.set(-0.22 - Math.abs(a) * 0.25, 0, a);
    g.add(f);
  }
  // wings: flat panels held out sideways with a 30-degree dihedral
  for (const sx of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.20); shape.quadraticCurveTo(0.40, 0.26, 0.78, 0.03);
    shape.quadraticCurveTo(0.40, -0.12, 0, -0.20); shape.lineTo(0, 0.20);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: false, curveSegments: 8 });
    geo.rotateX(-Math.PI / 2);                       // lie the wing flat...
    const w = mesh(geo, stripe, { pos: [sx * 0.16, 0.08, -0.02] });
    w.rotation.z = sx * 0.50;                        // ...then raise the tip
    w.rotation.y = sx > 0 ? 0 : Math.PI;
    w.scale.z = sx > 0 ? 1 : 1;
    g.add(w);
    // black wing tip
    const tip = mesh(new THREE.BoxGeometry(0.16, 0.022, 0.20), dark,
      { pos: [sx * 0.86, 0.08 + 0.42 * 0.5, -0.02], rot: [0, 0, sx * 0.50] });
    g.add(tip);
  }
  // tail, fanned flat behind
  const tail = new THREE.Shape();
  tail.moveTo(-0.13, 0); tail.lineTo(0.13, 0); tail.lineTo(0.21, -0.52); tail.lineTo(-0.21, -0.52);
  const tg = new THREE.ExtrudeGeometry(tail, { depth: 0.022, bevelEnabled: false });
  tg.rotateX(-Math.PI / 2 + 0.22);
  g.add(mesh(tg, stripe, { pos: [0, 0.02, -0.28] }));
  g.userData = { id: 'duchifat', radius: 0.45, spin: [0, 0, 0], iconTilt: 0.30, iconYaw: -0.7 };
  return g;
}

/** Afifon — a beach kite. Short glide/dash. */
export function makeAfifon() {
  const g = new THREE.Group(); g.name = 'item:afifon';
  const panel = (color) => std('kite-' + color, { color, roughness: 0.42, metalness: 0.02, side: THREE.DoubleSide });
  const quad = (a, b, c, d, m) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    geo.computeVertexNormals();
    return mesh(geo, m);
  };
  const T = [0, 0.55, 0.04], B = [0, -0.62, 0.04], L = [-0.42, 0.03, -0.05], R = [0.42, 0.03, -0.05], C = [0, 0.03, 0.06];
  g.add(quad(T, L, C, C, panel(0x2f6fd0)));
  g.add(quad(T, C, R, R, panel(0xf3f6fb)));
  g.add(quad(B, C, L, L, panel(0xf3f6fb)));
  g.add(quad(B, R, C, C, panel(0x2f6fd0)));
  const spar = std('kite-spar', { color: 0x6b5230, roughness: 0.7 });
  g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.18, 6), spar, { pos: [0, -0.03, 0.03] }));
  g.add(mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.86, 6), spar, { pos: [0, 0.03, 0.0], rot: [0, 0, Math.PI / 2] }));
  // tail ribbons
  const rib = std('kite-rib', { color: 0xef8b1f, roughness: 0.5, side: THREE.DoubleSide });
  const rib2 = std('kite-rib2', { color: 0xf3f6fb, roughness: 0.5, side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    g.add(mesh(new THREE.PlaneGeometry(0.13, 0.07), i % 2 ? rib2 : rib,
      { pos: [Math.sin(t * 5.2) * 0.15, -0.70 - t * 0.62, 0.02], rot: [0, 0, Math.sin(t * 5.2) * 0.7] }));
  }
  g.userData = { id: 'afifon', radius: 0.55, spin: [0, 1.6, 0], iconYaw: -0.15 };
  return g;
}

const FACTORY = {
  sabra: makeSabra, jaffa: () => makeJaffa(1), jaffa3: makeJaffaTriple, pan: makePan,
  falafel: () => makeFalafel(1), falafel3: makeFalafelTriple, hummus: makeHummus,
  pardes: makePardes, khamsin: () => makeKhamsin(1.35, 1), hamsa: makeHamsa,
  avatiach: makeAvatiach, catnap: makeCatnap, duchifat: makeDuchifat, afifon: makeAfifon,
};

/** Build the mesh for an item id. Unknown ids get a neutral crate so nothing ever throws. */
export function createItemMesh(id, opts = {}) {
  const f = FACTORY[id];
  let o;
  try { o = f ? f() : null; } catch (e) { o = null; }
  if (!o) {
    o = new THREE.Group();
    o.add(mesh(roundedBoxGeometry(0.5, 0.2, 3), std('unknown-item', { color: 0x8899aa, roughness: 0.6 })));
    o.userData = { id, radius: 0.35, spin: [0, 1.5, 0] };
  }
  if (opts.scale) o.scale.multiplyScalar(opts.scale);
  return o;
}

export const ITEM_MESH_IDS = Object.keys(FACTORY);

/* ------------------------------------------------------------- the item box */

/**
 * Floating iridescent cube with a gold frame, a pomegranate motif on every face and a
 * glowing seed in the middle. No question marks anywhere.
 */
export function createItemBoxMesh(opts = {}) {
  const size = opts.size ?? 1.5;
  const g = new THREE.Group();
  g.name = 'itembox';

  // One material set for every box on the course: 12 boxes cost 12 x 6 draws, not 12 x 22.
  const shellMat = mat('box-shell', () => new THREE.MeshPhysicalMaterial({
    color: 0xbfe8ff, map: iridescentSheen(), roughness: 0.05, metalness: 0.0,
    transparent: true, opacity: 0.60, side: THREE.DoubleSide,
    iridescence: 1.0, iridescenceIOR: 1.9, iridescenceThicknessRange: [140, 640],
    clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.6,
    emissive: 0x1d4b74, emissiveIntensity: 0.30, depthWrite: false,
  }));
  const shell = mesh(mat('box-shell-geo', () => roundedBoxGeometry(size, 0.20, 4)), shellMat, { shadow: false });
  g.add(shell);

  const innerMat = mat('box-inner', () => new THREE.MeshBasicMaterial({
    color: 0xffcf7a, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  g.add(mesh(mat('box-inner-geo', () => roundedBoxGeometry(size * 0.80, 0.24, 3)), innerMat, { shadow: false }));

  // gold edge frame + corner studs, merged into a single draw
  const gold = std('box-gold', { color: 0xf3cb6c, roughness: 0.20, metalness: 0.92, emissive: 0x5a4408, emissiveIntensity: 0.7 });
  const frameGeo = mat('box-frame-geo', () => {
    const t = size * 0.080, h = size * 0.5 - t * 0.5;
    const bar = new THREE.BoxGeometry(size - t * 1.5, t, t);
    const stud = new THREE.SphereGeometry(t * 0.92, 8, 6);
    const parts = [], m4 = new THREE.Matrix4(), e = new THREE.Euler();
    for (const axis of [0, 1, 2]) for (const a of [-1, 1]) for (const b of [-1, 1]) {
      if (axis === 0) m4.compose(new THREE.Vector3(0, a * h, b * h), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      if (axis === 1) m4.compose(new THREE.Vector3(a * h, 0, b * h), new THREE.Quaternion().setFromEuler(e.set(0, 0, Math.PI / 2)), new THREE.Vector3(1, 1, 1));
      if (axis === 2) m4.compose(new THREE.Vector3(a * h, b * h, 0), new THREE.Quaternion().setFromEuler(e.set(0, Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1));
      parts.push([bar, m4.clone()]);
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      parts.push([stud, new THREE.Matrix4().makeTranslation(sx * h, sy * h, sz * h)]);
    }
    return mergeGeometries(parts);
  });
  g.add(mesh(frameGeo, gold, { shadow: false }));

  // etched pomegranate motif on all six faces, one draw
  const motifMat = mat('box-motif-mat', () => new THREE.MeshBasicMaterial({
    map: boxMotif(), transparent: true, opacity: 1.0, depthWrite: false,
    color: 0xd8891f, side: THREE.DoubleSide,
  }));
  const motifGeo = mat('box-motif-geo', () => {
    const plane = new THREE.PlaneGeometry(size * 0.62, size * 0.62);
    const d = size * 0.504, e = new THREE.Euler(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const faces = [
      [[0, 0, d], [0, 0, 0]], [[0, 0, -d], [0, Math.PI, 0]],
      [[d, 0, 0], [0, Math.PI / 2, 0]], [[-d, 0, 0], [0, -Math.PI / 2, 0]],
      [[0, d, 0], [-Math.PI / 2, 0, 0]], [[0, -d, 0], [Math.PI / 2, 0, 0]],
    ];
    return mergeGeometries(faces.map(([p, r]) => [plane,
      new THREE.Matrix4().compose(new THREE.Vector3(...p), q.setFromEuler(e.set(...r)), one)]));
  });
  g.add(mesh(motifGeo, motifMat, { shadow: false }));

  // glowing seed in the middle
  const core = mesh(mat('box-core-geo', () => new THREE.OctahedronGeometry(size * 0.13, 0)),
    mat('box-core', () => new THREE.MeshBasicMaterial({
      color: 0xffc860, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false,
    })), { shadow: false });
  g.add(core);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSprite(), color: 0xffc978, transparent: true, opacity: 0.24,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.setScalar(size * 1.9);
  g.add(halo);

  g.userData = { shell, shellMat, core, halo, innerMat, motifMat, size };
  return g;
}

/**
 * Pickup burst: a ring plus a scatter of additive shards, replayable.
 *   const b = createPickupBurst(); scene.add(b.object3D); b.play(pos, 0xffd27a);
 */
export function createPickupBurst(opts = {}) {
  const N = opts.count ?? 14;
  const g = new THREE.Group();
  g.visible = false;
  const shardMat = new THREE.SpriteMaterial({
    map: shardSprite(), color: 0xffe0a0, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const shards = [];
  const r = rng(opts.seed ?? 77);
  for (let i = 0; i < N; i++) {
    const s = new THREE.Sprite(shardMat.clone());
    const a = i / N * TAU + r() * 0.3, el = (r() - 0.25) * 1.3;
    s.userData.dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el) + 0.55, Math.sin(a) * Math.cos(el));
    s.userData.sp = 2.6 + r() * 4.4;
    g.add(s);
    shards.push(s);
  }
  // the shockwave is a billboard, so it never reads as a decal painted on the tarmac
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringSprite(), color: 0xffe7ae, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  g.add(ring);

  let t = -1;
  const dur = opts.duration ?? 0.5;
  const origin = new THREE.Vector3();
  return {
    object3D: g,
    get active() { return t >= 0; },
    play(pos, color = 0xffd27a) {
      origin.set(pos.x, pos.y, pos.z);
      t = 0; g.visible = true;
      ring.material.color.setHex(color).lerp(new THREE.Color(0xffffff), 0.45);
      for (const s of shards) s.material.color.setHex(color).lerp(new THREE.Color(0xfff3d0), 0.35);
    },
    update(dt) {
      if (t < 0) return;
      t += dt;
      const k = clamp(t / dur, 0, 1), fade = 1 - k;
      for (const s of shards) {
        const d = s.userData.dir, sp = s.userData.sp;
        s.position.set(origin.x + d.x * sp * t, origin.y + d.y * sp * t - 3.0 * t * t, origin.z + d.z * sp * t);
        s.scale.setScalar(lerp(0.55, 0.08, k));
        s.material.opacity = fade * fade;
      }
      ring.position.copy(origin);
      ring.scale.setScalar(lerp(0.7, 3.4, Math.sqrt(k)));
      ring.material.opacity = fade * fade * 0.85;
      if (k >= 1) { t = -1; g.visible = false; }
    },
    dispose() { g.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); },
  };
}

/**
 * A fading ribbon trail for projectiles.
 *   const tr = makeTrail(0xff9a3c); scene.add(tr.object3D); tr.push(pos); tr.update(dt);
 */
export function makeTrail(color = 0xffc46b, opts = {}) {
  const N = opts.points ?? 22;
  const width = opts.width ?? 0.30;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 2 * 3);
  const alpha = new Float32Array(N * 2);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  geo.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mm = new THREE.Mesh(geo, m);
  mm.frustumCulled = false;
  const pts = [];
  const up = new THREE.Vector3(0, 1, 0), tan = new THREE.Vector3(), side = new THREE.Vector3();
  return {
    object3D: mm, material: m,
    reset() { pts.length = 0; geo.attributes.position.needsUpdate = true; },
    push(p) {
      pts.push(new THREE.Vector3(p.x, p.y, p.z));
      if (pts.length > N) pts.shift();
    },
    update() {
      const n = pts.length;
      if (n < 2) { mm.visible = false; return; }
      mm.visible = true;
      for (let i = 0; i < N; i++) {
        const k = Math.min(i, n - 1);
        const p = pts[Math.max(0, n - 1 - (N - 1 - i))] || pts[k];
        const q = pts[Math.min(n - 1, Math.max(0, n - 1 - (N - 1 - i) + 1))] || p;
        tan.subVectors(q, p);
        if (tan.lengthSq() < 1e-8) tan.set(0, 0, 1);
        side.crossVectors(tan.normalize(), up).normalize().multiplyScalar(width * (i / (N - 1)) * 0.5 + 0.02);
        pos[i * 6 + 0] = p.x + side.x; pos[i * 6 + 1] = p.y + side.y; pos[i * 6 + 2] = p.z + side.z;
        pos[i * 6 + 3] = p.x - side.x; pos[i * 6 + 4] = p.y - side.y; pos[i * 6 + 5] = p.z - side.z;
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeBoundingSphere();
    },
    dispose() { geo.dispose(); m.dispose(); },
  };
}

export default {
  createItemMesh, createItemBoxMesh, createPickupBurst, makeTrail, makeHummusSlick,
  makeKhamsin, ITEM_VISUALS, ITEM_MESH_IDS, roundedBoxGeometry,
};
