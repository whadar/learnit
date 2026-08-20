import { execFileSync } from 'node:child_process'; import { PNG } from 'pngjs'; import fs from 'node:fs';
const Z=12,n=2**Z;
const pts={ 'Jerusalem_OldCity(~760m)':[31.7767,35.2345], 'DeadSea_shore(~-420m)':[31.5,35.47],
  'Mt_Meron(~1200m)':[33.0,35.4], 'Tel_Aviv_beach(~5m)':[32.0853,34.7660], 'Amikam':[32.5581,35.0106],
  'Mt_Carmel_high(~546m)':[32.7333,35.0333] };
for(const [k,[lat,lon]] of Object.entries(pts)){
  const fx=(lon+180)/360*n, l=lat*Math.PI/180, fy=(1-Math.log(Math.tan(l)+1/Math.cos(l))/Math.PI)/2*n;
  const tx=Math.floor(fx),ty=Math.floor(fy);
  const f=`/tmp/chk_${tx}_${ty}.png`;
  if(!fs.existsSync(f)) execFileSync('curl',['-sS','--max-time','40','-o',f,`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`]);
  const p=PNG.sync.read(fs.readFileSync(f));
  const px=Math.floor((fx-tx)*256), py=Math.floor((fy-ty)*256), i=(py*256+px)*4;
  console.log(k.padEnd(26), (p.data[i]*256+p.data[i+1]+p.data[i+2]/256-32768).toFixed(1),'m');
}
