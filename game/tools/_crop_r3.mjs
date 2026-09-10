import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, src, dst, xs, ys, ws, hs, ss] = process.argv;
const x0=+xs, y0=+ys, w=+ws, h=+hs, s=+(ss||4);
const png = PNG.sync.read(fs.readFileSync(src));
const out = new PNG({ width: w*s, height: h*s });
for (let y=0; y<h*s; y++) for (let x=0; x<w*s; x++) {
  const sx = Math.min(png.width-1, x0 + Math.floor(x/s));
  const sy = Math.min(png.height-1, y0 + Math.floor(y/s));
  const si = (sy*png.width+sx)*4, di = (y*out.width+x)*4;
  out.data[di]=png.data[si]; out.data[di+1]=png.data[si+1]; out.data[di+2]=png.data[si+2]; out.data[di+3]=255;
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log('ok', dst, out.width, out.height);
