// Converts real Amikam GIS data (Overture + SRTM/Terrarium) into the game's world asset.
// Output: public/data/amikam.json (metadata + vectors) and public/data/amikam-height.bin (Float32 heightfield)
import fs from 'node:fs'; import { PNG } from 'pngjs';

const ORIGIN = { lat: 32.5636, lon: 35.0208 };           // Moshav Amikam, Ramot Menashe, Israel
const R = 6378137;
const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * ORIGIN.lat * Math.PI / 180) + 1.175 * Math.cos(4 * ORIGIN.lat * Math.PI / 180);
const mPerDegLon = 111412.84 * Math.cos(ORIGIN.lat * Math.PI / 180) - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180);
const toWorld = ([lon, lat]) => [ (lon - ORIGIN.lon) * mPerDegLon, -(lat - ORIGIN.lat) * mPerDegLat ]; // [x(east), z(south+)]

// ---- Heightfield from terrarium tiles -------------------------------------------------
const Z = 15, n = 2 ** Z, CX = 19570, CY = 13246, RT = 2, T = 256;
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
const tileX = lon => (lon + 180) / 360 * n;
const tileY = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
function elevAt(lon, lat) {
  const fx = (tileX(lon) - (CX - RT)) * T, fy = (tileY(lat) - (CY - RT)) * T;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), sx = fx - x0, sy = fy - y0;
  const g = (x, y) => raw[Math.min(GW - 1, Math.max(0, y)) * GW + Math.min(GW - 1, Math.max(0, x))];
  return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
}

// Resample onto a regular metric grid centred on the origin: EXTENT m across, RES posts.
const EXTENT = 3072, RES = 1025;                     // 3 m per post
const step = EXTENT / (RES - 1);
const height = new Float32Array(RES * RES);
let hmin = Infinity, hmax = -Infinity;
for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
  const x = -EXTENT / 2 + i * step, z = -EXTENT / 2 + j * step;
  const lon = ORIGIN.lon + x / mPerDegLon, lat = ORIGIN.lat - z / mPerDegLat;
  const e = elevAt(lon, lat);
  height[j * RES + i] = e; if (e < hmin) hmin = e; if (e > hmax) hmax = e;
}
fs.mkdirSync('public/data', { recursive: true });
fs.writeFileSync('public/data/amikam-height.bin', Buffer.from(height.buffer));

// ---- Vectors ---------------------------------------------------------------------------
const rd = v => Math.round(v * 100) / 100;
const ring = r => r.map(c => toWorld(c).map(rd));
const J = f => JSON.parse(fs.readFileSync(f, 'utf8'));

const B = J('data/amikam-buildings.json');
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

const world = {
  meta: {
    place: 'Moshav Amikam, Ramot Menashe, Haifa District, Israel',
    origin: ORIGIN, mPerDegLat: rd(mPerDegLat), mPerDegLon: rd(mPerDegLon),
    sources: {
      elevation: 'AWS Terrain Tiles (elevation-tiles-prod, SRTM 1-arcsec derived), z15 terrarium',
      vectors: 'Overture Maps Foundation release 2026-08-19.0 (OSM-derived)',
    },
  },
  terrain: { file: 'amikam-height.bin', res: RES, extent: EXTENT, step, min: rd(hmin), max: rd(hmax) },
  buildings,
  roads: conv('data/amikam-transportation-segment.json', f => ({ surface: f.road_surface || f.surface, width: f.width })),
  landuse: conv('data/amikam-base-land_use.json'),
  landcover: conv('data/amikam-base-land_cover.json'),
  water: conv('data/amikam-base-water.json'),
};
fs.writeFileSync('public/data/amikam.json', JSON.stringify(world));
console.log(JSON.stringify({
  heightfield: `${RES}x${RES} @ ${step}m  elev ${rd(hmin)}..${rd(hmax)}m`,
  buildings: buildings.length, roads: world.roads.length, landuse: world.landuse.length,
  landcover: world.landcover.length, water: world.water.length,
  json_MB: +(fs.statSync('public/data/amikam.json').size / 1048576).toFixed(2),
  bin_MB: +(fs.statSync('public/data/amikam-height.bin').size / 1048576).toFixed(2),
}, null, 1));
