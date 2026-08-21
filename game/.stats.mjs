import fs from 'node:fs'; import { PNG } from 'pngjs';
// mean luminance, mean chroma (max-min)/max, % clipped, over the frame minus HUD corners
for (const f of process.argv.slice(2)) {
  const p = PNG.sync.read(fs.readFileSync(f));
  let n=0, L=0, C=0, clip=0, r0=0,g0=0,b0=0;
  for (let y=0;y<p.height;y++) for (let x=0;x<p.width;x++){
    // mask HUD: top-left 300x160, top-right 340x300, bottom-left 200x140, bottom-right 260x140
    if (x<300&&y<170) continue;
    if (x>p.width-350&&y<310) continue;
    if (x<220&&y>p.height-150) continue;
    if (x>p.width-280&&y>p.height-150) continue;
    const k=(y*p.width+x)*4, r=p.data[k],g=p.data[k+1],b=p.data[k+2];
    const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
    L += 0.2126*r+0.7152*g+0.0722*b;
    C += mx>0 ? (mx-mn)/mx : 0;
    if (mx>=250) clip++;
    r0+=r;g0+=g;b0+=b;
    n++;
  }
  console.log(f.padEnd(38), 'lum', (L/n).toFixed(1), 'chroma', (C/n).toFixed(3), 'clip%', (100*clip/n).toFixed(1), 'mean rgb', (r0/n).toFixed(0)+','+(g0/n).toFixed(0)+','+(b0/n).toFixed(0));
}
