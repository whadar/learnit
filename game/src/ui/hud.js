/**
 * Kat Racing - the in-race HUD.
 *
 * A DOM/CSS overlay (crisp at any resolution, free anti-aliasing, cheap to animate) sitting on
 * top of the WebGL canvas, plus one 2D canvas for the minimap. Everything is built from a
 * single palette drawn off the Israeli landscape: olive, terracotta, cream, wheat and sky.
 * Every element is a plate with a dark outline and a soft drop shadow so it stays legible over
 * a bright sunlit village.
 *
 *   import { createHUD } from './ui/hud.js';
 *   const hud = createHUD({ mount: container, track, world, field: 12 });
 *   hud.update(dt, {
 *     phase:'racing', place:3, field:12, lap:2, laps:3, time:74.2, lapTime:24.1,
 *     bestLap:23.4, speedKmh:118, item:{ item:'sabra', count:1, spinning:false },
 *     drift:{ active:true, charge:1.8, tier:2 }, coins:6, wrongWay:false,
 *     minimap:{ racers:[...], items:[...] },
 *   });
 *
 * `update()` is idempotent and allocation-free in the steady state: it only writes to the DOM
 * when a value actually changed.
 */
import { clamp, lerp, damp } from '../core/mathx.js';
import { createMinimap } from './minimap.js';

/* =============================================================== formatting */

export const ORDINALS = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

export function ordinal(n) {
  n = Math.max(1, Math.round(n || 1));
  if (n < ORDINALS.length) return ORDINALS[n];
  const r10 = n % 10, r100 = n % 100;
  const suf = (r100 >= 11 && r100 <= 13) ? 'th' : r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th';
  return n + suf;
}
export const ordinalSuffix = n => ordinal(n).replace(/^\d+/, '');
export const ordinalNumber = n => Math.max(1, Math.round(n || 1));

const QUOTE = '′';      // prime, for minutes
const DQUOTE = '″';     // double prime, for seconds

/** 1'23"456, and a dashed placeholder for anything not finite. */
export function fmtTime(t, ms = true) {
  if (!Number.isFinite(t) || t < 0) return ms ? `--${QUOTE}--${DQUOTE}---` : `--${QUOTE}--`;
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = (s < 10 ? '0' : '') + (ms ? s.toFixed(3) : s.toFixed(2));
  return m + QUOTE + ss.replace('.', DQUOTE);
}
/** Signed split against a reference: +1.284 / -0.512. */
export function fmtDelta(d) {
  if (!Number.isFinite(d)) return '';
  return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3);
}

/* ================================================================== palette */

export const PALETTE = {
  cream:      '#FFF8E7',
  creamDeep:  '#F0E2C4',
  ink:        '#241F16',
  inkSoft:    '#3B3426',
  olive:      '#6E7A3C',
  oliveDeep:  '#404A21',
  oliveLight: '#9CA85F',
  terracotta: '#C9552F',
  terraLight: '#E3784C',
  sky:        '#3FA9E0',
  skyLight:   '#8FD3F4',
  skyDeep:    '#1B6FA8',
  wheat:      '#E9B84A',
  wheatLight: '#FFD46B',
  gold:       '#FFCE3D',
  silver:     '#E2E6EA',
  bronze:     '#D2884A',
  danger:     '#E23D2E',
  mint:       '#63C8A0',
  grape:      '#8E63C8',
};

/* Mini-turbo tier colours: blue -> orange -> violet, like the sparks off the wheels. */
export const TIER_COLORS = ['#8FD3F4', '#3FA9E0', '#FF9B2F', '#C86BE8'];
export const TIER_NAMES = ['CHARGING', 'MINI-TURBO', 'SUPER MINI-TURBO', 'ULTRA MINI-TURBO'];

/* =============================================================== item icons */

/**
 * Every item drawn as a tiny inline SVG - no files, scales to any slot size, and each keeps the
 * item's own colour from items.js so the HUD and the world agree.
 */
export const ITEM_ART = {
  sabra:   c => `<ellipse cx="32" cy="36" rx="15" ry="19" fill="${c}"/><ellipse cx="19" cy="27" rx="8" ry="11" fill="${c}" transform="rotate(-28 19 27)"/><ellipse cx="45" cy="27" rx="7" ry="10" fill="${c}" transform="rotate(26 45 27)"/><g stroke="#F6F2D8" stroke-width="2.2" stroke-linecap="round" opacity=".9"><path d="M26 26l-4-4M32 30v-6M39 27l4-4M26 42l-4 4M33 46v6M40 43l4 4"/></g><path d="M32 7l6 11H26z" fill="#D9534A"/>`,
  jaffa:   c => `<circle cx="32" cy="35" r="19" fill="${c}"/><circle cx="26" cy="28" r="6" fill="#FFC98A" opacity=".55"/><path d="M32 16c4-6 10-6 12-3-3 5-8 6-12 3z" fill="#5C8A34"/><rect x="30" y="11" width="4" height="8" rx="2" fill="#7A5A2E"/>`,
  jaffa3:  c => `<circle cx="19" cy="43" r="12" fill="${c}"/><circle cx="45" cy="43" r="12" fill="${c}"/><circle cx="32" cy="23" r="13" fill="${c}"/><path d="M32 9c3-4 8-4 9-2-2 4-6 5-9 2z" fill="#5C8A34"/>`,
  pan:     c => `<ellipse cx="29" cy="35" rx="19" ry="15" fill="#3A342C"/><ellipse cx="29" cy="33" rx="14" ry="11" fill="${c}"/><circle cx="25" cy="31" r="4" fill="#FFD86B"/><circle cx="34" cy="36" r="3.4" fill="#FFD86B"/><rect x="45" y="28" width="17" height="5.5" rx="2.7" fill="#5A4A34" transform="rotate(-14 45 28)"/>`,
  falafel: c => `<circle cx="32" cy="35" r="17" fill="${c}"/><g fill="#B6BF6A" opacity=".85"><circle cx="25" cy="29" r="3"/><circle cx="38" cy="31" r="2.6"/><circle cx="31" cy="41" r="2.8"/><circle cx="40" cy="41" r="2.2"/></g><path d="M20 17c2-5 7-8 12-8M46 21c1-4-1-8-4-10" stroke="#FF8A3D" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  falafel3:c => `<circle cx="19" cy="43" r="11" fill="${c}"/><circle cx="45" cy="43" r="11" fill="${c}"/><circle cx="32" cy="24" r="12" fill="${c}"/><path d="M32 9c0-4 3-6 6-6" stroke="#FF8A3D" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  hummus:  c => `<ellipse cx="32" cy="42" rx="22" ry="11" fill="${c}"/><ellipse cx="32" cy="39" rx="16" ry="7.5" fill="#EFE0B4"/><circle cx="32" cy="38" r="4" fill="#8FA246"/><ellipse cx="47" cy="47" rx="6" ry="3" fill="${c}"/><ellipse cx="16" cy="48" rx="5" ry="2.6" fill="${c}"/>`,
  pardes:  c => `<rect x="12" y="21" width="40" height="30" rx="4" fill="${c}"/><path d="M12 31h40M12 41h40M25 21v30M39 21v30" stroke="#8A6942" stroke-width="2.6"/><rect x="12" y="21" width="40" height="30" rx="4" fill="none" stroke="#8A6942" stroke-width="3"/><circle cx="20" cy="17" r="6.5" fill="#EF8B1F"/><circle cx="34" cy="14" r="6.5" fill="#EF8B1F"/>`,
  khamsin: c => `<path d="M32 7c8 6 13 15 13 23 0 12-7 23-13 27-6-4-13-15-13-27 0-8 5-17 13-23z" fill="${c}"/><g stroke="#9C7439" stroke-width="2.8" fill="none" stroke-linecap="round" opacity=".8"><path d="M23 21c8 3 12 3 18 0M21 32c11 4 15 4 23 0M23 42c8 3 12 3 17 0"/></g>`,
  hamsa:   c => `<path d="M32 55c-9 0-15-7-15-16V26c0-3.2 4.4-3.2 4.4 0v8h2.2V17c0-3.2 4.4-3.2 4.4 0v15h2.2V13c0-3.2 4.4-3.2 4.4 0v19h2.2V17c0-3.2 4.4-3.2 4.4 0v17h2.2v-8c0-3.2 4.4-3.2 4.4 0v13c0 9-6 16-13 16z" fill="${c}"/><circle cx="32" cy="37" r="5.4" fill="#FFF8E7"/><circle cx="32" cy="37" r="2.5" fill="#1B4E7A"/>`,
  avatiach:c => `<path d="M9 23a23 23 0 0 0 46 0z" fill="#E2465A"/><path d="M7 20h50v4H7z" fill="#F6F2D8"/><path d="M5 15h54v6H5z" fill="${c}"/><g fill="#2A2A20"><ellipse cx="23" cy="32" rx="2" ry="2.6"/><ellipse cx="34" cy="35" rx="2" ry="2.6"/><ellipse cx="43" cy="30" rx="2" ry="2.6"/></g>`,
  catnap:  c => `<ellipse cx="29" cy="39" rx="20" ry="12" fill="${c}"/><ellipse cx="42" cy="33" rx="12" ry="9" fill="${c}"/><ellipse cx="19" cy="34" rx="10" ry="8" fill="${c}"/><g fill="#7686B4"><path d="M42 20l6-7 1 8zM52 22l7-4-3 7z"/></g>`,
  duchifat:c => `<path d="M15 41c4-11 15-17 25-15 6 1 10 6 8 11-2 6-10 8-16 7l-6 7z" fill="${c}"/><path d="M27 22l3-11 3 7 4-7 2 10z" fill="#3A332A"/><path d="M46 34l14 4-14 4z" fill="#3A332A"/><circle cx="33" cy="31" r="2.4" fill="#2A2A20"/>`,
  afifon:  c => `<path d="M32 6l17 19-17 25-17-25z" fill="${c}"/><path d="M32 6v44M15 25h34" stroke="#F6F2D8" stroke-width="2.2" opacity=".75"/><path d="M32 50c4 4 0 8 4 11" stroke="#F6F2D8" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
};
const ITEM_FALLBACK = c => `<circle cx="32" cy="32" r="19" fill="${c}"/>`;

export function itemIconSVG(id, colorHex) {
  const art = ITEM_ART[id] || ITEM_FALLBACK;
  const c = colorHex || '#E9B84A';
  return `<svg viewBox="0 0 64 64" class="kr-itemart" aria-hidden="true">`
    + `<g stroke="#241F16" stroke-width="3.6" stroke-linejoin="round" paint-order="stroke">${art(c)}</g></svg>`;
}
export const hexColor = n => typeof n === 'string' ? n : '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

/* ==================================================================== styles */

const CSS = `
.kr-hud{
  --cream:${PALETTE.cream}; --creamDeep:${PALETTE.creamDeep}; --ink:${PALETTE.ink};
  --olive:${PALETTE.olive}; --oliveDeep:${PALETTE.oliveDeep}; --terra:${PALETTE.terracotta};
  --sky:${PALETTE.sky}; --skyDeep:${PALETTE.skyDeep}; --wheat:${PALETTE.wheat}; --gold:${PALETTE.gold};
  --plate: linear-gradient(180deg,rgba(255,251,238,.97),rgba(238,223,193,.95));
  --plateDark: linear-gradient(180deg,rgba(58,52,39,.92),rgba(31,27,20,.94));
  --edge: 0 0 0 3px var(--ink), 0 5px 0 rgba(0,0,0,.22), 0 12px 26px rgba(0,0,0,.34);
  --ease: cubic-bezier(.22,1,.36,1);
  --pop: cubic-bezier(.34,1.56,.64,1);
  position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;
  font-family:'Trebuchet MS','Liberation Sans','DejaVu Sans',Verdana,system-ui,sans-serif;
  font-weight:700;color:var(--ink);-webkit-font-smoothing:antialiased;
  -webkit-user-select:none;user-select:none;
  container-type:size;
}
.kr-hud *{box-sizing:border-box;margin:0}

/* ---- corner anchors ---- */
.kr-hud .kr-tl{position:absolute;left:2.2cqmin;top:2.2cqmin;display:flex;gap:1.4cqmin;align-items:flex-start}
.kr-hud .kr-tr{position:absolute;right:2.2cqmin;top:2.2cqmin;display:flex;flex-direction:column;align-items:flex-end;gap:1.4cqmin}
.kr-hud .kr-bl{position:absolute;left:2.6cqmin;bottom:3.4cqmin;display:flex;flex-direction:column;align-items:flex-start;gap:1.2cqmin}
.kr-hud .kr-br{position:absolute;right:2.6cqmin;bottom:2.8cqmin;display:flex;flex-direction:column;align-items:flex-end;gap:1.1cqmin}
.kr-hud .kr-mid{position:absolute;inset:0;display:grid;place-items:center}

/* ---- item slot ---- */
.kr-hud .kr-slot{position:relative;width:14cqmin;height:14cqmin;min-width:92px;min-height:92px;
  border-radius:24%;background:var(--plate);box-shadow:var(--edge);
  display:grid;place-items:center;transition:transform .18s var(--pop)}
.kr-hud .kr-slot::before{content:'';position:absolute;inset:7%;border-radius:20%;
  background:radial-gradient(circle at 50% 20%,rgba(255,255,255,.98),rgba(228,211,177,.30) 60%,rgba(174,152,113,.34));
  box-shadow:inset 0 2px 5px rgba(255,255,255,.95),inset 0 -7px 13px rgba(120,100,70,.24)}
.kr-hud .kr-slot .kr-itemart{position:relative;width:74%;height:74%;display:block;
  filter:drop-shadow(0 3px 3px rgba(0,0,0,.38))}
.kr-hud .kr-slot > div{position:relative;width:100%;height:100%;display:grid;place-items:center}
.kr-hud .kr-slot.empty{background:linear-gradient(180deg,rgba(247,241,226,.80),rgba(224,210,182,.78))}
.kr-hud .kr-slot.empty .kr-itemart{display:none}
.kr-hud .kr-slot.empty::after{content:'';position:absolute;inset:24%;border-radius:26%;
  border:.42cqmin dashed rgba(96,82,56,.42)}
.kr-hud .kr-slot.spin{animation:kr-slotspin .42s linear infinite}
.kr-hud .kr-slot.got{animation:kr-got .5s var(--pop)}
@keyframes kr-slotspin{0%,100%{transform:rotate(-2deg) scale(1)}50%{transform:rotate(2deg) scale(1.04)}}
@keyframes kr-got{0%{transform:scale(1)}35%{transform:scale(1.22)}100%{transform:scale(1)}}
.kr-hud .kr-count{position:absolute;right:-6%;bottom:-6%;width:37%;height:37%;padding:0;
  border-radius:50%;background:radial-gradient(circle at 38% 28%,#F2A277,#E3784C 42%,#A8452A);
  color:var(--cream);text-shadow:0 1px 0 rgba(0,0,0,.45);
  box-shadow:0 0 0 3px var(--ink),0 3px 0 rgba(0,0,0,.28);display:grid;place-items:center;
  font-size:4.6cqmin;line-height:1;letter-spacing:-.02em;opacity:0;transform:scale(.6);
  transition:opacity .18s var(--ease),transform .22s var(--pop);z-index:2}
.kr-hud .kr-count.on{opacity:1;transform:scale(1)}
.kr-hud .kr-held{display:flex;flex-direction:column;gap:.8cqmin;padding-top:1.6cqmin}
.kr-hud .kr-tag{padding:.55cqmin 1.3cqmin;border-radius:999px;font-size:2.3cqmin;letter-spacing:.08em;
  background:var(--plateDark);color:var(--cream);box-shadow:0 0 0 2.6px var(--ink),0 3px 0 rgba(0,0,0,.24);
  white-space:nowrap;text-transform:uppercase;opacity:0;transform:translateX(-10px);
  transition:opacity .2s var(--ease),transform .2s var(--ease)}
.kr-hud .kr-tag.on{opacity:1;transform:none}
.kr-hud .kr-tag.shield{background:linear-gradient(180deg,#8FD9F8,#2E86BE);color:#06273E;
  text-shadow:0 1px 0 rgba(255,255,255,.35)}

/* ---- lap chip + minimap + clock ---- */
.kr-hud .kr-lap{display:flex;align-items:baseline;gap:.7cqmin;padding:.6cqmin 1.8cqmin;border-radius:999px;
  background:var(--plate);box-shadow:var(--edge)}
.kr-hud .kr-lap .w{font-size:2.4cqmin;letter-spacing:.16em;color:var(--oliveDeep);text-transform:uppercase}
.kr-hud .kr-lap .n{font-size:4.8cqmin;line-height:.95;letter-spacing:-.03em;color:var(--ink)}
.kr-hud .kr-lap .d{font-size:2.8cqmin;color:#93855F}
.kr-hud .kr-lap.final{background:linear-gradient(180deg,#FFE9A8,#EFBB43)}
.kr-hud .kr-lap.final .w{color:#7A4A12}
.kr-hud .kr-lap.bump{animation:kr-got .45s var(--pop)}

.kr-hud .kr-mapwrap{position:relative;padding:1.1cqmin;border-radius:20px;background:var(--plate);box-shadow:var(--edge)}
.kr-hud .kr-mapwrap canvas{display:block;border-radius:13px;box-shadow:inset 0 0 0 2.5px rgba(36,31,22,.9)}
.kr-hud .kr-maplabel{position:absolute;left:50%;bottom:-1.1cqmin;transform:translateX(-50%);
  padding:.3cqmin 1.2cqmin;border-radius:999px;background:var(--plateDark);color:var(--cream);
  font-size:1.75cqmin;letter-spacing:.14em;text-transform:uppercase;box-shadow:0 0 0 2.4px var(--ink);white-space:nowrap}

.kr-hud .kr-clock{display:flex;flex-direction:column;align-items:flex-end;gap:.3cqmin;
  padding:.8cqmin 1.5cqmin;border-radius:15px;background:var(--plateDark);color:var(--cream);
  box-shadow:0 0 0 3px var(--ink),0 4px 0 rgba(0,0,0,.24),0 10px 20px rgba(0,0,0,.32)}
.kr-hud .kr-clock .row{display:flex;align-items:baseline;gap:.9cqmin}
.kr-hud .kr-clock .k{font-size:1.8cqmin;letter-spacing:.16em;opacity:.7;text-transform:uppercase}
.kr-hud .kr-clock .v{font-size:3.0cqmin;line-height:1.05;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.kr-hud .kr-clock .v.big{font-size:3.8cqmin;color:var(--wheat)}
.kr-hud .kr-split{font-size:2.1cqmin;letter-spacing:.02em;padding:.1cqmin .9cqmin;border-radius:999px;
  background:rgba(255,255,255,.10);opacity:0;transition:opacity .25s var(--ease)}
.kr-hud .kr-split.on{opacity:1}
.kr-hud .kr-split.up{background:rgba(226,61,46,.4);color:#FFCFC7}
.kr-hud .kr-split.down{background:rgba(99,200,160,.34);color:#CCF7E6}

/* ---- position badge ---- */
/* NOTE: every [data-p] override below must use `background-image`, never the `background`
   shorthand - the shorthand resets background-clip to border-box and the gradient then paints
   as an opaque plate behind the glyphs instead of inside them. */
.kr-hud .kr-pos{position:relative;display:flex;align-items:flex-start;
  filter:drop-shadow(0 4px 0 rgba(0,0,0,.26)) drop-shadow(0 12px 22px rgba(0,0,0,.42));
  transition:transform .3s var(--pop)}
.kr-hud .kr-pos .num,.kr-hud .kr-pos .suf{
  -webkit-background-clip:text;background-clip:text;color:transparent;
  background-repeat:no-repeat;background-size:100% 100%}
.kr-hud .kr-pos .num{font-size:16cqmin;line-height:.88;letter-spacing:-.06em;
  -webkit-text-stroke:.86cqmin var(--ink);paint-order:stroke fill;
  background-image:linear-gradient(180deg,#FFFDF4 4%,#FFD24A 46%,#B8791A 92%)}
.kr-hud .kr-pos .suf{font-size:6.8cqmin;line-height:1;margin-top:1.4cqmin;letter-spacing:-.02em;
  -webkit-text-stroke:.62cqmin var(--ink);paint-order:stroke fill;
  background-image:linear-gradient(180deg,#FFFDF4,#E8A93A)}
.kr-hud .kr-pos[data-p="2"] .num{background-image:linear-gradient(180deg,#FFFFFF 4%,#DCE3EA 46%,#8B98A6 92%)}
.kr-hud .kr-pos[data-p="2"] .suf{background-image:linear-gradient(180deg,#FFFFFF,#B9C3CD)}
.kr-hud .kr-pos[data-p="3"] .num{background-image:linear-gradient(180deg,#FFF0DE 4%,#E0904A 46%,#94551F 92%)}
.kr-hud .kr-pos[data-p="3"] .suf{background-image:linear-gradient(180deg,#FFF0DE,#C67D3E)}
.kr-hud .kr-pos[data-p="0"] .num{background-image:linear-gradient(180deg,#FFFDF3 4%,#EFE3C8 46%,#A3936E 92%)}
.kr-hud .kr-pos[data-p="0"] .suf{background-image:linear-gradient(180deg,#FFFDF3,#C7B896)}
.kr-hud .kr-pos.up{animation:kr-posup .55s var(--pop)}
.kr-hud .kr-pos.down{animation:kr-posdown .55s var(--pop)}
@keyframes kr-posup{0%{transform:translateY(16px) scale(.84)}60%{transform:translateY(-5px) scale(1.11)}100%{transform:none}}
@keyframes kr-posdown{0%{transform:translateY(-14px) scale(1.09)}60%{transform:translateY(4px) scale(.94)}100%{transform:none}}
.kr-hud .kr-field{align-self:flex-end;font-size:2.5cqmin;letter-spacing:.10em;color:var(--cream);
  text-shadow:0 0 4px rgba(0,0,0,.95),0 2px 0 rgba(0,0,0,.6);margin-left:.7cqmin;margin-bottom:1.1cqmin}

/* ---- coins ---- */
.kr-hud .kr-coins{display:flex;align-items:center;gap:1.0cqmin;padding:.5cqmin 1.6cqmin .5cqmin .5cqmin;
  border-radius:999px;background:var(--plate);box-shadow:var(--edge)}
.kr-hud .kr-coins .c{width:4.6cqmin;height:4.6cqmin;min-width:26px;min-height:26px;border-radius:50%;
  background:radial-gradient(circle at 38% 28%,#FFF6CE,#FFCE3D 55%,#BF8712);
  box-shadow:0 0 0 2.8px var(--ink),inset 0 -1.6px 3px rgba(120,80,0,.45);display:grid;place-items:center;
  font-size:2.6cqmin;color:#8E6209}
.kr-hud .kr-coins .n{font-size:4.1cqmin;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kr-hud .kr-coins.bump{animation:kr-got .4s var(--pop)}

/* ---- speedometer ---- */
/* The dial is one self-contained SVG: no CSS drop-shadow (that duplicated every tick as a
   ghost), no needle over the digits - the value rides the arc as a knob instead. */
.kr-hud .kr-speedo{position:relative;width:24cqmin;height:14.2cqmin;min-width:170px;min-height:100px}
.kr-hud .kr-speedo svg{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;display:block}
.kr-hud .kr-speedo text{font-family:inherit;font-weight:700}
.kr-hud .kr-speedo .val{fill:var(--ink);transition:fill .18s var(--ease)}
.kr-hud .kr-speedo .unit{fill:#7A6E4C;letter-spacing:.22em}
.kr-hud .kr-speedo.boost .val{fill:#B34A12}
.kr-hud .kr-speedo.boost [data-knobdot]{fill:#FF8A2F}

/* ---- mini-turbo charge ---- */
.kr-hud .kr-mt{display:flex;flex-direction:column;align-items:flex-end;gap:.55cqmin;
  opacity:0;transform:translateY(8px);transition:opacity .18s var(--ease),transform .18s var(--ease)}
.kr-hud .kr-mt.on{opacity:1;transform:none}
.kr-hud .kr-mt .bar{position:relative;width:23cqmin;height:2.6cqmin;min-width:152px;min-height:16px;border-radius:999px;
  background:var(--plateDark);box-shadow:0 0 0 2.8px var(--ink),0 3px 0 rgba(0,0,0,.24);overflow:hidden}
.kr-hud .kr-mt .fill{position:absolute;top:.36cqmin;left:.36cqmin;bottom:.36cqmin;width:0;border-radius:999px;
  background:linear-gradient(90deg,#8FD3F4,#3FA9E0);transition:background .18s var(--ease);
  box-shadow:0 0 10px rgba(143,211,244,.8)}
.kr-hud .kr-mt .fill.t2{background:linear-gradient(90deg,#FFC46B,#FF8A2F);box-shadow:0 0 12px rgba(255,150,50,.85)}
.kr-hud .kr-mt .fill.t3{background:linear-gradient(90deg,#EFB6FF,#B24AE8);box-shadow:0 0 14px rgba(200,110,240,.9)}
.kr-hud .kr-mt .pips{position:absolute;inset:0;display:flex;pointer-events:none}
.kr-hud .kr-mt .pips i{border-right:2.6px solid rgba(0,0,0,.5)}
.kr-hud .kr-mt .lab{font-size:1.95cqmin;letter-spacing:.18em;color:var(--cream);text-transform:uppercase;
  text-shadow:0 0 4px rgba(0,0,0,.9),0 2px 0 rgba(0,0,0,.55)}
.kr-hud .kr-mt.ready .bar{animation:kr-mtready .3s ease-in-out infinite alternate}
@keyframes kr-mtready{from{transform:scale(1)}to{transform:scale(1.04)}}

/* ---- centre messages ---- */
.kr-hud .kr-count3{font-size:27cqmin;line-height:1;letter-spacing:-.05em;
  -webkit-text-stroke:1.3cqmin var(--ink);paint-order:stroke fill;
  background:linear-gradient(180deg,#FFFDF4 8%,#FFCE3D 50%,#B87516 96%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 8px 0 rgba(0,0,0,.28)) drop-shadow(0 18px 30px rgba(0,0,0,.45));
  opacity:0;transform:scale(2.4)}
.kr-hud .kr-count3.tick{animation:kr-tick .95s var(--ease) forwards}
.kr-hud .kr-count3.go{background:linear-gradient(180deg,#F4FFEA 8%,#8FE05A 46%,#3C8B22 96%);animation:kr-go .9s var(--pop) forwards}
@keyframes kr-tick{0%{opacity:0;transform:scale(2.4)}22%{opacity:1;transform:scale(1)}72%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.86)}}
@keyframes kr-go{0%{opacity:0;transform:scale(.3) rotate(-8deg)}30%{opacity:1;transform:scale(1.25) rotate(2deg)}55%{transform:scale(1) rotate(0)}100%{opacity:0;transform:scale(1.5)}}

.kr-hud .kr-banner{position:absolute;left:50%;top:15%;transform:translate(-50%,-16px) scale(.9);
  padding:.95cqmin 2.8cqmin;border-radius:999px;font-size:3.3cqmin;letter-spacing:.12em;text-transform:uppercase;
  background:linear-gradient(180deg,#FFF0B8,#EFB63A);box-shadow:var(--edge);opacity:0;
  transition:opacity .24s var(--ease),transform .28s var(--pop);white-space:nowrap}
.kr-hud .kr-banner.on{opacity:1;transform:translate(-50%,0) scale(1)}

.kr-hud .kr-wrong{position:absolute;left:50%;top:29%;transform:translate(-50%,0);
  display:flex;align-items:center;gap:1.3cqmin;padding:1.0cqmin 2.6cqmin;border-radius:15px;
  background:linear-gradient(180deg,#F2513E,#B7291B);color:#FFF3EC;box-shadow:var(--edge);
  font-size:3.5cqmin;letter-spacing:.12em;text-transform:uppercase;opacity:0;visibility:hidden}
.kr-hud .kr-wrong.on{visibility:visible;animation:kr-wrong .62s ease-in-out infinite alternate}
.kr-hud .kr-wrong .ar{font-size:4.4cqmin;line-height:.9}
@keyframes kr-wrong{from{opacity:.6;transform:translate(-50%,0) scale(.97)}to{opacity:1;transform:translate(-50%,0) scale(1.04)}}

.kr-hud .kr-rocket{position:absolute;left:50%;top:63%;transform:translate(-50%,0);
  padding:.85cqmin 2.4cqmin;border-radius:999px;font-size:2.7cqmin;letter-spacing:.2em;text-transform:uppercase;
  background:var(--plateDark);color:var(--cream);box-shadow:0 0 0 3px var(--ink),0 5px 0 rgba(0,0,0,.28);
  opacity:0;transition:opacity .2s var(--ease);white-space:nowrap}
.kr-hud .kr-rocket.on{opacity:1;animation:kr-rockpulse .5s ease-in-out infinite alternate}
.kr-hud .kr-rocket.perfect{background:linear-gradient(180deg,#96E463,#3C8B22);color:#0E2408}
.kr-hud .kr-rocket.burn{background:linear-gradient(180deg,#F2513E,#912116)}
@keyframes kr-rockpulse{from{transform:translate(-50%,0) scale(1)}to{transform:translate(-50%,0) scale(1.05)}}

/* ---- full-screen effects ---- */
.kr-hud .kr-flash{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:radial-gradient(ellipse at 50% 58%,rgba(255,255,255,0) 32%,rgba(255,196,84,.5) 76%,rgba(255,122,26,.85) 100%)}
.kr-hud .kr-lines{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:repeating-conic-gradient(from 0deg at 50% 55%,rgba(255,255,255,.34) 0deg .45deg,rgba(255,255,255,0) .45deg 4.6deg);
  -webkit-mask-image:radial-gradient(ellipse at 50% 55%,transparent 24%,#000 74%);
  mask-image:radial-gradient(ellipse at 50% 55%,transparent 24%,#000 74%)}
.kr-hud .kr-hurt{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 38%,rgba(190,30,20,.72) 100%)}

/* ---- standings strip, shown on the final lap ---- */
.kr-hud .kr-strip{position:absolute;left:2.6cqmin;top:50%;transform:translate(-130%,-50%);
  display:flex;flex-direction:column;gap:.28cqmin;padding:.9cqmin .9cqmin 1.0cqmin;border-radius:17px;
  background:var(--plateDark);box-shadow:var(--edge);
  transition:transform .34s var(--ease),opacity .3s var(--ease);opacity:0}
.kr-hud .kr-strip.on{transform:translate(0,-50%);opacity:1}
.kr-hud .kr-strip .hd{display:flex;align-items:center;gap:.7cqmin;padding:0 .5cqmin .55cqmin;
  font-size:1.7cqmin;letter-spacing:.20em;text-transform:uppercase;color:rgba(255,248,231,.62)}
.kr-hud .kr-strip .hd::after{content:'';flex:1;height:2px;border-radius:2px;background:rgba(255,248,231,.20)}
.kr-hud .kr-strip .r{display:flex;align-items:center;gap:.85cqmin;font-size:2.1cqmin;color:#F3EBDA;
  padding:.28cqmin .9cqmin .28cqmin .28cqmin;border-radius:999px;line-height:1}
.kr-hud .kr-strip .r.me{background:linear-gradient(180deg,#FFE08A,#E9A93A);color:#2E1F05;
  box-shadow:0 0 0 2.4px var(--ink),0 2px 0 rgba(0,0,0,.3)}
.kr-hud .kr-strip .r .p{width:3.0cqmin;height:3.0cqmin;flex:none;border-radius:50%;
  display:grid;place-items:center;font-size:1.85cqmin;color:#2A2419;
  background:linear-gradient(180deg,#EFE7D4,#BEB39A);box-shadow:0 0 0 1.8px rgba(20,17,12,.85)}
.kr-hud .kr-strip .r[data-p="1"] .p{background:linear-gradient(180deg,#FFF0BE,#E8A93A)}
.kr-hud .kr-strip .r[data-p="2"] .p{background:linear-gradient(180deg,#FFFFFF,#B9C3CD)}
.kr-hud .kr-strip .r[data-p="3"] .p{background:linear-gradient(180deg,#FFE1BF,#C67D3E)}
.kr-hud .kr-strip .r .k{width:1.0cqmin;height:2.4cqmin;flex:none;border-radius:3px;
  background:var(--k,#8FA05B);box-shadow:0 0 0 1.6px rgba(20,17,12,.8)}
.kr-hud .kr-strip .r .n{min-width:10cqmin;letter-spacing:.02em;white-space:nowrap}
.kr-hud .kr-strip .r .g{margin-left:auto;opacity:.7;font-variant-numeric:tabular-nums;font-size:1.8cqmin;
  padding-left:1.2cqmin}
.kr-hud .kr-strip .r.me .g{opacity:.85}

.kr-hud.hidden{opacity:0;transition:opacity .25s var(--ease)}

/* ---- cinematic: the pre-race flythrough is a plate, not a gameplay frame ---- */
.kr-hud .kr-title{position:absolute;left:3.4cqmin;bottom:4.2cqmin;display:flex;flex-direction:column;
  align-items:flex-start;gap:.8cqmin;opacity:0;transform:translateY(10px);
  transition:opacity .45s var(--ease),transform .45s var(--ease);pointer-events:none}
.kr-hud .kr-title .k{padding:.45cqmin 1.5cqmin;border-radius:999px;font-size:1.9cqmin;letter-spacing:.24em;
  text-transform:uppercase;background:var(--plateDark);color:var(--cream);
  box-shadow:0 0 0 2.6px var(--ink),0 3px 0 rgba(0,0,0,.26)}
.kr-hud .kr-title .t{font-size:6.4cqmin;line-height:1;letter-spacing:-.01em;
  -webkit-text-stroke:.62cqmin var(--ink);paint-order:stroke fill;
  background-image:linear-gradient(180deg,#FFFDF4 6%,#FFD24A 52%,#C4862099 96%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 4px 0 rgba(0,0,0,.26)) drop-shadow(0 12px 24px rgba(0,0,0,.45))}
.kr-hud.cine .kr-title{opacity:1;transform:none}
.kr-hud.cine .kr-tl,.kr-hud.cine .kr-tr,.kr-hud.cine .kr-bl,.kr-hud.cine .kr-br,
.kr-hud.cine .kr-rocket,.kr-hud.cine .kr-strip,.kr-hud.cine .kr-wrong,.kr-hud.cine .kr-banner{
  opacity:0;transition:opacity .3s var(--ease);pointer-events:none}
`;

/* ================================================================== the HUD */

export function createHUD(opts = {}) {
  const O = Object.assign({
    mount: null,
    track: null,
    world: null,
    field: 12,
    laps: 3,
    minimap: true,
    minimapSize: 190,
    minimapMode: 'north',
    driftTiers: [0.62, 1.55, 2.65],
    topSpeedKmh: 150,
    standingsOnFinalLap: true,
    trackName: 'Amikam Village Circuit',
  }, opts);

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return stubHUD();

  ensureStyle(doc);
  const root = doc.createElement('div');
  root.className = 'kr-hud';
  root.dataset.phase = 'idle';
  root.innerHTML = `
  <div class="kr-tl">
    <div class="kr-slot empty" data-el="slot"><div data-el="art"></div><div class="kr-count" data-el="count">2</div></div>
    <div class="kr-held">
      <div class="kr-tag" data-el="itemname">&mdash;</div>
      <div class="kr-tag shield" data-el="shield">Held</div>
    </div>
  </div>

  <div class="kr-tr">
    <div class="kr-lap" data-el="lapchip"><span class="w">Lap</span><span class="n" data-el="lap">1</span><span class="d">/</span><span class="n" data-el="laps">3</span></div>
    <div class="kr-mapwrap" data-el="mapwrap"><div class="kr-maplabel" data-el="maplabel">Amikam</div></div>
    <div class="kr-clock">
      <div class="row"><span class="k">Total</span><span class="v big" data-el="total">0${QUOTE}00${DQUOTE}000</span></div>
      <div class="row"><span class="k">Lap</span><span class="v" data-el="laptime">0${QUOTE}00${DQUOTE}000</span><span class="kr-split" data-el="split"></span></div>
      <div class="row"><span class="k">Best</span><span class="v" data-el="best">--${QUOTE}--${DQUOTE}---</span></div>
    </div>
  </div>

  <div class="kr-bl">
    <div class="kr-coins" data-el="coinbox"><div class="c">&#10022;</div><div class="n" data-el="coins">0</div></div>
    <div class="kr-pos" data-el="pos" data-p="1"><span class="num" data-el="posnum">1</span><span class="suf" data-el="possuf">st</span><span class="kr-field" data-el="field">/12</span></div>
  </div>

  <div class="kr-br">
    <div class="kr-mt" data-el="mt">
      <div class="lab" data-el="mtlab">Mini-Turbo</div>
      <div class="bar"><div class="fill" data-el="mtfill"></div><div class="pips" data-el="pips"></div></div>
    </div>
    <div class="kr-speedo" data-el="speedo">${speedoSVG()}</div>
  </div>

  <div class="kr-mid"><div class="kr-count3" data-el="count3"></div></div>
  <div class="kr-banner" data-el="banner"></div>
  <div class="kr-wrong" data-el="wrong"><span class="ar">&#9664;</span><span>Wrong Way</span><span class="ar">&#9654;</span></div>
  <div class="kr-rocket" data-el="rocket"></div>
  <div class="kr-strip" data-el="strip"></div>
  <div class="kr-title" data-el="title"><div class="k" data-el="titlekind">Grand Prix</div><div class="t" data-el="titlename">Amikam Village Circuit</div></div>
  <div class="kr-flash" data-el="flash"></div>
  <div class="kr-lines" data-el="lines"></div>
  <div class="kr-hurt" data-el="hurt"></div>`;

  const el = {};
  for (const n of root.querySelectorAll('[data-el]')) el[n.dataset.el] = n;
  (O.mount || doc.body).appendChild(root);

  // mini-turbo pips sit at the tier thresholds, not at even thirds
  {
    const t = O.driftTiers, max = t[2] * 1.12;
    el.pips.innerHTML = t.map((v, i) => {
      const prevV = i ? t[i - 1] : 0;
      return `<i style="width:${((v - prevV) / max * 100).toFixed(2)}%"></i>`;
    }).join('') + `<i style="flex:1;border-right:0"></i>`;
  }

  /* --------------------------------------------------------------- minimap */
  let map = null;
  if (O.minimap) {
    try {
      map = createMinimap({ track: O.track, world: O.world, size: O.minimapSize, mode: O.minimapMode });
      if (map && map.canvas) el.mapwrap.insertBefore(map.canvas, el.maplabel);
      el.maplabel.textContent = O.trackName || 'Circuit';
    } catch (e) {
      console.warn('[hud] minimap unavailable:', e && e.message);
      el.mapwrap.style.display = 'none';
    }
  } else el.mapwrap.style.display = 'none';

  /* ----------------------------------------------------------------- state */
  const prev = {
    place: 0, field: -1, lap: 0, laps: -1, item: ' ', count: -1, coins: -1, kmh: -1,
    phase: '', wrong: null, tier: -1, drift: null, spinning: null, shield: null,
    total: '', laptime: '', best: '', split: '', banner: '', rocket: '', strip: '',
    name: '', final: null,
  };
  let speedShown = 0, needleShown = 0, mtShown = 0;
  let flash = 0, lines = 0, hurt = 0, pulse = 0;
  let lastLapNumber = 0, refLap = Infinity, splitHold = 0, splitText = '', splitCls = '';
  let count3Shown = null;
  const knob = el.speedo.querySelector('[data-knob]');
  const gaugeFill = el.speedo.querySelector('[data-gauge]');
  el.kmh = el.speedo.querySelector('[data-el="kmh"]');
  el.title.style.display = O.trackName ? '' : 'none';
  el.titlename.textContent = O.trackName || 'Circuit';

  const mapData = { racers: [], items: [], player: null, pulse: 0, dt: 0 };

  /* ---------------------------------------------------------------- update */
  function update(dt, s = {}) {
    dt = clamp(dt || 0, 0, 0.1);
    pulse += dt;

    const phase = s.phase || 'racing';
    if (phase !== prev.phase) { root.dataset.phase = phase; prev.phase = phase; }

    /* ---- position ---- */
    const place = ordinalNumber(s.place);
    if (place !== prev.place) {
      el.posnum.textContent = place;
      el.possuf.textContent = ordinalSuffix(place);
      el.pos.dataset.p = place <= 3 ? String(place) : '0';
      if (prev.place) {
        el.pos.classList.remove('up', 'down');
        void el.pos.offsetWidth;
        el.pos.classList.add(place < prev.place ? 'up' : 'down');
      }
      prev.place = place;
    }
    const field = s.field == null ? O.field : s.field;
    if (field !== prev.field) { el.field.textContent = '/' + field; prev.field = field; }

    /* ---- lap ---- */
    const laps = Math.round(s.laps == null ? O.laps : s.laps);
    const lap = clamp(Math.round(s.lap == null ? 1 : s.lap), 1, Math.max(1, laps));
    if (lap !== prev.lap) {
      el.lap.textContent = lap;
      el.lapchip.classList.remove('bump'); void el.lapchip.offsetWidth; el.lapchip.classList.add('bump');
      prev.lap = lap;
    }
    if (laps !== prev.laps) { el.laps.textContent = laps; prev.laps = laps; }
    const final = lap >= laps && laps > 1;
    if (final !== prev.final) { el.lapchip.classList.toggle('final', final); prev.final = final; }

    /* ---- clocks + split ---- */
    const total = fmtTime(s.time);
    if (total !== prev.total) { el.total.textContent = total; prev.total = total; }
    const lapT = fmtTime(s.lapTime);
    if (lapT !== prev.laptime) { el.laptime.textContent = lapT; prev.laptime = lapT; }
    const best = fmtTime(s.bestLap);
    if (best !== prev.best) { el.best.textContent = best; prev.best = best; }

    if (Number.isFinite(s.lastLap) && (s.lapCount == null ? lap : s.lapCount) !== lastLapNumber) {
      lastLapNumber = s.lapCount == null ? lap : s.lapCount;
      if (Number.isFinite(refLap)) {
        const d = s.lastLap - refLap;
        splitText = fmtDelta(d);
        splitCls = d > 0 ? 'up' : 'down';
      } else { splitText = fmtTime(s.lastLap, false); splitCls = 'down'; }
      refLap = Math.min(refLap, s.lastLap);
      splitHold = 4.5;
    }
    if (splitHold > 0) {
      splitHold -= dt;
      if (prev.split !== splitText) { el.split.textContent = splitText; prev.split = splitText; }
      el.split.className = 'kr-split on ' + splitCls;
      if (splitHold <= 0) el.split.className = 'kr-split';
    }

    /* ---- item slot ---- */
    const it = s.item || null;
    const spinning = !!(it && it.spinning);
    const face = spinning ? (it.rouletteFace || it.item) : (it && it.item);
    const key = (face || '') + (spinning ? '#' : '');
    if (key !== prev.item) {
      const col = it && it.color != null ? hexColor(it.color) : PALETTE.wheat;
      el.art.innerHTML = itemIconSVG(face || 'jaffa', face ? col : '#9A8E74');
      el.slot.classList.toggle('empty', !face);
      if (!spinning && prev.item.endsWith('#') && face) {
        el.slot.classList.remove('got'); void el.slot.offsetWidth; el.slot.classList.add('got');
      }
      prev.item = key;
    }
    if (spinning !== prev.spinning) { el.slot.classList.toggle('spin', spinning); prev.spinning = spinning; }
    const cnt = it && !spinning ? (it.count || 0) : 0;
    if (cnt !== prev.count) {
      el.count.textContent = cnt;
      el.count.classList.toggle('on', cnt > 1);
      prev.count = cnt;
    }
    const iname = spinning ? '• • •' : (it && it.name ? it.name : '');
    if (iname !== prev.name) {
      el.itemname.textContent = iname || '—';
      el.itemname.classList.toggle('on', !!iname);
      prev.name = iname;
    }
    const shield = !!(it && it.shield);
    if (shield !== prev.shield) { el.shield.classList.toggle('on', shield); prev.shield = shield; }

    /* ---- coins ---- */
    const coins = Math.max(0, Math.round(s.coins || 0));
    if (coins !== prev.coins) {
      el.coins.textContent = String(coins);
      if (coins > prev.coins && prev.coins >= 0) {
        el.coinbox.classList.remove('bump'); void el.coinbox.offsetWidth; el.coinbox.classList.add('bump');
      }
      prev.coins = coins;
    }

    /* ---- speed ---- */
    const kmh = Math.max(0, s.speedKmh || 0);
    speedShown = damp(speedShown, kmh, 14, dt);
    const shown = Math.round(speedShown);
    if (shown !== prev.kmh) { el.kmh.textContent = shown; prev.kmh = shown; }
    const top = s.topSpeedKmh || O.topSpeedKmh;
    needleShown = damp(needleShown, clamp(speedShown / top, 0, 1.06), 16, dt);
    const gt = clamp(needleShown, 0, 1);
    if (knob) knob.setAttribute('transform', `rotate(${lerp(GAUGE_A0, GAUGE_A1, gt).toFixed(2)} ${DIAL_X} ${DIAL_Y})`);
    if (gaugeFill) gaugeFill.setAttribute('stroke-dashoffset', (GAUGE_LEN * (1 - gt)).toFixed(2));
    const boosting = !!(s.boost && (s.boost === true || s.boost.time > 0));
    el.speedo.classList.toggle('boost', boosting);

    /* ---- mini-turbo ---- */
    const d = s.drift || {};
    const chargeMax = O.driftTiers[2] * 1.12;
    const charge = clamp((d.charge || 0) / chargeMax, 0, 1);
    const tier = Math.min(3, d.tier || 0);
    const showMT = !!d.active || charge > 0.02;
    if (showMT !== prev.drift) { el.mt.classList.toggle('on', showMT); prev.drift = showMT; }
    mtShown = damp(mtShown, charge, 24, dt);
    el.mtfill.style.width = `calc(${(mtShown * 100).toFixed(1)}% - 0.72cqmin)`;
    if (tier !== prev.tier) {
      el.mtfill.className = 'fill' + (tier >= 3 ? ' t3' : tier === 2 ? ' t2' : '');
      el.mt.classList.toggle('ready', tier >= 3);
      el.mtlab.textContent = TIER_NAMES[tier];
      prev.tier = tier;
    }

    /* ---- wrong way ---- */
    const wrong = !!s.wrongWay && phase === 'racing';
    if (wrong !== prev.wrong) { el.wrong.classList.toggle('on', wrong); prev.wrong = wrong; }

    /* ---- countdown numerals ---- */
    if (phase === 'countdown' || phase === 'racing') {
      let want = null;
      if (phase === 'countdown' && Number.isFinite(s.countdown)) want = String(clamp(Math.ceil(s.countdown), 1, 5));
      else if (phase === 'racing' && (s.sinceGo == null ? 9 : s.sinceGo) < 0.9) want = 'GO!';
      if (want !== count3Shown) {
        count3Shown = want;
        el.count3.className = 'kr-count3';
        void el.count3.offsetWidth;
        el.count3.textContent = want || '';
        if (want) el.count3.classList.add(want === 'GO!' ? 'go' : 'tick');
      }
    } else if (count3Shown !== null) {
      count3Shown = null; el.count3.textContent = ''; el.count3.className = 'kr-count3';
    }

    /* ---- rocket-start prompt ---- */
    let rk = '', rkCls = '';
    if (phase === 'countdown' && (s.countdown == null ? 9 : s.countdown) < 2.2) { rk = 'Hold accelerate'; rkCls = 'on'; }
    if (s.rocket === 'perfect') { rk = 'Rocket Start!'; rkCls = 'on perfect'; }
    else if (s.rocket === 'good') { rk = 'Good Start'; rkCls = 'on'; }
    else if (s.rocket === 'burnout') { rk = 'Burnout — too early'; rkCls = 'on burn'; }
    if (rk !== prev.rocket) {
      if (rk) el.rocket.textContent = rk;
      el.rocket.className = 'kr-rocket ' + (rk ? rkCls : '');
      prev.rocket = rk;
    }

    /* ---- banner ---- */
    let banner = s.message || '';
    if (!banner && final && phase === 'racing' && (s.lapAge == null ? 9 : s.lapAge) < 3) banner = 'Final Lap!';
    if (phase === 'finished') banner = 'Finish';
    if (banner !== prev.banner) {
      if (banner) el.banner.textContent = banner;
      el.banner.classList.toggle('on', !!banner);
      prev.banner = banner;
    }

    /* ---- standings strip ---- */
    const wantStrip = O.standingsOnFinalLap && Array.isArray(s.standings) && (final || phase === 'finished');
    if (wantStrip) {
      const rows = s.standings.slice(0, 8);
      const sig = rows.map(r => r.place + ':' + r.name).join('|');
      if (sig !== prev.strip) {
        el.strip.innerHTML = '<div class="hd">Standings</div>' + rows.map(r =>
          `<div class="r${r.player ? ' me' : ''}" data-p="${r.place}">`
          + `<span class="p">${r.place}</span>`
          + `<span class="k" style="--k:${liveryFor(r)}"></span>`
          + `<span class="n">${escapeHTML(r.name)}</span>`
          + `<span class="g">${r.gap == null ? (r.player ? 'You' : '') : (r.gap > 0 ? '+' + r.gap.toFixed(1) : '—')}</span></div>`).join('');
        prev.strip = sig;
      }
      el.strip.classList.add('on');
    } else el.strip.classList.remove('on');

    /* ---- full-screen effects ---- */
    if (s.boostFlash) flash = Math.max(flash, clamp(s.boostFlash, 0, 1));
    if (boosting) { flash = Math.max(flash, 0.45); lines = Math.max(lines, 0.85); }
    if (s.hit) hurt = Math.max(hurt, clamp(s.hit, 0, 1));
    flash = Math.max(0, flash - dt * 2.4);
    lines = Math.max(0, lines - dt * 2.0);
    hurt = Math.max(0, hurt - dt * 1.4);
    el.flash.style.opacity = (flash * 0.9).toFixed(3);
    el.lines.style.opacity = (lines * clamp(needleShown - 0.3, 0, 1) * 1.2).toFixed(3);
    el.hurt.style.opacity = (hurt * 0.85).toFixed(3);

    /* ---- minimap ---- */
    if (map && s.minimap) {
      if (s.minimap.racers) mapData.racers = s.minimap.racers;
      if (s.minimap.items) mapData.items = s.minimap.items;
      mapData.player = s.minimap.player || mapData.racers.find(r => r.player) || null;
      mapData.pulse = pulse; mapData.dt = dt;
      map.update(mapData);
    }
    return api;
  }

  const api = {
    root, dom: root, minimap: map, el,
    update,
    setTrack(t) { O.track = t; if (map) map.setTrack(t); return api; },
    setTrackName(n) { O.trackName = n; el.maplabel.textContent = n; return api; },
    setMinimapMode(m) { if (map) map.setMode(m); return api; },
    toggleMinimapMode() { return map ? map.toggleMode() : null; },
    show(v = true) { root.classList.toggle('hidden', !v); return api; },
    hide() { return api.show(false); },
    flashBoost(a = 1) { flash = Math.max(flash, a); lines = Math.max(lines, a); return api; },
    shakeHit(a = 1) { hurt = Math.max(hurt, a); return api; },
    resize() { return api; },
    dispose() { if (map) map.dispose(); root.remove(); },
  };
  return api;
}

/* ------------------------------------------------------------------ helpers */

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ensureStyle(doc) {
  if (doc.getElementById('kr-hud-style')) return;
  const st = doc.createElement('style');
  st.id = 'kr-hud-style';
  st.textContent = CSS;
  doc.head.appendChild(st);
}

/** A 236-unit arc gauge with tick marks and a chunky needle. */
function speedoSVG() {
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = lerp(-118, 118, i / 10) * Math.PI / 180;
    const major = i % 5 === 0;
    const r0 = major ? 54 : 60, r1 = 69;
    ticks.push(`<line x1="${(100 + Math.sin(a) * r0).toFixed(1)}" y1="${(92 - Math.cos(a) * r0).toFixed(1)}"`
      + ` x2="${(100 + Math.sin(a) * r1).toFixed(1)}" y2="${(92 - Math.cos(a) * r1).toFixed(1)}"`
      + ` stroke="#5B5039" stroke-width="${major ? 3.6 : 2}" stroke-linecap="round" opacity="${major ? 0.95 : 0.55}"/>`);
  }
  return `<svg viewBox="0 0 200 116" preserveAspectRatio="xMidYMax meet">
    <defs>
      <linearGradient id="krPlate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFCF0"/><stop offset="1" stop-color="#EBDCBB"/></linearGradient>
      <linearGradient id="krGauge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#9CC85F"/><stop offset=".55" stop-color="#E9B84A"/><stop offset="1" stop-color="#D8452A"/></linearGradient>
    </defs>
    <path d="M6 112 A 94 94 0 0 1 194 112 Z" fill="url(#krPlate)" stroke="#241F16" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 33.3 25.0 A 78 78 0 0 1 166.7 25.0" fill="none" stroke="rgba(60,52,36,.20)" stroke-width="11" stroke-linecap="round"/>
    <path data-gauge d="M 33.3 25.0 A 78 78 0 0 1 166.7 25.0" fill="none" stroke="url(#krGauge)" stroke-width="11"
      stroke-linecap="round" stroke-dasharray="236" stroke-dashoffset="236"/>
    ${ticks.join('')}
    <g data-needle transform="rotate(-118 100 92)">
      <path d="M100 24 L104.4 90 L95.6 90 Z" fill="#C9552F" stroke="#241F16" stroke-width="3.2" stroke-linejoin="round"/>
    </g>
    <circle cx="100" cy="92" r="9" fill="#FFF8E7" stroke="#241F16" stroke-width="4.6"/>
  </svg>`;
}

function stubHUD() {
  const stub = {};
  const noop = () => stub;
  Object.assign(stub, {
    root: null, dom: null, minimap: null, el: {},
    update: noop, setTrack: noop, setTrackName: noop, setMinimapMode: noop,
    toggleMinimapMode: noop, show: noop, hide: noop, flashBoost: noop, shakeHit: noop,
    resize: noop, dispose() {},
  });
  return stub;
}

export default createHUD;
