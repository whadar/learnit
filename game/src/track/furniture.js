/**
 * Trackside furniture for the Amikam Village Circuit.
 *
 * Everything here is placed from the track spline itself: guard rails go where the ground
 * actually falls away, tyre stacks sit on the outside of the hairpins, hay bales line the
 * chicane, olive-crate barriers and bunting dress the village straight, and the start gantry
 * straddles the line on Rehov Rakefet.
 *
 * Draw calls are kept low by merging every static prop into a handful of vertex-coloured
 * meshes (metal / wood / rubber / straw / foliage) plus a couple of small textured atlases
 * for banners, signs and bunting.
 */
import * as THREE from 'three';
import { clamp, lerp, rng, TAU } from '../core/mathx.js';

/* ============================================================== builder ===== */

/** Accumulates transformed primitives into one vertex-coloured BufferGeometry. */
class Builder {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; this.base = 0; }
  add(geo, m, col, uvScale) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      this.p.push(v.x, v.y, v.z);
      nv.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.n.push(nv.x, nv.y, nv.z);
      if (uv) this.u.push(uv.getX(i) * (uvScale ? uvScale[0] : 1), uv.getY(i) * (uvScale ? uvScale[1] : 1));
      else this.u.push(0, 0);
      this.c.push(col[0], col[1], col[2]);
    }
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i++) this.i.push(idx.getX(i) + this.base);
    else for (let i = 0; i < pos.count; i++) this.i.push(i + this.base);
    this.base += pos.count;
    return this;
  }
  get count() { return this.base; }
  build() {
    if (!this.base) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.base > 65000 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const M = () => new THREE.Matrix4();
/** Transform helper: position, Y rotation, scale, optional extra tilt about X. */
function trs(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  const m = M();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  return m;
}

/* ============================================================== textures ==== */

function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return { c, x: c.getContext('2d') };
}
function texFrom(c, { repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}

/**
 * Atlas of banners, road signs and sponsor boards.
 *
 * 16 rows of 1024 x 128 in a 1024 x 2048 canvas. Text is drawn the normal way round here;
 * `panel()` below is responsible for making sure a viewer never sees the mirrored back of a
 * quad (it emits a real front face and a real back face, each with its own correct UVs).
 */
function buildSignAtlas() {
  const W = 1024, H = 2048, cell = 128, ROWS = H / cell;
  const { c, x } = makeCanvas(W, H);
  x.fillStyle = '#20242c'; x.fillRect(0, 0, W, H);
  const font = '"DejaVu Sans","Liberation Sans","FreeSans",sans-serif';

  const row = (i, draw) => { x.save(); x.translate(0, i * cell); x.beginPath(); x.rect(0, 0, W, cell); x.clip(); draw(x); x.restore(); };
  const grad = (ctx, a, b) => { const g = ctx.createLinearGradient(0, 0, 0, cell); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
  const centred = (ctx, he, en, col, size = 62) => {
    ctx.textAlign = 'center'; ctx.fillStyle = col;
    ctx.font = `700 ${size}px ${font}`;
    ctx.fillText(he, W * 0.5, cell * 0.50);
    ctx.font = `600 ${Math.round(size * 0.52)}px ${font}`;
    ctx.fillText(en, W * 0.5, cell * 0.86);
  };
  // a small seated-cat mark, drawn at (cx, cy) with radius r
  const catMark = (ctx, cx, cy, r, col) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.35, r * 0.72, r * 0.62, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy - r * 0.42, r * 0.46, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - r * 0.44, cy - r * 0.62); ctx.lineTo(cx - r * 0.10, cy - r * 0.66); ctx.lineTo(cx - r * 0.36, cy - r * 1.05); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + r * 0.44, cy - r * 0.62); ctx.lineTo(cx + r * 0.10, cy - r * 0.66); ctx.lineTo(cx + r * 0.36, cy - r * 1.05); ctx.closePath(); ctx.fill();
    ctx.lineWidth = r * 0.16; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(cx + r * 0.66, cy + r * 0.62); ctx.quadraticCurveTo(cx + r * 1.15, cy + r * 0.30, cx + r * 0.92, cy - r * 0.34); ctx.stroke();
  };
  const chequerBand = (ctx, y0, h, n) => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = (i & 1) ? '#16171b' : '#f2efe6';
      ctx.fillRect(i * W / n, y0, W / n + 1, h);
    }
  };

  // 0 — start gantry banner
  row(0, ctx => {
    ctx.fillStyle = grad(ctx, '#16457c', '#0a2246'); ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#e9b53a'; ctx.fillRect(0, cell - 9, W, 9); ctx.fillRect(0, 0, W, 6);
    catMark(ctx, 74, cell * 0.52, 34, 'rgba(233,181,58,0.85)');
    catMark(ctx, W - 74, cell * 0.52, 34, 'rgba(233,181,58,0.85)');
    centred(ctx, 'מסלול מושב עמיקם', 'AMIKAM VILLAGE CIRCUIT', '#f6f1e4', 56);
  });
  // 1 — START / FINISH, chequer-edged
  row(1, ctx => {
    ctx.fillStyle = '#f3efe4'; ctx.fillRect(0, 0, W, cell);
    chequerBand(ctx, 0, 24, 32); chequerBand(ctx, cell - 24, 24, 32);
    centred(ctx, 'זינוק · סיום', 'START / FINISH', '#16181c', 52);
  });
  // 2 — lap banner
  row(2, ctx => {
    ctx.fillStyle = grad(ctx, '#9a2027', '#5d1119'); ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#e9b53a'; ctx.fillRect(0, 0, W, 5); ctx.fillRect(0, cell - 5, W, 5);
    centred(ctx, 'הקפה אחרונה', 'FINAL LAP', '#f7e9c9', 58);
  });
  // 3 — sponsor: olive press
  row(3, ctx => {
    ctx.fillStyle = '#2f5b34'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#cfe0b6'; ctx.beginPath(); ctx.ellipse(96, cell / 2, 40, 26, -0.4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8fae70'; ctx.beginPath(); ctx.ellipse(W - 96, cell / 2, 40, 26, 0.4, 0, TAU); ctx.fill();
    centred(ctx, 'בית הבד עמיקם', 'AMIKAM OLIVE PRESS', '#e9f0dc', 50);
  });
  // 4 — sponsor: dairy / cats
  row(4, ctx => {
    ctx.fillStyle = '#2a3b6d'; ctx.fillRect(0, 0, W, cell);
    catMark(ctx, 92, cell * 0.52, 36, '#dfe6f4');
    centred(ctx, 'מחלבת רמות מנשה', 'RAMOT MENASHE DAIRY', '#f0eede', 50);
  });
  // 5 — sponsor: watermelon
  row(5, ctx => {
    ctx.fillStyle = '#b8362f'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#2d6b34'; ctx.beginPath(); ctx.arc(92, cell / 2, 42, 0, TAU); ctx.fill();
    ctx.fillStyle = '#e6584e'; ctx.beginPath(); ctx.arc(92, cell / 2, 32, 0, TAU); ctx.fill();
    centred(ctx, 'אבטיחי העמק', 'VALLEY WATERMELONS', '#fdf1de', 50);
  });
  // 6 — hairpin warning (yellow)
  row(6, ctx => {
    ctx.fillStyle = '#e5b209'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#171612'; ctx.fillRect(0, 0, 10, cell); ctx.fillRect(W - 10, 0, 10, cell);
    centred(ctx, 'סיבוב חד', 'HAIRPIN', '#171612', 58);
  });
  // 7 — blue street sign
  row(7, ctx => {
    ctx.fillStyle = '#123a6b'; ctx.fillRect(0, 0, W, cell);
    ctx.strokeStyle = '#f0eede'; ctx.lineWidth = 6; ctx.strokeRect(10, 10, W - 20, cell - 20);
    centred(ctx, 'רחוב רקפת', 'REHOV RAKEFET', '#f0eede', 52);
  });
  // 8 — 100 m board
  row(8, ctx => {
    ctx.fillStyle = '#f2efe4'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#1b1c20'; ctx.fillRect(0, 0, W, 8); ctx.fillRect(0, cell - 8, W, 8);
    for (let i = 0; i < 3; i++) { ctx.fillStyle = '#8d1f26'; ctx.fillRect(150 + i * 90, 26, 46, cell - 52); }
    ctx.textAlign = 'center'; ctx.fillStyle = '#1b1c20';
    ctx.font = `800 82px ${font}`; ctx.fillText('100', W * 0.62, cell * 0.76);
    ctx.font = `700 40px ${font}`; ctx.fillText('m', W * 0.80, cell * 0.76);
  });
  // 9 — 50 m board
  row(9, ctx => {
    ctx.fillStyle = '#f2efe4'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#1b1c20'; ctx.fillRect(0, 0, W, 8); ctx.fillRect(0, cell - 8, W, 8);
    for (let i = 0; i < 2; i++) { ctx.fillStyle = '#8d1f26'; ctx.fillRect(200 + i * 90, 26, 46, cell - 52); }
    ctx.textAlign = 'center'; ctx.fillStyle = '#1b1c20';
    ctx.font = `800 82px ${font}`; ctx.fillText('50', W * 0.62, cell * 0.76);
    ctx.font = `700 40px ${font}`; ctx.fillText('m', W * 0.78, cell * 0.76);
  });
  // 10 — sponsor: winery
  row(10, ctx => {
    ctx.fillStyle = grad(ctx, '#6d3055', '#431c36'); ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#c9a24a'; ctx.fillRect(0, cell - 7, W, 7);
    centred(ctx, 'יקב רמות מנשה', 'MENASHE HILLS WINERY', '#f0e2d6', 50);
  });
  // 11 — sponsor: tyres
  row(11, ctx => {
    ctx.fillStyle = '#17181c'; ctx.fillRect(0, 0, W, cell);
    ctx.strokeStyle = '#e0a21f'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(96, cell / 2, 38, 0, TAU); ctx.stroke();
    centred(ctx, 'צמיגי עמיקם', 'AMIKAM TYRES', '#f0d99a', 52);
  });
  // 12 — chequered strip (no text) for barrier tops
  row(12, ctx => { chequerBand(ctx, 0, cell * 0.5, 32); chequerBand(ctx, cell * 0.5, cell * 0.5, 32); ctx.fillStyle = '#f2efe6'; for (let i = 0; i < 32; i += 2) ctx.fillRect(i * W / 32, cell * 0.5, W / 32 + 1, cell * 0.5); for (let i = 1; i < 32; i += 2) { ctx.fillStyle = '#16171b'; ctx.fillRect(i * W / 32, cell * 0.5, W / 32 + 1, cell * 0.5); } });
  // 13 — marshal post
  row(13, ctx => {
    ctx.fillStyle = '#e56a12'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#1b1c20'; ctx.fillRect(0, 0, W, 7); ctx.fillRect(0, cell - 7, W, 7);
    centred(ctx, 'עמדת שופט', 'MARSHAL POST', '#1b1c20', 54);
  });
  // 14 — championship banner
  row(14, ctx => {
    ctx.fillStyle = grad(ctx, '#0e6b6e', '#07393f'); ctx.fillRect(0, 0, W, cell);
    catMark(ctx, 80, cell * 0.5, 36, '#f2c94c');
    catMark(ctx, W - 80, cell * 0.5, 36, '#f2c94c');
    centred(ctx, 'אליפות החתולים', 'KAT RACING GRAND PRIX', '#f2efe0', 52);
  });
  // 15 — red/white chevron hazard
  row(15, ctx => {
    ctx.fillStyle = '#f2efe4'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#c1332b';
    for (let i = -1; i < 18; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 64, cell); ctx.lineTo(i * 64 + 34, cell); ctx.lineTo(i * 64 + 34 + cell, 0); ctx.lineTo(i * 64 + cell, 0);
      ctx.closePath(); ctx.fill();
    }
  });
  return { tex: texFrom(c), cell: cell / H, rows: ROWS };
}

/** Vertical feather-flag banners: 4 designs across one 512 x 512 texture. */
function buildFlagTexture() {
  const W = 512, H = 512, cw = W / 4;
  const { c, x } = makeCanvas(W, H);
  const font = '"DejaVu Sans","Liberation Sans","FreeSans",sans-serif';
  const designs = [
    { bg: '#16457c', fg: '#e9b53a', t: 'KAT' },
    { bg: '#9a2027', fg: '#f7e9c9', t: 'GP' },
    { bg: '#2f5b34', fg: '#e9f0dc', t: 'OLIVE' },
    { bg: '#e0a21f', fg: '#2b2417', t: 'AMIKAM' },
  ];
  designs.forEach((d, i) => {
    const x0 = i * cw;
    x.fillStyle = d.bg; x.fillRect(x0, 0, cw, H);
    x.fillStyle = d.fg; x.fillRect(x0 + 6, 8, cw - 12, 6); x.fillRect(x0 + 6, H - 14, cw - 12, 6);
    x.save();
    x.translate(x0 + cw * 0.5, H * 0.5);
    x.textAlign = 'center'; x.fillStyle = d.fg;
    x.font = `800 ${Math.round(cw * 0.44)}px ${font}`;
    const letters = d.t.split('');
    const step = Math.min(cw * 0.56, (H * 0.72) / letters.length);
    letters.forEach((ch, k) => x.fillText(ch, 0, (k - (letters.length - 1) / 2) * step + step * 0.34));
    x.restore();
  });
  return { tex: texFrom(c), cols: 4 };
}

/**
 * Triangular bunting pennants.
 *
 * Clean primaries, not the muddy maroon/olive/navy the review found: the old palette read
 * dull because the strings were also lit with a hard-coded normal, so every pennant that did
 * not happen to face +Z came back near-black. Colours here are authored bright and the mesh
 * supplies real per-string normals.
 */
function buildBuntingTexture() {
  const { c, x } = makeCanvas(384, 128);
  x.clearRect(0, 0, 384, 128);
  const cols = ['#ee3b26', '#ffc21f', '#2f8fe0', '#fbf4e4', '#3fb256', '#ff7a1c'];
  const cw = 384 / 6;
  for (let i = 0; i < 6; i++) {
    x.fillStyle = cols[i];
    x.beginPath();
    x.moveTo(i * cw + 1.5, 6); x.lineTo((i + 1) * cw - 1.5, 6); x.lineTo(i * cw + cw * 0.5, 118);
    x.closePath(); x.fill();
    // a soft crease down the middle of each pennant so the cloth is not one flat fill
    const sh = x.createLinearGradient(i * cw, 0, (i + 1) * cw, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.28)');
    sh.addColorStop(0.40, 'rgba(255,255,255,0.18)');
    sh.addColorStop(0.56, 'rgba(255,255,255,0.08)');
    sh.addColorStop(1, 'rgba(0,0,0,0.32)');
    x.save();
    x.beginPath();
    x.moveTo(i * cw + 1.5, 6); x.lineTo((i + 1) * cw - 1.5, 6); x.lineTo(i * cw + cw * 0.5, 118);
    x.closePath(); x.clip();
    x.fillStyle = sh; x.fillRect(i * cw, 0, cw, 128);
    x.restore();
  }
  x.fillStyle = '#3b332a'; x.fillRect(0, 0, 384, 7);
  const t = texFrom(c, { repeat: true });
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Clean primaries for the crowd's hand flags — they are the brightest specks in the stands. */
const CROWD_FLAGS = [
  [0.90, 0.20, 0.13], [1.00, 0.74, 0.10], [0.16, 0.50, 0.84],
  [0.22, 0.68, 0.32], [0.94, 0.92, 0.86], [0.94, 0.45, 0.10],
];

/* ============================================================ primitives ==== */

const GEO = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }

/** W-beam guard-rail profile, extruded along a run of points. */
function railRun(b, pts, up, col) {
  if (pts.length < 2) return;
  // profile in (lateral, vertical) about the rail centre
  const prof = [[-0.045, -0.30], [0.035, -0.20], [0.035, -0.06], [-0.045, 0.0], [0.035, 0.06], [0.035, 0.20], [-0.045, 0.30]];
  const P = prof.length;
  const start = b.base;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const nx = p.nx, nz = p.nz;
    for (let k = 0; k < P; k++) {
      const [lat, vert] = prof[k];
      b.p.push(p.x + nx * lat, p.y + up + vert, p.z + nz * lat);
      const n = new THREE.Vector3(nx * (k % 2 ? 1 : -0.4), vert > 0.24 || vert < -0.24 ? 0.5 : 0.2, nz * (k % 2 ? 1 : -0.4)).normalize();
      b.n.push(n.x, n.y, n.z);
      b.u.push(k / (P - 1), p.s * 0.4);
      b.c.push(col[0], col[1], col[2]);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < P - 1; k++) {
    const a = start + i * P + k, bb = a + 1, c = start + (i + 1) * P + k, d = c + 1;
    b.i.push(a, c, bb, bb, c, d);
  }
  b.base = start + pts.length * P;
}

/* ============================================================== factory ===== */

export function createFurniture(engine, world, track, opts = {}) {
  const o = Object.assign({
    seed: 424242,
    rails: true, tyres: true, bales: true, crates: true, bunting: true,
    stands: true, gantry: true, signs: true, arches: true, jump: true, grove: true,
    markers: true, barriers: true, marshals: true, village: true,
    shadows: true,
  }, opts);
  const R = rng(o.seed);
  const group = new THREE.Group(); group.name = 'furniture';

  const metal = new Builder(), wood = new Builder(), rubber = new Builder();
  const straw = new Builder(), foliage = new Builder(), fur = new Builder();
  const panels = [];      // textured quads collected into one atlas mesh
  const flagPanels = [];  // vertical feather-flag quads (their own small texture)

  const len = track.length;
  const at = s => track.sample(((s % len) + len) % len);
  const side = (sm, off) => ({
    x: sm.pos.x + sm.normal.x * off,
    y: sm.pos.y + Math.tan(sm.banking) * off,
    z: sm.pos.z + sm.normal.z * off,
  });

  /* --------------------------------------------------------- guard rails --- */
  if (o.rails) {
    const step = 3.0, n = Math.floor(len / step);
    const need = [new Uint8Array(n), new Uint8Array(n)];       // [left, right]
    for (let i = 0; i < n; i++) {
      const sm = at(i * step), hw = sm.width * 0.5;
      for (let k = 0; k < 2; k++) {
        const sgn = k ? 1 : -1;
        const edge = side(sm, sgn * (hw + 1.6));
        const outp = side(sm, sgn * (hw + 9.5));
        const drop = edge.y - world.heightAt(outp.x, outp.z);
        const fast = Math.abs(sm.curvature || 0) > 0.004 && Math.abs(sm.curvature || 0) < 0.020;
        const outside = (sm.curvature || 0) * sgn < 0;
        if (drop > 2.4 || (fast && outside && drop > 0.9)) need[k][i] = 1;
      }
    }
    for (let k = 0; k < 2; k++) {
      const arr = need[k], src = Uint8Array.from(arr);
      for (let i = 0; i < n; i++) { let m = 0; for (let d = -3; d <= 3; d++) m |= src[((i + d) % n + n) % n]; arr[i] = m; }
    }
    const steel = [0.56, 0.57, 0.585], postC = [0.42, 0.43, 0.45];
    for (let k = 0; k < 2; k++) {
      const sgn = k ? 1 : -1;
      let run = [];
      const flush = () => {
        if (run.length > 3) {
          railRun(metal, run, 0.62, steel);
          for (let i = 0; i < run.length; i += 3) {
            const p = run[i];
            metal.add(geo('post', () => new THREE.BoxGeometry(0.13, 1.0, 0.13)),
              trs(p.x, p.y + 0.34, p.z, Math.atan2(p.nx, p.nz)), postC);
          }
        }
        run = [];
      };
      for (let i = 0; i <= n; i++) {
        if (i < n && need[k][i]) {
          const sm = at(i * step), hw = sm.width * 0.5;
          const p = side(sm, sgn * (hw + 1.85));
          run.push({ x: p.x, y: Math.max(p.y, world.heightAt(p.x, p.z) - 0.2), z: p.z,
            nx: sm.normal.x, nz: sm.normal.z, s: sm.s });
        } else flush();
      }
      flush();
    }
  }

  /* --------------------------------------------------------- tyre stacks --- */
  const tyreGeo = () => geo('tyre', () => new THREE.TorusGeometry(0.44, 0.17, 6, 14).rotateX(Math.PI / 2));
  function tyreStack(x, y, z, h, tint) {
    for (let i = 0; i < h; i++) {
      const c = i === h - 1 ? tint : [0.075, 0.072, 0.074];
      rubber.add(tyreGeo(), trs(x, y + 0.22 + i * 0.34, z, R() * TAU), c);
    }
  }
  if (o.tyres) {
    for (const c of track.corners) {
      if (Math.abs(c.angle) < 1.5) continue;              // hairpins and the hardest corners
      const sgn = c.angle > 0 ? -1 : 1;                    // outside of the corner
      const spread = Math.abs(c.angle) > 2.4 ? 16 : 10;
      for (let d = -spread; d <= spread; d += 2.0) {
        const sm = at(c.s + d);
        const hw = sm.width * 0.5;
        const p = side(sm, sgn * (hw + 1.95 + (Math.abs(d) > spread * 0.7 ? 0.5 : 0)));
        const gy = world.heightAt(p.x, p.z);
        const tint = ((d / 2) | 0) % 2 ? [0.62, 0.10, 0.09] : [0.80, 0.78, 0.74];
        tyreStack(p.x, Math.min(p.y, gy + 0.1), p.z, 3, tint);
      }
    }
  }

  /* ------------------------------------------------- hay bales & crates ---- */
  const baleGeo = () => geo('bale', () => new THREE.CylinderGeometry(0.62, 0.62, 1.25, 12, 1).rotateZ(Math.PI / 2));
  const crateGeo = () => geo('crate', () => new THREE.BoxGeometry(0.62, 0.34, 0.44));
  function baleRow(s0, s1, off, count, seedOff) {
    for (let i = 0; i < count; i++) {
      const sm = at(lerp(s0, s1, count === 1 ? 0.5 : i / (count - 1)));
      const p = side(sm, off);
      const gy = world.heightAt(p.x, p.z);
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z) + (R() - 0.5) * 0.2;
      const tint = 0.86 + R() * 0.22;
      straw.add(baleGeo(), trs(p.x, Math.min(p.y, gy + 0.2) + 0.62, p.z, ry),
        [0.66 * tint, 0.575 * tint, 0.315 * tint]);
      void seedOff;
    }
  }
  if (o.bales) {
    // the bale chicane on the Narkis straight, plus the tight village corners
    const chic = track.nearest({ x: 122, z: -390 });
    baleRow(chic.s - 26, chic.s + 4, -7.6, 9);
    baleRow(chic.s + 14, chic.s + 44, 7.6, 9);
    for (const c of track.corners) {
      if (Math.abs(c.angle) < 1.0 || Math.abs(c.angle) > 1.5) continue;
      const sgn = c.angle > 0 ? 1 : -1;                    // inside kerb of the corner
      const sm = at(c.s), hw = sm.width * 0.5;
      baleRow(c.s - 7, c.s + 7, sgn * (hw + 2.3), 5);
    }
  }
  if (o.crates) {
    // olive crates stacked in the village, three high, in rows of four
    const spots = [track.startS - 34, track.startS + 26, track.nearest({ x: 121, z: -25 }).s,
      track.nearest({ x: 208, z: -94 }).s];
    for (let si = 0; si < spots.length; si++) {
      const sgn = si % 2 ? 1 : -1;
      for (let r2 = 0; r2 < 4; r2++) {
        const sm = at(spots[si] + r2 * 0.72);
        const hw = sm.width * 0.5;
        const p = side(sm, sgn * (hw + 2.45));
        const gy = world.heightAt(p.x, p.z);
        const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
        for (let h = 0; h < 3; h++) {
          const t = 0.9 + R() * 0.25;
          wood.add(crateGeo(), trs(p.x, Math.min(p.y, gy + 0.15) + 0.18 + h * 0.35, p.z, ry + (R() - 0.5) * 0.12),
            h === 2 ? [0.30 * t, 0.36 * t, 0.20 * t] : [0.52 * t, 0.38 * t, 0.22 * t]);
        }
      }
    }
  }

  /* -------------------------------------------------------- start gantry --- */
  const atlas = buildSignAtlas();
  const flagTex = buildFlagTexture();
  /**
   * A trackside sign.
   *
   * The old version pushed a single quad and relied on `side: DoubleSide`, so anyone standing
   * behind the sign — which, for the gantry banner and the pit-wall boards, was the whole
   * grid — read the artwork through the back of the plane, i.e. mirrored. Now every sign emits
   * two *real* faces, each with its own correctly-wound UVs, and the material is single sided.
   * `ry` is the yaw of the front face; both faces read the right way round regardless.
   */
  function panel(x, y, z, ry, w, h, rowIdx, rx = 0, opts = {}) {
    // Boards are real objects: 12 cm of frame behind the artwork, so every sign shows an
    // edge and a cast shadow instead of reading as a sticker floating on a pole.
    const t = opts.thickness === undefined ? 0.062 : opts.thickness;
    const face = back => {
      const g = new THREE.PlaneGeometry(w, h);
      if (back) g.rotateY(Math.PI);
      g.translate(0, 0, back ? -t : t);
      const uv = g.attributes.uv;
      const rIdx = back && opts.backRow !== undefined ? opts.backRow : rowIdx;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (rIdx + (1 - uv.getY(i))) * atlas.cell);
      panels.push({ g, m: trs(x, y, z, ry, 1, 1, 1, rx) });
    };
    face(false);
    if (opts.oneSided !== true) face(true);
    if (opts.frame !== false) {
      metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(x, y, z, ry, w * 1.025, h * 1.08, t * 1.9, rx), opts.frameCol || [0.14, 0.15, 0.17]);
    }
  }
  /** Vertical feather flag on a pole; `col` picks one of four designs. */
  function featherFlag(x, gy, z, ry, hgt, col) {
    const w = hgt * 0.30;
    const u0 = col / 4, u1 = (col + 1) / 4;
    for (const back of [false, true]) {
      const g = new THREE.PlaneGeometry(w, hgt);
      if (back) g.rotateY(Math.PI);
      g.translate(w * 0.5 + 0.07, hgt * 0.5 + 0.9, back ? -0.02 : 0.02);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, lerp(u0, u1, uv.getX(i)));
      flagPanels.push({ g, m: trs(x, gy, z, ry) });
    }
    metal.add(geo('flagpole', () => new THREE.CylinderGeometry(0.05, 0.06, 1, 6)),
      trs(x, gy + (hgt + 1.4) * 0.5, z, ry, 1, hgt + 1.4, 1), [0.62, 0.63, 0.66]);
    metal.add(geo('flagfoot', () => new THREE.CylinderGeometry(0.34, 0.40, 0.14, 8)),
      trs(x, gy + 0.07, z, ry), [0.30, 0.31, 0.33]);
  }
  if (o.gantry) {
    const sm = at(track.startS), hw = sm.width * 0.5;
    // the banner faces back down the road, at the karts coming to the line
    const ryFwd = Math.atan2(sm.tangent.x, sm.tangent.z);
    const ry = ryFwd + Math.PI;
    const towerC = [0.74, 0.75, 0.77];
    for (const sgn of [-1, 1]) {
      const p = side(sm, sgn * (hw + 2.2));
      const gy = Math.min(p.y, world.heightAt(p.x, p.z));
      metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(p.x, gy + 4.3, p.z, ry, 0.95, 8.6, 0.95), towerC);
      metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(p.x, gy + 0.22, p.z, ry, 2.1, 0.44, 2.1), [0.48, 0.49, 0.51]);
      // red/white hazard skirt on the tower foot, so the gate reads from far away
      panel(p.x, gy + 1.5, p.z, ry, 1.0, 1.9, 15, 0, { thickness: 0.5, frame: false });
      panel(p.x, gy + 1.5, p.z, ry + Math.PI / 2, 1.0, 1.9, 15, 0, { thickness: 0.5, frame: false });
      for (let i = 1; i < 6; i++)
        metal.add(geo('brace', () => new THREE.BoxGeometry(0.16, 0.16, 2.1)),
          trs(p.x, gy + 1.6 + i * 1.25, p.z, ry), [0.60, 0.61, 0.64]);
      // diagonal truss on the outward face
      for (let i = 0; i < 5; i++)
        metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(p.x, gy + 2.1 + i * 1.25, p.z, ry, 0.10, 1.75, 0.10, 0, (i % 2 ? 1 : -1) * 0.62), [0.58, 0.59, 0.62]);
      // feather flags flanking the gate
      for (const d of [-3.4, 3.4]) {
        const q = { x: p.x + sm.tangent.x * d, z: p.z + sm.tangent.z * d };
        const qy = world.heightAt(q.x, q.z);
        featherFlag(q.x, qy, q.z, ryFwd + (sgn > 0 ? -0.5 : 0.5), 3.1, ((d < 0 ? 0 : 2) + (sgn > 0 ? 1 : 0)) % 4);
      }
    }
    const c0 = side(sm, 0);
    const gy = Math.min(c0.y, world.heightAt(c0.x, c0.z));
    const span = hw * 2 + 5.8;
    metal.add(geo('beam', () => new THREE.BoxGeometry(1.0, 1.0, 1.0)),
      trs(c0.x, gy + 7.55, c0.z, ry, 1.0, 1.0, span), [0.70, 0.71, 0.73]);
    metal.add(geo('beam', () => new THREE.BoxGeometry(1.0, 1.0, 1.0)),
      trs(c0.x, gy + 9.72, c0.z, ry, 0.5, 0.42, span * 0.97), [0.62, 0.63, 0.66]);
    // headline banner + START/FINISH board, both readable from either side
    panel(c0.x, gy + 8.95, c0.z, ry, span * 0.94, 2.1, 0);
    panel(c0.x, gy + 6.32, c0.z, ry, span * 0.94, 1.30, 1);
    // a chequered valance hanging under the beam
    panel(c0.x, gy + 5.45, c0.z, ry, span * 0.94, 0.44, 12, 0, { frame: false, thickness: 0.02 });
    // gantry lights: five bulbs across the beam, F1-style
    for (let i = 0; i < 5; i++) {
      const t = (i - 2) * span * 0.135;
      const lx = c0.x + sm.tangent.x * 0 - sm.normal.x * t, lz = c0.z - sm.normal.z * t;
      metal.add(geo('lightbox', () => new THREE.BoxGeometry(0.62, 0.72, 0.34)),
        trs(lx, gy + 10.25, lz, ry), [0.10, 0.11, 0.12]);
      metal.add(geo('bulb', () => new THREE.SphereGeometry(0.20, 8, 6)),
        trs(lx, gy + 10.25, lz + 0.0, ry, 1, 1, 0.6), [0.62, 0.10, 0.09]);
    }

    // tyre stacks bracketing the crossing
    for (const sgn of [-1, 1]) for (let j = -1; j <= 1; j++) {
      const s2 = at(track.startS + j * 1.35), h2 = s2.width * 0.5;
      const q = side(s2, sgn * (h2 + 4.2));
      const qy = Math.min(q.y, world.heightAt(q.x, q.z));
      tyreStack(q.x, qy, q.z, 3, j === 0 ? [0.82, 0.80, 0.76] : [0.62, 0.10, 0.09]);
    }

    // pit wall: sponsor hoardings both sides of the straight, on a low concrete wall
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const s2 = track.startS - 40 + i * 11.4;
        // leave the crossing itself clear so the chequered walls and the line stay visible
        if (Math.abs(s2 - track.startS) < 7.5) continue;
        const s3 = at(s2), h2 = s3.width * 0.5;
        const p = side(s3, sgn * (h2 + 2.5));
        const g2 = Math.min(p.y, world.heightAt(p.x, p.z));
        const rw = Math.atan2(s3.tangent.x, s3.tangent.z) + (sgn > 0 ? 0 : Math.PI);
        const rows = [3, 4, 5, 10, 11, 14, 3];
        panel(p.x, g2 + 1.02, p.z, rw, 8.8, 1.2, rows[(i + (sgn > 0 ? 3 : 0)) % rows.length], 0,
          { frameCol: [0.55, 0.53, 0.50] });
        // concrete plinth under the board
        wood.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(p.x, g2 + 0.21, p.z, rw, 8.9, 0.42, 0.5), [0.68, 0.66, 0.60]);
        for (const d of [-4.1, 4.1])
          metal.add(geo('boardpost2', () => new THREE.BoxGeometry(0.11, 1.5, 0.11)),
            trs(p.x + s3.tangent.x * d, g2 + 0.76, p.z + s3.tangent.z * d, rw), [0.70, 0.71, 0.73]);
        // light capping rail along the top of the hoarding
        metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(p.x, g2 + 1.70, p.z, rw, 9.0, 0.10, 0.20), [0.78, 0.78, 0.79]);
        // A packed row of cats leaning over the hoarding. They stand on a real timber viewing
        // step behind the board — the old version parked them in mid-air with nothing under
        // them, which is what made the crowd read as floating pawns.
        const stepX = p.x + s3.normal.x * sgn * 0.95, stepZ = p.z + s3.normal.z * sgn * 0.95;
        const stepY = Math.min(g2, world.heightAt(stepX, stepZ));
        wood.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(stepX, stepY + 0.36, stepZ, rw, 8.6, 0.72, 0.9), [0.54, 0.45, 0.33]);
        for (let k = 0; k < 10; k++) {
          if (R() > 0.86) continue;
          const d = (k - 4.5) * 0.90 + (R() - 0.5) * 0.22;
          const bx = stepX + s3.tangent.x * d, bz = stepZ + s3.tangent.z * d;
          catAt(fur, bx, stepY + 0.72, bz, rw + Math.PI + (R() - 0.5) * 0.4, 0.92 + R() * 0.22, R);
        }
      }
    }
  }

  /* ------------------------------------------------------ checkpoint arch -- */
  if (o.arches) {
    for (const f of [0.34, 0.67]) {
      const s = track.startS + f * len, sm = at(s), hw = sm.width * 0.5;
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
      for (const sgn of [-1, 1]) {
        const p = side(sm, sgn * (hw + 1.9));
        const gy = Math.min(p.y, world.heightAt(p.x, p.z));
        metal.add(geo('archleg', () => new THREE.CylinderGeometry(0.34, 0.42, 6.0, 8)),
          trs(p.x, gy + 3.0, p.z, ry), [0.78, 0.30, 0.24]);
      }
      const c0 = side(sm, 0), gy = Math.min(c0.y, world.heightAt(c0.x, c0.z));
      const span = hw * 2 + 3.6;
      metal.add(geo('archtop', () => new THREE.CylinderGeometry(0.34, 0.34, 1, 8).rotateX(Math.PI / 2)),
        trs(c0.x, gy + 5.9, c0.z, ry, 1, 1, span), [0.78, 0.30, 0.24]);
      panel(c0.x, gy + 6.7, c0.z, ry, span * 0.9, 1.2, 2);
    }
  }

  /* -------------------------------------------------------------- signs --- */
  if (o.signs) {
    const marks = [
      { s: track.startS + 0.02 * len, row: 7 },
      { s: track.startS + 0.245 * len, row: 6 },
      { s: track.startS + 0.395 * len, row: 6 },
      { s: track.startS + 0.52 * len, row: 6 },
      { s: track.startS + 0.735 * len, row: 5 },
      { s: track.startS + 0.88 * len, row: 4 },
    ];
    for (const mk of marks) {
      const sm = at(mk.s), hw = sm.width * 0.5;
      const sgn = (sm.curvature || 0) > 0 ? -1 : 1;
      const p = side(sm, sgn * (hw + 3.0));
      const gy = Math.min(p.y, world.heightAt(p.x, p.z));
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI + sgn * 0.35;
      metal.add(geo('signpost', () => new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6)),
        trs(p.x, gy + 1.3, p.z, 0), [0.55, 0.56, 0.58]);
      panel(p.x, gy + 2.25, p.z, ry, 2.9, 0.44, mk.row);
    }
  }

  /* ------------------------------------------------- distance markers ----- */
  if (o.markers) {
    const hard = track.corners.slice().sort((a, b2) => Math.abs(b2.angle) - Math.abs(a.angle)).slice(0, 5);
    for (const c of hard) {
      const sgn = c.angle > 0 ? -1 : 1;                  // outside of the corner
      for (const [d, rowIdx] of [[100, 8], [50, 9]]) {
        const sm = at(c.s - d), hw = sm.width * 0.5;
        const p = side(sm, sgn * (hw + 2.6));
        const gy = Math.min(p.y, world.heightAt(p.x, p.z));
        const ry = Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI + sgn * 0.30;
        panel(p.x, gy + 1.62, p.z, ry, 2.3, 0.95, rowIdx, 0, { frameCol: [0.30, 0.31, 0.33] });
        for (const t of [-0.95, 0.95])
          metal.add(geo('markpost', () => new THREE.CylinderGeometry(0.06, 0.06, 1.9, 6)),
            trs(p.x + Math.cos(ry) * t, gy + 0.95, p.z - Math.sin(ry) * t, 0), [0.52, 0.53, 0.55]);
      }
    }
  }

  /* ---------------------------------------------------- crowd barriers ---- */
  if (o.barriers) {
    // outside the pit-wall boards on the start straight, and around the two grandstands
    const runs = [
      { s0: track.startS - 62, s1: track.startS - 36, sgn: -1 },
      { s0: track.startS + 40, s1: track.startS + 76, sgn: -1 },
      { s0: track.startS - 62, s1: track.startS - 22, sgn: 1 },
      { s0: track.startS + 44, s1: track.startS + 84, sgn: 1 },
      { s0: track.startS + 0.375 * len - 22, s1: track.startS + 0.375 * len + 22, sgn: -1 },
    ];
    for (const r of runs) {
      const n = Math.max(2, Math.round((r.s1 - r.s0) / 2.4));
      for (let i = 0; i < n; i++) {
        const sm = at(lerp(r.s0, r.s1, (i + 0.5) / n)), hw = sm.width * 0.5;
        const p = side(sm, r.sgn * (hw + 4.2));
        const gy = Math.min(p.y, world.heightAt(p.x, p.z));
        const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
        // frame: two uprights, top and bottom rail, four verticals
        for (const t of [-1.1, 1.1])
          metal.add(geo('barpost', () => new THREE.BoxGeometry(0.07, 1.15, 0.07)),
            trs(p.x + sm.tangent.x * t, gy + 0.58, p.z + sm.tangent.z * t, ry), [0.66, 0.67, 0.69]);
        for (const h of [1.08, 0.12])
          metal.add(geo('barrail', () => new THREE.BoxGeometry(1, 1, 1)),
            trs(p.x, gy + h, p.z, ry, 0.06, 0.07, 2.3), [0.66, 0.67, 0.69]);
        for (const t of [-0.55, 0, 0.55])
          metal.add(geo('barvert', () => new THREE.BoxGeometry(0.045, 0.98, 0.045)),
            trs(p.x + sm.tangent.x * t, gy + 0.6, p.z + sm.tangent.z * t, ry), [0.60, 0.61, 0.63]);
        // every third bay carries a small sponsor skirt
        if (i % 3 === 1)
          panel(p.x, gy + 0.60, p.z, ry + (r.sgn > 0 ? 0 : Math.PI), 2.2, 0.86, [3, 5, 11, 10][i % 4], 0,
            { frame: false, thickness: 0.03 });
      }
    }
  }

  /* -------------------------------------------------------- marshal posts -- */
  if (o.marshals) {
    const hard = track.corners.slice().sort((a, b2) => Math.abs(b2.angle) - Math.abs(a.angle)).slice(0, 6);
    for (let ci = 0; ci < hard.length; ci++) {
      const c = hard[ci];
      const sgn = c.angle > 0 ? -1 : 1;
      const sm = at(c.s + 12), hw = sm.width * 0.5;
      const p = side(sm, sgn * (hw + 6.5));
      const gy = Math.min(p.y, world.heightAt(p.x, p.z));
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
      // raised deck
      wood.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(p.x, gy + 0.62, p.z, ry, 2.4, 0.16, 2.4), [0.58, 0.50, 0.38]);
      for (const dx of [-1.0, 1.0]) for (const dz of [-1.0, 1.0])
        wood.add(geo('deckleg', () => new THREE.BoxGeometry(0.14, 0.62, 0.14)),
          trs(p.x + sm.tangent.x * dz - sm.normal.x * dx, gy + 0.31, p.z + sm.tangent.z * dz - sm.normal.z * dx, ry),
          [0.42, 0.34, 0.24]);
      // railing on the track side
      metal.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(p.x - sm.normal.x * sgn * 1.15, gy + 1.35, p.z - sm.normal.z * sgn * 1.15, ry, 0.06, 0.06, 2.4), [0.70, 0.71, 0.73]);
      // orange marshal board on the front rail
      panel(p.x - sm.normal.x * sgn * 1.2, gy + 1.02, p.z - sm.normal.z * sgn * 1.2,
        ry + (sgn > 0 ? Math.PI : 0), 2.3, 0.52, 13, 0, { frame: false, thickness: 0.03 });
      // two marshal cats on the deck
      for (const dz of [-0.55, 0.55])
        catAt(fur, p.x + sm.tangent.x * dz, gy + 0.70, p.z + sm.tangent.z * dz,
          ry + (sgn > 0 ? Math.PI * 0.5 : -Math.PI * 0.5), 1.0, R);
      // feather flag beside the post
      featherFlag(p.x + sm.normal.x * sgn * 1.9, world.heightAt(p.x + sm.normal.x * sgn * 1.9, p.z + sm.normal.z * sgn * 1.9),
        p.z + sm.normal.z * sgn * 1.9, ry + 0.6, 2.8, ci % 4);
    }
  }

  /* --------------------------------------------- village-edge dressing ---- */
  if (o.village) {
    const cyp = geo('cypress', () => new THREE.ConeGeometry(1, 1, 7));
    const drum = geo('drum', () => new THREE.CylinderGeometry(0.42, 0.42, 0.88, 10));
    const tank = geo('tank', () => new THREE.CylinderGeometry(0.85, 0.85, 1.7, 12));
    const stack = [track.startS - 78, track.startS + 96, track.startS + 0.19 * len, track.startS + 0.62 * len];
    for (let k = 0; k < stack.length; k++) {
      const base = stack[k];
      // a cypress line running away from the road
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < 7; i++) {
          const sm = at(base + i * 6.4), hw = sm.width * 0.5;
          const p = side(sm, sgn * (hw + 10.0 + (R() - 0.5) * 1.6));
          const gy = world.heightAt(p.x, p.z);
          const h = 6.2 + R() * 3.4, w = 0.95 + R() * 0.3;
          const tint = 0.85 + R() * 0.3;
          wood.add(geo('cyptrunk', () => new THREE.CylinderGeometry(0.14, 0.20, 1, 5)),
            trs(p.x, gy + 0.5, p.z, 0, 1, 1.0, 1), [0.31, 0.26, 0.20]);
          foliage.add(cyp, trs(p.x, gy + h * 0.5 + 0.4, p.z, R() * TAU, w, h, w),
            [0.135 * tint, 0.225 * tint, 0.135 * tint]);
        }
      }
      // water tanks and olive drums on the verge
      const sm = at(base + 18), hw = sm.width * 0.5;
      const sgn = k % 2 ? 1 : -1;
      const p = side(sm, sgn * (hw + 6.2));
      const gy = world.heightAt(p.x, p.z);
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
      metal.add(tank, trs(p.x, gy + 0.85, p.z, ry), [0.80, 0.79, 0.75]);
      metal.add(geo('tankband', () => new THREE.CylinderGeometry(0.88, 0.88, 0.12, 12)),
        trs(p.x, gy + 1.35, p.z, ry), [0.55, 0.56, 0.58]);
      wood.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(p.x, gy + 0.06, p.z, ry, 2.2, 0.12, 2.2), [0.62, 0.60, 0.55]);
      for (let i = 0; i < 4; i++) {
        const q = { x: p.x + sm.tangent.x * (2.4 + i * 1.0) + sm.normal.x * (R() - 0.5),
          z: p.z + sm.tangent.z * (2.4 + i * 1.0) + sm.normal.z * (R() - 0.5) };
        const qy = world.heightAt(q.x, q.z);
        metal.add(drum, trs(q.x, qy + 0.44, q.z, R() * TAU),
          i % 2 ? [0.20, 0.34, 0.22] : [0.60, 0.30, 0.16]);
      }
      // olive-harvest netting spread out under the trees
      for (let i = 0; i < 3; i++) {
        const q = { x: p.x + sm.tangent.x * (-4 - i * 5) + sm.normal.x * sgn * 4.2,
          z: p.z + sm.tangent.z * (-4 - i * 5) + sm.normal.z * sgn * 4.2 };
        const qy = world.heightAt(q.x, q.z);
        straw.add(geo('unitbox', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(q.x, qy + 0.04, q.z, ry + (R() - 0.5) * 0.5, 4.2, 0.06, 3.4), [0.52, 0.44, 0.22]);
      }
    }
  }

  /* ------------------------------------------------------------ bunting --- */
  let buntingMat = null;
  if (o.bunting) {
    const tex = buildBuntingTexture();
    const gs = [];
    // Alternating heights: two strings seen down the straight used to superimpose into one
    // muddy band. Staggering them by 0.9 m separates them at every camera angle.
    for (let k = 0; k < 6; k++) {
      const s = track.startS - 46 + k * 17;
      const sm = at(s), hw = sm.width * 0.5;
      const a = side(sm, -(hw + 2.6)), b = side(sm, hw + 2.6);
      const top = 5.3 + (k & 1) * 0.9;
      const ay = Math.min(a.y, world.heightAt(a.x, a.z)) + top;
      const by = Math.min(b.y, world.heightAt(b.x, b.z)) + top;
      const spanLen = Math.hypot(b.x - a.x, b.z - a.z);
      // real string normal: horizontal, perpendicular to the run (i.e. along the road)
      const nx = (b.z - a.z) / (spanLen || 1), nz = -(b.x - a.x) / (spanLen || 1);
      const reps = Math.max(2, Math.round(spanLen / (0.58 * 6)));
      const segs = 20, sag = 1.35, drop = 0.62;
      const pos = [], uv = [], idx = [], nor = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
        const y = lerp(ay, by, t) - Math.sin(t * Math.PI) * sag;
        // gentle twist along the string so the pennants catch the light differently
        const tw = Math.sin(t * Math.PI * 3.1 + k) * 0.30;
        const cy = Math.cos(tw), cs = Math.sin(tw);
        const n = new THREE.Vector3(nx * cy, cs, nz * cy).normalize();
        pos.push(x, y, z, x, y - drop, z);
        uv.push(t * reps, 1, t * reps, 0);
        nor.push(n.x, n.y, n.z, n.x, n.y, n.z);
      }
      for (let i = 0; i < segs; i++) {
        const q = i * 2;
        idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      gs.push(g);
      // poles
      for (const p of [a, b]) {
        const gy = Math.min(p.y, world.heightAt(p.x, p.z));
        wood.add(geo('pole', () => new THREE.CylinderGeometry(0.09, 0.12, 5.6, 6)),
          trs(p.x, gy + 2.8, p.z, 0), [0.44, 0.34, 0.24]);
      }
    }
    const merged = mergeSimple(gs);
    if (merged) {
      // A touch of self-illumination keeps the primaries clean when a string is backlit, and
      // a vertex-shader wind term gives the cloth motion instead of dead flat triangles.
      buntingMat = new THREE.MeshStandardMaterial({
        map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.30,
        transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.88, metalness: 0,
      });
      buntingMat.userData.time = { value: 0 };
      buntingMat.onBeforeCompile = (sh) => {
        sh.uniforms.uWind = buntingMat.userData.time;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uWind;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float hang = 1.0 - uv.y;
  float w = sin(uWind * 2.3 + wp.x * 0.55 + wp.z * 0.42) * 0.5
          + sin(uWind * 3.7 + wp.x * 1.30) * 0.22;
  transformed += normal * w * hang * 0.26;
  transformed.y -= abs(w) * hang * 0.05; }`);
      };
      const buntingMesh = new THREE.Mesh(merged, buntingMat);
      buntingMesh.name = 'furniture:bunting';
      buntingMesh.frustumCulled = false;
      group.add(buntingMesh);
    }
  }

  /* ------------------------------------------------- spectator stands ------ */
  if (o.stands) {
    const spots = [
      { s: track.startS - 14, sgn: 1, rows: 5, w: 22 },
      { s: track.startS + 30, sgn: -1, rows: 4, w: 16 },
      { s: track.startS + 0.375 * len, sgn: -1, rows: 4, w: 18 },
      { s: track.startS + 0.535 * len, sgn: 1, rows: 3, w: 14 },
    ];
    for (const sp of spots) {
      const sm = at(sp.s), hw = sm.width * 0.5;
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
      const p = side(sm, sp.sgn * (hw + 5.0));
      const gy = Math.min(p.y, world.heightAt(p.x, p.z));
      const outward = { x: sm.normal.x * sp.sgn, z: sm.normal.z * sp.sgn };
      for (let r2 = 0; r2 < sp.rows; r2++) {
        const d = r2 * 1.25, h = 0.55 + r2 * 0.62;
        const cx = p.x + outward.x * d, cz = p.z + outward.z * d;
        wood.add(geo('step', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(cx, gy + h * 0.5, cz, ry, 1.25, h, sp.w), [0.60, 0.53, 0.42]);
        wood.add(geo('bench', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(cx, gy + h + 0.06, cz, ry, 1.15, 0.12, sp.w * 0.97), [0.42, 0.30, 0.20]);
        // Cats in the crowd. The old spacing put one cat every 2.6 m and then skipped a
        // third of them, which is why the stands photographed as bare benches. A packed
        // bench is ~0.8 m per spectator, so every row now actually fills up.
        const nCats = Math.max(3, Math.round(sp.w / 0.95));
        for (let i = 0; i < nCats; i++) {
          if (R() > 0.90) continue;                       // the odd gap on the bench
          const t = (i + 0.5) / nCats - 0.5 + (R() - 0.5) * 0.012;
          const jitter = (R() - 0.5) * 0.30;
          const tx = cx + sm.tangent.x * t * sp.w + outward.x * jitter;
          const tz = cz + sm.tangent.z * t * sp.w + outward.z * jitter;
          const face = ry + Math.PI + (R() - 0.5) * 0.5;
          catAt(fur, tx, gy + h + 0.1, tz, face, 0.82 + R() * 0.34, R);
          // one in five is waving a bright pennant on a stick
          if (R() < 0.20) {
            const fx = tx - Math.sin(face) * 0.22, fz = tz - Math.cos(face) * 0.22;
            wood.add(geo('wavestick', () => new THREE.BoxGeometry(0.035, 0.62, 0.035)),
              trs(fx, gy + h + 0.72, fz, face, 1, 1, 1, 0, (R() - 0.5) * 0.7), [0.52, 0.42, 0.30]);
            const fc = CROWD_FLAGS[(R() * CROWD_FLAGS.length) | 0];
            fur.add(geo('waveflag', () => new THREE.BoxGeometry(0.30, 0.22, 0.02)),
              trs(fx + Math.cos(face) * 0.16, gy + h + 1.02, fz - Math.sin(face) * 0.16,
                face, 1, 1, 1, 0, (R() - 0.5) * 0.9), fc);
          }
        }
      }
      // canopy
      const cx = p.x + outward.x * (sp.rows * 0.62), cz = p.z + outward.z * (sp.rows * 0.62);
      for (const t of [-0.45, 0.45]) {
        metal.add(geo('canopypost', () => new THREE.CylinderGeometry(0.08, 0.08, 4.4, 6)),
          trs(cx + sm.tangent.x * t * sp.w, gy + 2.2 + sp.rows * 0.3, cz + sm.tangent.z * t * sp.w, 0), [0.5, 0.5, 0.52]);
      }
      wood.add(geo('canopy', () => new THREE.BoxGeometry(1, 1, 1)),
        trs(cx, gy + 4.4 + sp.rows * 0.3, cz, ry, 4.2, 0.12, sp.w * 1.02, -0.12), [0.74, 0.30, 0.24]);
    }
  }

  /* ---------------------------------------------------------- jump ramp ---- */
  if (o.jump && track.jump && track.jump.active) {
    const j = track.jump;
    const build = (s0, s1, sgn) => {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const sm = at(lerp(s0, s1, i / n)), hw = sm.width * 0.5;
        const p = side(sm, sgn * (hw + 0.35));
        const gy = world.heightAt(p.x, p.z);
        const h = Math.max(0.25, p.y - gy);
        wood.add(geo('rampside', () => new THREE.BoxGeometry(1, 1, 1)),
          trs(p.x, gy + h * 0.5, p.z, Math.atan2(sm.tangent.x, sm.tangent.z), 0.34, h, (s1 - s0) / n * 1.2),
          [0.47, 0.34, 0.22]);
      }
    };
    build(j.kickerS, j.lipS + 3.4, -1); build(j.kickerS, j.lipS + 3.4, 1);
    build(j.landS, j.landEndS, -1); build(j.landS, j.landEndS, 1);
    // chevron boards on the lip
    const sm = at(j.lipS), hw = sm.width * 0.5;
    for (const sgn of [-1, 1]) {
      const p = side(sm, sgn * (hw + 1.95));
      const gy = world.heightAt(p.x, p.z);
      panel(p.x, gy + 1.5, p.z, Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI, 2.2, 0.5, 6);
      metal.add(geo('signpost', () => new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6)), trs(p.x, gy + 0.9, p.z, 0), [0.55, 0.56, 0.58]);
    }
  }

  /* ------------------------------------------------ orchard for the cut ---- */
  if (o.grove && track.shortcuts && track.shortcuts.length) {
    const sc = track.shortcuts[0];
    const pts = sc.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b2 = pts[i + 1];
      const L = Math.hypot(b2.x - a.x, b2.z - a.z);
      const tx = (b2.x - a.x) / L, tz = (b2.z - a.z) / L;
      const nx = tz, nz = -tx;
      const rowsN = Math.max(1, Math.round(L / 7));
      for (let k = 0; k < rowsN; k++) {
        const t = (k + 0.5) / rowsN;
        for (const sgn of [-1, 1]) for (let c = 0; c < 3; c++) {
          const off = sgn * (sc.width * 0.5 + 3.4 + c * 6.5) + (R() - 0.5) * 1.6;
          const x = lerp(a.x, b2.x, t) + nx * off + (R() - 0.5) * 1.4;
          const z = lerp(a.z, b2.z, t) + nz * off + (R() - 0.5) * 1.4;
          oliveAt(wood, foliage, x, world.heightAt(x, z), z, 0.85 + R() * 0.4, R);
        }
      }
    }
  }

  /* ------------------------------------------------------------- meshes --- */
  const mk = (b, name, mat) => {
    const g = b.build(); if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.name = 'furniture:' + name;
    m.castShadow = o.shadows; m.receiveShadow = o.shadows;
    group.add(m); return m;
  };
  mk(metal, 'metal', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.44, metalness: 0.62 }));
  mk(wood, 'wood', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0 }));
  mk(rubber, 'rubber', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.0 }));
  mk(straw, 'straw', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }));
  mk(foliage, 'foliage', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0, flatShading: true }));
  mk(fur, 'cats', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.80, metalness: 0.0, flatShading: true }));

  if (panels.length) {
    const pb = new Builder();
    for (const p of panels) pb.add(p.g, p.m, [1, 1, 1]);
    const g = pb.build();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: atlas.tex, vertexColors: true, roughness: 0.72, metalness: 0.0, side: THREE.FrontSide,
    }));
    mesh.name = 'furniture:signs';
    mesh.castShadow = o.shadows; mesh.receiveShadow = o.shadows;
    group.add(mesh);
    for (const p of panels) p.g.dispose();
  }

  if (flagPanels.length) {
    const fb = new Builder();
    for (const p of flagPanels) fb.add(p.g, p.m, [1, 1, 1]);
    const g = fb.build();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: flagTex.tex, vertexColors: true, roughness: 0.8, metalness: 0.0, side: THREE.FrontSide,
    }));
    mesh.name = 'furniture:flags';
    mesh.castShadow = o.shadows; mesh.receiveShadow = o.shadows;
    group.add(mesh);
    for (const p of flagPanels) p.g.dispose();
  }

  const api = {
    group,
    update(dt, elapsed) {
      if (buntingMat) buntingMat.userData.time.value = elapsed ?? (buntingMat.userData.time.value + (dt || 0));
    },
    dispose() { group.traverse(n => n.geometry?.dispose?.()); },
  };
  return api;
}

/* ============================================================== props ======= */

/**
 * A very low-poly sitting cat: body, head, ears, muzzle, tail and a bright supporter scarf.
 *
 * The scarf and the wider coat range exist because the old five-coat, scarfless version
 * photographed as a row of identical pale capsules — "chess pawns" in the review. A dab of
 * saturated colour per spectator is what makes a stand read as a crowd from 40 m.
 */
function catAt(b, x, y, z, ry, sc, R) {
  const coats = [
    [0.86, 0.62, 0.34], [0.26, 0.24, 0.24], [0.90, 0.87, 0.82], [0.58, 0.36, 0.19],
    [0.60, 0.58, 0.57], [0.78, 0.70, 0.55], [0.42, 0.32, 0.26], [0.94, 0.80, 0.55],
  ];
  const scarves = [
    [0.86, 0.16, 0.11], [0.98, 0.68, 0.08], [0.12, 0.42, 0.78],
    [0.16, 0.60, 0.27], [0.92, 0.90, 0.84], [0.90, 0.38, 0.07], [0.55, 0.22, 0.66],
  ];
  const base = coats[(R() * coats.length) | 0];
  const shade = 0.86 + R() * 0.30;
  const c = [clamp(base[0] * shade, 0, 1), clamp(base[1] * shade, 0, 1), clamp(base[2] * shade, 0, 1)];
  const dark = [c[0] * 0.62, c[1] * 0.60, c[2] * 0.58];
  const sk = scarves[(R() * scarves.length) | 0];
  // Kept deliberately cheap — there are several hundred of these in one merged mesh.
  const body = geo('catbody', () => new THREE.SphereGeometry(0.24, 5, 4).scale(0.85, 1.15, 0.75));
  const head = geo('cathead', () => new THREE.SphereGeometry(0.15, 5, 4));
  const ear = geo('catear', () => new THREE.ConeGeometry(0.06, 0.13, 4));
  const tail = geo('cattail', () => new THREE.CylinderGeometry(0.03, 0.045, 0.42, 4));
  const muzzle = geo('catmuzzle', () => new THREE.SphereGeometry(0.075, 4, 3).scale(1, 0.8, 0.9));
  const scarf = geo('catscarf', () => new THREE.CylinderGeometry(0.155, 0.155, 0.085, 6));
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  b.add(body, trs(x, y + 0.26 * sc, z, ry, sc, sc, sc), c);
  b.add(scarf, trs(x, y + 0.415 * sc, z, ry, sc, sc, sc), sk);
  b.add(head, trs(x + fx * 0.05 * sc, y + 0.52 * sc, z + fz * 0.05 * sc, ry, sc, sc, sc), c);
  b.add(muzzle, trs(x + fx * 0.16 * sc, y + 0.50 * sc, z + fz * 0.16 * sc, ry, sc, sc, sc),
    [0.94 * shade, 0.90 * shade, 0.84 * shade]);
  for (const s of [-1, 1])
    b.add(ear, trs(x + Math.cos(ry) * 0.08 * s * sc, y + 0.63 * sc, z - Math.sin(ry) * 0.08 * s * sc, ry, sc, sc, sc), dark);
  b.add(tail, trs(x - fx * 0.22 * sc, y + 0.22 * sc, z - fz * 0.22 * sc, ry, sc, sc, sc, 0.7), dark);
}

/** Low-poly olive tree: gnarled trunk plus two silvery crowns. */
function oliveAt(wood, foliage, x, y, z, sc, R) {
  const trunk = geo('olivetrunk', () => new THREE.CylinderGeometry(0.16, 0.30, 1.5, 6));
  const crown = geo('olivecrown', () => new THREE.IcosahedronGeometry(1.0, 0));
  wood.add(trunk, trs(x, y + 0.75 * sc, z, R() * TAU, sc, sc, sc), [0.36, 0.31, 0.25]);
  const t = 0.9 + R() * 0.25;
  foliage.add(crown, trs(x, y + 2.0 * sc, z, R() * TAU, 1.35 * sc, 1.05 * sc, 1.3 * sc),
    [0.32 * t, 0.375 * t, 0.245 * t]);
  foliage.add(crown, trs(x + (R() - 0.5) * 0.9 * sc, y + 2.75 * sc, z + (R() - 0.5) * 0.9 * sc, R() * TAU,
    0.95 * sc, 0.8 * sc, 0.95 * sc), [0.39 * t, 0.435 * t, 0.30 * t]);
}

/** Merge geometries that carry position/normal/uv + index (no colour attribute). */
function mergeSimple(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = nv > 65000 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += g.attributes.position.count; io += ix.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export default createFurniture;
