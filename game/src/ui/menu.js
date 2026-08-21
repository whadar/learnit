/**
 * Kat Racing — front end: loading screen, title, character select, course select, settings,
 * pause menu and the results board.
 *
 *   import { createMenu } from './ui/menu.js';
 *   const menu = createMenu({ mount: app, roster, courses, quality });
 *   menu.on('start',  e => race.begin(e.character, e.course));
 *   menu.on('resume', () => …);
 *   menu.setLoading(0.4, 'building the village');
 *   menu.show('title');
 *   menu.update(dt, input.menu(dt));      // keyboard / gamepad navigation
 *
 * Pure DOM + CSS over the WebGL canvas: crisp at any resolution, animates for free, and it
 * costs nothing on the GPU budget that the software renderer does not have. Every screen is
 * navigable by keyboard, gamepad and mouse; the same palette as the HUD keeps the game looking
 * like one product.
 */

const P = {
  cream: '#FFF8E7', creamDeep: '#F0E2C4', ink: '#241F16', inkSoft: '#3B3426',
  olive: '#6E7A3C', oliveDeep: '#404A21', oliveLight: '#9CA85F',
  terracotta: '#C9552F', terraLight: '#E3784C',
  sky: '#3FA9E0', skyLight: '#8FD3F4', skyDeep: '#1B6FA8',
  wheat: '#E9B84A', wheatLight: '#FFD46B', gold: '#FFCE3D',
};

const STAT_KEYS = [
  ['speed', 'Speed'], ['accel', 'Accel'], ['weight', 'Weight'],
  ['handling', 'Handling'], ['drift', 'Drift'], ['offroad', 'Off-road'],
];

const hex = n => (typeof n === 'string' ? n : '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------- art --- */

/** A cat portrait built from the roster's own fur/eye/suit colours — no image files. */
function catPortrait(cat) {
  const base = hex(cat?.base ?? 0x9a7550), dark = hex(cat?.dark ?? 0x53381f);
  const belly = hex(cat?.belly ?? 0xe6d3b3), eye = hex(cat?.eye ?? 0x8fd14f);
  const nose = hex(cat?.nose ?? 0xd98d92);
  const suitA = hex(cat?.suit?.[0] ?? 0xe2542a);
  const ear = cat?.ear || 'pointed';
  const earShape = ear === 'round'
    ? `<circle cx="24" cy="30" r="11" fill="${base}"/><circle cx="76" cy="30" r="11" fill="${base}"/>`
    : ear === 'fold'
      ? `<path d="M17 36c0-9 6-14 13-12 4 1 4 8-1 12z" fill="${base}"/><path d="M83 36c0-9-6-14-13-12-4 1-4 8 1 12z" fill="${base}"/>`
      : `<path d="M20 44 21 19 42 33z" fill="${base}"/><path d="M80 44 79 19 58 33z" fill="${base}"/>`;
  return `<svg viewBox="0 0 100 100" class="kt-por" aria-hidden="true">
    <defs><clipPath id="c${cat?.id || 'x'}"><rect x="0" y="0" width="100" height="100" rx="14"/></clipPath></defs>
    <g clip-path="url(#c${cat?.id || 'x'})">
      <rect width="100" height="100" fill="${suitA}" opacity=".22"/>
      <path d="M8 100c4-22 20-30 42-30s38 8 42 30z" fill="${suitA}"/>
      ${earShape}
      <path d="M20 44 24 22 42 34z" fill="${dark}" opacity=".35"/>
      <path d="M80 44 76 22 58 34z" fill="${dark}" opacity=".35"/>
      <ellipse cx="50" cy="52" rx="31" ry="28" fill="${base}"/>
      <ellipse cx="50" cy="64" rx="17" ry="13" fill="${belly}"/>
      <ellipse cx="38" cy="48" rx="7.4" ry="8.6" fill="#FFFDF5"/>
      <ellipse cx="62" cy="48" rx="7.4" ry="8.6" fill="#FFFDF5"/>
      <ellipse cx="38.6" cy="48.6" rx="4.6" ry="6.6" fill="${eye}"/>
      <ellipse cx="61.4" cy="48.6" rx="4.6" ry="6.6" fill="${eye}"/>
      <ellipse cx="38.6" cy="48.6" rx="1.9" ry="5.4" fill="#181410"/>
      <ellipse cx="61.4" cy="48.6" rx="1.9" ry="5.4" fill="#181410"/>
      <circle cx="36.6" cy="45.4" r="1.5" fill="#fff" opacity=".9"/>
      <circle cx="59.4" cy="45.4" r="1.5" fill="#fff" opacity=".9"/>
      <path d="M50 58 46 62h8z" fill="${nose}"/>
      <path d="M50 62v3.5M50 65.5c-2.6 0-4-1.4-4.6-2.6M50 65.5c2.6 0 4-1.4 4.6-2.6" stroke="#2A2118" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <g stroke="#2A2118" stroke-width="1.3" opacity=".55" stroke-linecap="round">
        <path d="M28 58 12 55M28 62 13 63M72 58 88 55M72 62 87 63"/></g>
    </g>
    <rect x="1" y="1" width="98" height="98" rx="14" fill="none" stroke="${P.ink}" stroke-width="2.4"/>
  </svg>`;
}

const stars = v => {
  const n = Math.round((v || 0) * 2) / 2;
  let s = '';
  for (let i = 1; i <= 5; i++) s += `<i class="${n >= i ? 'on' : n >= i - 0.5 ? 'half' : ''}"></i>`;
  return s;
};

function statBar(v) {
  const pct = Math.max(4, Math.min(100, (v / 5) * 100));
  return `<span class="kt-bar"><b style="width:${pct.toFixed(0)}%"></b></span>`;
}

/* ------------------------------------------------------------------ css ---- */

const CSS = `
.kt-menu{position:fixed;inset:0;z-index:40;color:${P.cream};
  font:500 16px/1.35 'Trebuchet MS',DejaVu Sans,Verdana,system-ui,sans-serif;
  -webkit-user-select:none;user-select:none;overflow:hidden}
.kt-menu.hidden{display:none}
.kt-menu .scr{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;
  padding:min(4vh,42px) min(5vw,64px);box-sizing:border-box}
.kt-menu .scr.on{display:flex;animation:ktin .28s cubic-bezier(.2,.9,.3,1.2) both}
@keyframes ktin{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
.kt-menu .veil{position:absolute;inset:0;background:
  radial-gradient(120% 90% at 50% 8%,rgba(24,32,48,.30),rgba(10,14,22,.80) 70%,rgba(6,9,14,.92));
  backdrop-filter:blur(2.5px)}
.kt-menu .scr>*{position:relative}

/* ---- word marks ---- */
.kt-logo{text-align:center;margin-bottom:min(4vh,34px);line-height:.92}
.kt-logo .k{display:block;font-size:min(13vw,116px);font-weight:900;letter-spacing:-.02em;
  color:${P.wheatLight};text-shadow:0 4px 0 ${P.terracotta},0 8px 0 ${P.oliveDeep},0 14px 26px rgba(0,0,0,.6);
  transform:rotate(-2.2deg)}
.kt-logo .r{display:block;font-size:min(7.4vw,64px);font-weight:900;letter-spacing:.12em;
  color:${P.cream};text-shadow:0 3px 0 ${P.skyDeep},0 7px 20px rgba(0,0,0,.55);transform:rotate(-2.2deg)}
.kt-logo .sub{display:block;margin-top:10px;font-size:min(2.1vw,16px);letter-spacing:.34em;
  text-transform:uppercase;color:${P.creamDeep};opacity:.86;transform:none}
.kt-title{font-size:min(3.4vw,27px);font-weight:900;letter-spacing:.20em;text-transform:uppercase;
  color:${P.wheatLight};text-shadow:0 2px 0 rgba(0,0,0,.5);margin:0 0 14px}
.kt-sub{color:${P.creamDeep};opacity:.8;font-size:14px;letter-spacing:.06em;margin:0 0 18px;text-align:center}

/* ---- generic buttons ---- */
.kt-list{display:flex;flex-direction:column;gap:10px;min-width:min(330px,72vw)}
.kt-btn{display:flex;align-items:center;gap:12px;justify-content:center;
  padding:13px 26px;border-radius:13px;border:2.5px solid ${P.ink};cursor:pointer;
  background:linear-gradient(180deg,rgba(255,248,231,.94),rgba(228,212,178,.92));color:${P.ink};
  font-weight:800;font-size:17px;letter-spacing:.05em;
  box-shadow:0 5px 0 rgba(20,16,10,.55),0 12px 26px rgba(0,0,0,.35);
  transition:transform .08s cubic-bezier(.34,1.56,.64,1),box-shadow .08s,background .12s}
.kt-btn small{font-weight:600;opacity:.62;letter-spacing:.02em}
.kt-btn:hover{transform:translateY(-1px)}
.kt-btn.sel{background:linear-gradient(180deg,${P.wheatLight},${P.wheat});
  box-shadow:0 5px 0 ${P.terracotta},0 14px 30px rgba(0,0,0,.45);transform:translateY(-2px) scale(1.02)}
.kt-btn.sel::before{content:'▶';font-size:13px;color:${P.terracotta}}
.kt-btn.wide{min-width:min(420px,80vw)}
.kt-btn.ghost{background:rgba(20,26,34,.55);color:${P.cream};border-color:rgba(255,248,231,.45);
  box-shadow:0 4px 0 rgba(0,0,0,.45)}
.kt-btn.ghost.sel{background:linear-gradient(180deg,rgba(255,248,231,.22),rgba(255,248,231,.10));
  border-color:${P.wheatLight};color:${P.wheatLight}}

/* ---- loading ---- */
.kt-load{width:min(520px,78vw);text-align:center}
.kt-load .track{height:15px;border-radius:99px;border:2.5px solid ${P.ink};overflow:hidden;
  background:rgba(12,16,22,.7);box-shadow:0 4px 14px rgba(0,0,0,.45)}
.kt-load .fill{height:100%;width:0%;border-radius:99px;transition:width .28s ease;
  background:linear-gradient(90deg,${P.olive},${P.wheat} 60%,${P.wheatLight})}
.kt-load .msg{margin-top:12px;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:${P.creamDeep};opacity:.85}
.kt-load .tip{margin-top:26px;font-size:13px;color:${P.creamDeep};opacity:.6;max-width:46ch;margin-inline:auto;line-height:1.5}
.kt-spin{width:44px;height:44px;margin:0 auto 22px;border-radius:50%;
  border:5px solid rgba(255,248,231,.18);border-top-color:${P.wheatLight};animation:ktspin 1s linear infinite}
@keyframes ktspin{to{transform:rotate(360deg)}}

/* ---- character select ---- */
.kt-cs{display:grid;grid-template-columns:minmax(0,1fr) min(330px,32vw);gap:min(3vw,28px);
  width:min(1180px,94vw);align-items:center}
.kt-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:min(1.2vw,12px)}
.kt-card{position:relative;border-radius:15px;border:2.5px solid ${P.ink};overflow:hidden;cursor:pointer;
  background:linear-gradient(180deg,rgba(255,248,231,.90),rgba(214,196,160,.85));
  box-shadow:0 4px 0 rgba(20,16,10,.5),0 10px 22px rgba(0,0,0,.35);
  transition:transform .1s cubic-bezier(.34,1.56,.64,1),box-shadow .1s}
.kt-card .kt-por{display:block;width:100%;height:auto}
.kt-card .nm{position:absolute;left:0;right:0;bottom:0;padding:4px 6px;font-size:12px;font-weight:800;
  letter-spacing:.05em;text-align:center;color:${P.cream};background:linear-gradient(180deg,transparent,rgba(24,20,14,.86) 45%)}
.kt-card .no{position:absolute;top:4px;right:6px;font-weight:900;font-size:13px;color:${P.ink};opacity:.55}
.kt-card.sel{transform:translateY(-4px) scale(1.06);z-index:2;
  box-shadow:0 6px 0 ${P.terracotta},0 16px 30px rgba(0,0,0,.5);border-color:${P.wheatLight}}
.kt-panel{border-radius:17px;border:2.5px solid ${P.ink};padding:16px 18px;
  background:linear-gradient(180deg,rgba(28,34,42,.90),rgba(16,20,27,.92));
  box-shadow:0 8px 24px rgba(0,0,0,.5)}
.kt-panel h3{margin:0;font-size:25px;font-weight:900;letter-spacing:.04em;color:${P.wheatLight}}
.kt-panel .blurb{margin:4px 0 12px;font-size:13.5px;opacity:.78;line-height:1.45}
.kt-panel .kart{display:flex;justify-content:space-between;font-size:13px;opacity:.85;
  border-top:1px dashed rgba(255,248,231,.24);border-bottom:1px dashed rgba(255,248,231,.24);
  padding:8px 0;margin-bottom:10px}
.kt-stats{display:grid;grid-template-columns:auto 1fr;gap:5px 10px;align-items:center;font-size:12.5px}
.kt-stats span.k{opacity:.75;letter-spacing:.05em}
.kt-bar{display:block;height:9px;border-radius:99px;background:rgba(255,248,231,.14);overflow:hidden;
  border:1px solid rgba(255,248,231,.20)}
.kt-bar b{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,${P.olive},${P.wheat})}

/* ---- course select ---- */
.kt-courses{display:flex;gap:min(2vw,20px);flex-wrap:wrap;justify-content:center;width:min(1080px,94vw)}
.kt-course{width:min(330px,84vw);border-radius:17px;border:2.5px solid ${P.ink};overflow:hidden;cursor:pointer;
  background:linear-gradient(180deg,rgba(28,34,42,.92),rgba(16,20,27,.94));
  box-shadow:0 6px 0 rgba(20,16,10,.5),0 14px 30px rgba(0,0,0,.42);transition:transform .1s,box-shadow .1s}
.kt-course.sel{transform:translateY(-4px) scale(1.02);border-color:${P.wheatLight};
  box-shadow:0 6px 0 ${P.terracotta},0 18px 36px rgba(0,0,0,.5)}
.kt-course.locked{filter:grayscale(.8) brightness(.7);cursor:not-allowed}
.kt-course .art{height:150px;position:relative;overflow:hidden}
.kt-course .art svg{display:block;width:100%;height:100%}
.kt-course .cap{padding:11px 14px 13px}
.kt-course .cap h4{margin:0 0 3px;font-size:19px;font-weight:900;letter-spacing:.03em;color:${P.wheatLight}}
.kt-course .cap p{margin:0;font-size:12.5px;opacity:.72;line-height:1.4}
.kt-course .meta{display:flex;gap:12px;margin-top:9px;font-size:11.5px;letter-spacing:.08em;
  text-transform:uppercase;opacity:.66}

/* ---- settings ---- */
.kt-rows{display:flex;flex-direction:column;gap:9px;width:min(560px,90vw)}
.kt-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;
  padding:11px 16px;border-radius:12px;border:2px solid rgba(255,248,231,.20);background:rgba(18,23,31,.72)}
.kt-row.sel{border-color:${P.wheatLight};background:rgba(255,248,231,.10)}
.kt-row .lab{font-weight:700;letter-spacing:.04em}
.kt-row .lab small{display:block;font-weight:500;font-size:11.5px;opacity:.6;letter-spacing:.02em;margin-top:2px}
.kt-row .val{display:flex;align-items:center;gap:10px;font-weight:800;color:${P.wheatLight};min-width:150px;justify-content:flex-end}
.kt-row .val .ar{opacity:.5;font-size:12px}
.kt-row.sel .val .ar{opacity:1}

/* ---- results ---- */
.kt-res{width:min(760px,94vw)}
.kt-res table{width:100%;border-collapse:separate;border-spacing:0 5px;font-variant-numeric:tabular-nums}
.kt-res td{padding:8px 12px;background:rgba(18,23,31,.78);border-top:2px solid rgba(255,248,231,.12);
  border-bottom:2px solid rgba(0,0,0,.35)}
.kt-res tr td:first-child{border-radius:11px 0 0 11px;border-left:2px solid rgba(255,248,231,.12);width:56px;
  font-weight:900;font-size:19px;text-align:center;color:${P.creamDeep}}
.kt-res tr td:last-child{border-radius:0 11px 11px 0;border-right:2px solid rgba(255,248,231,.12);text-align:right}
.kt-res tr.p1 td{background:linear-gradient(90deg,rgba(255,206,61,.30),rgba(18,23,31,.80))}
.kt-res tr.p1 td:first-child{color:${P.gold}}
.kt-res tr.p2 td:first-child{color:#E2E6EA}.kt-res tr.p3 td:first-child{color:#D2884A}
.kt-res tr.me td{background:linear-gradient(90deg,rgba(63,169,224,.30),rgba(18,23,31,.82));
  border-color:${P.skyLight}}
.kt-res .nm{font-weight:800;letter-spacing:.03em}
.kt-res .best{font-size:12px;opacity:.62;letter-spacing:.03em}
.kt-place{text-align:center;margin-bottom:14px}
.kt-place .big{font-size:min(9vw,74px);font-weight:900;line-height:1;color:${P.gold};
  text-shadow:0 4px 0 ${P.terracotta},0 10px 24px rgba(0,0,0,.55)}
.kt-place .cap{font-size:14px;letter-spacing:.28em;text-transform:uppercase;opacity:.8;margin-top:6px}

/* ---- misc ---- */
.kt-hint{margin-top:min(3vh,22px);font-size:12.5px;letter-spacing:.13em;text-transform:uppercase;
  opacity:.55;text-align:center}
.kt-blink{animation:ktblink 1.5s ease-in-out infinite}
@keyframes ktblink{0%,100%{opacity:.35}50%{opacity:1}}
.kt-corner{position:absolute;left:22px;bottom:18px;font-size:11.5px;letter-spacing:.1em;opacity:.42}
.kt-pausebg{background:rgba(8,11,17,.55)!important;backdrop-filter:blur(4px)}
@media (max-width:820px){
  .kt-cs{grid-template-columns:1fr}
  .kt-grid{grid-template-columns:repeat(5,1fr)}
  .kt-panel{display:none}
}
`;

/* ------------------------------------------------------------- course art -- */

/** A tiny map of the course drawn from its own centreline. */
function courseArt(course) {
  const pts = course.preview || [];
  if (!pts.length) {
    return `<svg viewBox="0 0 300 150"><rect width="300" height="150" fill="${P.oliveDeep}"/></svg>`;
  }
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const w = maxX - minX || 1, h = maxZ - minZ || 1;
  const s = Math.min(258 / w, 112 / h);
  const ox = 150 - (minX + w / 2) * s, oy = 75 - (minZ + h / 2) * s;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] * s + ox).toFixed(1)} ${(p[1] * s + oy).toFixed(1)}`).join('') + 'Z';
  return `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="cg${course.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8FB4D8"/><stop offset=".46" stop-color="#C7BE93"/>
      <stop offset="1" stop-color="#7E8C4E"/></linearGradient></defs>
    <rect width="300" height="150" fill="url(#cg${course.id})"/>
    <g opacity=".28" fill="#4A5A2E">
      <ellipse cx="46" cy="128" rx="70" ry="26"/><ellipse cx="250" cy="132" rx="82" ry="24"/></g>
    <path d="${d}" fill="none" stroke="${P.ink}" stroke-width="9" stroke-linejoin="round" opacity=".55"/>
    <path d="${d}" fill="none" stroke="${P.cream}" stroke-width="5.4" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#5A5A55" stroke-width="3.4" stroke-linejoin="round"/>
  </svg>`;
}

/* =================================================================== menu === */

export function createMenu(opts = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return stubMenu();

  const O = Object.assign({
    mount: null,
    roster: [],
    courses: [],
    quality: null,
    title: 'Kat Racing',
    subtitle: 'Moshav Amikam · Ramot Menashe',
    tips: [
      'Hold DRIFT through a corner to charge a mini-turbo — three tiers, three colours.',
      'Hold accelerate as the last light goes out for a rocket start. Too early and you bog down.',
      'The orchard cut through the olive grove saves 95 m — if you carry a boost onto the loose dirt.',
      'Tuck in behind a rival for a second and the slipstream fires you past them.',
      'Every roof in the village is a real building footprint from Moshav Amikam.',
    ],
  }, opts);

  if (!doc.getElementById('kt-menu-style')) {
    const st = doc.createElement('style');
    st.id = 'kt-menu-style'; st.textContent = CSS;
    doc.head.appendChild(st);
  }

  const root = doc.createElement('div');
  root.className = 'kt-menu';
  (O.mount || doc.body).appendChild(root);

  let roster = O.roster.length ? O.roster : [{ id: 'mitzi', name: 'Mitzi', stats: {}, cat: {} }];
  let courses = O.courses.length ? O.courses : [{ id: 'amikam', name: 'Amikam Village Circuit' }];

  const listeners = new Map();
  const on = (t, cb) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(cb); return () => off(t, cb); };
  const off = (t, cb) => { const a = listeners.get(t); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } };
  const emit = (t, e = {}) => { const a = listeners.get(t); if (a) for (const cb of a) { try { cb(e); } catch (err) { console.warn('[menu]', err); } } };

  /* ------------------------------------------------------------- state --- */
  const state = {
    screen: 'loading',
    character: 0,
    course: 0,
    focus: 0,
    loading: 0,
    tip: 0,
  };

  const settings = {
    quality: O.quality ? (O.quality.auto ? 'auto' : O.quality.id) : 'auto',
    music: 70, sfx: 90,
    minimap: 'north',
    camera: 'chase',
    difficulty: 150,
  };

  /* ------------------------------------------------------------ markup --- */
  root.innerHTML = `
  <div class="veil" data-el="veil"></div>

  <section class="scr" data-scr="loading">
    <div class="kt-load">
      <div class="kt-spin"></div>
      <div class="kt-logo"><span class="k">KAT</span><span class="r">RACING</span></div>
      <div class="track"><div class="fill" data-el="loadfill"></div></div>
      <div class="msg" data-el="loadmsg">Loading</div>
      <div class="tip" data-el="loadtip"></div>
    </div>
  </section>

  <section class="scr" data-scr="title">
    <div class="kt-logo"><span class="k">KAT</span><span class="r">RACING</span>
      <span class="sub">${esc(O.subtitle)}</span></div>
    <div class="kt-list" data-el="titlelist"></div>
    <div class="kt-hint">Arrows / WASD to move · Enter or Space to select</div>
    <div class="kt-corner" data-el="gpu"></div>
  </section>

  <section class="scr" data-scr="characters">
    <h2 class="kt-title">Choose your racer</h2>
    <div class="kt-cs">
      <div class="kt-grid" data-el="cgrid"></div>
      <aside class="kt-panel" data-el="cpanel"></aside>
    </div>
    <div class="kt-hint">Enter to confirm · Backspace to go back</div>
  </section>

  <section class="scr" data-scr="courses">
    <h2 class="kt-title">Choose a course</h2>
    <div class="kt-courses" data-el="courselist"></div>
    <div class="kt-hint">Enter to start the race · Backspace to go back</div>
  </section>

  <section class="scr" data-scr="settings">
    <h2 class="kt-title">Settings</h2>
    <p class="kt-sub" data-el="gpuline"></p>
    <div class="kt-rows" data-el="setrows"></div>
    <div class="kt-hint">Left / Right to change · Backspace to go back</div>
  </section>

  <section class="scr" data-scr="pause">
    <h2 class="kt-title">Paused</h2>
    <div class="kt-list" data-el="pauselist"></div>
    <div class="kt-hint">Esc to resume</div>
  </section>

  <section class="scr" data-scr="results">
    <div class="kt-res">
      <div class="kt-place"><div class="big" data-el="placebig">1st</div>
        <div class="cap" data-el="placecap">Amikam Village Circuit</div></div>
      <table><tbody data-el="restable"></tbody></table>
      <div class="kt-list" style="margin-top:16px" data-el="reslist"></div>
    </div>
  </section>`;

  const el = {};
  for (const n of root.querySelectorAll('[data-el]')) el[n.dataset.el] = n;
  const screens = {};
  for (const n of root.querySelectorAll('[data-scr]')) screens[n.dataset.scr] = n;

  /* --------------------------------------------------------- menu items -- */
  const TITLE_ITEMS = [
    { id: 'grandprix', label: 'Grand Prix', sub: '3 laps · 8 karts' },
    { id: 'quick', label: 'Quick Race', sub: 'straight to the grid' },
    { id: 'settings', label: 'Settings' },
    { id: 'photo', label: 'Photo Mode', sub: 'free camera' },
  ];
  const PAUSE_ITEMS = [
    { id: 'resume', label: 'Resume' },
    { id: 'restart', label: 'Restart Race' },
    { id: 'photo', label: 'Photo Mode' },
    { id: 'settings', label: 'Settings' },
    { id: 'quit', label: 'Quit to Title' },
  ];
  const RESULT_ITEMS = [
    { id: 'restart', label: 'Race Again' },
    { id: 'characters', label: 'Change Racer' },
    { id: 'quit', label: 'Back to Title' },
  ];

  const QUALITY_VALUES = ['auto', 'potato', 'low', 'medium', 'high'];
  const DIFFS = [[50, 'Sunday Drive'], [100, 'Club'], [150, 'Pro'], [200, 'Ace']];
  const SET_ROWS = [
    {
      id: 'quality', label: 'Graphics', sub: 'auto-detects the renderer',
      get: () => settings.quality,
      show: () => (settings.quality === 'auto' && O.quality ? `Auto · ${O.quality.name}` : cap(settings.quality)),
      step: d => {
        const i = QUALITY_VALUES.indexOf(settings.quality);
        settings.quality = QUALITY_VALUES[(i + d + QUALITY_VALUES.length) % QUALITY_VALUES.length];
        O.quality?.set(settings.quality);
        emit('setting', { key: 'quality', value: settings.quality });
      },
    },
    {
      id: 'difficulty', label: 'CPU skill', sub: 'how hard the field pushes',
      show: () => (DIFFS.find(d => d[0] === settings.difficulty) || DIFFS[2])[1],
      step: d => {
        const i = DIFFS.findIndex(x => x[0] === settings.difficulty);
        settings.difficulty = DIFFS[(i + d + DIFFS.length) % DIFFS.length][0];
        emit('setting', { key: 'difficulty', value: settings.difficulty });
      },
    },
    {
      id: 'music', label: 'Music', show: () => settings.music + '%',
      step: d => { settings.music = Math.max(0, Math.min(100, settings.music + d * 10)); emit('setting', { key: 'music', value: settings.music / 100 }); },
    },
    {
      id: 'sfx', label: 'Sound effects', show: () => settings.sfx + '%',
      step: d => { settings.sfx = Math.max(0, Math.min(100, settings.sfx + d * 10)); emit('setting', { key: 'sfx', value: settings.sfx / 100 }); },
    },
    {
      id: 'minimap', label: 'Minimap', sub: 'north-up or heading-up',
      show: () => (settings.minimap === 'north' ? 'North up' : 'Heading up'),
      step: () => { settings.minimap = settings.minimap === 'north' ? 'heading' : 'north'; emit('setting', { key: 'minimap', value: settings.minimap }); },
    },
    { id: 'back', label: 'Back', show: () => '', step: () => {}, action: () => back() },
  ];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* ------------------------------------------------------------- build --- */
  function buildList(host, items, kind) {
    host.innerHTML = items.map((it, i) =>
      `<div class="kt-btn ${kind || ''}" data-i="${i}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`).join('');
    host.querySelectorAll('[data-i]').forEach(n => {
      n.addEventListener('click', () => { state.focus = +n.dataset.i; paint(); activate(); });
      n.addEventListener('mousemove', () => { if (state.focus !== +n.dataset.i) { state.focus = +n.dataset.i; paint(); } });
    });
  }
  buildList(el.titlelist, TITLE_ITEMS);
  buildList(el.pauselist, PAUSE_ITEMS, 'ghost');
  buildList(el.reslist, RESULT_ITEMS);

  function renderRoster() {
    el.cgrid.innerHTML = roster.map((r, i) =>
      `<div class="kt-card" data-i="${i}" title="${esc(r.name)}">${catPortrait(r.cat)}
        <span class="no">#${r.number ?? ''}</span><span class="nm">${esc(r.name)}</span></div>`).join('');
    el.cgrid.querySelectorAll('[data-i]').forEach(n => {
      n.addEventListener('click', () => { state.character = +n.dataset.i; state.focus = state.character; paint(); go('courses'); });
      n.addEventListener('mousemove', () => { const i = +n.dataset.i; if (state.character !== i) { state.character = i; state.focus = i; paint(); } });
    });
  }

  function renderCourses() {
    el.courselist.innerHTML = courses.map((c, i) =>
      `<div class="kt-course ${c.locked ? 'locked' : ''}" data-i="${i}">
        <div class="art">${courseArt(c)}</div>
        <div class="cap"><h4>${esc(c.name)}</h4><p>${esc(c.blurb || '')}</p>
          <div class="meta"><span>${c.laps ?? 3} laps</span><span>${c.lengthM ? (c.lengthM / 1000).toFixed(2) + ' km' : ''}</span>
          <span>${esc(c.surface || '')}</span></div></div>
      </div>`).join('');
    el.courselist.querySelectorAll('[data-i]').forEach(n => {
      n.addEventListener('click', () => {
        const i = +n.dataset.i;
        if (courses[i].locked) return;
        state.course = i; state.focus = i; paint(); startRace();
      });
      n.addEventListener('mousemove', () => { const i = +n.dataset.i; if (state.course !== i) { state.course = i; state.focus = i; paint(); } });
    });
  }
  renderRoster();
  renderCourses();

  function paintSettings() {
    el.setrows.innerHTML = SET_ROWS.map((r, i) =>
      `<div class="kt-row" data-i="${i}"><div class="lab">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
        <div class="val">${r.id === 'back' ? '' : '<span class="ar">◀</span>'}<span>${esc(r.show())}</span>${r.id === 'back' ? '' : '<span class="ar">▶</span>'}</div></div>`).join('');
    el.setrows.querySelectorAll('[data-i]').forEach(n => {
      n.addEventListener('click', ev => {
        const i = +n.dataset.i; state.focus = i;
        const r = SET_ROWS[i];
        if (r.action) r.action();
        else r.step(ev.offsetX < n.clientWidth * 0.5 ? -1 : 1);
        paintSettings(); paint();
      });
    });
    highlight(el.setrows, '[data-i]');
  }

  /* ------------------------------------------------------------- paint --- */
  function highlight(host, sel) {
    if (!host) return;
    const items = host.querySelectorAll(sel);
    items.forEach((n, i) => n.classList.toggle('sel', i === state.focus));
    const cur = items[state.focus];
    if (cur && cur.scrollIntoView) { /* keeps long lists usable on tiny screens */ }
  }

  function paintPanel() {
    const r = roster[state.character] || roster[0];
    const st = r.stats || {};
    el.cpanel.innerHTML = `<h3>${esc(r.name)}</h3>
      <p class="blurb">${esc(r.blurb || '')}</p>
      <div class="kart"><span>${esc(r.kartName || 'Standard Kart')}</span><span>${esc(r.liveryName || '')}</span></div>
      <div class="kt-stats">${STAT_KEYS.map(([k, lab]) =>
        `<span class="k">${lab}</span>${statBar(st[k] ?? 3)}`).join('')}</div>`;
    el.cgrid.querySelectorAll('[data-i]').forEach((n, i) => n.classList.toggle('sel', i === state.character));
  }

  function paint() {
    for (const k in screens) screens[k].classList.toggle('on', k === state.screen);
    root.classList.toggle('hidden', state.screen === 'none');
    el.veil.classList.toggle('kt-pausebg', state.screen === 'pause');
    if (state.screen === 'title') highlight(el.titlelist, '[data-i]');
    if (state.screen === 'pause') highlight(el.pauselist, '[data-i]');
    if (state.screen === 'results') highlight(el.reslist, '[data-i]');
    if (state.screen === 'characters') paintPanel();
    if (state.screen === 'courses') {
      el.courselist.querySelectorAll('[data-i]').forEach((n, i) => n.classList.toggle('sel', i === state.course));
    }
    if (state.screen === 'settings') highlight(el.setrows, '[data-i]');
  }

  /* ----------------------------------------------------------- actions --- */
  let prevScreen = 'title';
  function go(s) {
    if (s === state.screen) return;
    prevScreen = state.screen;
    state.screen = s;
    state.focus = s === 'characters' ? state.character : s === 'courses' ? state.course : 0;
    if (s === 'settings') paintSettings();
    paint();
    emit('screen', { screen: s, from: prevScreen });
  }

  function startRace() {
    const r = roster[state.character] || roster[0];
    const c = courses[state.course] || courses[0];
    emit('start', { character: r.id, characterIndex: state.character, course: c.id, courseIndex: state.course, settings: { ...settings } });
  }

  function back() {
    if (state.screen === 'courses') go('characters');
    else if (state.screen === 'characters') go('title');
    else if (state.screen === 'settings') go(prevScreen === 'pause' ? 'pause' : 'title');
    else if (state.screen === 'pause') emit('resume', {});
  }

  function activate() {
    const s = state.screen;
    if (s === 'title') {
      const it = TITLE_ITEMS[state.focus];
      if (it.id === 'grandprix') go('characters');
      else if (it.id === 'quick') startRace();
      else if (it.id === 'settings') go('settings');
      else if (it.id === 'photo') emit('photo', {});
    } else if (s === 'characters') { state.character = state.focus; go('courses'); }
    else if (s === 'courses') { if (!courses[state.focus]?.locked) { state.course = state.focus; startRace(); } }
    else if (s === 'settings') {
      const r = SET_ROWS[state.focus];
      if (r.action) r.action(); else r.step(1);
      paintSettings();
    } else if (s === 'pause') {
      const it = PAUSE_ITEMS[state.focus];
      if (it.id === 'resume') emit('resume', {});
      else if (it.id === 'restart') emit('restart', {});
      else if (it.id === 'photo') emit('photo', {});
      else if (it.id === 'settings') go('settings');
      else if (it.id === 'quit') emit('quit', {});
    } else if (s === 'results') {
      const it = RESULT_ITEMS[state.focus];
      if (it.id === 'restart') emit('restart', {});
      else if (it.id === 'characters') go('characters');
      else if (it.id === 'quit') emit('quit', {});
    }
  }

  /* ------------------------------------------------------------ update --- */
  const COUNTS = () => ({
    title: TITLE_ITEMS.length, pause: PAUSE_ITEMS.length, results: RESULT_ITEMS.length,
    settings: SET_ROWS.length, characters: roster.length, courses: courses.length, loading: 0, none: 0,
  }[state.screen] || 0);

  function update(dt, nav) {
    if (!nav || state.screen === 'loading' || state.screen === 'none') return api;
    const n = COUNTS();
    if (!n) return api;
    const cols = state.screen === 'characters' ? 5 : state.screen === 'courses' ? Math.max(1, Math.min(3, n)) : 1;
    let f = state.focus;
    if (nav.up) f -= cols;
    if (nav.down) f += cols;
    if (state.screen === 'settings') {
      if (nav.left) { SET_ROWS[f].step?.(-1); paintSettings(); }
      if (nav.right) { SET_ROWS[f].step?.(1); paintSettings(); }
    } else {
      if (nav.left) f -= 1;
      if (nav.right) f += 1;
    }
    if (f !== state.focus) {
      state.focus = ((f % n) + n) % n;
      if (state.screen === 'characters') state.character = state.focus;
      if (state.screen === 'courses') state.course = state.focus;
      paint();
      emit('move', { focus: state.focus });
    }
    if (nav.confirm) activate();
    else if (nav.back) back();
    return api;
  }

  /* -------------------------------------------------------------- api ---- */
  let tipTimer = 0;
  const api = {
    root, state, settings, on, off, emit,
    get screen() { return state.screen; },
    get visible() { return state.screen !== 'none'; },
    show(s = 'title') { go(s === state.screen ? s : s); state.screen = s; paint(); return api; },
    hide() { state.screen = 'none'; paint(); return api; },
    go,
    back,
    update,
    /** The roster and the course list only exist once the world is built; fill them in here. */
    setData({ roster: r, courses: c } = {}) {
      if (Array.isArray(r) && r.length) { roster = r; state.character = Math.min(state.character, r.length - 1); renderRoster(); }
      if (Array.isArray(c) && c.length) { courses = c; state.course = Math.min(state.course, c.length - 1); renderCourses(); }
      paint();
      return api;
    },
    get roster() { return roster; },
    get courses() { return courses; },
    setLoading(p, msg) {
      state.loading = Math.max(0, Math.min(1, p));
      el.loadfill.style.width = (state.loading * 100).toFixed(1) + '%';
      if (msg) el.loadmsg.textContent = msg;
      if (!el.loadtip.textContent || (tipTimer++ % 40) === 0) {
        el.loadtip.textContent = O.tips[(state.tip++) % O.tips.length];
      }
      return api;
    },
    setGPU(text) { el.gpu.textContent = text; el.gpuline.textContent = text; return api; },
    setCharacter(i) { state.character = Math.max(0, Math.min(roster.length - 1, i | 0)); paint(); return api; },
    get character() { return roster[state.character]; },
    get course() { return courses[state.course]; },
    /**
     * @param {Array<{place,name,time,bestLap,isPlayer,dnf}>} rows
     * @param {{format:Function, course:string}} [meta]
     */
    setResults(rows, meta = {}) {
      const fmt = meta.format || (t => (Number.isFinite(t) ? t.toFixed(2) + 's' : '—'));
      const me = rows.find(r => r.isPlayer);
      el.placebig.textContent = me ? ordinal(me.place) : '—';
      el.placecap.textContent = meta.course || (courses[state.course]?.name || '');
      el.restable.innerHTML = rows.map(r =>
        `<tr class="p${r.place}${r.isPlayer ? ' me' : ''}"><td>${r.place}</td>
          <td><span class="nm">${esc(r.name)}</span></td>
          <td class="best">${r.bestLap ? 'best ' + fmt(r.bestLap) : ''}</td>
          <td>${r.dnf ? 'DNF' : fmt(r.time)}</td></tr>`).join('');
      state.focus = 0;
      return api;
    },
    dispose() { root.remove(); },
  };

  const ordinal = n => {
    n = Math.max(1, Math.round(n || 1));
    const r10 = n % 10, r100 = n % 100;
    const suf = (r100 >= 11 && r100 <= 13) ? 'th' : r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th';
    return n + suf;
  };

  if (O.quality) api.setGPU(O.quality.describe());
  paint();
  return api;
}

function stubMenu() {
  const noop = () => stub;
  const stub = {
    root: null, state: { screen: 'none' }, settings: {},
    on: noop, off: noop, emit: noop, show: noop, hide: noop, go: noop, back: noop,
    update: noop, setLoading: noop, setGPU: noop, setResults: noop, setCharacter: noop,
    dispose: noop, get visible() { return false; }, get screen() { return 'none'; },
  };
  return stub;
}

export default createMenu;
