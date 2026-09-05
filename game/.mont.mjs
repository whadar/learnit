import fs from 'node:fs'; import {PNG} from 'pngjs';
const [,,out,...srcs]=process.argv;
const imgs=srcs.map(f=>PNG.sync.read(fs.readFileSync(f)));
const W=imgs[0].width,H=imgs[0].height;
const o=new PNG({width:W*imgs.length,height:H});
imgs.forEach((im,k)=>{for(let y=0;y<H;y++)for(let x=0;x<W;x++){const si=((y*im.width)+x)<<2,di=((y*o.width)+(k*W+x))<<2;o.data[di]=im.data[si];o.data[di+1]=im.data[si+1];o.data[di+2]=im.data[si+2];o.data[di+3]=255;}});
fs.writeFileSync(out,PNG.sync.write(o));
