/** Every module imports cleanly, and the world + track actually build. Costs a second. */
import fs from 'node:fs';
import path from 'node:path';

const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true }))
  f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith('.js') && files.push(path.join(d, f.name)); })('src');

let bad = 0;
for (const f of files) {
  try { await import('../' + f); }
  catch (e) { if (/location|document|window|navigator|HTMLCanvas/.test(e.message)) continue; bad++; console.log('  FAIL ' + f + ' — ' + e.message); }
}
console.log(`modules: ${files.length}   import-clean: ${files.length - bad}   failing: ${bad}`);

const { World } = await import('../src/world/world.js');
const { buildTrack } = await import('../src/track/track.js');
const json = JSON.parse(fs.readFileSync('public/data/world.json', 'utf8'));
const bin = fs.readFileSync('public/data/world-height.bin');
const world = new World(json, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));
const track = buildTrack(world);
console.log(`world: ${world.buildings.length} buildings, ${world.roads.length} roads, `
  + `elevation ${world.terrain.min}..${world.terrain.max} m`);
console.log(`track: ${track.name}  ${track.length.toFixed(0)} m, ${track.count} samples, `
  + `${track.checkpoints.length} checkpoints, ${track.startGrid.length} grid slots`);
if (bad) process.exit(1);
