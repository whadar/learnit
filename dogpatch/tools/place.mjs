/**
 * Dogpatch, San Francisco — the one place this game is built from.
 *
 * `origin` is the world's (0,0): +X east, +Z south, metres. The 3 km box reaches Potrero Hill
 * in the west and open Bay in the east, which is most of what gives the neighbourhood its shape.
 */
export const PLACE = {
  name: 'Dogpatch, San Francisco, California, USA',
  origin: { lat: 37.7570, lon: -122.3900 },
  extent: 3072, res: 1025, demRadius: 2,
  // Reclaimed waterfront at 0-10 m rising to Potrero Hill around 70 m. A wrong tile centre still
  // decodes to a perfectly plausible heightfield, so build-world refuses to write outside this.
  expect: { minM: -5, maxM: 110 },
  // A city extracts far more than the world can show: 3,955 of 7,668 buildings sit outside the
  // playable box and 2,302 of 5,251 "roads" are mapped pavements.
  cull: { box: 1620, footwayNear: 480, simplifyM: 1.2, bgPrecision: 1 },
};

export function tileOf(lon, lat, z = 15) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return { x: Math.floor((lon + 180) / 360 * n),
           y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n) };
}

/** Metres per degree at a latitude, WGS84 — good to a few cm over a 3 km box. */
export function metresPerDegree(lat) {
  const r = lat * Math.PI / 180;
  return { lat: 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r),
           lon: 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) };
}
