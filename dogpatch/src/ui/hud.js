/** Speed, lap, place, item and the countdown. DOM, because DOM is cheaper than a texture atlas. */
const CSS = `
.dk-hud{position:fixed;inset:0;pointer-events:none;z-index:30;font-family:Overpass,sans-serif;
  color:#f2f5f8;text-shadow:0 2px 6px rgba(0,0,0,.55);opacity:0;transition:opacity .25s}
.dk-hud.on{opacity:1}
.dk-hud .place{position:absolute;left:2.2vmin;bottom:2vmin;font-weight:900;line-height:.86;
  font-size:min(11vmin,88px);letter-spacing:-.03em}
.dk-hud .place sup{font-size:.42em;margin-left:.06em}
.dk-hud .place b{display:block;font-size:.2em;opacity:.72;font-weight:600;letter-spacing:.16em}
.dk-hud .lap{position:absolute;right:2.2vmin;top:2vmin;text-align:right;font-weight:900;
  font-size:min(5vmin,38px);letter-spacing:-.01em}
.dk-hud .lap b{font-size:.5em;opacity:.7;font-weight:600;letter-spacing:.14em;display:block}
.dk-hud .spd{position:absolute;right:2.2vmin;bottom:2vmin;text-align:right;
  font-family:"Overpass Mono",monospace;font-weight:600}
.dk-hud .spd i{font-style:normal;font-size:min(8vmin,60px);line-height:1}
.dk-hud .spd b{display:block;font-size:min(1.7vmin,13px);opacity:.66;letter-spacing:.2em}
.dk-hud .time{position:absolute;left:50%;top:2vmin;transform:translateX(-50%);
  font-family:"Overpass Mono",monospace;font-size:min(3.2vmin,24px);font-weight:600;opacity:.9}
.dk-hud .item{position:absolute;left:2.2vmin;top:2vmin;min-width:min(20vmin,150px);
  background:rgba(18,22,28,.55);border:2px solid rgba(255,255,255,.32);border-radius:12px;
  padding:.7vmin 1.4vmin;font-weight:900;font-size:min(2.4vmin,18px);letter-spacing:.04em;
  opacity:0;transition:opacity .18s}
.dk-hud .item.on{opacity:1}
.dk-hud .big{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);
  font-weight:900;font-size:min(18vmin,150px);letter-spacing:-.04em;opacity:0;transition:opacity .12s}
.dk-hud .big.on{opacity:1}
.dk-hud .warn{position:absolute;left:50%;top:62%;transform:translateX(-50%);color:#ff6b5a;
  font-weight:900;font-size:min(4vmin,30px);letter-spacing:.1em;opacity:0}
.dk-hud .warn.on{opacity:1}
.dk-hud .boost{position:absolute;inset:0;box-shadow:inset 0 0 18vmin rgba(90,180,255,.0);transition:box-shadow .2s}
.dk-hud .boost.on{box-shadow:inset 0 0 18vmin rgba(90,180,255,.30)}
`;
const ord = n => ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
const clock = t => {
  if (!Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};

export function createHUD(mount) {
  const el = document.createElement('div');
  el.className = 'dk-hud';
  el.innerHTML = `<style>${CSS}</style>
    <div class="place"><span data-p>1</span><sup data-o>st</sup><b data-f>/ 8</b></div>
    <div class="lap"><b>LAP</b><span data-l>1 / 3</span></div>
    <div class="spd"><i data-s>0</i><b>KM/H</b></div>
    <div class="time" data-t>0:00.000</div>
    <div class="item" data-i></div>
    <div class="big" data-b></div>
    <div class="warn" data-w>WRONG WAY</div>
    <div class="boost" data-bo></div>`;
  mount.appendChild(el);
  const q = k => el.querySelector(`[data-${k}]`);
  const P = q('p'), O = q('o'), F = q('f'), L = q('l'), SP = q('s'), T = q('t'),
        I = q('i'), B = q('b'), W = q('w'), BO = q('bo');
  let flashT = 0;

  return {
    show(v) { el.classList.toggle('on', v !== false); },
    flash() { flashT = 0.5; },
    update(h) {
      P.textContent = h.place; O.textContent = ord(h.place);
      F.textContent = `/ ${h.field}`;
      L.textContent = `${h.lap} / ${h.laps}`;
      SP.textContent = Math.round(h.speed);
      T.textContent = clock(h.time);
      I.textContent = h.item ?? '';
      I.classList.toggle('on', !!h.item);
      B.textContent = h.message ?? '';
      B.classList.toggle('on', !!h.message);
      W.classList.toggle('on', !!h.wrongWay);
      BO.classList.toggle('on', !!h.boost || flashT > 0);
      if (flashT > 0) flashT -= 1 / 60;
    },
    dispose() { el.remove(); },
  };
}
