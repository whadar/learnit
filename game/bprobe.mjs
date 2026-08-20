import { chromium } from 'playwright';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1']});
const p = await b.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
p.on('console',m=>console.log('[c]',m.type(),m.text().slice(0,300)));
p.on('pageerror',e=>console.log('[E]',e.message.slice(0,600)));
p.on('crash',()=>console.log('[CRASH]'));
await p.goto('http://127.0.0.1:5203/preview/_bprobe.html',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:240000}).catch(e=>console.log('waitfail',String(e).slice(0,200)));
const info = await p.evaluate(()=>{
  let tris=0,meshes=0,verts=0;
  window.__game.engine.scene.traverse(o=>{ if(o.isMesh&&o.name.startsWith('bld')){meshes++;const g=o.geometry;const n=g.index?g.index.count/3:g.attributes.position.count/3;tris+=n*(o.isInstancedMesh?o.count:1);verts+=g.attributes.position.count;} });
  return {ready:window.__game.ready,err:window.__game.error, meshes, tris, verts, count:window.__b?.count, chunks:window.__b?.chunks, draws:window.__b?.drawCalls};
}).catch(e=>({fail:String(e).slice(0,200)}));
console.log(JSON.stringify(info));
await b.close();
