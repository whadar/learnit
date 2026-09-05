import fs from 'node:fs'; import { PNG } from 'pngjs';
const p = PNG.sync.read(fs.readFileSync(process.argv[2]));
const mode = process.argv[3];
const a = process.argv.slice(4).map(Number);
const L = (x,y)=>{const i=(y*p.width+x)*4;return (0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2]).toFixed(0);} ;
if (mode==='h'){const [y,x0,x1,st]=a;let s='';for(let x=x0;x<x1;x+=st)s+=`${x}:${L(x,y)} `;console.log(s);}
if (mode==='v'){const [x,y0,y1,st]=a;let s='';for(let y=y0;y<y1;y+=st)s+=`${y}:${L(x,y)} `;console.log(s);}
