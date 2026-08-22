import fs from 'node:fs';
import { PNG } from 'pngjs';
// mean |laplacian| of luma in horizontal bands
for (const f of process.argv.slice(2)) {
  const p = PNG.sync.read(fs.readFileSync(f));
  const W = p.width, H = p.height;
  const L = new Float32Array(W*H);
  for (let k=0;k<W*H;k++) L[k]=0.2126*p.data[k*4]+0.7152*p.data[k*4+1]+0.0722*p.data[k*4+2];
  const bands = 8; const out=[];
  for (let bnd=0;bnd<bands;bnd++){
    const y0=Math.floor(H*bnd/bands)+1, y1=Math.floor(H*(bnd+1)/bands)-1;
    let s=0,n=0;
    for(let y=y0;y<y1;y++)for(let x=1;x<W-1;x++){
      const k=y*W+x;
      s+=Math.abs(4*L[k]-L[k-1]-L[k+1]-L[k-W]-L[k+W]); n++;
    }
    out.push((s/n).toFixed(1));
  }
  console.log(f.split('/').pop().padEnd(20), W+'x'+H, out.join('  '));
}
