/**
 * Fetch real SRTM-derived elevation (Terrarium RGB tiles, AWS Open Data) around a place.
 *
 *   node tools/fetch-dem.mjs            # amikam (default, unchanged)
 *   node tools/fetch-dem.mjs dogpatch
 *
 * Terrarium encodes height as h = R*256 + G + B/256 - 32768, so the tiles are useless unless
 * they arrive intact; anything under 100 bytes is an S3 error page, not a tile.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { placeOf, tileOf } from './places.mjs';

const P = placeOf(process.argv[2] || 'amikam');
const Z = 15, n = 2 ** Z, R = P.demRadius;
const { x: cx, y: cy } = tileOf(P.dem.lon, P.dem.lat, Z);

const jobs = [];
for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) jobs.push([x, y]);
fs.mkdirSync('data/dem', { recursive: true });
let ok = 0, fetched = 0;
for (const [x, y] of jobs) {
  const f = `data/dem/${Z}_${x}_${y}.png`;
  if (fs.existsSync(f) && fs.statSync(f).size > 100) { ok++; continue; }
  try {
    execFileSync('curl', ['-sS', '--max-time', '40', '-o', f,
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`]);
    if (fs.statSync(f).size > 100) { ok++; fetched++; }
  } catch (e) { console.error('fail', x, y, e.message); }
}
console.log(JSON.stringify({
  place: P.slug, Z, cx, cy, tiles: jobs.length, ok, fetched,
  bbox_deg: { west: (cx - R) / n * 360 - 180, east: (cx + R + 1) / n * 360 - 180 },
}));
