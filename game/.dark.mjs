import fs from 'node:fs'; import {PNG} from 'pngjs';
// % of pixels below luma 12, with the HUD corners masked out
const MASK=[[0,0,320,120],[960,0,320,120],[0,220,210,300],[0,520,240,200],[1040,540,240,180],[1040,280,240,120],[420,430,440,60]];
for (const f of process.argv.slice(2)) {
  const p=PNG.sync.read(fs.readFileSync(f));
  const inMask=(x,y)=>MASK.some(([mx,my,mw,mh])=>x>=mx&&x<mx+mw&&y>=my&&y<my+mh);
  let n=0,dark=0,sum=0;
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
    if(inMask(x,y))continue;
    const i=((y*p.width)+x)<<2;
    const l=0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];
    n++; sum+=l; if(l<12)dark++;
  }
  console.log(f.split('/').pop().padEnd(20),'below12%',(100*dark/n).toFixed(2),'mean',(sum/n).toFixed(1));
}
