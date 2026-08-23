import fs from 'node:fs';
import { PNG } from 'pngjs';
const [src, x0, y0, w, h, scale, out] = process.argv.slice(2);
const p = PNG.sync.read(fs.readFileSync(src));
const X = +x0, Y = +y0, W = +w, H = +h, S = +scale;
const o = new PNG({ width: W * S, height: H * S });
for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
  const sx = Math.min(p.width - 1, X + (x / S | 0)), sy = Math.min(p.height - 1, Y + (y / S | 0));
  const i = (sy * p.width + sx) * 4, j = (y * o.width + x) * 4;
  o.data[j] = p.data[i]; o.data[j+1] = p.data[i+1]; o.data[j+2] = p.data[i+2]; o.data[j+3] = 255;
}
fs.writeFileSync(out, PNG.sync.write(o));
console.log(out);
