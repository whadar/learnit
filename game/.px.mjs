import fs from 'node:fs'; import {PNG} from 'pngjs';
const [file,...rest]=process.argv.slice(2);
const p=PNG.sync.read(fs.readFileSync(file));
for(const spec of rest){
  const [x,y,w,h]=spec.split(',').map(Number);
  let r=0,g=0,b=0,n=0,mn=[255,255,255],mx=[0,0,0];
  for(let j=y;j<y+(h||1);j++)for(let i=x;i<x+(w||1);i++){
    const k=(j*p.width+i)*4; r+=p.data[k];g+=p.data[k+1];b+=p.data[k+2];n++;
    for(let c=0;c<3;c++){mn[c]=Math.min(mn[c],p.data[k+c]);mx[c]=Math.max(mx[c],p.data[k+c]);}
  }
  console.log(spec,'mean',(r/n).toFixed(1),(g/n).toFixed(1),(b/n).toFixed(1),'min',mn.join('/'),'max',mx.join('/'));
}
