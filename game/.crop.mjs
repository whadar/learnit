import fs from 'node:fs'; import {PNG} from 'pngjs';
const [,,src,x0,y0,w,h,scale,out]=process.argv;
const png=PNG.sync.read(fs.readFileSync(src));
const S=+scale||1, W=+w, H=+h, X=+x0, Y=+y0;
const o=new PNG({width:W*S,height:H*S});
for(let y=0;y<H*S;y++)for(let x=0;x<W*S;x++){
  const sx=X+Math.floor(x/S), sy=Y+Math.floor(y/S);
  const si=((sy*png.width)+sx)<<2, di=((y*o.width)+x)<<2;
  o.data[di]=png.data[si];o.data[di+1]=png.data[si+1];o.data[di+2]=png.data[si+2];o.data[di+3]=255;
}
fs.writeFileSync(out,PNG.sync.write(o));
// stats
let mx=0,clip=0,n=0;
for(let y=Y;y<Y+H;y++)for(let x=X;x<X+W;x++){const i=((y*png.width)+x)<<2;const l=0.2126*png.data[i]+0.7152*png.data[i+1]+0.0722*png.data[i+2];mx=Math.max(mx,l);if(l>244)clip++;n++;}
console.log('maxLum',mx.toFixed(0),'clipped%',(100*clip/n).toFixed(2));
