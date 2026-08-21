import fs from 'fs';
import { PNG } from 'pngjs';
const [,, src, X, Y, W, H, S, out] = process.argv;
const png = PNG.sync.read(fs.readFileSync(src));
const x=+X,y=+Y,w=+W,h=+H,s=+S;
const dst = new PNG({width:w*s, height:h*s});
for (let j=0;j<h*s;j++) for (let i=0;i<w*s;i++){
  const sx=Math.min(png.width-1,x+((i/s)|0)), sy=Math.min(png.height-1,y+((j/s)|0));
  const a=(sy*png.width+sx)*4, b=(j*w*s+i)*4;
  dst.data[b]=png.data[a];dst.data[b+1]=png.data[a+1];dst.data[b+2]=png.data[a+2];dst.data[b+3]=255;
}
fs.writeFileSync(out, PNG.sync.write(dst));
console.log(out);
