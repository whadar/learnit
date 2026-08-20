// Fetch real SRTM-derived elevation (Terrarium RGB tiles, AWS Open Data) around Amikam.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const LAT = 32.5586, LON = 35.0106, Z = 15;
const n = 2 ** Z;
const tx = (lon) => (lon + 180) / 360 * n;
const ty = (lat) => { const l = lat * Math.PI / 180; return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * n; };
const cx = Math.floor(tx(LON)), cy = Math.floor(ty(LAT));
const R = 2; // (2R+1)^2 tiles
const jobs = [];
for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) jobs.push([x, y]);
fs.mkdirSync('data/dem', { recursive: true });
let ok = 0;
for (const [x, y] of jobs) {
  const f = `data/dem/${Z}_${x}_${y}.png`;
  if (fs.existsSync(f) && fs.statSync(f).size > 100) { ok++; continue; }
  try {
    execFileSync('curl', ['-sS', '--max-time', '40', '-o', f,
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`]);
    if (fs.statSync(f).size > 100) ok++;
  } catch (e) { console.error('fail', x, y, e.message); }
}
console.log(JSON.stringify({ Z, cx, cy, tiles: jobs.length, ok,
  bbox_deg: { west: (cx - R) / n * 360 - 180, east: (cx + R + 1) / n * 360 - 180 } }));
