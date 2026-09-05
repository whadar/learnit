import fs from 'node:fs'; import { PNG } from 'pngjs';
const [,, f, ...pts] = process.argv;
const p = PNG.sync.read(fs.readFileSync(f));
for (const s of pts) { const [x,y]=s.split(',').map(Number); const i=(y*p.width+x)*4;
  console.log(s, p.data[i], p.data[i+1], p.data[i+2]); }
