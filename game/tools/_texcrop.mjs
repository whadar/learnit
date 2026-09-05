import { PNG } from 'pngjs'; import fs from 'node:fs';
const src = PNG.sync.read(fs.readFileSync(process.argv[2]));
const x0=+process.argv[3]||0, y0=+process.argv[4]||0, w=+process.argv[5]||src.width, h=+process.argv[6]||src.height;
const out = new PNG({width:w,height:h});
for(let j=0;j<h;j++)for(let i=0;i<w;i++){const s=((j+y0)*src.width+(i+x0))*4,d=(j*w+i)*4;
 out.data[d]=src.data[s];out.data[d+1]=src.data[s+1];out.data[d+2]=src.data[s+2];out.data[d+3]=255;}
fs.writeFileSync(process.argv[7], PNG.sync.write(out));
