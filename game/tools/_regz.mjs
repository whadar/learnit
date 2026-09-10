import fs from 'node:fs'; import { PNG } from 'pngjs';
const [,,x,y,w,h,...files]=process.argv;
for(const f of files){ const p=PNG.sync.read(fs.readFileSync(f)); let R=0,G=0,B=0,n=0,mn=999,mx=0;
 for(let j=+y;j<+y+ +h;j++)for(let i=+x;i<+x+ +w;i++){const k=(j*p.width+i)*4;R+=p.data[k];G+=p.data[k+1];B+=p.data[k+2];
  const l=0.2126*p.data[k]+0.7152*p.data[k+1]+0.0722*p.data[k+2]; mn=Math.min(mn,l);mx=Math.max(mx,l); n++;}
 const mean=[R/n,G/n,B/n]; const L=0.2126*mean[0]+0.7152*mean[1]+0.0722*mean[2];
 // stddev of luma
 let s=0; for(let j=+y;j<+y+ +h;j++)for(let i=+x;i<+x+ +w;i++){const k=(j*p.width+i)*4;const l=0.2126*p.data[k]+0.7152*p.data[k+1]+0.0722*p.data[k+2];s+=(l-L)**2;}
 console.log(f.split('/').slice(-2).join('/').padEnd(28), 'rgb', mean.map(v=>v.toFixed(1)).join('/'), 'L', L.toFixed(1), 'sd', Math.sqrt(s/n).toFixed(1), 'min/max', mn.toFixed(0)+'/'+mx.toFixed(0));
}
