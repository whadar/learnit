/**
 * Real-world data for Moshav Amikam (32.5636 N, 35.0208 E), Ramot Menashe, Israel.
 *   elevation — AWS Terrain Tiles (SRTM 1-arcsec derived), resampled to a 3 m metric grid
 *   vectors   — Overture Maps 2026-08-19.0 (OSM-derived): buildings, roads, land use, water
 * World units are metres. +X east, +Z south, +Y up. Origin is the centre of the moshav.
 */
import { clamp } from '../core/mathx.js';

export class WorldData {
  constructor(json, heights) {
    this.meta = json.meta;
    this.t = json.terrain;
    this.heights = heights;                       // Float32Array, res*res, row-major from -extent/2
    this.buildings = json.buildings;
    this.roads = json.roads;
    this.landuse = json.landuse;
    this.landcover = json.landcover;
    this.water = json.water;
    this.res = this.t.res; this.extent = this.t.extent; this.step = this.t.step;
    this.half = this.extent / 2;
    this.minH = this.t.min; this.maxH = this.t.max;
  }

  /** @param {string} base asset directory  @param {string} slug which world to load */
  static async load(base = 'data/', slug = 'amikam') {
    const [json, bin] = await Promise.all([
      fetch(`${base}${slug}.json`).then(r => r.json()),
      fetch(`${base}${slug}-height.bin`).then(r => r.arrayBuffer()),
    ]);
    return new WorldData(json, new Float32Array(bin));
  }

  /** Raw heightfield sample by grid index (clamped at the borders). */
  gridH(i, j) {
    const r = this.res;
    return this.heights[clamp(j, 0, r - 1) * r + clamp(i, 0, r - 1)];
  }

  /** Bilinear terrain height (metres above sea level) at world x/z. */
  heightAt(x, z) {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    const i = Math.floor(fx), j = Math.floor(fz), sx = fx - i, sz = fz - j;
    const h00 = this.gridH(i, j), h10 = this.gridH(i + 1, j);
    const h01 = this.gridH(i, j + 1), h11 = this.gridH(i + 1, j + 1);
    return (h00 * (1 - sx) + h10 * sx) * (1 - sz) + (h01 * (1 - sx) + h11 * sx) * sz;
  }

  /** Surface normal from central differences. `out` is any {x,y,z}. */
  normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const d = this.step;
    const hl = this.heightAt(x - d, z), hr = this.heightAt(x + d, z);
    const hd = this.heightAt(x, z - d), hu = this.heightAt(x, z + d);
    const nx = hl - hr, nz = hd - hu, ny = 2 * d;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** Steepest-slope angle in radians at world x/z. */
  slopeAt(x, z) { const n = this.normalAt(x, z); return Math.acos(clamp(n.y, -1, 1)); }

  inBounds(x, z) { return Math.abs(x) < this.half && Math.abs(z) < this.half; }

  /** Lon/lat of a world position — used for sun position and for reporting. */
  toLonLat(x, z) {
    return { lon: this.meta.origin.lon + x / this.meta.mPerDegLon,
             lat: this.meta.origin.lat - z / this.meta.mPerDegLat };
  }
}
