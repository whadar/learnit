/**
 * Keyboard, gamepad and touch merged into one polled object.
 *
 * The steering sign lives here and nowhere else. The vehicle and the AI both use a convention
 * where a POSITIVE steer produces a positive yaw rate, and with `yaw = atan2(fwd.x, fwd.z)` over
 * a +X-east/+Z-south world that is a turn to the driver's LEFT. So the player's "right" is
 * negative, and only this mapping flips it — flipping the physics instead would invert the AI,
 * which computes its own steer in the same convention and drives the circuit correctly.
 */
import { clamp, damp } from './math.js';

const KEYS = {
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  drift: ['Space'], item: ['ControlLeft', 'ShiftLeft', 'KeyJ'],
  pause: ['Escape', 'KeyP'], reset: ['KeyR'],
};

export function createInput(opts = {}) {
  const held = new Set();
  const tapped = new Set();
  const out = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, pause: false, reset: false };
  const touch = { steer: 0, throttle: 0, brake: 0, drift: 0, item: 0, pauseTap: false, active: false };
  let smooth = 0;

  const doc = typeof document !== 'undefined' ? document : null;
  if (doc) {
    addEventListener('keydown', e => {
      if (!held.has(e.code)) tapped.add(e.code);
      held.add(e.code);
      if (Object.values(KEYS).flat().includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => held.delete(e.code));
    addEventListener('blur', () => held.clear());
  }
  const down = list => list.some(k => held.has(k));
  const hit = list => list.some(k => tapped.has(k));

  /* ---- touch: a stick and three buttons, mounted on the BODY ----------------------------
   * Not on the canvas. Children of a <canvas> are fallback content: the browser parses them,
   * querySelector finds them, they have computed styles, and they are never laid out. A whole
   * touch control set once shipped at 0x0 px that way. */
  let ui = null;
  const wantTouch = opts.touch === true
    || (opts.touch !== false && typeof matchMedia === 'function'
        && (matchMedia('(pointer: coarse)').matches || (navigator?.maxTouchPoints ?? 0) > 0));
  if (doc && wantTouch) {
    ui = doc.createElement('div');
    ui.className = 'dk-touch';
    ui.innerHTML = `<div class="dk-stick"><i></i></div>
      <button class="dk-b dk-drift">DRIFT</button>
      <button class="dk-b dk-item">ITEM</button>
      <button class="dk-b dk-pause" aria-label="Pause">&#10074;&#10074;</button>
      <style>
      .dk-touch{position:fixed;inset:0;z-index:40;pointer-events:none;font:800 12px Overpass,sans-serif;
        -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
      .dk-touch .dk-stick{position:absolute;left:3vmin;bottom:3vmin;width:32vmin;height:32vmin;
        max-width:200px;max-height:200px;border-radius:50%;pointer-events:auto;touch-action:none;
        background:radial-gradient(circle at 50% 38%,rgba(255,255,255,.22),rgba(20,24,30,.32));
        border:3px solid rgba(255,255,255,.5);display:grid;place-items:center}
      .dk-touch .dk-stick i{width:36%;height:36%;border-radius:50%;background:#eef2f7;
        border:3px solid rgba(20,24,30,.4);transition:transform .06s linear}
      .dk-touch .dk-b{position:absolute;pointer-events:auto;touch-action:none;border:0;border-radius:999px;
        color:#181c22;box-shadow:0 5px 0 rgba(0,0,0,.3);font:inherit;letter-spacing:.06em}
      .dk-touch .dk-drift{right:3vmin;bottom:3vmin;width:21vmin;height:21vmin;max-width:140px;max-height:140px;
        background:linear-gradient(180deg,#ffd873,#e9a63a)}
      .dk-touch .dk-item{right:25vmin;bottom:6vmin;width:15vmin;height:15vmin;max-width:100px;max-height:100px;
        background:linear-gradient(180deg,#9adcf7,#41a6dd)}
      .dk-touch .dk-pause{top:2.4vmin;right:2.4vmin;width:11vmin;height:11vmin;max-width:54px;max-height:54px;
        background:linear-gradient(180deg,#f0f3f7,#c3cbd4);opacity:.85;font-size:3.2vmin}
      </style>`;
    doc.body.appendChild(ui);

    const stick = ui.querySelector('.dk-stick'), nub = ui.querySelector('.dk-stick i');
    let id = null, cx = 0, cy = 0, R = 1;
    const dead = (v, d) => (Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d));
    const move = e => {
      if (e.pointerId !== id) return;
      const dx = clamp((e.clientX - cx) / R, -1, 1), dy = clamp((e.clientY - cy) / R, -1, 1);
      touch.steer = dead(dx, 0.12);
      const v = dead(-dy, 0.2);
      touch.throttle = Math.max(0, v); touch.brake = Math.max(0, -v); touch.active = true;
      nub.style.transform = `translate(${dx * R * 0.5}px,${dy * R * 0.5}px)`;
      e.preventDefault();
    };
    stick.addEventListener('pointerdown', e => {
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width * 0.42;
      id = e.pointerId; stick.setPointerCapture(e.pointerId); move(e);
    }, { passive: false });
    stick.addEventListener('pointermove', move, { passive: false });
    const end = e => { if (e.pointerId !== id) return; id = null; touch.steer = touch.throttle = touch.brake = 0; nub.style.transform = 'translate(0,0)'; };
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);

    const hold = (sel, key) => {
      const el = ui.querySelector(sel);
      el.addEventListener('pointerdown', e => { touch[key] = 1; touch.active = true; el.setPointerCapture(e.pointerId); e.preventDefault(); }, { passive: false });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => { touch[key] = 0; });
    };
    hold('.dk-drift', 'drift'); hold('.dk-item', 'item');
    ui.querySelector('.dk-pause').addEventListener('pointerup', () => { touch.pauseTap = true; touch.active = true; });
  }

  function poll(dt) {
    const pad = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()[0] : null;
    let thr = down(KEYS.up) ? 1 : 0, brk = down(KEYS.down) ? 1 : 0;
    let raw = (down(KEYS.right) ? 1 : 0) - (down(KEYS.left) ? 1 : 0);
    let drift = down(KEYS.drift) ? 1 : 0, item = down(KEYS.item) ? 1 : 0;
    let analogue = false;

    if (pad) {
      thr = Math.max(thr, pad.buttons[7]?.value ?? 0);
      brk = Math.max(brk, pad.buttons[6]?.value ?? 0);
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) { raw = ax; analogue = true; }
      drift = Math.max(drift, (pad.buttons[0]?.value ?? 0) > 0.5 ? 1 : 0);
      item = Math.max(item, (pad.buttons[2]?.value ?? 0) > 0.5 ? 1 : 0);
    }
    if (touch.active) {
      thr = Math.max(thr, touch.throttle); brk = Math.max(brk, touch.brake);
      drift = Math.max(drift, touch.drift); item = Math.max(item, touch.item);
      if (touch.steer) { raw = touch.steer; analogue = true; }
    }

    // digital steering ramps and self-centres; a stick passes straight through
    smooth = analogue ? raw : damp(smooth, raw, 9, dt);
    if (!analogue && !raw) smooth = damp(smooth, 0, 13, dt);

    out.throttle = thr; out.brake = brk;
    out.steer = clamp(-smooth, -1, 1);          // the one place the player's sign is flipped
    out.drift = drift; out.item = item;
    out.pause = hit(KEYS.pause) || touch.pauseTap || (pad && pad.buttons[9]?.pressed) || false;
    out.reset = hit(KEYS.reset);
    touch.pauseTap = false;
    tapped.clear();
    return out;
  }

  return { poll, out, keyHeld: c => held.has(c),
    get touchVisible() { return !!ui; },
    dispose() { ui?.remove(); } };
}
