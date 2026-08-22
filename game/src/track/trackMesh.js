/**
 * The Amikam Village Circuit, as geometry.
 *
 * Everything is driven off `track.sample(s)` so the mesh, the physics ribbon and the AI line
 * can never disagree: same centreline, same width, same banking. The racing surface is ONE
 * merged ribbon of chip-seal whose lane markings and start/finish chequer are drawn
 * analytically by its material, plus corner kerbs, run-off, grid boxes and boost pads.
 *
 *   const tm = createTrackMesh(engine, world, track);
 */
import * as THREE from 'three';
import { clamp, lerp, rng } from '../core/mathx.js';
import { hash2i } from '../render/materials/noise.js';
import { buildRoadTextures, createRoadMaterial, mergeGeoms } from '../world/roads.js';
import { createFurniture } from './furniture.js';

/* ================================================================ helpers === */

/**
 * The circuit's ONE kerb livery: red/white corner rumble.
 *
 * There used to be a second, pale-limestone column in this atlas for the straights, which is
 * how the same circuit ended up showing three different kerb languages from shot to shot. A
 * kerb is a corner-reading cue, so there is now exactly one look and it only appears at
 * apexes (see the curvature mask in `createTrackMesh`).
 *
 * The U axis runs across the extruded profile (inner chamfer -> top -> outer chamfer -> drop
 * face); V runs along the kerb, one block per repeat.
 */
function kerbTexture(w = 96, h = 192) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const rnd = rng(5150);
  const noise = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) noise[i] = rnd();
  // Authored to survive a hot sun and ACES. The scene's key light plus the filmic curve lifts
  // a mid albedo a long way *and* skews it hard to red, so the white block is authored with a
  // cool bias (b > r) to come back a real white instead of the cream it used to render.
  const RED = [0.150, 0.020, 0.030];
  const WHT = [0.585, 0.660, 0.850];
  for (let y = 0; y < h; y++) {
    const block = Math.floor(y / (h / 2)) % 2;
    // a dark mortar joint between blocks, so the kerb reads as laid stones up close
    const dy = Math.min(y % (h / 2), (h / 2) - 1 - (y % (h / 2)));
    const joint = clamp(1 - dy / (h * 0.030), 0, 1);
    for (let x = 0; x < w; x++) {
      const col = block ? RED : WHT;
      const k = y * w + x;
      const t = x / (w - 1);
      // grime on both chamfers, clean across the rumble top
      const dirt = 0.15 * (0.55 + 0.45 * noise[k]) * (0.20 + 0.80 * Math.abs(t * 2 - 1) ** 1.4);
      const scuff = (noise[(k * 7919) % (w * h)] - 0.5) * 0.05;
      const v = i => clamp((col[i] * (1 - dirt) + 0.24 * dirt * [1.0, 0.93, 0.86][i]) + scuff
        - joint * 0.45 * col[i], 0, 1);
      d[k * 4] = Math.round(Math.pow(v(0), 1 / 2.2) * 255);
      d[k * 4 + 1] = Math.round(Math.pow(v(1), 1 / 2.2) * 255);
      d[k * 4 + 2] = Math.round(Math.pow(v(2), 1 / 2.2) * 255);
      d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return t;
}

/**
 * Chequer for the two waist-high start-line walls.
 *
 * The chequer painted on the ROAD is no longer a texture at all — it is generated
 * analytically in the surface shader (see `createSurfaceMaterial`), which is the only way to keep the
 * squares square, aligned to the road axis and crisp at every distance. This canvas is only
 * ever wrapped round the two marker blocks either side of the line, where a texture is fine.
 *
 * The white is authored with a cool bias so the scene's very warm key light and grade land it
 * on white rather than the dingy cream the critics measured.
 */
function chequerTexture(across = 6, rows = 2, cellPx = 64) {
  const W = across * cellPx, H = rows * cellPx;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  for (let j = 0; j < rows; j++) for (let i = 0; i < across; i++) {
    ctx.fillStyle = ((i + j) & 1) ? '#e2ecff' : '#0a0b0f';
    ctx.fillRect(i * cellPx, j * cellPx, cellPx + 1, cellPx + 1);
  }
  // a light, even scuff — never the full-height smears that turned the whites grey
  const rnd = rng(99);
  ctx.globalAlpha = 0.07;
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = rnd() > 0.55 ? '#3a3733' : '#9aa4b4';
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 10, 1 + rnd() * 4);
  }
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return t;
}

/**
 * 4 x 4 atlas of numbered starting boxes (the field is eight, so rows 0-1 carry 1..8).
 *
 * Painted as a CONSTANT-COLOUR, varying-alpha texture: the artwork is drawn as a white mask,
 * wear is erased out of the alpha channel, and the whole canvas is then flooded with the paint
 * colour through `source-in`. A conventional coloured-on-transparent atlas mips towards
 * transparent black, which is why the numbers turned into faint grey dashes at grid distance.
 *
 * Drawn mirrored in x because the decal UV's u axis runs right-to-left as the driver sees it.
 */
function gridBoxTexture(px = 256) {
  const c = document.createElement('canvas'); c.width = c.height = px * 4;
  const ctx = c.getContext('2d');
  const font = '"DejaVu Sans","Liberation Sans","FreeSans",sans-serif';
  const rnd = rng(1717);
  ctx.clearRect(0, 0, px * 4, px * 4);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  for (let k = 0; k < 16; k++) {
    const cx = (k % 4) * px, cy = ((k / 4) | 0) * px;
    ctx.save();
    // mirror in x within this cell so painted text reads correctly on the road
    ctx.translate(cx + px, cy); ctx.scale(-1, 1);
    const pad = px * 0.075, lw = px * 0.085;
    ctx.lineWidth = lw;
    ctx.strokeRect(pad + lw * 0.5, pad + lw * 0.5, px - pad * 2 - lw, px - pad * 2 - lw);
    // forward chevron (canvas top = down-track)
    ctx.beginPath();
    ctx.moveTo(px * 0.5, px * 0.15); ctx.lineTo(px * 0.76, px * 0.38); ctx.lineTo(px * 0.63, px * 0.38);
    ctx.lineTo(px * 0.5, px * 0.26); ctx.lineTo(px * 0.37, px * 0.38); ctx.lineTo(px * 0.24, px * 0.38);
    ctx.closePath(); ctx.fill();
    // grid number, upright for a driver sitting in the box
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(px * 0.50)}px ${font}`;
    ctx.fillText(String(k + 1), px * 0.5, px * 0.86);
    ctx.restore();
  }
  // scrub the paint away in patches (alpha only — never darken the colour)
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  for (let i = 0; i < 2600; i++) {
    ctx.fillRect(rnd() * px * 4, rnd() * px * 4, 3 + rnd() * 16, 2 + rnd() * 7);
  }
  ctx.restore();
  // flood the surviving alpha with a single paint colour so every mip level stays this colour
  ctx.save();
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#dfe9ff';
  ctx.fillRect(0, 0, px * 4, px * 4);
  ctx.restore();
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
    // Deliberately darker than the surrounding hillside: the run-off has to be a value step
    // down from the racing surface, or the ribbon has no readable edge at speed.
    let r = 0.335 * (0.78 + macro * 0.46) + grit * 0.085;
    let g = 0.300 * (0.78 + macro * 0.46) + grit * 0.080;
    let b = 0.215 * (0.76 + macro * 0.46) + grit * 0.060;
    r = lerp(r, 0.300, grass * 0.85); g = lerp(g, 0.282, grass * 0.85); b = lerp(b, 0.140, grass * 0.85);
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

/* ====================================================== surface material === */

/**
 * The racing surface's material.
 *
 * Three things are done here that a baked cross-section texture cannot do, and each one was a
 * defect in the last round:
 *
 *  1. **Markings are analytic.** The centre dashes and the edge lines are evaluated per pixel
 *     from the vertex's real lateral offset and real distance-along, and box-filtered by the
 *     pixel footprint. A 23 cm line seen from 200 m therefore fades to a faint but *present*
 *     line instead of mip-mapping to nothing, and it is impossible for a sector to be missing
 *     its markings, because there is only one surface and one marking pass.
 *  2. **The start/finish chequer is analytic too, and lives ON the road.** It is keyed on the
 *     wrapped distance to `startS` and masked by the road half-width, so its grid axis is the
 *     road axis by construction, it cannot overhang onto the dirt, and it cannot z-fight or
 *     drift out of register the way a separately projected decal did.
 *  3. **A world-space detail layer** adds real aggregate — chippings, binder grain and the
 *     micro-normal that makes them catch the sun — at a spatial frequency far above anything
 *     a 640-texel cross-section could hold. It fades out past ~18 m so it never aliases.
 *
 * Colour uniforms are LINEAR albedo. The scene's very warm key and grade are corrected for at
 * the END of the shader instead of in the palette — see `uSat` / `uTint` below for why.
 */
function createSurfaceMaterial(tex, o) {
  const uniforms = {
    uStartS: { value: o.startS },
    uLen: { value: o.length },
    uPaint: { value: new THREE.Vector3(0.72, 0.80, 0.95) },
    uPaintGlow: { value: new THREE.Vector3(0.0, 0.012, 0.075) },
    uDark: { value: new THREE.Vector3(0.016, 0.020, 0.030) },
    uCell: { value: 1.25 },
    uBand: { value: 3.75 },
    uEdge: { value: new THREE.Vector2(0.62, 0.115) },
    uDash: { value: new THREE.Vector2(7.0, 0.44) },
    uChipA: { value: new THREE.Vector3(0.150, 0.148, 0.140) },
    /* The scene's key light and grade skew a neutral albedo hard to orange — a plain dark
     * binder rendered as milk chocolate at R : G : B = 1 : 0.78 : 0.48. Tinting the ALBEDO
     * cool fixes the sunlit road and ruins everything else: albedo multiplies the light, so
     * under the blue sky-fill of a tree shadow a blue-biased tarmac went electric royal blue.
     *
     * The correction therefore happens on the lit result and is anchored to LUMINANCE:
     * pull the pixel towards `luma * uTint`, keeping `uSat` of its original chroma. The
     * neutral point it is pulled towards scales with how bright the pixel already is, so a
     * dim shadow gets a proportionally dim correction and simply stays a cool dark grey. */
    uSat: { value: 0.30 },
    uTint: { value: new THREE.Vector3(0.93, 1.00, 1.18) },
    uDetail: { value: new THREE.Vector2(18.0, 0.85) },   // fade distance, strength
  };
  const m = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
    roughness: 0.94, metalness: 0, color: 0xffffff,
    envMapIntensity: 0.30,
    normalScale: new THREE.Vector2(0.9, 0.9),
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -14,
    side: THREE.FrontSide, dithering: true,
  });
  m.userData.uniforms = uniforms;
  m.customProgramCacheKey = () => 'kat:circuit-surface';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aRoad;              // (lateral m, half-width m, distance along m)
varying vec3 vRoad;
varying vec3 vSurfW;
varying vec3 vAxX;
varying vec3 vAxZ;
varying float vSurfD;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vRoad = aRoad;
  vSurfW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vSurfD = -mvPosition.z;
  vAxX = normalMatrix * vec3(1.0, 0.0, 0.0);
  vAxZ = normalMatrix * vec3(0.0, 0.0, 1.0);`);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoad;
varying vec3 vSurfW;
varying vec3 vAxX;
varying vec3 vAxZ;
varying float vSurfD;
uniform float uStartS, uLen, uCell, uBand;
uniform vec3 uPaint, uPaintGlow, uDark, uChipA, uTint;
uniform float uSat;
uniform vec2 uEdge, uDash, uDetail;
float gPaint = 0.0;      // white-paint coverage (lines + chequer whites)
float gChequer = 0.0;    // inside the start/finish band
float gGrain = 0.0;      // aggregate height, for the detail normal

float kdH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float kdN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(kdH(i), kdH(i+vec2(1,0)), f.x), mix(kdH(i+vec2(0,1)), kdH(i+vec2(1,1)), f.x), f.y); }

/* Box-filtered coverage of a band of half-width h centred on d=0, for a pixel footprint w.
   Sub-pixel lines return their true fractional coverage instead of vanishing. */
float kBand(float d, float h, float w){
  w = max(w, 1e-5);
  return clamp((h - d)/w + 0.5, 0.0, 1.0) - clamp((-h - d)/w + 0.5, 0.0, 1.0);
}
/* Box-filtered duty cycle of a dashed line of the given period. */
float kPulseI(float x, float duty){ return floor(x)*duty + min(fract(x), duty); }
float kDash(float s, float period, float duty, float w){
  if (w >= period) return duty;
  float a = (s - w*0.5)/period, b = (s + w*0.5)/period;
  return clamp((kPulseI(b, duty) - kPulseI(a, duty)) * period / max(w, 1e-5), 0.0, 1.0);
}
/* Box-filtered chequer. tri() is the exact antiderivative of a unit square wave of period 2,
   so the average over the pixel footprint is exact and the pattern converges to flat grey at
   distance instead of shimmering. */
float kTri(float x){ float u = fract(x*0.5)*2.0; return 1.0 - abs(1.0 - u); }
float kSq(float x, float w){ w = max(w, 1e-5); return (kTri(x + 0.5*w) - kTri(x - 0.5*w)) / w; }
float kChecker(vec2 p, vec2 w){ return 0.5 + 0.5 * kSq(p.x, w.x) * kSq(p.y, w.y); }`)

      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float lat = vRoad.x, hw = vRoad.y, s = vRoad.z;
  float au = abs(lat);
  float wLat = fwidth(lat) + 1e-5;
  float wS   = fwidth(s) + 1e-5;

  /* --- de-tile the 24 m cross-section repeat ------------------------------- */
  float dt = kdN(vSurfW.xz * 0.085) * 0.45 + kdN(vSurfW.xz * 0.34) * 0.35 + kdN(vSurfW.xz * 1.7) * 0.20;
  diffuseColor.rgb *= 0.945 + 0.115 * dt;

  /* --- close-range aggregate ----------------------------------------------- */
  float dfade = (1.0 - smoothstep(uDetail.x * 0.35, uDetail.x, vSurfD)) * uDetail.y;
  if (dfade > 0.002) {
    vec2 wp = vSurfW.xz;
    float a1 = kdN(wp * 33.0);
    float a2 = kdN(wp * 12.5);
    float a3 = kdN(wp * 74.0);
    float chips = smoothstep(0.60, 0.95, max(a1, a2 * 0.94));
    gGrain = (chips * 0.8 + (a3 - 0.5) * 0.5 + (a1 - 0.5) * 0.35) * dfade;
    diffuseColor.rgb = mix(diffuseColor.rgb, uChipA, chips * 0.34 * dfade);
    diffuseColor.rgb *= 1.0 + ((a3 - 0.5) * 0.26 + (a1 - 0.5) * 0.16) * dfade;
  }

  /* --- start / finish chequer, laid on the road axis ----------------------- */
  float ds = s - uStartS;
  ds -= uLen * floor(ds / uLen + 0.5);
  float onRoad = 1.0 - smoothstep(hw - 0.16, hw - 0.01, au);
  float band = (1.0 - smoothstep(uBand - 0.05, uBand + 0.02, abs(ds))) * onRoad;
  float rail = kBand(abs(ds) - (uBand + 0.20), 0.13, wS) * onRoad;
  if (band > 0.001) {
    float chk = kChecker(vec2(lat / uCell, ds / uCell), vec2(wLat, wS) / uCell);
    vec3 cc = mix(uDark, uPaint, chk);
    diffuseColor.rgb = mix(diffuseColor.rgb, cc, band);
    gChequer = band;
    gPaint = max(gPaint, band * chk);
  }

  /* --- lane markings ------------------------------------------------------- */
  float mEdge = kBand(au - (hw - uEdge.x), uEdge.y, wLat);
  float mCent = kBand(lat, 0.085, wLat) * kDash(s, uDash.x, uDash.y, wS);
  float paint = max(mEdge, mCent) * onRoad * (1.0 - gChequer);
  paint = max(paint, rail);
  // scuffed, but never faded away: a marking the player cannot see is a marking that is not there
  paint *= 0.80 + 0.20 * kdN(vSurfW.xz * 0.6);
  if (paint > 0.001) {
    diffuseColor.rgb = mix(diffuseColor.rgb, uPaint, paint);
    gPaint = max(gPaint, paint);
  }
}`)

      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.60, gPaint * 0.85);
  roughnessFactor = clamp(roughnessFactor - gGrain * 0.06, 0.05, 1.0);`)

      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += uPaintGlow * gPaint;`)

      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  if (gGrain != 0.0) {
    vec2 wp = vSurfW.xz;
    float e = 0.008;
    float gx = kdN((wp + vec2(e, 0.0)) * 33.0) - kdN((wp - vec2(e, 0.0)) * 33.0);
    float gz = kdN((wp + vec2(0.0, e)) * 33.0) - kdN((wp - vec2(0.0, e)) * 33.0);
    float k = (1.0 - gPaint * 0.8) * uDetail.y * (1.0 - smoothstep(uDetail.x * 0.35, uDetail.x, vSurfD));
    normal = normalize(normal - (gx * vAxX + gz * vAxZ) * 0.55 * k);
  }`);

    // Luminance-anchored chroma correction on the LIT result (see uSat/uTint above).
    const grade = ch => `
{
  float l = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
  outgoingLight = mix(l * uTint, outgoingLight, uSat);
}
#include <${ch}>`;
    for (const ch of ['opaque_fragment', 'output_fragment']) {
      if (sh.fragmentShader.includes(`#include <${ch}>`)) {
        sh.fragmentShader = sh.fragmentShader.replace(`#include <${ch}>`, grade(ch));
        break;
      }
    }
  };
  return m;
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

/** Squeeze a decal's 0..1 UVs into an atlas sub-rectangle. */
function remapUV(g, u0, u1, v0, v1) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, lerp(u0, u1, uv.getX(i)), lerp(v0, v1, uv.getY(i)));
  }
  uv.needsUpdate = true;
  return g;
}

/* =============================================================== factory ==== */

export function createTrackMesh(engine, world, track, opts = {}) {
  const o = Object.assign({
    ds: 2.2,               // longitudinal tessellation
    runoff: 6.5,           // gravel/verge each side
    kerbWidth: 1.18,
    kerbRise: 0.205,
    kerbDrop: 0.30,        // height of the outer face below the kerb top
    kerbCurv: 0.0055,      // curvature above which a corner earns *red/white* kerbing
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
  /**
   * ONE surface for the whole circuit.
   *
   * The old build emitted a tarmac ribbon and a separate "gravel" ribbon wherever the source
   * way was unsealed, gave them different palettes, and then painted identical lane markings
   * and racing kerbs on both — so the same lap alternated between chocolate dirt and grey
   * asphalt with a visible seam mid-frame where the two overlapped. A race circuit is one
   * surface: this is a moshav chip-seal, dark limestone-chipped binder end to end.
   *
   * The palette stays NEUTRAL here. The scene's key light and grade skew a neutral albedo hard
   * to orange, but the correction for that belongs on the lit result, not on the albedo — see
   * `uSat` / `uTint` in `createSurfaceMaterial`.
   *
   * Markings are NOT baked here (`centre: null, edge: false`) — the material draws them
   * analytically so they survive to the horizon.
   */
  const surfTex = buildRoadTextures({
    total: NOMW + MARGIN * 2, road: NOMW, vMetres: 24, kind: 'gravel',
    centre: null, edge: false,
    seed: 771, normalStrength: 1.05, W: 640, H: 1536,
    edgeInset: 0.62, edgeHalf: 0.115, dustWidth: 0.50,
    base: [0.045, 0.0445, 0.047],
    shoulder: [0.150, 0.140, 0.112],
    polish: [{ at: 0, w: 3.05, k: 0.78 }, { at: 4.95, w: 0.95, k: 0.34 }],
  });
  for (const t of [surfTex.map, surfTex.normalMap, surfTex.roughnessMap]) t.anisotropy = 16;
  const matSurface = createSurfaceMaterial(surfTex, { startS: track.startS, length: track.length });
  const vergeTex = vergeTextures();
  const matVerge = createRoadMaterial(vergeTex, { normalScale: 1.15, offsetFactor: -1, offsetUnits: -2 });
  matVerge.vertexColors = true;
  matVerge.map.wrapS = THREE.RepeatWrapping;
  matVerge.normalMap.wrapS = THREE.RepeatWrapping;
  matVerge.roughnessMap.wrapS = THREE.RepeatWrapping;

  /** Merge a list of strip geometries, carrying every attribute they share. */
  function mergeStrips(list) {
    list = list.filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1) { list[0].computeBoundingSphere(); return list[0]; }
    const names = Object.keys(list[0].attributes).filter(n => list.every(g => g.attributes[n]));
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
    const out = new THREE.BufferGeometry();
    for (const n of names) {
      const size = list[0].attributes[n].itemSize;
      const arr = new Float32Array(nv * size);
      let vo = 0;
      for (const g of list) { arr.set(g.attributes[n].array, vo * size); vo += g.attributes.position.count; }
      out.setAttribute(n, new THREE.BufferAttribute(arr, size));
    }
    const idx = nv > 65000 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const g of list) {
      const ix = g.index.array;
      for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
      vo += g.attributes.position.count; io += ix.length;
    }
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  /**
   * Build a longitudinal strip.
   *
   * Lanes are `[lateralOffset, heightAboveTrackPlane, u, drapeBlend, tint]`. `tint` is
   * optional; when any lane supplies one the strip gains a vertex-colour attribute, which is
   * how the run-off fades from a dark verge next to the kerb out to the hillside albedo
   * without leaving the dead-straight value seam the critics flagged.
   *
   * `opt.road` adds the `aRoad` attribute (lateral metres, half-width metres, unwrapped
   * distance along) the surface shader needs, and switches vertex normals from a finite
   * difference over the quad grid to the EXACT plane of the track at that station. That
   * change is what removes the faint regular grid of darker lines the critics could see
   * through the tarmac: a piecewise-linear normal field over a 1.7 x 2.2 m quad grid creases
   * at every quad boundary, and the eye reads those creases as ruled lines.
   */
  function buildStrip(mask, laneFn, vScale, drape, opt = {}) {
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
      const wantCol = lanes0.some(l => l.length > 4);
      const pos = new Float32Array(M * L * 3), nor = new Float32Array(M * L * 3), uv = new Float32Array(M * L * 2);
      const col = wantCol ? new Float32Array(M * L * 3) : null;
      const road = opt.road ? new Float32Array(M * L * 3) : null;
      for (let r = 0; r < M; r++) {
        const sm = samples[run[r]];
        const sAbs = run[r] * ds;
        const lanes = laneFn(sm);
        for (let k = 0; k < L; k++) {
          const off = lanes[k][0], up = lanes[k][1], u = lanes[k][2], blend = lanes[k][3] || 0;
          if (col) {
            const c = lanes[k][4] || [1, 1, 1], c3 = (r * L + k) * 3;
            col[c3] = c[0]; col[c3 + 1] = c[1]; col[c3 + 2] = c[2];
          }
          const x = sm.pos.x + sm.normal.x * off, z = sm.pos.z + sm.normal.z * off;
          let y = sm.pos.y + Math.tan(sm.banking) * off + up;
          if (drape && blend > 0) {
            const th = world.heightAt(x, z);
            y = lerp(y, clamp(th, y - 8, y + 8), blend);
          }
          const i3 = (r * L + k) * 3;
          pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
          const i2 = (r * L + k) * 2;
          uv[i2] = u; uv[i2 + 1] = sAbs * vScale;
          if (road) { road[i3] = off; road[i3 + 1] = sm.width * 0.5; road[i3 + 2] = sAbs; }
        }
      }
      const gi = (r, k) => (clamp(r, 0, M - 1) * L + clamp(k, 0, L - 1)) * 3;
      if (opt.road) {
        // Exact plane of the road at each station: the across-vector is the track normal
        // tilted by the banking, the along-vector is the 3D tangent. Constant across a row
        // and smooth along the lap, so there is no crease at a quad boundary to shade.
        for (let r = 0; r < M; r++) {
          const sm = samples[run[r]];
          const tb = Math.tan(sm.banking);
          const al = 1 / Math.hypot(sm.normal.x, tb, sm.normal.z);
          const ax = sm.normal.x * al, ay = tb * al, az = sm.normal.z * al;
          const t = sm.tangent;
          let nx = ay * t.z - az * t.y, ny = az * t.x - ax * t.z, nz = ax * t.y - ay * t.x;
          if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
          const l = Math.hypot(nx, ny, nz) || 1;
          for (let k = 0; k < L; k++) {
            const o3 = (r * L + k) * 3;
            nor[o3] = nx / l; nor[o3 + 1] = ny / l; nor[o3 + 2] = nz / l;
          }
        }
      } else for (let r = 0; r < M; r++) for (let k = 0; k < L; k++) {
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
      if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (road) g.setAttribute('aRoad', new THREE.BufferAttribute(road, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      geoms.push(g);
    }
    return mergeStrips(geoms);
  }

  // hard surface lanes: 13 across, with a parabolic crown
  const HARD_L = 13;
  const hardLanes = sm => {
    const hw = sm.width * 0.5, out = [];
    const span = hw + MARGIN;
    for (let k = 0; k < HARD_L; k++) {
      const t = k / (HARD_L - 1) * 2 - 1;      // -1..1
      const off = t * span;
      const crown = 0.085 * (1 - Math.min(1, (Math.abs(off) / hw) ** 2));
      out.push([off, crown, 0.5 + t * 0.5, 0]);
    }
    return out;
  };
  /**
   * Run-off lanes for one side.
   *
   * Starts *under* the outer face of the kerb (so the kerb's drop face has something to land
   * on and never floats), sits a clear step below the racing surface, then drapes onto the
   * real hillside. The tint runs dark at the road edge and brightens to roughly hillside albedo
   * at the outer lip, which feathers the polygon boundary instead of leaving a straight seam.
   */
  const runoffLanes = side => sm => {
    const hw = sm.width * 0.5, R = o.runoff;
    // The verge now starts right at the road edge, not outboard of the kerb. Kerbs only exist
    // at corners, so anchoring the run-off to the kerb left a 1.2 m strip of nothing wherever
    // there was no kerb to cover it.
    const inner = hw + 0.14;
    const fr = [0.0, 0.03, 0.10, 0.20, 0.40, 0.68, 1.0];
    const tint = f => {
      const t = clamp((f - 0.50) / 0.50, 0, 1) ** 1.25;
      return [lerp(1.0, 1.72, t), lerp(1.0, 1.70, t), lerp(1.0, 1.62, t)];
    };
    return fr.map(f => {
      const off = side * (inner + f * R);
      // Sit 5 cm ABOVE the bottom edge of a kerb's drop face, so where there IS a kerb its
      // face buries into the verge instead of stopping short and leaving a sliver of daylight.
      const up = (o.kerbRise - o.kerbDrop) + 0.05 - f * 0.20;
      return [off, up, side * (inner + f * R) / 3.2, f < 0.02 ? 0 : f * f * (3 - 2 * f), tint(f)];
    }).concat([[side * (inner + R + 1.6), -1.0, side * (inner + R + 1.6) / 3.2, 1, tint(1.35)]]);
  };

  const allMask = new Float32Array(N + 1).fill(1);
  {
    const g = buildStrip(allMask, hardLanes, 1 / 24, false, { road: true });
    if (g) {
      const m = new THREE.Mesh(g, matSurface);
      m.name = 'circuit:tarmac'; m.receiveShadow = o.shadows; m.renderOrder = 3;
      group.add(m);
    }
  }
  for (const side of [-1, 1]) {
    const g = buildStrip(allMask, runoffLanes(side), 1 / 3.2, true);
    if (!g) continue;
    const m = new THREE.Mesh(g, matVerge);
    m.name = 'circuit:runoff'; m.receiveShadow = o.shadows; m.renderOrder = 1;
    group.add(m);
  }

  /* -------------------------------------------------------------- kerbs --- */
  // ONE kerb language, and only where a kerb means something.
  //
  // The old build ran a kerb round the entire lap and switched livery between red/white and
  // pale limestone, which put racing kerbing along kilometres of open countryside, destroyed
  // its value as a corner-reading cue and made the circuit look like it had been built by
  // three different people. MK8 kerbs mark apexes: so does this one now.
  const matKerb = new THREE.MeshStandardMaterial({
    map: kerbTexture(), roughness: 0.78, metalness: 0, side: THREE.DoubleSide,
  });

  const kerbL = new Float32Array(N + 1), kerbR = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const c = samples[i].curvature || 0;
    const mag = clamp((Math.abs(c) - o.kerbCurv) / 0.010, 0, 1);
    if (c > 0) { kerbR[i] = mag; kerbL[i] = mag * 0.70; }   // left-hander: inside is left
    else if (c < 0) { kerbL[i] = mag; kerbR[i] = mag * 0.70; }
  }
  // smear so the kerb leads into and out of the corner it marks
  for (const arr of [kerbL, kerbR]) {
    const src = Float32Array.from(arr);
    for (let i = 0; i <= N; i++) {
      let m = 0;
      for (let d = -6; d <= 6; d++) m = Math.max(m, src[(i + d + N) % N] * (1 - Math.abs(d) / 8));
      arr[i] = m > 0.42 ? 1 : 0;
    }
  }
  for (const [side, corner] of [[-1, kerbL], [1, kerbR]]) {
    const g = kerbStrip(samples, side, corner, o, null);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, matKerb);
    mesh.name = 'circuit:kerb'; mesh.receiveShadow = o.shadows; mesh.castShadow = o.shadows;
    mesh.renderOrder = 4;
    group.add(mesh);
  }

  /* ------------------------------------------------------------- paint ---- */
  const paints = new THREE.Group(); paints.name = 'circuit:paint';
  {
    // The start/finish chequer and the white rails either side of it are NOT here any more.
    // A projected decal quad can never stay in register with a curving, banked, cambered
    // ribbon: it overhung onto the dirt on one side, cut off square on the other, and its
    // grid axis drifted off the road direction. It is now drawn by the surface shader from
    // the road's own coordinates, so it is aligned by construction. See `createSurfaceMaterial`.

    /* --- numbered starting boxes ------------------------------------------- */
    const gridTex = gridBoxTexture(256);
    const gridMat = new THREE.MeshStandardMaterial({
      map: gridTex, roughness: 0.6, metalness: 0, transparent: true, alphaTest: 0.04,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16,
    });
    const gridGeos = [];
    track.startGrid.forEach((g, i) => {
      const n = track.nearest(g.pos);
      const q = decalGeometry(track, n.s - 1.85, n.s + 1.85, n.lateral - 1.55, n.lateral + 1.55, 0.052);
      const col = i % 4, row = (i / 4) | 0;
      remapUV(q, col / 4, (col + 1) / 4, 1 - (row + 1) / 4, 1 - row / 4);
      gridGeos.push(q);
    });
    const gridMerged = mergeGeoms(gridGeos);
    if (gridMerged) {
      const gm = new THREE.Mesh(gridMerged, gridMat);
      gm.name = 'circuit:grid'; gm.renderOrder = 6; paints.add(gm);
    }
  }
  group.add(paints);

  /* ------------------------------------------- start-line furniture ------- */
  // The circuit-wide extruded kerb already brackets the crossing, so the old run of loose
  // red/white boxes (which floated above the surface with a visible seam in photoFinish) is
  // gone. What is left is the pair of waist-high chequered walls that carry the line at
  // distance.
  {
    const q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    // chequered walls: 1.0 m tall, so they are ~12 px on screen from the back of the grid
    const wallTex = chequerTexture(6, 2, 96);
    wallTex.wrapS = THREE.RepeatWrapping; wallTex.repeat.set(1, 1);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, metalness: 0 });
    const wg = new THREE.BoxGeometry(0.50, 1.60, 5.4);
    const wallInst = new THREE.InstancedMesh(wg, wallMat, 2);
    [-1, 1].forEach((sgn, i) => {
      const s2 = track.sample(track.startS);
      const off = sgn * (s2.width * 0.5 + 2.55);
      const x = s2.pos.x + s2.normal.x * off, z = s2.pos.z + s2.normal.z * off;
      const gy = Math.min(s2.pos.y + Math.tan(s2.banking) * off, world.heightAt(x, z)) + 0.78;
      q.setFromEuler(new THREE.Euler(0, Math.atan2(s2.tangent.x, s2.tangent.z), 0));
      wallInst.setMatrixAt(i, new THREE.Matrix4().compose(v.set(x, gy, z), q, sc));
    });
    wallInst.name = 'circuit:startwall';
    wallInst.castShadow = o.shadows; wallInst.receiveShadow = o.shadows;
    wallInst.instanceMatrix.needsUpdate = true;
    group.add(wallInst);
  }

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
    materials: { tarmac: matSurface, surface: matSurface, kerb: matKerb, verge: matVerge },
    update(dt, elapsed) { furniture?.update?.(dt, elapsed); },
    dispose() {
      group.traverse(n => n.geometry?.dispose?.());
      engine.scene.remove(group);
    },
  };
  engine.add(api);
  return api;
}

/**
 * Kerb strip on one side.
 *
 * Six lanes give a real MK-style extrusion instead of a painted stripe: a shallow ramp off the
 * racing surface, a steep front chamfer, a flat rumble top, an outer chamfer and a vertical
 * drop face onto the verge. `mask` is the corner mask, so an isolated run tapers its rise and
 * drop back to zero over four stations and the kerb grows out of the road at a corner entry
 * instead of starting with a step. `colOf` is vestigial — there is only one livery now.
 */
function kerbStrip(samples, side, mask, o, colOf) {
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
  //          road lip | front chamfer | top in | top out | outer chamfer | drop face
  const uAcross = [0.03, 0.10, 0.22, 0.82, 0.94, 0.99];
  for (const run of runs) {
    const M = run.length, L = 6;
    const closed = M === N + 1;         // the whole lap: never taper, the ends meet
    const pos = new Float32Array(M * L * 3), nor = new Float32Array(M * L * 3), uv = new Float32Array(M * L * 2);
    for (let r = 0; r < M; r++) {
      const i = run[r];
      const sm = samples[i];
      const hw = sm.width * 0.5, kw = o.kerbWidth;
      // taper an isolated kerb in and out; a closed lap stays full height throughout
      const fade = closed ? 1 : clamp(Math.min(r, M - 1 - r) / 4, 0, 1);
      const rise = o.kerbRise * fade, drop = o.kerbDrop * fade;
      // A ~45 degree front chamfer over 0.22 m, then a flat rumble top. The first version
      // spread the rise over 0.56 m, which read as a gentle bank rather than a kerb.
      const offs = [hw - 0.07, hw + 0.05, hw + 0.16, hw + kw - 0.15, hw + kw, hw + kw];
      const ups = [0.004, rise * 0.52, rise, rise * 0.97, rise * 0.64, rise - drop];
      void colOf;
      for (let k = 0; k < L; k++) {
        const off = side * offs[k];
        const x = sm.pos.x + sm.normal.x * off, z = sm.pos.z + sm.normal.z * off;
        const y = sm.pos.y + Math.tan(sm.banking) * off + ups[k];
        const i3 = (r * L + k) * 3;
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        const i2 = (r * L + k) * 2;
        // Single livery, so U spans the whole texture. V is driven straight off arc length,
        // so the red/white pitch is 0.95 m everywhere and on both sides of the circuit.
        uv[i2] = uAcross[k];
        uv[i2 + 1] = sm.s / 1.9;
      }
    }
    const gi = (r, k) => (clamp(r, 0, M - 1) * L + clamp(k, 0, L - 1)) * 3;
    // The strip winds consistently across k, so the cross-product sign is decided ONCE per
    // row from the rumble top (which must face up). Flipping per vertex — the old rule —
    // turned the vertical drop face's outward normal upward and killed its shading, which is
    // exactly why the kerbs read as flat paint.
    for (let r = 0; r < M; r++) {
      let sgn = 1;
      {
        const a = gi(r - 1, 2), b = gi(r + 1, 2), c = gi(r, 1), d = gi(r, 3);
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
        sgn = (uz * vx - ux * vz) < 0 ? -1 : 1;
      }
      for (let k = 0; k < L; k++) {
        const a = gi(r - 1, k), b = gi(r + 1, k), c = gi(r, k - 1), d = gi(r, k + 1);
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[d] - pos[c], vy = pos[d + 1] - pos[c + 1], vz = pos[d + 2] - pos[c + 2];
        let nx = (uy * vz - uz * vy) * sgn, ny = (uz * vx - ux * vz) * sgn, nz = (ux * vy - uy * vx) * sgn;
        const l = Math.hypot(nx, ny, nz) || 1;
        const o3 = (r * L + k) * 3;
        nor[o3] = nx / l; nor[o3 + 1] = ny / l; nor[o3 + 2] = nz / l;
      }
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
