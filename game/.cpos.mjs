import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const view=process.argv[2]||'driftCorner';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(v=>window.__game.setView(v),view);
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=8?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const out=await p.evaluate(()=>{
  const g=window.__game, sc=g.engine.scene, cam=g.engine.camera;
  let c=null; const racers=[]; sc.traverse(o=>{if(o.name==='lighting:contact')c=o; if(/^racer:/.test(o.name||''))racers.push(o);});
  const V=cam.position.constructor;
  const proj=v=>{const q=v.clone().project(cam);return [Math.round((q.x*0.5+0.5)*1280), Math.round((-q.y*0.5+0.5)*720), +q.z.toFixed(3)];};
  const arr=c.instanceMatrix.array; const inst=[];
  for(let i=0;i<c.count;i++){const v=new V(arr[i*16+12],arr[i*16+13],arr[i*16+14]);inst.push({w:[+v.x.toFixed(1),+v.y.toFixed(1),+v.z.toFixed(1)],s:proj(v)});}
  const rs=racers.map(o=>{const v=new V();o.getWorldPosition(v);return {n:o.name,s:proj(v)};});
  return {inst, rs};
});
console.log(JSON.stringify(out));
await b.close();
