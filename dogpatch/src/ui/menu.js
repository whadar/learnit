/**
 * Title, driver select, pause and results.
 *
 * One screen at a time, plain DOM, clickable and keyboard-navigable — and every control is a real
 * button, so a phone can reach all of it. There is no course select: there is one course.
 */
const CSS = `
.dk-menu{position:fixed;inset:0;z-index:50;display:grid;place-items:center;
  font-family:Overpass,sans-serif;color:#eef2f7;background:rgba(12,16,22,.72);
  backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.dk-menu[hidden]{display:none}
.dk-menu .panel{width:min(92vw,660px);text-align:center;display:flex;flex-direction:column;gap:2.2vmin}
.dk-menu h1{margin:0;font-weight:900;font-size:min(10vmin,74px);line-height:.92;letter-spacing:-.03em}
.dk-menu h1 em{font-style:normal;color:#6fb2ff}
.dk-menu .sub{font-family:"Overpass Mono",monospace;font-size:min(2.2vmin,15px);
  letter-spacing:.22em;text-transform:uppercase;opacity:.75}
.dk-menu .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1.2vmin}
.dk-menu button{font-family:inherit;font-weight:900;letter-spacing:.05em;cursor:pointer;
  border:2px solid rgba(255,255,255,.22);border-radius:12px;background:rgba(255,255,255,.07);
  color:#eef2f7;padding:1.5vmin 2vmin;font-size:min(2.5vmin,17px);transition:transform .1s,background .15s}
.dk-menu button:hover,.dk-menu button:focus-visible{background:rgba(255,255,255,.16);transform:translateY(-2px);outline:none}
.dk-menu button.go{background:#c0392b;border-color:#e05a4a;font-size:min(3.4vmin,24px);padding:2vmin}
.dk-menu .kat{display:flex;flex-direction:column;align-items:center;gap:.6vmin}
.dk-menu .kat i{width:2.6vmin;height:2.6vmin;min-width:16px;min-height:16px;border-radius:50%;display:block}
.dk-menu table{width:100%;border-collapse:collapse;font-size:min(2.3vmin,16px)}
.dk-menu td,.dk-menu th{padding:.8vmin 1vmin;text-align:left;border-bottom:1px solid rgba(255,255,255,.12)}
.dk-menu th{font-family:"Overpass Mono",monospace;font-size:.72em;letter-spacing:.14em;
  text-transform:uppercase;opacity:.6}
.dk-menu tr.me{color:#ffd873;font-weight:900}
.dk-menu .bar{height:6px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
.dk-menu .bar i{display:block;height:100%;background:#6fb2ff;width:0;transition:width .3s}
`;
const clock = t => Number.isFinite(t) && t > 0
  ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '—';

export function createMenu(mount) {
  const el = document.createElement('div');
  el.className = 'dk-menu';
  el.innerHTML = `<style>${CSS}</style><div class="panel"></div>`;
  mount.appendChild(el);
  const panel = el.querySelector('.panel');
  const show = html => { panel.innerHTML = html; el.hidden = false; };

  let pct = 0;
  return {
    hide() { el.hidden = true; },
    loading(msg) {
      pct = Math.min(0.94, pct + 0.16);
      show(`<h1>DOGPATCH <em>KART</em></h1>
        <div class="sub">San Francisco · California</div>
        <div class="bar"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>
        <div class="sub">${msg}</div>`);
    },
    title(drivers) {
      show(`<h1>DOGPATCH <em>KART</em></h1>
        <div class="sub">Pier 70 · Illinois St · 1719 m</div>
        <div class="grid">${drivers.map((d, i) => `
          <button data-k="${i}" class="kat">
            <i style="background:#${d.livery.toString(16).padStart(6, '0')}"></i>${d.name}
          </button>`).join('')}</div>
        <div class="sub">Pick a driver</div>`);
      panel.querySelectorAll('[data-k]').forEach(b =>
        b.addEventListener('click', () => window.__game.startRace(+b.dataset.k)));
    },
    pause(on, restart) {
      if (!on) { el.hidden = true; return; }
      show(`<h1>PAUSED</h1>
        <div class="grid">
          <button data-r>Resume</button>
          <button data-x>Restart race</button>
        </div>`);
      panel.querySelector('[data-r]').addEventListener('click', () => { el.hidden = true; });
      panel.querySelector('[data-x]').addEventListener('click', restart);
    },
    results(rows, again) {
      show(`<h1>RESULTS</h1>
        <table><tr><th>#</th><th>Driver</th><th>Time</th><th>Best lap</th></tr>
        ${rows.map(r => `<tr class="${r.isPlayer ? 'me' : ''}">
          <td>${r.place}</td><td>${r.name}</td><td>${clock(r.time)}</td><td>${clock(r.best)}</td></tr>`).join('')}
        </table>
        <button class="go" data-a>Race again</button>`);
      panel.querySelector('[data-a]').addEventListener('click', again);
    },
    dispose() { el.remove(); },
  };
}
