/**
 * Turn real GIS data (Overture vectors + SRTM/Terrarium elevation) into the game's world asset.
 *
 *   node tools/build-world.mjs             # amikam (default)
 *   node tools/build-world.mjs dogpatch
 *
 * Writes public/data/<slug>.json (metadata + vectors) and public/data/<slug>-height.bin
 * (Float32 heightfield, RES x RES posts over EXTENT metres, centred on the place's origin).
 *
 * Place constants live in tools/places.mjs. Note that a place's DEM tile centre is not
 * necessarily its origin — Amikam's tiles were fetched before its coordinates were corrected —
 * so the pyramid is addressed by `dem` and the metric grid by `origin`.
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { placeOf, tileOf, metresPerDegree } from './places.mjs';

const P = placeOf(process.argv[2] || 'amikam');
const ORIGIN = P.origin;
const mpd = metresPerDegree(ORIGIN.lat);
const mPerDegLat = mpd.lat, mPerDegLon = mpd.lon;
const toWorld = ([lon, lat]) => [(lon - ORIGIN.lon) * mPerDegLon, -(lat - ORIGIN.lat) * mPerDegLat]; // [x(east), z(south+)]

// ---- Heightfield from terrarium tiles -------------------------------------------------
const Z = 15, n = 2 ** Z, RT = P.demRadius, T = 256;
const { x: CX, y: CY } = tileOf(P.dem.lon, P.dem.lat, Z);
const GW = (2 * RT + 1) * T;
const raw = new Float32Array(GW * GW);
for (let ty = CY - RT; ty <= CY + RT; ty++) for (let tx = CX - RT; tx <= CX + RT; tx++) {
  const p = PNG.sync.read(fs.readFileSync(`data/dem/${Z}_${tx}_${ty}.png`));
  const ox = (tx - (CX - RT)) * T, oy = (ty - (CY - RT)) * T;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const i = (y * T + x) * 4;
    raw[(oy + y) * GW + (ox + x)] = p.data[i] * 256 + p.data[i + 1] + p.data[i + 2] / 256 - 32768;
  }
}
// Sample the tile pyramid at a given lon/lat (bilinear).
const tileXf = lon => (lon + 180) / 360 * n;
const tileYf = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
function elevAt(lon, lat) {
  const fx = (tileXf(lon) - (CX - RT)) * T, fy = (tileYf(lat) - (CY - RT)) * T;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), sx = fx - x0, sy = fy - y0;
  const g = (x, y) => raw[Math.min(GW - 1, Math.max(0, y)) * GW + Math.min(GW - 1, Math.max(0, x))];
  return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
}

// Resample onto a regular metric grid centred on the origin: EXTENT m across, RES posts.
const EXTENT = P.extent, RES = P.res;
const step = EXTENT / (RES - 1);
const height = new Float32Array(RES * RES);
let hmin = Infinity, hmax = -Infinity;
for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
  const x = -EXTENT / 2 + i * step, z = -EXTENT / 2 + j * step;
  const lon = ORIGIN.lon + x / mPerDegLon, lat = ORIGIN.lat - z / mPerDegLat;
  const e = elevAt(lon, lat);
  height[j * RES + i] = e; if (e < hmin) hmin = e; if (e > hmax) hmax = e;
}

// A wrong tile centre still decodes to a perfectly plausible-looking heightfield — that is how
// Amikam shipped a kilometre off before anyone noticed — so assert the range is the right shape
// for the place before writing anything.
if (P.expect) {
  const { minM, maxM } = P.expect;
  if (hmin < minM - 25 || hmax > maxM + 25 || hmax < maxM - 45) {
    console.error(`\n!! elevation ${hmin.toFixed(1)}..${hmax.toFixed(1)} m does not look like ${P.slug}` +
      ` (expected roughly ${minM}..${maxM}). Wrong DEM tiles or wrong origin — refusing to write.\n`);
    process.exit(2);
  }
}

fs.mkdirSync('public/data', { recursive: true });
fs.writeFileSync(`public/data/${P.slug}-height.bin`, Buffer.from(height.buffer));

// ---- Vectors ---------------------------------------------------------------------------
const rd = v => Math.round(v * 100) / 100;
const ring = r => r.map(c => toWorld(c).map(rd));
const J = f => JSON.parse(fs.readFileSync(f, 'utf8'));

const B = J(`data/${P.slug}-buildings.json`);
const buildings = B.buildings.map(b => ({
  id: b.id, cls: b.class, sub: b.subtype, name: b.names,
  h: b.height, lv: b.levels, roof: b.roof_shape, rmat: b.roof_material, rcol: b.roof_color,
  fmat: b.facade_material, fcol: b.facade_color,
  rings: b.geom.map(ring),
}));

function lines(gj) {                                   // flatten Line/MultiLine/Polygon geometry
  const t = gj.type, c = gj.coordinates;
  if (t === 'LineString') return [c];
  if (t === 'MultiLineString') return c;
  if (t === 'Polygon') return c;
  if (t === 'MultiPolygon') return c.flat();
  if (t === 'Point') return [[c]];
  if (t === 'GeometryCollection') return [];
  return [];
}
const conv = (file, extra = () => ({})) => J(file).features.map(f => ({
  cls: f.class, sub: f.subtype, name: f.name, ...extra(f),
  paths: lines(f.geom).map(ring),
  poly: /Polygon/.test(f.geom.type),
}));

/* ---------------------------------------------------------------------- cull --
 * A dense place extracts far more than the world can show. Everything here is about
 * throwing away what is off-map or invisible, never about thinning what the player
 * drives past. Places without a `cull` config are passed through untouched. */
const C = P.cull;
const inBox = pts => C ? pts.some(c => Math.abs(c[0]) <= C.box && Math.abs(c[1]) <= C.box) : true;
const nearest = paths => {
  let d = Infinity;
  for (const p of paths) for (const c of p) d = Math.min(d, Math.hypot(c[0], c[1]));
  return d;
};
/** Drop vertices closer together than `minD`, always keeping the first and last. */
function thin(path, minD, prec) {
  if (path.length < 3) return path;
  const q = v => +v.toFixed(prec);
  const out = [path[0].map(q)];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= minD) out.push(b.map(q));
  }
  out.push(path[path.length - 1].map(q));
  return out;
}
const PAVEMENT = new Set(['footway', 'steps', 'sidewalk', 'crosswalk', 'path', 'pedestrian']);

function cullRoads(rs) {
  if (!C) return rs;
  return rs.filter(r => inBox(r.paths.flat()))
    .filter(r => !(PAVEMENT.has(r.cls) && nearest(r.paths) > C.footwayNear));
}
function cullBuildings(bs) {
  if (!C) return bs;
  return bs.filter(b => inBox(b.rings.flat()));
}
/** Background layers — the Bay, land cover, land use. Big, distant, and drawn flat. */
function cullBg(fs) {
  if (!C) return fs;
  return fs.filter(f => inBox(f.paths.flat()))
    .map(f => ({ ...f, paths: f.paths.map(p => thin(p, C.simplifyM, C.bgPrecision)) }));
}

const world = {
  meta: {
    place: P.place, slug: P.slug, theme: P.theme,
    origin: ORIGIN, mPerDegLat: rd(mPerDegLat), mPerDegLon: rd(mPerDegLon),
    sources: {
      elevation: 'AWS Terrain Tiles (elevation-tiles-prod, SRTM 1-arcsec derived), z15 terrarium',
      vectors: 'Overture Maps Foundation release 2026-08-19.0 (OSM-derived)',
    },
  },
  terrain: { file: `${P.slug}-height.bin`, res: RES, extent: EXTENT, step, min: rd(hmin), max: rd(hmax) },
  buildings: cullBuildings(buildings),
  roads: cullRoads(conv(`data/${P.slug}-transportation-segment.json`, f => ({ surface: f.road_surface || f.surface, width: f.width }))),
  landuse: cullBg(conv(`data/${P.slug}-base-land_use.json`)),
  landcover: cullBg(conv(`data/${P.slug}-base-land_cover.json`)),
  water: cullBg(conv(`data/${P.slug}-base-water.json`)),
};
fs.writeFileSync(`public/data/${P.slug}.json`, JSON.stringify(world));
console.log(JSON.stringify({
  place: P.slug,
  heightfield: `${RES}x${RES} @ ${step}m  elev ${rd(hmin)}..${rd(hmax)}m`,
  buildings: `${world.buildings.length} of ${buildings.length}`, roads: world.roads.length, landuse: world.landuse.length,
  landcover: world.landcover.length, water: world.water.length,
  json_MB: +(fs.statSync(`public/data/${P.slug}.json`).size / 1048576).toFixed(2),
  bin_MB: +(fs.statSync(`public/data/${P.slug}-height.bin`).size / 1048576).toFixed(2),
}, null, 1));
