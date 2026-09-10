import { PNG } from 'pngjs'; import fs from 'node:fs';
const f = process.argv[2];
const png = PNG.sync.read(fs.readFileSync(f));
const pts = process.argv.slice(3).map(s => s.split(',').map(Number));
for (const [x,y,r=6] of pts) {
  let R=0,G=0,B=0,n=0;
  for (let j=y-r;j<=y+r;j++) for (let i=x-r;i<=x+r;i++){
    if(i<0||j<0||i>=png.width||j>=png.height) continue;
    const k=(j*png.width+i)*4; R+=png.data[k];G+=png.data[k+1];B+=png.data[k+2];n++;
  }
  console.log(`(${x},${y}) rgb ${(R/n).toFixed(0)},${(G/n).toFixed(0)},${(B/n).toFixed(0)}  L=${((0.299*R+0.587*G+0.114*B)/n/255).toFixed(3)}`);
}
