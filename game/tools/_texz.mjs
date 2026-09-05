import { PNG } from 'pngjs';
import fs from 'node:fs';
class Ctx {
  constructor(c){ this.c=c; }
  createImageData(w,h){ return { width:w, height:h, data:new Uint8ClampedArray(w*h*4) }; }
  putImageData(img){ this.c._img = img; }
  getImageData(){ return this.c._img; }
  fillRect(){} save(){} restore(){} translate(){} beginPath(){} fill(){} stroke(){}
}
global.document = { createElement: () => { const c = { width:0, height:0 }; c.getContext = () => (c._ctx ||= new Ctx(c)); return c; } };
global.window = global;
const SRC = process.env.RSRC || '/home/user/learnit/game/src/world/roads.js';
const { buildRoadTextures } = await import(SRC);
const OUT='/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/';
function dump(name, img){ const p=new PNG({width:img.width,height:img.height}); p.data=Buffer.from(img.data.buffer.slice(0)); fs.writeFileSync(OUT+name, PNG.sync.write(p)); console.log('wrote',name,img.width,img.height); }
// exactly the circuit surface spec from src/track/trackMesh.js
const spec = { total: 13.0+0.64, road: 13.0, vMetres: 24, kind:'gravel', centre:null, edge:false,
  seed:771, normalStrength:1.05, W:640, H:1536, edgeInset:0.62, edgeHalf:0.115, dustWidth:0.50,
  base:[0.045,0.0445,0.047], shoulder:[0.150,0.140,0.112],
  polish:[{at:0,w:3.05,k:0.78},{at:4.95,w:0.95,k:0.34}] };
const t0=Date.now();
const t = buildRoadTextures(spec);
console.log('build ms', Date.now()-t0);
dump('circ-alb.png', t.map.image._img);
dump('circ-nrm.png', t.normalMap.image._img);
// stats over the middle of the road
const d = t.map.image._img.data, W=spec.W, H=spec.H;
let s=0,n=0,lap=0;
const L=(x,y)=>{const k=(y*W+x)*4;return 0.2126*d[k]+0.7152*d[k+1]+0.0722*d[k+2];};
for(let y=1;y<H-1;y++)for(let x=Math.floor(W*0.2);x<W*0.8;x++){ s+=L(x,y);n++;
  lap+=Math.abs(4*L(x,y)-L(x-1,y)-L(x+1,y)-L(x,y-1)-L(x,y+1)); }
let lin=0; for(let y=0;y<H;y++)for(let x=Math.floor(W*0.2);x<W*0.8;x++){const k=(y*W+x)*4;for(let c=0;c<3;c++)lin+=Math.pow(d[k+c]/255,2.2)*[0.2126,0.7152,0.0722][c];}
console.log('albedo LINEAR mean', (lin/n).toFixed(4));
console.log('albedo mean luma', (s/n).toFixed(1), 'mean |lap|', (lap/n).toFixed(2));
const nd = t.normalMap.image._img.data; let dev=0;
for(let y=0;y<H;y++)for(let x=Math.floor(W*0.2);x<W*0.8;x++){const k=(y*W+x)*4; dev+=Math.hypot(nd[k]-128,nd[k+1]-128);}
console.log('normal mean deviation (bytes)', (dev/n).toFixed(2));
