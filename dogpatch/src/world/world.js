/**
 * The world: a 1025x1025 heightfield over 3072 m, plus the real Overture vectors.
 *
 * Everything downstream — terrain mesh, physics, AI, buildings — samples height through here,
 * so there is exactly one definition of where the ground is.
 *
 * Coordinates are metres, +X east, +Z south, origin at the centre of the box.
 */
export class World {
  constructor(json, heights) {
    Object.assign(this, json);
    this.h = heights;
    this.res = json.terrain.res;
    this.extent = json.terrain.extent;
    this.step = json.terrain.step;
    this.half = json.terrain.extent / 2;
  }

  static async load(base = 'data/') {
    const [json, bin] = await Promise.all([
      fetch(base + 'world.json').then(r => r.json()),
      fetch(base + 'world-height.bin').then(r => r.arrayBuffer()),
    ]);
    return new World(json, new Float32Array(bin));
  }

  /** Grid height, clamped at the edges so sampling outside the box never reads garbage. */
  grid(i, j) {
    const r = this.res;
    i = i < 0 ? 0 : i > r - 1 ? r - 1 : i;
    j = j < 0 ? 0 : j > r - 1 ? r - 1 : j;
    return this.h[j * r + i];
  }

  /** Bilinear height at a world position. */
  heightAt(x, z) {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    const i = Math.floor(fx), j = Math.floor(fz), sx = fx - i, sz = fz - j;
    const a = this.grid(i, j), b = this.grid(i + 1, j), c = this.grid(i, j + 1), d = this.grid(i + 1, j + 1);
    return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
  }

  /** Unit surface normal, from central differences one grid step apart. */
  normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const d = this.step;
    const nx = this.heightAt(x - d, z) - this.heightAt(x + d, z);
    const nz = this.heightAt(x, z - d) - this.heightAt(x, z + d);
    const ny = 2 * d, l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  inBounds(x, z) { return Math.abs(x) < this.half && Math.abs(z) < this.half; }

  /**
   * Grade the heightfield to the circuit's own draped height, the way a real road corridor is cut.
   *
   * Without this the road ribbon is flat across its width while the ground under it keeps its
   * natural cross-slope, so the terrain rises through the asphalt and eats the verge in ragged
   * tan wedges — measured at 22 cm of terrain standing proud of the road surface. Grade the
   * ground to the road instead of bending the road to the ground: the circuit is the reference.
   *
   * Must run after buildTrack (which reads these heights to drape itself) and before the terrain
   * mesh is built from them.
   */
  carve(track, opts = {}) {
    const flat = opts.flat ?? 10.5;              // fully graded out to here, metres
    const blend = opts.blend ?? 7;               // then eased back to the natural ground
    const r = this.res, step = this.step, half = this.half;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of track.points) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1];
    }
    const pad = flat + blend + step;
    const gi0 = Math.max(0, Math.floor((x0 - pad + half) / step)), gi1 = Math.min(r - 1, Math.ceil((x1 + pad + half) / step));
    const gj0 = Math.max(0, Math.floor((z0 - pad + half) / step)), gj1 = Math.min(r - 1, Math.ceil((z1 + pad + half) / step));
    const q = { x: 0, z: 0 };
    for (let j = gj0; j <= gj1; j++) {
      for (let i = gi0; i <= gi1; i++) {
        q.x = -half + i * step; q.z = -half + j * step;
        const n = track.nearest(q);
        const d = Math.abs(n.lateral);
        if (d > flat + blend) continue;
        const t = d <= flat ? 1 : 1 - (d - flat) / blend;
        const k = t * t * (3 - 2 * t);           // smoothstep, so there is no crease at the edge
        const idx = j * r + i;
        this.h[idx] += (n.y - this.h[idx]) * k;
      }
    }
    return this;
  }
}
