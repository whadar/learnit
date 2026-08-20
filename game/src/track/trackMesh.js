/**
 * The Amikam Village Circuit, as geometry.
 *
 * Everything is driven off `track.sample(s)` so the mesh, the physics ribbon and the AI line
 * can never disagree: same centreline, same width, same banking. The surface is emitted as
 * two merged meshes (tarmac sectors and gravel sectors) plus kerbs, run-off, paint decals,
 * boost pads and the jump structure.
 *
 *   const tm = createTrackMesh(engine, world, track);
 */
import * as THREE from 'three';
import { clamp, lerp, rng } from '../core/mathx.js';
import { hash2i } from '../render/materials/noise.js';
import { buildRoadTextures, createRoadMaterial, mergeGeoms } from '../world/roads.js';
import { createFurniture } from './furniture.js';

/* ================================================================ helpers === */

function stripeTexture({ a, b, blocks = 2, w = 24, h = 128, grime = 0.25, seed = 3 }) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const rnd = rng(seed);
  const noise = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) noise[i] = rnd();
  for (let y = 0; y < h; y++) {
    const block = Math.floor(y / (h / blocks)) % 2;
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const col = block ? a : b;
      // grime toward the low, road-side edge and a scuffed top
      const t = x / (w - 1);
      const dirt = grime * (0.55 + 0.45 * noise[k]) * (0.35 + 0.65 * (1 - t));
      const scuff = (noise[(k * 7919) % (w * h)] - 0.5) * 0.10;
      const v = i => clamp((col[i] * (1 - dirt) + 0.30 * dirt * [1.0, 0.93, 0.80][i]) + scuff, 0, 1);
      d[k * 4] = Math.round(Math.pow(v(0), 1 / 2.2) * 255);
      d[k * 4 + 1] = Math.round(Math.pow(v(1), 1 / 2.2) * 255);
      d[k * 4 + 2] = Math.round(Math.pow(v(2), 1 / 2.2) * 255);
      d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function chequerTexture(n = 8, px = 256) {
  const c = document.createElement('canvas'); c.width = px; c.height = px;
  const ctx = c.getContext('2d');
  const cell = px / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    ctx.fillStyle = ((i + j) & 1) ? '#e8e6e0' : '#16161a';
    ctx.fillRect(i * cell, j * cell, cell, cell);
  }
  // wear: scrape a little of the paint away
  const rnd = rng(99);
  ctx.globalAlpha = 0.30;
  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = '#3a3733';
    ctx.fillRect(rnd() * px, rnd() * px, 2 + rnd() * 9, 1 + rnd() * 4);
  }
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function boostTexture(px = 128) {
  const c = document.createElement('canvas'); c.width = px; c.height = px;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, px, px);
  const g = ctx.createLinearGradient(0, px, 0, 0);
  g.addColorStop(0, 'rgba(255,60,10,0.05)');
  g.addColorStop(0.35, 'rgba(255,120,20,0.85)');
  g.addColorStop(0.75, 'rgba(255,215,90,1)');
  g.addColorStop(1, 'rgba(255,255,225,1)');
  ctx.fillStyle = g;
  for (let k = 0; k < 3; k++) {
    const y0 = px * (0.06 + k * 0.30), hgt = px * 0.24;
    ctx.beginPath();
    ctx.moveTo(px * 0.10, y0 + hgt); ctx.lineTo(px * 0.5, y0);
    ctx.lineTo(px * 0.90, y0 + hgt); ctx.lineTo(px * 0.90, y0 + hgt * 1.55);
    ctx.lineTo(px * 0.5, y0 + hgt * 0.55); ctx.lineTo(px * 0.10, y0 + hgt * 1.55);
    ctx.closePath(); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Seamless run-off / verge surface: sun-bleached grit, dry grass and scattered stones. */
function vergeTextures(px = 256, seed = 4242) {
  const sm5 = t => t * t * t * (t * (t * 6 - 15) + 10);
  const vn = (x, y, p, sd) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm5(x - xi), fy = sm5(y - yi);
    const w = a => ((a % p) + p) % p;
    const a = hash2i(w(xi), w(yi), sd), b = hash2i(w(xi + 1), w(yi), sd);
    const c = hash2i(w(xi), w(yi + 1), sd), d = hash2i(w(xi + 1), w(yi + 1), sd);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
  const fb = (x, y, p, sd, oct) => {
    let s = 0, n = 0, a = 1, f = 1;
    for (let i = 0; i < oct; i++) { s += a * vn(x * f, y * f, Math.max(1, Math.round(p * f)), sd + i * 71); n += a; a *= 0.5; f *= 2; }
    return s / n;
  };
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = px; return c; };
  const ca = mk(), cn = mk(), cr = mk();
  const ia = ca.getContext('2d').createImageData(px, px);
  const inr = cn.getContext('2d').createImageData(px, px);
  const ir = cr.getContext('2d').createImageData(px, px);
  const H = new Float32Array(px * px);
  const enc = v => Math.round(clamp(Math.pow(clamp(v, 0, 1), 1 / 2.2), 0, 1) * 255);
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const k = j * px + i, u = i / px * 8, v = j / px * 8;
    const grit = fb(u * 3, v * 3, 24, seed, 4);
    const macro = fb(u * 0.7, v * 0.7, 6, seed + 300, 4);
    const grass = clamp(fb(u * 2.2, v * 2.2, 18, seed + 900, 3) * 1.9 - 0.82, 0, 1);
    let r = 0.545 * (0.72 + macro * 0.55) + grit * 0.10;
    let g = 0.500 * (0.72 + macro * 0.55) + grit * 0.095;
    let b = 0.395 * (0.70 + macro * 0.55) + grit * 0.075;
    r = lerp(r, 0.455, grass * 0.8); g = lerp(g, 0.412, grass * 0.8); b = lerp(b, 0.212, grass * 0.8);
    const st = vn(u * 9, v * 9, 72, seed + 55);
    let h = grit * 1.2 + macro * 0.8 + grass * 1.1;
    if (st > 0.905) { const q = (st - 0.905) * 10.5; r += q * 0.19; g += q * 0.18; b += q * 0.16; h += q * 2.4; }
    ia.data[k * 4] = enc(r); ia.data[k * 4 + 1] = enc(g); ia.data[k * 4 + 2] = enc(b); ia.data[k * 4 + 3] = 255;
    const rv = Math.round(clamp(0.93 - grass * 0.04, 0, 1) * 255);
    ir.data[k * 4] = rv; ir.data[k * 4 + 1] = rv; ir.data[k * 4 + 2] = rv; ir.data[k * 4 + 3] = 255;
    H[k] = h;
  }
  const at = (x, y) => H[(((y % px) + px) % px) * px + (((x % px) + px) % px)];
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const gx = at(i + 1, j) - at(i - 1, j), gy = at(i, j + 1) - at(i, j - 1);
    let nx = -gx * 0.85, ny = -gy * 0.85, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz), k = (j * px + i) * 4;
    inr.data[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    inr.data[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    inr.data[k + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
    inr.data[k + 3] = 255;
  }
  ca.getContext('2d').putImageData(ia, 0, 0);
  cn.getContext('2d').putImageData(inr, 0, 0);
  cr.getContext('2d').putImageData(ir, 0, 0);
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8; return t;
  };
  return { map: tex(ca, true), normalMap: tex(cn, false), roughnessMap: tex(cr, false) };
}

/* ================================================================ ribbons === */

/** A flat quad lying on the track surface — start line, grid boxes, boost pads. */
function decalGeometry(track, s0, s1, off0, off1, lift) {
  const n = Math.max(2, Math.ceil((s1 - s0) / 1.2));
  const pos = [], uv = [], nor = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const s = lerp(s0, s1, i / n), sm = track.sample(s);
    for (let k = 0; k < 2; k++) {
      const off = k ? off1 : off0;
      pos.push(sm.pos.x + sm.normal.x * off,
        sm.pos.y + Math.tan(sm.banking) * off + lift,
        sm.pos.z + sm.normal.z * off);
      nor.push(0, 1, 0);
      uv.push(k, i / n);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* =============================================================== factory ==== */

export function createTrackMesh(engine, world, track, opts = {}) {
  const o = Object.assign({
    ds: 2.2,               // longitudinal tessellation
    runoff: 6.5,           // gravel/verge each side
    kerbWidth: 1.05,
    kerbRise: 0.115,
    kerbCurv: 0.0055,      // curvature above which a corner earns a kerb
    shadows: true,
    itemBoxes: false,      // items.js owns these in the real game
    furniture: true,
  }, opts);

  const group = new THREE.Group();
  group.name = 'circuit';
  const N = Math.max(64, Math.round(track.length / o.ds));
  const ds = track.length / N;
  const samples = [];
  for (let i = 0; i <= N; i++) samples.push(track.sample(i * ds));

  /* ---------------------------------------------------------- surfaces --- */
  // Hard surface: the texture's U axis spans the racing surface plus 0.3 m of ragged margin,
  // so the painted edge lines land at an exact metric offset whatever the local width is.
  const MARGIN = 0.32;
  const NOMW = 13.0;
  const tarmacTex = buildRoadTextures({
    total: NOMW + MARGIN * 2, road: NOMW, vMetres: 22, kind: 'asphalt', centre: null, edge: true,
    seed: 771, normalStrength: 1.05, W: 224, H: 1024,
    polish: [{ at: 0, w: 2.1, k: 0.8 }, { at: 3.3, w: 0.9 }],
  });
  const gravelTex = buildRoadTextures({
    total: NOMW + MARGIN * 2, road: NOMW, vMetres: 19, kind: 'dirt', centre: null, edge: false,
    seed: 883, normalStrength: 1.45, W: 224, H: 1024,
    polish: [{ at: 0, w: 1.7, k: 0.65 }, { at: 3.4, w: 0.85 }],
  });
  const matTarmac = createRoadMaterial(tarmacTex, { normalScale: 0.95, offsetFactor: -4, offsetUnits: -10 });
  const matGravel = createRoadMaterial(gravelTex, { normalScale: 1.35, offsetFactor: -4, offsetUnits: -10 });
  const vergeTex = vergeTextures();
  const matVerge = createRoadMaterial(vergeTex, { normalScale: 1.15, offsetFactor: -1, offsetUnits: -2 });
  matVerge.map.wrapS = THREE.RepeatWrapping;
  matVerge.normalMap.wrapS = THREE.RepeatWrapping;
  matVerge.roughnessMap.wrapS = THREE.RepeatWrapping;

  const isTarmac = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) isTarmac[i] = samples[i].surface === 'tarmac' ? 1 : 0;

  /** Build a longitudinal strip: lanes are [lateralOffset(hw), heightAbove, u]. */
  function buildStrip(mask, laneFn, vScale, drape) {
    const runs = [];
    let cur = [];
    for (let i = 0; i <= N; i++) {
      if (mask[i] > 0) cur.push(i);
      else { if (cur.length > 1) runs.push(cur); cur = []; }
    }
    if (cur.length > 1) runs.push(cur);
    if (!runs.length) return null;
    const geoms = [];
    for (const run of runs) {
      const lanes0 = laneFn(samples[run[0]]);
      const M = run.length, L = lanes0.length;
      const pos = new Float32Array(M * L * 3), nor = new Float32Array(M * L * 3), uv = new Float32Array(M * L * 2);
      for (let r = 0; r < M; r++) {
        const sm = samples[run[r]];
        const lanes = laneFn(sm);
        for (let k = 0; k < L; k++) {
          const off = lanes[k][0], up = lanes[k][1], u = lanes[k][2], blend = lanes[k][3] || 0;
          const x = sm.pos.x + sm.normal.x * off, z = sm.pos.z + sm.normal.z * off;
          let y = sm.pos.y + Math.tan(sm.banking) * off + up;
          if (drape && blend > 0) {
            const th = world.heightAt(x, z);
            y = lerp(y, clamp(th, y - 8, y + 8), blend);
          }
          const i3 = (r * L + k) * 3;
          pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
          const i2 = (r * L + k) * 2;
          uv[i2] = u; uv[i2 + 1] = sm.s * vScale;
        }
      }
      const gi = (r, k) => (clamp(r, 0, M - 1) * L + clamp(k, 0, L - 1)) * 3;
      for (let r = 0; r < M; r++) for (let k = 0; k < L; k++) {
        const a = gi(r - 1, k), b = gi(r + 1, k), c = gi(r, k - 1), d = gi(r, k + 1);
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const l = Math.hypot(nx, ny, nz) || 1;
        const o3 = (r * L + k) * 3;
        nor[o3] = nx / l; nor[o3 + 1] = ny / l; nor[o3 + 2] = nz / l;
      }
      const nIdx = (M - 1) * (L - 1) * 6;
      const idx = (M * L > 65000) ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
      let t = 0;
      for (let r = 0; r < M - 1; r++) for (let k = 0; k < L - 1; k++) {
        const a = r * L + k, b = a + 1, c = (r + 1) * L + k, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      geoms.push(g);
    }
    return mergeGeoms(geoms);
  }

  // hard surface lanes: 9 across, with a parabolic crown
  const hardLanes = sm => {
    const hw = sm.width * 0.5, out = [];
    const span = hw + MARGIN;
    for (let k = 0; k < 9; k++) {
      const t = k / 8 * 2 - 1;                 // -1..1
      const off = t * span;
      const crown = 0.085 * (1 - Math.min(1, (Math.abs(off) / hw) ** 2));
      out.push([off, crown, 0.5 + t * 0.5, 0]);
    }
    return out;
  };
  // run-off lanes for one side: from the kerb line out onto the real hillside
  const runoffLanes = side => sm => {
    const hw = sm.width * 0.5, R = o.runoff;
    const fr = [0.0, 0.10, 0.30, 0.62, 1.0];
    return fr.map(f => {
      const off = side * (hw + MARGIN * 0.9 + f * R);
      const up = f < 0.02 ? 0.0 : -0.06 - f * 0.10;
      return [off, up, side * (hw + f * R) / 3.2, f < 0.02 ? 0 : f * f * (3 - 2 * f)];
    }).concat([[side * (hw + MARGIN + R + 1.4), -0.9, side * (hw + R + 1.4) / 3.2, 1]]);
  };

  const tarmacMask = new Float32Array(N + 1), gravelMask = new Float32Array(N + 1), allMask = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const near = k => isTarmac[clamp(k, 0, N)];
    tarmacMask[i] = (near(i) || near(i - 2) || near(i + 2)) ? 1 : 0;
    gravelMask[i] = (!near(i) || !near(i - 2) || !near(i + 2)) ? 1 : 0;
    allMask[i] = 1;
  }
  for (const [mask, mat, name, order] of [[gravelMask, matGravel, 'gravel', 2], [tarmacMask, matTarmac, 'tarmac', 3]]) {
    const g = buildStrip(mask, hardLanes, 1 / 22, false);
    if (!g) continue;
    const m = new THREE.Mesh(g, mat);
    m.name = 'circuit:' + name; m.receiveShadow = o.shadows; m.renderOrder = order;
    group.add(m);
  }
  for (const side of [-1, 1]) {
    const g = buildStrip(allMask, runoffLanes(side), 1 / 3.2, true);
    if (!g) continue;
    const m = new THREE.Mesh(g, matVerge);
    m.name = 'circuit:runoff'; m.receiveShadow = o.shadows; m.renderOrder = 1;
    group.add(m);
  }

  /* -------------------------------------------------------------- kerbs --- */
  const kerbTar = stripeTexture({ a: [0.66, 0.10, 0.09], b: [0.86, 0.845, 0.82], blocks: 2, w: 20, h: 96, grime: 0.30, seed: 5 });
  const kerbDirt = stripeTexture({ a: [0.80, 0.775, 0.72], b: [0.46, 0.36, 0.22], blocks: 2, w: 20, h: 96, grime: 0.45, seed: 9 });
  const matKerbT = new THREE.MeshStandardMaterial({ map: kerbTar, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
  const matKerbD = new THREE.MeshStandardMaterial({ map: kerbDirt, roughness: 0.94, metalness: 0, side: THREE.DoubleSide });

  const kerbL = new Float32Array(N + 1), kerbR = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const c = samples[i].curvature || 0;
    const mag = clamp((Math.abs(c) - o.kerbCurv) / 0.012, 0, 1);
    if (c > 0) { kerbR[i] = mag; kerbL[i] = mag * 0.75; }   // left-hander: inside is left
    else if (c < 0) { kerbL[i] = mag; kerbR[i] = mag * 0.75; }
  }
  // smear so kerbs run into and out of a corner
  for (const arr of [kerbL, kerbR]) {
    const src = Float32Array.from(arr);
    for (let i = 0; i <= N; i++) {
      let m = 0;
      for (let d = -7; d <= 7; d++) m = Math.max(m, src[clamp(i + d, 0, N)] * (1 - Math.abs(d) / 9));
      arr[i] = m > 0.14 ? 1 : 0;
    }
  }
  for (const [side, mask] of [[-1, kerbL], [1, kerbR]]) {
    for (const [mat, want] of [[matKerbT, 1], [matKerbD, 0]]) {
      const m2 = new Float32Array(N + 1);
      for (let i = 0; i <= N; i++) m2[i] = (mask[i] && (isTarmac[i] === want)) ? 1 : 0;
      const g = kerbStrip(samples, side, m2, o);
      if (g) {
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = 'circuit:kerb'; mesh.receiveShadow = o.shadows; mesh.castShadow = false;
        mesh.renderOrder = 4;
        group.add(mesh);
      }
    }
  }

  /* ------------------------------------------------------------- paint ---- */
  const paints = new THREE.Group(); paints.name = 'circuit:paint';
  {
    const sm = track.sample(track.startS);
    const hw = sm.width * 0.5;
    const line = decalGeometry(track, track.startS - 1.1, track.startS + 1.1, -hw + 0.35, hw - 0.35, 0.055);
    const t = chequerTexture(10, 256);
    t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1);
    const mesh = new THREE.Mesh(line, new THREE.MeshStandardMaterial({
      map: t, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16,
    }));
    mesh.renderOrder = 6; paints.add(mesh);
    // grid boxes
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xe6e2d8, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.72,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16,
    });
    for (const g of track.startGrid) {
      const n = track.nearest(g.pos);
      const s = n.s, off = n.lateral;
      const q = decalGeometry(track, s - 2.4, s + 2.4, off - 1.35, off + 1.35, 0.05);
      const mesh2 = new THREE.Mesh(q, boxMat);
      mesh2.renderOrder = 5; paints.add(mesh2);
    }
  }
  group.add(paints);

  /* --------------------------------------------------------- boost pads --- */
  {
    const tex = boostTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, opacity: 0.95,
    });
    const geos = [];
    for (const p of track.boostPads) {
      const n = track.nearest(p.pos);
      const g = decalGeometry(track, n.s - 3.2, n.s + 3.2, n.lateral - 1.9, n.lateral + 1.9, 0.075);
      geos.push(g);
    }
    const g = mergeGeoms(geos);
    if (g) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'circuit:boost'; mesh.renderOrder = 8; group.add(mesh);
    }
  }

  /* --------------------------------------------------------- item boxes --- */
  if (o.itemBoxes) {
    const geo = new THREE.BoxGeometry(1.15, 1.15, 1.15);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x39d8ff, emissive: 0x1f6f96, roughness: 0.18, metalness: 0.05,
      transparent: true, opacity: 0.62,
    });
    const inst = new THREE.InstancedMesh(geo, mat, track.itemBoxes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
    track.itemBoxes.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0.4, 1, 0.2).normalize(), i * 0.7);
      m.compose(new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), q, sc);
      inst.setMatrixAt(i, m);
    });
    inst.name = 'circuit:itembox'; inst.castShadow = false;
    group.add(inst);
  }

  /* ---------------------------------------------------------- furniture --- */
  let furniture = null;
  if (o.furniture) {
    try { furniture = createFurniture(engine, world, track, opts.furnitureOpts || {}); }
    catch (e) { console.warn('[trackMesh] furniture failed:', e); }
  }
  if (furniture && furniture.group) group.add(furniture.group);

  engine.scene.add(group);
  const api = {
    group, furniture,
    materials: { tarmac: matTarmac, gravel: matGravel, kerbTarmac: matKerbT, kerbDirt: matKerbD },
    update(dt, elapsed) { furniture?.update?.(dt, elapsed); },
    dispose() {
      group.traverse(n => n.geometry?.dispose?.());
      engine.scene.remove(group);
    },
  };
  engine.add(api);
  return api;
}

/** Kerb strip on one side: a raised, slightly outward-sloping shelf with a drop face. */
function kerbStrip(samples, side, mask, o) {
  const N = samples.length - 1;
  const runs = [];
  let cur = [];
  for (let i = 0; i <= N; i++) {
    if (mask[i] > 0) cur.push(i);
    else { if (cur.length > 2) runs.push(cur); cur = []; }
  }
  if (cur.length > 2) runs.push(cur);
  if (!runs.length) return null;
  const geoms = [];
  for (const run of runs) {
    const M = run.length, L = 4;
    const pos = new Float32Array(M * L * 3), nor = new Float32Array(M * L * 3), uv = new Float32Array(M * L * 2);
    for (let r = 0; r < M; r++) {
      const sm = samples[run[r]];
      const hw = sm.width * 0.5;
      // taper the kerb in and out over the first/last few stations
      const fade = clamp(Math.min(r, M - 1 - r) / 4, 0, 1);
      const rise = o.kerbRise * fade;
      const offs = [hw - 0.10, hw + o.kerbWidth * 0.45, hw + o.kerbWidth, hw + o.kerbWidth];
      const ups = [0.012, rise * 0.85, rise, rise - 0.34];
      for (let k = 0; k < L; k++) {
        const off = side * offs[k];
        const x = sm.pos.x + sm.normal.x * off, z = sm.pos.z + sm.normal.z * off;
        const y = sm.pos.y + Math.tan(sm.banking) * off + ups[k];
        const i3 = (r * L + k) * 3;
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        const i2 = (r * L + k) * 2;
        uv[i2] = k / (L - 1);
        uv[i2 + 1] = sm.s / 3.1;
      }
    }
    const gi = (r, k) => (clamp(r, 0, M - 1) * L + clamp(k, 0, L - 1)) * 3;
    for (let r = 0; r < M; r++) for (let k = 0; k < L; k++) {
      const a = gi(r - 1, k), b = gi(r + 1, k), c = gi(r, k - 1), d = gi(r, k + 1);
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      const o3 = (r * L + k) * 3;
      nor[o3] = nx / l; nor[o3 + 1] = ny / l; nor[o3 + 2] = nz / l;
    }
    const nIdx = (M - 1) * (L - 1) * 6;
    const idx = (M * L > 65000) ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
    let t = 0;
    for (let r = 0; r < M - 1; r++) for (let k = 0; k < L - 1; k++) {
      const a = r * L + k, b = a + 1, c = (r + 1) * L + k, d = c + 1;
      if (side < 0) { idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = d; idx[t++] = c; }
      else { idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    geoms.push(g);
  }
  return mergeGeoms(geoms);
}

export default createTrackMesh;
