// Diagnostic only: does every module parse, import, and expose the factory the contract promises?
// Writes nothing that any build agent owns.
import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const mods = [];
for (const dir of ['core','world','render','render/materials','track','physics','game','characters','ui','audio'])
  for (const f of (fs.existsSync(`src/${dir}`) ? fs.readdirSync(`src/${dir}`) : []))
    if (f.endsWith('.js')) mods.push(`src/${dir}/${f}`);

fs.mkdirSync('.smoke', { recursive: true });
fs.writeFileSync('.smoke/entry.js', `
const mods = ${JSON.stringify(mods)};
window.__smoke = [];
for (const m of mods) {
  try {
    const ns = await import('/' + m);
    window.__smoke.push({ m, ok: true, exports: Object.keys(ns) });
  } catch (e) {
    window.__smoke.push({ m, ok: false, err: String(e && e.message || e).slice(0, 300) });
  }
}
window.__smokeDone = true;
`);
fs.writeFileSync('.smoke/index.html', '<!doctype html><script type="module" src="/.smoke/entry.js"></script>');

const server = await createServer({ root: process.cwd(), server: { port: 5399, strictPort: true }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
const console_errors = [];
p.on('pageerror', e => console_errors.push(String(e.message).slice(0, 200)));
await p.goto('http://127.0.0.1:5399/.smoke/index.html', { waitUntil: 'load' });
try { await p.waitForFunction(() => window.__smokeDone, { timeout: 180000 }); } catch { }
const res = await p.evaluate(() => window.__smoke || []);
await b.close(); await server.close();

const bad = res.filter(r => !r.ok);
console.log(`modules: ${res.length}   import-clean: ${res.length - bad.length}   failing: ${bad.length}`);
for (const r of bad) console.log(`  FAIL ${r.m}\n       ${r.err}`);
if (console_errors.length) { console.log('page errors:'); for (const e of new Set(console_errors)) console.log('  ' + e); }
const missing = res.filter(r => r.ok && !r.exports.length);
if (missing.length) console.log('no exports: ' + missing.map(r => r.m).join(', '));
