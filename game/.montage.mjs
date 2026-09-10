import fs from 'node:fs'; import {PNG} from 'pngjs';
const files=process.argv.slice(3); const out=process.argv[2];
const CW=+(process.env.CW||360), CH=+(process.env.CH2||330), X0=+(process.env.X0||460), Y0=+(process.env.Y0||60); // crop region from each 1280x720
const cols=4, rows=Math.ceil(files.length/cols);
const o=new PNG({width:CW*cols, height:CH*rows});
files.forEach((f,i)=>{
  const p=PNG.sync.read(fs.readFileSync(f));
  const cx=(i%cols)*CW, cy=Math.floor(i/cols)*CH;
  for(let y=0;y<CH;y++)for(let x=0;x<CW;x++){
    const sx=X0+x, sy=Y0+y;
    const si=((sy*p.width)+sx)<<2, di=(((cy+y)*o.width)+(cx+x))<<2;
    o.data[di]=p.data[si];o.data[di+1]=p.data[si+1];o.data[di+2]=p.data[si+2];o.data[di+3]=255;
  }
});
fs.writeFileSync(out,PNG.sync.write(o));
console.log(out, o.width, o.height);
