import fs from 'node:fs'; import { PNG } from 'pngjs';
const [,,x,y,w,h,...files]=process.argv;
for(const f of files){ const p=PNG.sync.read(fs.readFileSync(f)); const W=p.width;
 const L=(i,j)=>{const k=(j*W+i)*4;return 0.2126*p.data[k]+0.7152*p.data[k+1]+0.0722*p.data[k+2];};
 let s=0,n=0; for(let j=+y;j<+y+ +h;j++)for(let i=+x;i<+x+ +w;i++){s+=Math.abs(4*L(i,j)-L(i-1,j)-L(i+1,j)-L(i,j-1)-L(i,j+1));n++;}
 console.log(f.split('/').slice(-2).join('/').padEnd(28),'mean |lap|',(s/n).toFixed(2));}
