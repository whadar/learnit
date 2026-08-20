import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, src, dst, X, Y, W, H, S] = process.argv;
const png = PNG.sync.read(fs.readFileSync(src));
const x=+X,y=+Y,w=+W,h=+H,s=+(S||1);
const out = new PNG({ width: w*s, height: h*s });
for (let j=0;j<h*s;j++) for (let i=0;i<w*s;i++){
  const sx=x+Math.floor(i/s), sy=y+Math.floor(j/s);
  const a=(sy*png.width+sx)*4, b=(j*out.width+i)*4;
  out.data[b]=png.data[a];out.data[b+1]=png.data[a+1];out.data[b+2]=png.data[a+2];out.data[b+3]=255;
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log('ok', dst);
