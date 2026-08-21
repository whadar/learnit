import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, src, xs, ys, ws, hs, ss, out] = process.argv;
const x0=+xs, y0=+ys, w=+ws, h=+hs, s=+(ss||1);
const png = PNG.sync.read(fs.readFileSync(src));
const o = new PNG({ width: w*s, height: h*s });
for (let y=0;y<h*s;y++) for (let x=0;x<w*s;x++){
  const sx=Math.min(png.width-1,x0+Math.floor(x/s)), sy=Math.min(png.height-1,y0+Math.floor(y/s));
  const si=(sy*png.width+sx)*4, di=(y*o.width+x)*4;
  o.data[di]=png.data[si];o.data[di+1]=png.data[si+1];o.data[di+2]=png.data[si+2];o.data[di+3]=255;
}
fs.writeFileSync(out, PNG.sync.write(o));
console.log('wrote', out, o.width+'x'+o.height);
