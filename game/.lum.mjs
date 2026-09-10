import fs from 'node:fs'; import {PNG} from 'pngjs';
for (const f of process.argv.slice(2)) {
  const p=PNG.sync.read(fs.readFileSync(f));
  let clip=0,n=0,sum=0;
  for(let i=0;i<p.data.length;i+=4){const l=0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];sum+=l;if(l>244)clip++;n++;}
  console.log(f.split('/').pop().padEnd(22),'meanLum',(sum/n).toFixed(1),'clipped%',(100*clip/n).toFixed(2));
}
