import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, src, dst, X, Y, W, H, S] = process.argv;
const png = PNG.sync.read(fs.readFileSync(src));
const x0=+X, y0=+Y, w=+W, h=+H, s=+(S||1);
const out = new PNG({ width: w*s, height: h*s });
for (let y=0;y<h*s;y++) for (let x=0;x<w*s;x++){
  const sx = x0 + Math.floor(x/s), sy = y0 + Math.floor(y/s);
  const si = (sy*png.width+sx)*4, di=(y*out.width+x)*4;
  out.data[di]=png.data[si]; out.data[di+1]=png.data[si+1]; out.data[di+2]=png.data[si+2]; out.data[di+3]=255;
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log('wrote', dst, w*s+'x'+h*s);
