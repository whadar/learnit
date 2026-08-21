/**
 * Kat Racing — the minimap.
 *
 * A real top-down plan of the circuit, traced from the track spline (not a picture): tarmac
 * ribbon with a cream casing, the start/finish chequer and flag, direction-of-travel chevrons,
 * item-box diamonds, and one livery-coloured blip per kart with the player as a gold arrow.
 * The static layers are baked once into an offscreen canvas and blitted each frame, so
 * per-frame cost is a blit plus a couple of dozen small shapes.
 *
 *   import { createMinimap } from './ui/minimap.js';
 *   const map = createMinimap({ track, world, size: 210, mode: 'heading' });
 *   panel.appendChild(map.canvas);
 *   map.update({ racers, player, items });
 */
import { clamp, lerp, TAU } from '../core/mathx.js';

/* ------------------------------------------------------------ centre-line -- */

/** Pull an (x,z) centre-line out of whatever shape the track module hands us. */
export function trackCenterline(track, samples = 256) {
  const pts = [];
  if (!track) return pts;
  if (typeof track.sample === 'function' && track.length > 1) {
    const L = track.length;
    for (let i = 0; i < samples; i++) {
      let sm;
      try { sm = track.sample(i / samples * L); } catch (e) { break; }
      if (!sm || !sm.pos) break;
      pts.push({ x: sm.pos.x, y: sm.pos.y ?? 0, z: sm.pos.z, w: sm.width ?? 12 });
    }
    if (pts.length > 8) return pts;
    pts.length = 0;
  }
  const raw = track.spline || track.centerline || track.points || track.path;
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (Array.isArray(p)) pts.push({ x: p[0], y: p[1] ?? 0, z: p[2] ?? p[1] ?? 0, w: 12 });
      else if (p && typeof p.x === 'number') pts.push({ x: p.x, y: p.y ?? 0, z: p.z, w: p.width ?? 12 });
    }
  }
  return pts;
}

/**
 * World (x,z) -> canvas (px,py), fitted to the loop's bounding box with `pad` px of margin.
 * Returned as a plain object so the sim harness can assert on it without a DOM.
 */
export function buildMinimapProjection(pts, size = 200, pad = 16, extraM = 10) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  if (!Number.isFinite(minX)) { minX = -100; maxX = 100; minZ = -100; maxZ = 100; }
  minX -= extraM; maxX += extraM; minZ -= extraM; maxZ += extraM;
  const w = Math.max(1e-3, maxX - minX), h = Math.max(1e-3, maxZ - minZ);
  const inner = size - pad * 2;
  const scale = Math.min(inner / w, inner / h);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return {
    scale, cx, cz, size, pad, bounds: { minX, maxX, minZ, maxZ }, spanM: Math.max(w, h),
    /** world -> canvas pixels (north-up: +Z world is down the map, matching +Z = south) */
    to(x, z, out = { x: 0, y: 0 }) {
      out.x = size / 2 + (x - cx) * scale;
      out.y = size / 2 + (z - cz) * scale;
      return out;
    },
  };
}

/* ------------------------------------------------------------------ colours */

const C = {
  plate:    '#F6EEDC',
  plateEdge:'#2C2A22',
  tarmac:   '#4A4A46',
  tarmacHi: '#5E5E57',
  casing:   '#FFF8E7',
  kerbA:    '#D8563A',
  kerbB:    '#FFF8E7',
  ground:   '#B9C08A',
  grove:    '#8FA05B',
  road:     '#D9CDAF',
  water:    '#7FB6D0',
  start:    '#25231D',
  item:     '#3FA9E0',
  rival:    '#F0E6D2',
  player:   '#FFD24A',
  ink:      '#241F16',
};

const PLACE_TINT = ['#FFD24A', '#E7EBF0', '#D9964A'];

/**
 * One livery colour per grid slot, so every rival blip is its own kart on the map even when the
 * caller does not hand us a colour. Index is the racer's stable position in the racers array.
 */
export const RIVAL_TINTS = [
  '#E2513A', '#4FB4E6', '#8FD35A', '#C86BE8',
  '#F2953A', '#5FD9C0', '#E86AA0', '#B9A24A',
  '#7C8CE8', '#D8D2C0', '#8B6A3C', '#5E8C3A',
];

/* =================================================================== factory */

export function createMinimap(opts = {}) {
  const O = Object.assign({
    track: null,
    world: null,
    size: 200,             // css px (the backing store is size * dpr)
    dpr: (typeof devicePixelRatio === 'number' ? Math.min(devicePixelRatio, 3) : 1),
    pad: 18,
    mode: 'north',         // 'north' | 'heading'
    showItems: true,
    showRoads: true,
    samples: 320,
    blip: 5.4,
    className: 'kr-minimap-canvas',
  }, opts);

  const S = O.size, dpr = O.dpr;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) {
    canvas.width = Math.round(S * dpr); canvas.height = Math.round(S * dpr);
    canvas.style.width = S + 'px'; canvas.style.height = S + 'px';
    canvas.className = O.className;
  }
  const ctx = canvas ? canvas.getContext('2d') : null;

  let pts = trackCenterline(O.track, O.samples);
  let proj = buildMinimapProjection(pts, S, O.pad);
  let baked = null;
  let mode = O.mode;
  const tmp = { x: 0, y: 0 };
  let heading = 0, headingTarget = 0;

  /* --------------------------------------------------------------- baking -- */
  function ribbonPath(c, widthScale = 1) {
    if (pts.length < 2) return;
    c.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length];
      proj.to(p.x, p.z, tmp);
      if (i === 0) c.moveTo(tmp.x, tmp.y); else c.lineTo(tmp.x, tmp.y);
    }
    c.closePath();
  }

  function bake() {
    if (typeof document === 'undefined') return;
    const c2 = document.createElement('canvas');
    const B = Math.round(S * dpr);
    c2.width = B; c2.height = B;
    const c = c2.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, S, S);

    // ---- ground wash: a soft olive field so the ribbon reads as a road on land
    const g = c.createRadialGradient(S * 0.42, S * 0.36, S * 0.05, S * 0.5, S * 0.5, S * 0.62);
    g.addColorStop(0, '#CBD09C');
    g.addColorStop(0.65, '#B2BA85');
    g.addColorStop(1, '#96A26E');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);

    // ---- village hint: real roads and water near the circuit, drawn very faintly
    if (O.showRoads && O.world) {
      drawWorldFeature(c, O.world.water, C.water, 2.2, 0.55);
      drawWorldFeature(c, O.world.roads, C.road, 1.5, 0.45);
      drawBuildings(c);
    }

    // ---- the circuit itself
    const avgW = pts.reduce((a, p) => a + (p.w || 12), 0) / Math.max(1, pts.length);
    const px = Math.max(3.5, avgW * proj.scale);
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = 'rgba(0,0,0,.30)'; c.shadowBlur = 5; c.shadowOffsetY = 1.5;
    c.strokeStyle = C.casing; c.lineWidth = px + 3.4; ribbonPath(c); c.stroke();
    c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
    c.strokeStyle = C.tarmac; c.lineWidth = px; ribbonPath(c); c.stroke();
    // centre dashes
    c.strokeStyle = 'rgba(255,248,231,.34)';
    c.lineWidth = Math.max(0.7, px * 0.10);
    c.setLineDash([px * 0.55, px * 0.85]);
    ribbonPath(c); c.stroke();
    c.setLineDash([]);

    // ---- direction of travel: chevrons riding the ribbon, pointing the way round
    drawDirectionChevrons(c, px);

    // ---- start/finish chequer across the ribbon, plus a chequered flag in the margin
    if (pts.length > 3) {
      const s0 = Number.isFinite(O.track?.startS) ? O.track.startS : 0;
      const i0 = Math.round((s0 / (O.track?.length || 1)) * pts.length) % pts.length;
      const a = pts[i0], b = pts[(i0 + 1) % pts.length];
      const dx = b.x - a.x, dz = b.z - a.z, m = Math.hypot(dx, dz) || 1;
      const nx = dz / m, nz = -dx / m;
      const half = (a.w || avgW) * 0.55;
      proj.to(a.x - nx * half, a.z - nz * half, tmp);
      const x0 = tmp.x, y0 = tmp.y;
      proj.to(a.x + nx * half, a.z + nz * half, tmp);
      const x1 = tmp.x, y1 = tmp.y;
      const n = 6;
      c.lineWidth = Math.max(2.4, px * 0.34);
      c.lineCap = 'butt';
      for (let i = 0; i < n; i++) {
        c.strokeStyle = i % 2 ? '#22201A' : '#FFF8E7';
        c.beginPath();
        c.moveTo(lerp(x0, x1, i / n), lerp(y0, y1, i / n));
        c.lineTo(lerp(x0, x1, (i + 1) / n), lerp(y0, y1, (i + 1) / n));
        c.stroke();
      }
      c.lineCap = 'round';

      // the flag sits on the outboard side of the line so it never covers the ribbon
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      let ox = x1 - x0, oy = y1 - y0;
      const om = Math.hypot(ox, oy) || 1;
      ox /= om; oy /= om;
      const off = px * 0.55 + 19;
      let fx = mx + ox * off, fy = my + oy * off;
      // keep it on the map even if the line sits near an edge
      if (fx < 16 || fx > S - 16 || fy < 16 || fy > S - 16) { fx = mx - ox * off; fy = my - oy * off; }
      flagAt.x = clamp(fx, 14, S - 14); flagAt.y = clamp(fy, 12, S - 12); flagAt.ok = true;
    }
    baked = c2;
  }

  /** Where the start/finish flag goes; drawn each frame on top so karts never bury it. */
  const flagAt = { x: 0, y: 0, ok: false };

  /**
   * Little chequered flag on a pole - the map's "you start here, you finish here".
   * Kept light (cream body, six big squares) so it reads as a flag and not as a dark blob at
   * 12 px, and haloed so it separates from the tarmac ribbon underneath.
   */
  function startFlag(c, x, y) {
    const W = 12.6, H = 8.4, X = 1.0, Y = -11.2;
    c.save();
    c.translate(x, y);
    c.lineJoin = 'round'; c.lineCap = 'round';
    // halo
    c.fillStyle = 'rgba(255,248,231,.55)';
    c.beginPath(); c.ellipse(X + W * 0.4, Y + H * 0.5 + 1, W * 0.95, H * 1.5, 0, 0, TAU); c.fill();
    // pole
    c.strokeStyle = C.ink; c.lineWidth = 2.8;
    c.beginPath(); c.moveTo(0, 6.5); c.lineTo(0, Y - 0.6); c.stroke();
    // flag body, cased then chequered
    c.fillStyle = '#FFF8E7';
    c.strokeStyle = C.ink; c.lineWidth = 2.4;
    c.beginPath(); c.rect(X, Y, W, H); c.fill(); c.stroke();
    c.save();
    c.beginPath(); c.rect(X, Y, W, H); c.clip();
    c.fillStyle = '#22201A';
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      if ((i + j) % 2) continue;
      c.fillRect(X + i * (W / 3), Y + j * (H / 2), W / 3, H / 2);
    }
    c.restore();
    c.restore();
  }

  /** Arrowheads along the centre-line so the lap direction is never ambiguous. */
  function drawDirectionChevrons(c, px) {
    if (pts.length < 8) return;
    const n = 6, size = Math.max(4.8, px * 0.72);
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    for (let k = 0; k < n; k++) {
      const i = Math.round((k + 0.5) / n * pts.length) % pts.length;
      const a = pts[i], b = pts[(i + 4) % pts.length];
      proj.to(a.x, a.z, tmp); const ax = tmp.x, ay = tmp.y;
      proj.to(b.x, b.z, tmp); const bx = tmp.x, by = tmp.y;
      const dx = bx - ax, dy = by - ay, m = Math.hypot(dx, dy);
      if (m < 0.001) continue;
      c.save();
      c.translate(ax, ay);
      c.rotate(Math.atan2(dy, dx));
      c.beginPath();
      c.moveTo(size * 0.95, 0);
      c.lineTo(-size * 0.62, -size * 0.72);
      c.lineTo(-size * 0.28, 0);
      c.lineTo(-size * 0.62, size * 0.72);
      c.closePath();
      c.fillStyle = '#FFF8E7'; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = 'rgba(24,21,15,.9)'; c.stroke();
      c.restore();
    }
    c.restore();
  }

  function drawWorldFeature(c, list, colour, width, alpha) {
    if (!Array.isArray(list)) return;
    c.save();
    c.globalAlpha = alpha;
    c.strokeStyle = colour; c.fillStyle = colour;
    c.lineWidth = width;
    const R = proj.spanM * 0.95;
    for (const f of list) {
      const paths = f.paths || (f.rings ? f.rings : null);
      if (!paths) continue;
      for (const path of paths) {
        if (!Array.isArray(path) || path.length < 2) continue;
        // cheap cull: skip anything wholly outside the map box
        const p0 = path[0];
        if (Math.abs(p0[0] - proj.cx) > R && Math.abs(p0[1] - proj.cz) > R) continue;
        c.beginPath();
        for (let i = 0; i < path.length; i++) {
          proj.to(path[i][0], path[i][1], tmp);
          if (i === 0) c.moveTo(tmp.x, tmp.y); else c.lineTo(tmp.x, tmp.y);
        }
        if (f.poly) { c.closePath(); c.fill(); } else c.stroke();
      }
    }
    c.restore();
  }

  function drawBuildings(c) {
    const bl = O.world?.buildings;
    if (!Array.isArray(bl)) return;
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = '#E8DCC2';
    c.strokeStyle = 'rgba(60,54,42,.35)';
    c.lineWidth = 0.6;
    const { minX, maxX, minZ, maxZ } = proj.bounds;
    let drawn = 0;
    for (const b of bl) {
      const ring = b.rings && b.rings[0];
      if (!ring || ring.length < 3) continue;
      if (ring[0][0] < minX || ring[0][0] > maxX || ring[0][1] < minZ || ring[0][1] > maxZ) continue;
      c.beginPath();
      for (let i = 0; i < ring.length; i++) {
        proj.to(ring[i][0], ring[i][1], tmp);
        if (i === 0) c.moveTo(tmp.x, tmp.y); else c.lineTo(tmp.x, tmp.y);
      }
      c.closePath(); c.fill(); c.stroke();
      if (++drawn > 400) break;
    }
    c.restore();
  }

  /* ---------------------------------------------------------------- blips -- */
  /** A rival: cased disc in that kart's livery, with a gold ring on the race leader. */
  function blip(c, x, y, r, fill, leader) {
    c.beginPath(); c.arc(x, y + 1.1, r + 1.5, 0, TAU);
    c.fillStyle = 'rgba(0,0,0,.28)'; c.fill();
    c.beginPath(); c.arc(x, y, r + 1.5, 0, TAU);
    c.fillStyle = leader ? '#FFD24A' : 'rgba(30,28,22,.92)'; c.fill();
    c.beginPath(); c.arc(x, y, r, 0, TAU);
    c.fillStyle = fill; c.fill();
    // a soft top-light so the disc reads as a bead, not a flat dot
    c.beginPath(); c.arc(x - r * 0.28, y - r * 0.32, r * 0.46, 0, TAU);
    c.fillStyle = 'rgba(255,255,255,.42)'; c.fill();
  }

  /** The player: one cased arrowhead, no double-draw, pointing the way the kart faces. */
  function arrow(c, x, y, ang, r, fill) {
    c.save();
    c.translate(x, y); c.rotate(ang);
    c.beginPath();
    c.moveTo(0, -r * 1.62); c.lineTo(r * 1.12, r * 1.02); c.lineTo(0, r * 0.46); c.lineTo(-r * 1.12, r * 1.02);
    c.closePath();
    c.lineJoin = 'round';
    c.fillStyle = 'rgba(0,0,0,.30)';
    c.save(); c.translate(0, 1.4); c.fill(); c.restore();
    c.lineWidth = 2.6; c.strokeStyle = C.ink;
    c.fillStyle = fill; c.fill(); c.stroke();
    // bright bevel down the leading edge
    c.beginPath();
    c.moveTo(0, -r * 1.62); c.lineTo(r * 0.55, r * 0.1); c.lineTo(0, r * 0.0);
    c.closePath();
    c.fillStyle = 'rgba(255,255,255,.5)'; c.fill();
    c.restore();
  }

  /**
   * The pack bunches on the grid, and at map scale eight karts land inside one blip. Nudge
   * overlapping markers apart (deterministically, bounded to a couple of blip widths) so the
   * field is readable without lying about where anyone is.
   */
  const marks = [];
  function layoutRacers(racers) {
    marks.length = 0;
    for (let i = 0; i < racers.length; i++) {
      const r = racers[i];
      proj.to(r.x, r.z, tmp);
      marks.push({ r, i, x: tmp.x, y: tmp.y, ox: tmp.x, oy: tmp.y });
    }
    const MIN = O.blip * 2.25, MAXOFF = O.blip * 2.6;
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (let a = 0; a < marks.length; a++) {
        for (let b = a + 1; b < marks.length; b++) {
          const A = marks[a], B = marks[b];
          let dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
          if (d >= MIN) continue;
          if (d < 1e-4) {                       // exactly coincident: fan out on a fixed spiral
            const ang = (a * 2.39996 + b * 0.91);
            dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
          }
          const push = (MIN - d) * 0.5 / d;
          A.x -= dx * push; A.y -= dy * push;
          B.x += dx * push; B.y += dy * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const m of marks) {                    // never drift far from the truth
      const dx = m.x - m.ox, dy = m.y - m.oy, d = Math.hypot(dx, dy);
      if (d > MAXOFF) { m.x = m.ox + dx / d * MAXOFF; m.y = m.oy + dy / d * MAXOFF; }
    }
    return marks;
  }

  /**
   * @param {object} data { racers:[{x,z,yaw,place,player,color,finished}], items:[{x,z,active}],
   *                        player:{x,z,yaw}, pulse:number }
   */
  function update(data = {}) {
    if (!ctx) return;
    if (!baked) bake();
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);

    const player = data.player || (data.racers || []).find(r => r.player) || null;
    if (mode === 'heading' && player) {
      // bring the direction of travel to screen-up: map angle of travel is (PI - yaw)
      headingTarget = (player.yaw || 0) - Math.PI;
      let d = headingTarget - heading;
      while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      heading += d * clamp((data.dt ?? 1 / 60) * 8, 0, 1);
    } else heading = 0;

    c.save();
    // circular clip so the plate can be a disc or a rounded square
    c.beginPath();
    roundRect(c, 0, 0, S, S, S * 0.16);
    c.clip();

    c.save();
    c.translate(S / 2, S / 2);
    if (heading) c.rotate(heading);
    c.translate(-S / 2, -S / 2);
    if (baked) c.drawImage(baked, 0, 0, S, S);

    // item boxes
    if (O.showItems && Array.isArray(data.items)) {
      for (const b of data.items) {
        const p = b.pos || b;
        proj.to(p.x, p.z, tmp);
        // a diamond, not a dot - item boxes must never be mistaken for a kart blip
        c.save();
        c.globalAlpha = b.active === false ? 0.26 : 1;
        c.translate(tmp.x, tmp.y); c.rotate(Math.PI / 4);
        c.beginPath(); c.rect(-2.6, -2.6, 5.2, 5.2);
        c.fillStyle = C.item; c.fill();
        c.lineWidth = 1.4; c.strokeStyle = 'rgba(24,22,16,.85)'; c.stroke();
        c.restore();
      }
    }

    // every kart on the map: rivals first, the player last so it is never occluded
    const racers = data.racers || [];
    const pulse = data.pulse ?? 0;
    const laid = layoutRacers(racers);
    let me = null;
    for (const m of laid) {
      const r = m.r;
      if (r.player || r === player) { me = m; continue; }
      const tint = r.color != null ? hexish(r.color) : RIVAL_TINTS[m.i % RIVAL_TINTS.length];
      c.save();
      if (r.finished) c.globalAlpha = 0.45;
      blip(c, m.x, m.y, O.blip * 0.86, tint, r.place === 1);
      c.restore();
    }
    if (player) {
      const x = me ? me.x : (proj.to(player.x, player.z, tmp), tmp.x);
      const y = me ? me.y : tmp.y;
      const g = 1 + 0.09 * Math.sin(pulse * 5.0);
      c.beginPath(); c.arc(x, y, O.blip * 2.5 * g, 0, TAU);
      c.fillStyle = 'rgba(255,206,61,.20)'; c.fill();
      c.beginPath(); c.arc(x, y, O.blip * 1.85 * g, 0, TAU);
      c.fillStyle = 'rgba(255,206,61,.24)'; c.fill();
      // north-up: the arrow carries the kart's heading; heading-up: the map already turned
      arrow(c, x, y, Math.PI - (player.yaw || 0), O.blip * 1.2, C.player);
    }
    if (flagAt.ok) startFlag(c, flagAt.x, flagAt.y);
    c.restore();

    // compass rose (rotates with the map)
    c.save();
    c.translate(S - 15, 15);
    c.rotate(heading);
    c.fillStyle = 'rgba(36,31,22,.72)';
    c.beginPath(); c.moveTo(0, -8); c.lineTo(3.4, 2.2); c.lineTo(0, 0.4); c.lineTo(-3.4, 2.2); c.closePath(); c.fill();
    c.fillStyle = 'rgba(36,31,22,.72)';
    c.font = "800 7px 'Trebuchet MS',DejaVu Sans,sans-serif";
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', 0, -11.5);
    c.restore();

    c.restore();
  }

  const hexish = n => typeof n === 'string' ? n
    : '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  return {
    canvas, projection: proj, centerline: pts,
    get mode() { return mode; },
    setMode(m) { mode = m === 'heading' ? 'heading' : 'north'; return this; },
    toggleMode() { mode = mode === 'heading' ? 'north' : 'heading'; return mode; },
    setTrack(t) {
      O.track = t;
      pts = trackCenterline(t, O.samples);
      proj = buildMinimapProjection(pts, S, O.pad);
      baked = null; flagAt.ok = false;
      return this;
    },
    /** World point -> normalised 0..1 map coordinates (for external overlays). */
    project(x, z) { proj.to(x, z, tmp); return { x: tmp.x / S, y: tmp.y / S }; },
    update,
    dispose() { canvas?.remove(); baked = null; },
  };
}

export default createMinimap;
