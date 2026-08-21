import { PNG } from 'pngjs';
import fs from 'node:fs';
class Ctx {
  constructor(c){ this.c=c; this.data=null; }
  createImageData(w,h){ return { width:w, height:h, data:new Uint8ClampedArray(w*h*4) }; }
  putImageData(img){ this.c._img = img; }
  getImageData(){ return this.c._img; }
  fillRect(){} save(){} restore(){} translate(){} beginPath(){} fill(){} stroke(){}
}
global.document = { createElement: () => { const c = { width:0, height:0, _img:null }; c.getContext = () => (c._ctx ||= new Ctx(c)); return c; } };
global.window = global;
const three = await import('three');
global.THREE = three;
const { buildRoadTextures } = await import('/home/user/learnit/game/src/world/roads.js');
function dump(name, cvImg) {
  const { width:w, height:h, data } = cvImg;
  const p = new PNG({ width:w, height:h });
  p.data = Buffer.from(data.buffer.slice(0));
  fs.writeFileSync(name, PNG.sync.write(p));
  console.log('wrote', name, w, h);
}
// Patch: buildRoadTextures returns THREE.CanvasTexture; grab .image (the canvas) then _img
const specs = {
  tarmac: { total: 13.64, road: 13.0, vMetres: 22, kind:'asphalt', centre:'dash', edge:true, seed:771, normalStrength:0.85, W:320, H:1024, edgeInset:0.62, edgeHalf:0.125, dustWidth:0.48, shoulder:[0.152,0.138,0.106], polish:[{at:0,w:3.05,k:0.92},{at:4.95,w:0.95,k:0.42}] },
  gravel: { total: 13.64, road: 13.0, vMetres: 19, kind:'gravel', centre:null, edge:true, seed:883, normalStrength:0.80, W:320, H:1024, edgeInset:0.60, edgeHalf:0.115, dustWidth:0.55, shoulder:[0.162,0.146,0.112], paintCol:[0.58,0.565,0.522], polish:[{at:0,w:3.35,k:0.95},{at:5.1,w:1.05,k:0.45}] },
};
for (const [k, s] of Object.entries(specs)) {
  const t = buildRoadTextures(s);
  dump(`/tmp/claude-0/-home-user-learnit/8f6205af-22db-552b-aca3-2d3962bb4285/scratchpad/tex-${k}.png`, t.map.image._img);
  // report mean
  const d = t.map.image._img.data; let sum=0;
  for (let i=0;i<d.length;i+=4) sum += d[i];
  console.log(k, 'mean R byte', (sum/(d.length/4)).toFixed(1));
}
