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

/** Atlas of banners, road signs and sponsor boards. Rows of 1024 x 128 cells. */
function buildSignAtlas() {
  const W = 1024, H = 1024, cell = 128;
  const { c, x } = makeCanvas(W, H);
  x.fillStyle = '#20242c'; x.fillRect(0, 0, W, H);
  const rows = [];
  const font = '"DejaVu Sans","Liberation Sans","FreeSans",sans-serif';

  const row = (i, draw) => { x.save(); x.translate(0, i * cell); x.beginPath(); x.rect(0, 0, W, cell); x.clip(); draw(x); x.restore(); rows.push(i); };
  const grad = (ctx, a, b) => { const g = ctx.createLinearGradient(0, 0, 0, cell); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
  const centred = (ctx, he, en, col, size = 62) => {
    ctx.textAlign = 'center'; ctx.fillStyle = col;
    ctx.font = `700 ${size}px ${font}`;
    ctx.fillText(he, W * 0.5, cell * 0.50);
    ctx.font = `600 ${Math.round(size * 0.52)}px ${font}`;
    ctx.fillText(en, W * 0.5, cell * 0.86);
  };

  // 0 — start gantry banner
  row(0, ctx => {
    ctx.fillStyle = grad(ctx, '#123a6b', '#0a2244'); ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#e9b53a'; ctx.fillRect(0, cell - 9, W, 9); ctx.fillRect(0, 0, W, 6);
    centred(ctx, 'מסלול מושב עמיקם', 'AMIKAM VILLAGE CIRCUIT', '#f4efe2', 58);
  });
  // 1 — START / FINISH
  row(1, ctx => {
    ctx.fillStyle = '#f3efe4'; ctx.fillRect(0, 0, W, cell);
    for (let i = 0; i < 16; i++) { ctx.fillStyle = (i & 1) ? '#191a1e' : '#f3efe4'; ctx.fillRect(i * W / 16, 0, W / 16, 22); ctx.fillRect(i * W / 16, cell - 22, W / 16, 22); }
    centred(ctx, 'זינוק · סיום', 'START / FINISH', '#16181c', 52);
  });
  // 2 — lap banner
  row(2, ctx => {
    ctx.fillStyle = grad(ctx, '#8d1f26', '#5d1119'); ctx.fillRect(0, 0, W, cell);
    centred(ctx, 'הקפה אחרונה', 'FINAL LAP', '#f7e9c9', 58);
  });
  // 3 — sponsor: olive press
  row(3, ctx => {
    ctx.fillStyle = '#2f5b34'; ctx.fillRect(0, 0, W, cell);
    ctx.fillStyle = '#cfe0b6'; ctx.beginPath(); ctx.ellipse(96, cell / 2, 40, 26, -0.4, 0, TAU); ctx.fill();
    centred(ctx, 'בית הבד עמיקם', 'AMIKAM OLIVE PRESS', '#e9f0dc', 52);
  });
  // 4 — sponsor: dairy / cats
  row(4, ctx => {
    ctx.fillStyle = '#2a3b6d'; ctx.fillRect(0, 0, W, cell);
    centred(ctx, 'מחלבת רמות מנשה', 'RAMOT MENASHE DAIRY', '#f0eede', 52);
  });
  // 5 — sponsor: watermelon
  row(5, ctx => {
    ctx.fillStyle = '#b8362f'; ctx.fillRect(0, 0, W, cell);
    centred(ctx, 'אבטיחי העמק', 'VALLEY WATERMELONS', '#fdf1de', 52);
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
  return { tex: texFrom(c), cell: cell / H, rows: 8 };
}

/** Triangular bunting pennants, alternating colours. */
function buildBuntingTexture() {
  const { c, x } = makeCanvas(256, 128);
  x.clearRect(0, 0, 256, 128);
  const cols = ['#d9432f', '#e9b53a', '#2a6fb0', '#e8e2d2', '#3d8b4a', '#c8642a'];
  for (let i = 0; i < 6; i++) {
    x.fillStyle = cols[i];
    x.beginPath();
    x.moveTo(i * 42.6, 0); x.lineTo((i + 1) * 42.6, 0); x.lineTo(i * 42.6 + 21.3, 118);
    x.closePath(); x.fill();
  }
  x.fillStyle = '#4a4238'; x.fillRect(0, 0, 256, 6);
  const t = texFrom(c, { repeat: true });
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

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
    shadows: true,
  }, opts);
  const R = rng(o.seed);
  const group = new THREE.Group(); group.name = 'furniture';

  const metal = new Builder(), wood = new Builder(), rubber = new Builder();
  const straw = new Builder(), foliage = new Builder(), fur = new Builder();
  const panels = [];   // textured quads collected into one atlas mesh

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
          const p = side(sm, sgn * (hw + 1.35));
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
        const p = side(sm, sgn * (hw + 1.5 + (Math.abs(d) > spread * 0.7 ? 0.5 : 0)));
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
      baleRow(c.s - 7, c.s + 7, sgn * (hw + 1.9), 5);
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
        const p = side(sm, sgn * (hw + 2.1));
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
  function panel(x, y, z, ry, w, h, rowIdx, rx = 0) {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setY(i, 1 - (rowIdx + (1 - uv.getY(i))) * atlas.cell);
    }
    panels.push({ g, m: trs(x, y, z, ry, 1, 1, 1, rx) });
  }
  if (o.gantry) {
    const sm = at(track.startS), hw = sm.width * 0.5;
    const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
    const towerC = [0.72, 0.73, 0.75];
    for (const sgn of [-1, 1]) {
      const p = side(sm, sgn * (hw + 2.0));
      const gy = Math.min(p.y, world.heightAt(p.x, p.z));
      metal.add(geo('tower', () => new THREE.BoxGeometry(0.85, 8.0, 0.85)), trs(p.x, gy + 4.0, p.z, ry), towerC);
      metal.add(geo('foot', () => new THREE.BoxGeometry(1.7, 0.34, 1.7)), trs(p.x, gy + 0.17, p.z, ry), [0.5, 0.5, 0.52]);
      for (let i = 1; i < 5; i++)
        metal.add(geo('brace', () => new THREE.BoxGeometry(0.16, 0.16, 1.9)),
          trs(p.x, gy + i * 1.6, p.z, ry), [0.62, 0.63, 0.65]);
    }
    const c0 = side(sm, 0);
    const gy = Math.min(c0.y, world.heightAt(c0.x, c0.z));
    const span = hw * 2 + 5.4;
    metal.add(geo('beam', () => new THREE.BoxGeometry(1.0, 1.0, 1.0)),
      trs(c0.x, gy + 7.6, c0.z, ry, 0.9, 0.9, span), [0.68, 0.69, 0.71]);
    panel(c0.x, gy + 8.6, c0.z, ry, span * 0.95, 1.55, 0);
    panel(c0.x, gy + 6.55, c0.z, ry, span * 0.95, 1.05, 1);
    // sponsor boards along the pit wall
    for (let i = 0; i < 6; i++) {
      const s2 = track.startS - 30 + i * 10;
      const s3 = at(s2), h2 = s3.width * 0.5;
      const p = side(s3, -(h2 + 2.4));
      const g2 = Math.min(p.y, world.heightAt(p.x, p.z));
      panel(p.x, g2 + 0.75, p.z, Math.atan2(s3.tangent.x, s3.tangent.z), 8.6, 1.15, 3 + (i % 3));
      wood.add(geo('boardpost', () => new THREE.BoxGeometry(0.12, 1.5, 0.12)),
        trs(p.x, g2 + 0.75, p.z, 0), [0.38, 0.32, 0.26]);
    }
  }

  /* ------------------------------------------------------ checkpoint arch -- */
  if (o.arches) {
    for (const f of [0.34, 0.67]) {
      const s = track.startS + f * len, sm = at(s), hw = sm.width * 0.5;
      const ry = Math.atan2(sm.tangent.x, sm.tangent.z);
      for (const sgn of [-1, 1]) {
        const p = side(sm, sgn * (hw + 1.4));
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

  /* ------------------------------------------------------------ bunting --- */
  let buntingMesh = null;
  if (o.bunting) {
    const tex = buildBuntingTexture();
    const gs = [];
    for (let k = 0; k < 6; k++) {
      const s = track.startS - 46 + k * 17;
      const sm = at(s), hw = sm.width * 0.5;
      const a = side(sm, -(hw + 2.6)), b = side(sm, hw + 2.6);
      const ay = Math.min(a.y, world.heightAt(a.x, a.z)) + 5.4;
      const by = Math.min(b.y, world.heightAt(b.x, b.z)) + 5.4;
      const segs = 14, sag = 1.5;
      const pos = [], uv = [], idx = [], nor = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
        const y = lerp(ay, by, t) - Math.sin(t * Math.PI) * sag;
        pos.push(x, y, z, x, y - 0.85, z);
        uv.push(t * 3.2, 1, t * 3.2, 0);
        nor.push(0, 0.3, 0.95, 0, 0.3, 0.95);
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
      buntingMesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      }));
      buntingMesh.name = 'furniture:bunting';
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
        // cats in the crowd
        const nCats = Math.max(2, Math.round(sp.w / 2.6));
        for (let i = 0; i < nCats; i++) {
          if (R() > 0.72) continue;
          const t = (i + 0.5) / nCats - 0.5;
          const ox = -Math.sin(ry + Math.PI / 2) * 0, oz = 0;
          const tx = cx + sm.tangent.x * t * sp.w, tz = cz + sm.tangent.z * t * sp.w;
          catAt(fur, tx, gy + h + 0.1, tz, ry + Math.PI, 0.85 + R() * 0.3, R);
          void ox; void oz;
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
      const p = side(sm, sgn * (hw + 1.5));
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
      map: atlas.tex, vertexColors: true, roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide,
    }));
    mesh.name = 'furniture:signs';
    mesh.castShadow = false; mesh.receiveShadow = o.shadows;
    group.add(mesh);
    for (const p of panels) p.g.dispose();
  }

  const api = {
    group,
    update() {},
    dispose() { group.traverse(n => n.geometry?.dispose?.()); },
  };
  return api;
}

/* ============================================================== props ======= */

/** A very low-poly sitting cat: body, head, ears, tail. Reads at 20 m, costs 90 tris. */
function catAt(b, x, y, z, ry, sc, R) {
  const coats = [[0.72, 0.62, 0.48], [0.30, 0.28, 0.27], [0.85, 0.82, 0.78], [0.55, 0.36, 0.20], [0.62, 0.60, 0.58]];
  const c = coats[(R() * coats.length) | 0];
  const body = geo('catbody', () => new THREE.SphereGeometry(0.24, 6, 5).scale(0.85, 1.15, 0.75));
  const head = geo('cathead', () => new THREE.SphereGeometry(0.15, 6, 5));
  const ear = geo('catear', () => new THREE.ConeGeometry(0.06, 0.13, 4));
  const tail = geo('cattail', () => new THREE.CylinderGeometry(0.03, 0.045, 0.42, 4));
  b.add(body, trs(x, y + 0.26 * sc, z, ry, sc, sc, sc), c);
  b.add(head, trs(x - Math.sin(ry) * 0.05 * sc, y + 0.52 * sc, z - Math.cos(ry) * 0.05 * sc, ry, sc, sc, sc), c);
  for (const s of [-1, 1])
    b.add(ear, trs(x + Math.cos(ry) * 0.08 * s * sc, y + 0.63 * sc, z - Math.sin(ry) * 0.08 * s * sc, ry, sc, sc, sc), c);
  b.add(tail, trs(x + Math.sin(ry) * 0.22 * sc, y + 0.22 * sc, z + Math.cos(ry) * 0.22 * sc, ry, sc, sc, sc, 0.7), c);
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
