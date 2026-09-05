import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b = await chromium.launch({ executablePath: CHROME, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const page = await b.newPage({ viewport:{width:640,height:360}});
page.on('pageerror', e=>console.error('ERR',e.message));
await page.goto('http://127.0.0.1:4173/?review=1&audio=0&q=high',{waitUntil:'load'});
await page.waitForFunction(()=>window.__game&&(window.__game.ready||window.__game.error),null,{timeout:600000});
const out = await page.evaluate(()=>{
  const g=window.__game; const res={};
  for (const id of ['mitzi','shuki','kobi','shelly']) {
    let cat=null; g.engine.scene.traverse(o=>{ if(!cat && o.name==='cat:'+id) cat=o; });
    if(!cat) { res[id]='missing'; continue; }
    cat.updateMatrixWorld(true);
    const hits=[];
    cat.traverse(o=>{ if(o.isMesh && o.material && o.material.emissiveMap && o.material.transparent){
      const bb=new g.THREE.Box3().setFromObject(o); const c=bb.getCenter(new g.THREE.Vector3());
      cat.worldToLocal(c);
      const sz=bb.getSize(new g.THREE.Vector3());
      hits.push({c:[+c.x.toFixed(3),+c.y.toFixed(3),+c.z.toFixed(3)],sz:[+sz.x.toFixed(3),+sz.y.toFixed(3),+sz.z.toFixed(3)],vis:o.visible,parentVis:o.parent.visible, hasMap:!!o.material.map, img: o.material.map && o.material.map.image ? o.material.map.image.width : null});
    }});
    res[id]=hits;
  }
  return res;
});
console.log(JSON.stringify(out));
await b.close();
