import fs from 'node:fs';
import { PNG } from 'pngjs';
// usage: node crop.mjs in.png out.png x y w h zoom
const [,, inp, outp, X, Y, W, H, Z] = process.argv;
const x=+X, y=+Y, w=+W, h=+H, z=+(Z||1);
const src = PNG.sync.read(fs.readFileSync(inp));
const dst = new PNG({ width: Math.round(w*z), height: Math.round(h*z) });
for (let j=0;j<dst.height;j++) for (let i=0;i<dst.width;i++){
  const sx = Math.min(src.width-1, x + Math.floor(i/z));
  const sy = Math.min(src.height-1, y + Math.floor(j/z));
  const si=(sy*src.width+sx)*4, di=(j*dst.width+i)*4;
  dst.data[di]=src.data[si];dst.data[di+1]=src.data[si+1];dst.data[di+2]=src.data[si+2];dst.data[di+3]=255;
}
fs.writeFileSync(outp, PNG.sync.write(dst));
console.log(inp, src.width+'x'+src.height, '->', outp, dst.width+'x'+dst.height);
