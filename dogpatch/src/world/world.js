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
}
