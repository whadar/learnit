import fs from 'node:fs'; import { PNG } from 'pngjs';
const [,, src, ...pts] = process.argv;
const p = PNG.sync.read(fs.readFileSync(src));
for (const s of pts) {
  const [x,y,w=6] = s.split(',').map(Number);
  let r=0,g=0,b=0,n=0;
  for (let j=y-w;j<=y+w;j++) for(let i=x-w;i<=x+w;i++){ const k=(j*p.width+i)*4; r+=p.data[k];g+=p.data[k+1];b+=p.data[k+2];n++; }
  console.log(`${x},${y}: ${(r/n).toFixed(0)},${(g/n).toFixed(0)},${(b/n).toFixed(0)}`);
}
