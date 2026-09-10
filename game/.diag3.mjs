import { chromium } from 'playwright';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL='http://127.0.0.1:4173/?review=1&audio=0&q=high';
const b=await chromium.launch({executablePath:CHROME,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p=await b.newPage({viewport:{width:1280,height:720}});
const logs=[]; p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`));
await p.goto(URL,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
await p.evaluate(()=>window.__game.setView('photoFinish'));
await p.evaluate(()=>new Promise(r=>{let i=0;const s=()=>(++i>=10?r():requestAnimationFrame(s));requestAnimationFrame(s);}));
const info = await p.evaluate(async ()=>{
  const g=window.__game, sc=g.engine.scene;
  let contact=null; sc.traverse(o=>{ if(o.name==='lighting:contact') contact=o; });
  let drawn=0; contact.onBeforeRender=()=>{drawn++;};
  const par=[]; let o=contact; while(o){par.push([o.name||o.type,o.visible,o.layers.mask]);o=o.parent;}
  await new Promise(r=>{let i=0;const s=()=>(++i>=6?r():requestAnimationFrame(s));requestAnimationFrame(s);});
  const cam=g.engine.camera;
  return {drawn, par, camLayers:cam.layers.mask, count:contact.count,
    composer: !!g.engine.composer,
    mw: Array.from(contact.matrixWorld.elements).map(v=>+v.toFixed(2)),
    matUUID: contact.material.uuid, blend:contact.material.blending, depthTest:contact.material.depthTest,
    geoAttr: Object.keys(contact.geometry.attributes), instCount: contact.instanceMatrix.count,
    firstMat: Array.from(contact.instanceMatrix.array.slice(0,16)).map(v=>+v.toFixed(2)),
  };
});
console.log(JSON.stringify(info,null,1));
await b.close();
