import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(()=>window.__game.setView('photoFinish'));
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=10?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const info = await p.evaluate(()=>{
  const g=window.__game, sc=g.engine.scene;
  let contact=null; sc.traverse(o=>{ if(o.name==='lighting:contact') contact=o; });
  contact.material.color.setRGB(1,0,0); contact.material.opacity=1; contact.material.depthTest=false; contact.renderOrder=999;
  contact.material.needsUpdate=true;
  // dump matrices
  const m=[]; const M=new (contact.instanceMatrix.constructor===Float32Array?Object:Object)();
  const arr=contact.instanceMatrix.array;
  for(let i=0;i<contact.count;i++){ m.push([arr[i*16+12].toFixed(2),arr[i*16+13].toFixed(2),arr[i*16+14].toFixed(2)]); }
  // also list meshes drawn on the road with renderOrder
  const ro=[]; sc.traverse(o=>{ if(o.isMesh && o.renderOrder) ro.push([o.name,o.renderOrder, o.material?.transparent]); });
  return {pos:m, renderOrders:ro.slice(0,25)};
});
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=6?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
await p.screenshot({path:'/home/user/learnit/game/shots/_diag_contact.png',timeout:180000});
console.log(JSON.stringify(info,null,1));
await b.close();
