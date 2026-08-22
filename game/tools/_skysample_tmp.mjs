import fs from 'node:fs'; import { PNG } from 'pngjs';
const dir='/home/user/learnit/game/shots/';
for (const f of ['gridStart','villageStreet','driftCorner','oliveGrove','hilltopVista','itemChaos','photoFinish']){
  const p=PNG.sync.read(fs.readFileSync(dir+f+'.png'));
  // sample a horizontal strip near the top and one at 22% height
  const rows=[Math.round(p.height*0.03),Math.round(p.height*0.10),Math.round(p.height*0.18),Math.round(p.height*0.26)];
  const out=[];
  for(const y of rows){let r=0,g=0,b=0,n=0;
    for(let x=Math.round(p.width*0.1);x<p.width*0.9;x+=4){const i=(y*p.width+x)*4;r+=p.data[i];g+=p.data[i+1];b+=p.data[i+2];n++;}
    r/=n;g/=n;b/=n;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    out.push(`y${(y/p.height*100).toFixed(0)}% (${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) s${(mx?(mx-mn)/mx:0).toFixed(3)}`);
  }
  console.log(f.padEnd(16), out.join('  '));
}
