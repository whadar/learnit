/**
 * The places the game is built from.
 *
 * Every tool in the data pipeline used to hard-code Moshav Amikam — its origin, its DEM tile
 * numbers, its output filenames. Adding a second course meant naming those constants instead.
 *
 * `origin` is the world's (0,0): +X east, +Z south, metres. `dem` is the point the terrarium
 * tile pyramid was fetched around, which is NOT always the origin — Amikam's tiles were pulled
 * before its coordinates were corrected, so the two differ by about a kilometre and the tile
 * numbers below are the ones actually on disk. Keeping them apart is what lets Amikam rebuild
 * byte-identical while a new place is added beside it.
 */

/** z15 terrarium tile containing a lon/lat. */
export function tileOf(lon, lat, z = 15) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  return {
    x: Math.floor((lon + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
  };
}

/** Metres per degree at a latitude, WGS84, good to a few cm over a 3 km box. */
export function metresPerDegree(lat) {
  const r = lat * Math.PI / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r),
    lon: 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r),
  };
}

export const PLACES = {
  amikam: {
    slug: 'amikam',
    name: 'Amikam Village Circuit',
    place: 'Moshav Amikam, Ramot Menashe, Haifa District, Israel',
    origin: { lat: 32.5636, lon: 35.0208 },
    // fetched before the coordinates were corrected; leaving it alone keeps the build reproducible
    dem: { lat: 32.5586, lon: 35.0106 },
    extent: 3072, res: 1025, demRadius: 2,
    theme: 'levant',
    // a sanity check on the decoded DEM: if these do not come out close, the tiles are wrong
    expect: { minM: 40, maxM: 200 },
  },
  dogpatch: {
    slug: 'dogpatch',
    name: 'Dogpatch Waterfront',
    place: 'Dogpatch, San Francisco, California, USA',
    // 20th & Tennessee, the middle of the neighbourhood; the 3 km box reaches Potrero Hill in
    // the west and open Bay in the east, which is most of what gives the place its shape
    origin: { lat: 37.7570, lon: -122.3900 },
    dem: { lat: 37.7570, lon: -122.3900 },
    extent: 3072, res: 1025, demRadius: 2,
    theme: 'bayfront',
    /*
     * Dogpatch is a dense city where Amikam is a village: the raw extract is 8.0 MB against
     * Amikam's 0.33 MB, which would push the single-file build past twice its current size.
     * Nearly all of it is off-map or invisible — 3,955 of 7,668 buildings sit beyond 1500 m,
     * outside the playable box altogether, and 2,302 of 5,251 "roads" are mapped sidewalks.
     * Amikam deliberately has no cull config: it needs none, and its output has been tuned
     * over eight review rounds, so it stays byte-identical.
     */
    cull: {
      box: 1620,          // metres from origin; the world is 3072 across, so this is the edge
      footwayNear: 480,   // keep pavements near the circuit for detail, drop the rest
      simplifyM: 1.2,     // drop background vertices closer together than this
      bgPrecision: 1,     // 10 cm is plenty for the Bay's outline
    },
    // Dogpatch is reclaimed waterfront at 0-10 m rising to Potrero Hill around 70 m
    expect: { minM: -5, maxM: 110 },
  },
};

export function placeOf(slug) {
  const p = PLACES[slug];
  if (!p) throw new Error(`unknown place "${slug}" — have: ${Object.keys(PLACES).join(', ')}`);
  return p;
}
