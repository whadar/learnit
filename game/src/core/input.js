/**
 * Kat Racing — player input.
 *
 * One poll-based source that merges keyboard, gamepad and on-screen touch controls into the
 * single control vector the vehicle wants:
 *
 *   import { createInput } from './core/input.js';
 *   const input = createInput({ element: renderer.domElement, touch: 'auto' });
 *   race.setInput(input.poll());          // or race({ input: () => input.poll() })
 *   input.menu();                         // edge-triggered { up,down,left,right,confirm,back,start }
 *   input.dispose();
 *
 * Nothing is allocated per frame: `poll()` fills and returns the same object every time.
 * The module has no side effects on import — listeners are attached by the factory.
 */
import { clamp } from './mathx.js';

/* ------------------------------------------------------------------ tuning -- */

export const BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake:    ['KeyS', 'ArrowDown'],
  left:     ['KeyA', 'ArrowLeft'],
  right:    ['KeyD', 'ArrowRight'],
  drift:    ['Space'],
  item:     ['ShiftLeft', 'ShiftRight', 'KeyE'],
  look:     ['KeyC'],
  reset:    ['KeyR'],
  pause:    ['Escape', 'KeyP'],
  confirm:  ['Enter', 'NumpadEnter', 'KeyZ'],
  back:     ['Backspace', 'KeyX'],
};

/** Standard-gamepad button indices. */
const PAD = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
  back: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15,
};

/**
 * Radial deadzone plus a mild expo curve. Below `dz` the stick is dead; above it the range is
 * re-normalised so the first pixel of travel is still zero-ish but full deflection is exactly 1.
 * `expo` 0 = linear, 1 = fully cubic (finer control around centre — what analogue steering wants).
 */
export function applyDeadzone(v, dz = 0.16, expo = 0.45, max = 0.98) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  let t = (a - dz) / Math.max(1e-4, max - dz);
  t = clamp(t, 0, 1);
  t = t * (1 - expo) + t * t * t * expo;
  return Math.sign(v) * t;
}

/** Two-axis version so diagonal stick travel cannot exceed 1 nor snap on the axes. */
export function stickVector(x, y, dz = 0.16, expo = 0.45, out = { x: 0, y: 0, m: 0 }) {
  const m = Math.hypot(x, y);
  if (m <= dz) { out.x = 0; out.y = 0; out.m = 0; return out; }
  let t = clamp((m - dz) / (1 - dz), 0, 1);
  t = t * (1 - expo) + t * t * t * expo;
  out.x = x / m * t; out.y = y / m * t; out.m = t;
  return out;
}

const isTouchDevice = () => typeof matchMedia === 'function'
  && (matchMedia('(pointer: coarse)').matches || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

/* ==================================================================== input == */

export function createInput(opts = {}) {
  const O = Object.assign({
    element: null,            // where touch controls mount (defaults to document.body)
    target: null,             // keyboard listener target (defaults to window)
    touch: 'auto',            // true | false | 'auto'
    deadzone: 0.16,
    triggerDeadzone: 0.08,
    expo: 0.45,
    steerRate: 6.5,           // 1/s ramp for digital (keyboard) steering
    steerReturn: 11.0,        // 1/s recentre when no key is held
    analogueThrottle: true,
    invertLook: false,
    gamepadIndex: null,       // null = first connected pad
  }, opts);

  const doc = typeof document !== 'undefined' ? document : null;
  const target = O.target || (typeof window !== 'undefined' ? window : null);
  const keys = new Set();
  const pressedEdge = new Set();      // keys that went down since the last menu() call

  /* ------------------------------------------------------------- keyboard -- */
  const down = e => {
    if (e.repeat) { e.preventDefault?.(); return; }
    const c = e.code;
    if (!c) return;
    keys.add(c); pressedEdge.add(c);
    if (SWALLOW.has(c)) e.preventDefault?.();
  };
  const up = e => { if (e.code) keys.delete(e.code); };
  const blur = () => { keys.clear(); };
  const SWALLOW = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
  if (target) {
    target.addEventListener('keydown', down, { passive: false });
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
  }
  const held = list => { for (const k of list) if (keys.has(k)) return true; return false; };
  const tapped = list => { for (const k of list) if (pressedEdge.has(k)) return true; return false; };

  /* -------------------------------------------------------------- gamepad -- */
  let padIndex = O.gamepadIndex;
  let padConnected = false;
  const onPadConnect = e => { if (padIndex == null) padIndex = e.gamepad.index; };
  const onPadDisconnect = e => { if (padIndex === e.gamepad.index) padIndex = O.gamepadIndex; };
  if (target && target.addEventListener) {
    target.addEventListener('gamepadconnected', onPadConnect);
    target.addEventListener('gamepaddisconnected', onPadDisconnect);
  }
  function readPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    let pads;
    try { pads = navigator.getGamepads(); } catch (e) { return null; }
    if (!pads) return null;
    if (padIndex != null && pads[padIndex]) return pads[padIndex];
    for (const p of pads) if (p && p.connected) { padIndex = p.index; return p; }
    return null;
  }
  const btn = (p, i) => {
    const b = p.buttons && p.buttons[i];
    if (!b) return 0;
    return typeof b === 'number' ? b : (b.value != null ? b.value : (b.pressed ? 1 : 0));
  };
  const padPrev = new Uint8Array(20);

  /* ---------------------------------------------------------------- touch -- */
  let touchUI = null;
  const wantTouch = O.touch === true || (O.touch === 'auto' && isTouchDevice());
  const tState = { steer: 0, throttle: 0, brake: 0, drift: 0, item: 0, look: 0, active: false, pauseTap: false };

  function buildTouch() {
    if (!doc || touchUI) return;
    /*
     * NOT `O.element`. That is the renderer's canvas — it is where the pointer and wheel
     * listeners belong, but anything appended inside a <canvas> is *fallback content*: the
     * browser parses it, exposes it to querySelector, and never lays it out or renders it.
     * The whole touch control set was mounted there, so every phone got a stick, an ITEM, a
     * LOOK and a DRIFT button that measured 0x0 px and could not be tapped. The overlay is
     * position:fixed anyway, so it belongs on the document body.
     */
    const host = O.touchHost || (O.element && O.element.tagName !== 'CANVAS' ? O.element : null)
      || O.element?.parentElement || doc.body;
    const root = doc.createElement('div');
    root.className = 'kr-touch';
    root.innerHTML = TOUCH_HTML;
    const style = doc.createElement('style');
    style.textContent = TOUCH_CSS;
    root.appendChild(style);
    host.appendChild(root);

    const stick = root.querySelector('.kr-stick');
    const nub = root.querySelector('.kr-nub');
    let stickId = null, cx = 0, cy = 0, R = 1;
    const stickStart = e => {
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width * 0.42;
      stickId = e.pointerId; stick.setPointerCapture(e.pointerId); stickMove(e);
    };
    const stickMove = e => {
      if (e.pointerId !== stickId) return;
      const dx = clamp((e.clientX - cx) / R, -1, 1), dy = clamp((e.clientY - cy) / R, -1, 1);
      tState.steer = applyDeadzone(dx, 0.10, 0.35);
      const v = applyDeadzone(-dy, 0.22, 0.2);
      tState.throttle = Math.max(0, v); tState.brake = Math.max(0, -v);
      tState.active = true;
      nub.style.transform = `translate(${dx * R * 0.55}px, ${dy * R * 0.55}px)`;
      e.preventDefault();
    };
    const stickEnd = e => {
      if (e.pointerId !== stickId) return;
      stickId = null; tState.steer = 0; tState.throttle = 0; tState.brake = 0;
      nub.style.transform = 'translate(0,0)';
    };
    stick.addEventListener('pointerdown', stickStart, { passive: false });
    stick.addEventListener('pointermove', stickMove, { passive: false });
    stick.addEventListener('pointerup', stickEnd);
    stick.addEventListener('pointercancel', stickEnd);

    // one-shot buttons: they fire an edge on release rather than reporting a held state
    for (const el of root.querySelectorAll('[data-tap]')) {
      const k = el.dataset.tap;
      el.addEventListener('pointerdown', e => { el.classList.add('on'); e.preventDefault(); }, { passive: false });
      const fire = () => { el.classList.remove('on'); tState[k + 'Tap'] = true; tState.active = true; };
      el.addEventListener('pointerup', fire);
      el.addEventListener('pointercancel', () => el.classList.remove('on'));
    }
    for (const el of root.querySelectorAll('[data-btn]')) {
      const k = el.dataset.btn;
      const set = v => { tState[k] = v; tState.active = true; el.classList.toggle('on', !!v); };
      el.addEventListener('pointerdown', e => { set(1); el.setPointerCapture(e.pointerId); e.preventDefault(); }, { passive: false });
      el.addEventListener('pointerup', () => set(0));
      el.addEventListener('pointercancel', () => set(0));
      el.addEventListener('pointerleave', () => set(0));
    }
    touchUI = { root, dispose() { root.remove(); } };
  }
  if (wantTouch) buildTouch();

  /* ----------------------------------------------------------------- poll -- */
  const out = { throttle: 0, brake: 0, steer: 0, drift: 0, item: 0, look: 0 };
  const extra = {
    reset: false, pause: false, source: 'keyboard', padName: null,
    steerRaw: 0, hopEdge: false, itemEdge: false, anyPress: false,
  };
  Object.assign(out, { reset: false, pause: false, source: 'keyboard' });
  let steerSmoothed = 0;
  let lastT = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  let prevDrift = 0, prevItem = 0, prevReset = 0, prevPause = 0;
  let source = 'keyboard';

  function poll(dtOverride) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const dt = clamp(dtOverride != null ? dtOverride : now - lastT, 0, 0.1);
    lastT = now;

    let steerT = 0, throttle = 0, brake = 0, drift = 0, item = 0, look = 0, reset = 0, pause = 0;
    let analogue = false;

    /* keyboard */
    const kLeft = held(BINDINGS.left), kRight = held(BINDINGS.right);
    let kSteer = (kRight ? 1 : 0) - (kLeft ? 1 : 0);
    if (held(BINDINGS.throttle)) throttle = 1;
    if (held(BINDINGS.brake)) brake = 1;
    if (held(BINDINGS.drift)) drift = 1;
    if (held(BINDINGS.item)) item = 1;
    if (held(BINDINGS.look)) look = 1;
    if (held(BINDINGS.reset)) reset = 1;
    if (tapped(BINDINGS.pause)) pause = 1;
    let keyboardActive = kSteer !== 0 || throttle || brake || drift || item;

    /* gamepad */
    const p = readPad();
    padConnected = !!p;
    if (p) {
      const ax = p.axes || [];
      const lx = ax.length > 0 ? ax[0] : 0;
      const ly = ax.length > 1 ? ax[1] : 0;
      const gs = applyDeadzone(lx, O.deadzone, O.expo);
      const rt = Math.max(btn(p, PAD.rt), (ax[5] != null && ax.length > 5 && Math.abs(ax[5]) < 1.01 ? Math.max(0, (ax[5] + 1) / 2) : 0));
      const lt = Math.max(btn(p, PAD.lt), 0);
      const gThr = Math.max(rt > O.triggerDeadzone ? rt : 0, btn(p, PAD.a));
      const gBrk = Math.max(lt > O.triggerDeadzone ? lt : 0, btn(p, PAD.b) > 0.5 ? 0 : 0);
      const dpadX = (btn(p, PAD.right) > 0.5 ? 1 : 0) - (btn(p, PAD.left) > 0.5 ? 1 : 0);
      const gDrift = Math.max(btn(p, PAD.rb), btn(p, PAD.b));
      const gItem = Math.max(btn(p, PAD.lb), btn(p, PAD.x));
      const gLook = btn(p, PAD.y);
      const gReset = btn(p, PAD.back);
      if (Math.abs(gs) > 0 || dpadX) { steerT = dpadX || gs; analogue = Math.abs(gs) > 0; }
      if (gThr > 0) throttle = Math.max(throttle, gThr);
      if (gBrk > 0) brake = Math.max(brake, gBrk);
      if (gDrift > 0.5) drift = 1;
      if (gItem > 0.5) item = 1;
      if (gLook > 0.5) look = 1;
      if (gReset > 0.5) reset = 1;
      if (btn(p, PAD.start) > 0.5 && !padPrev[PAD.start]) pause = 1;
      for (let i = 0; i < 16; i++) padPrev[i] = btn(p, i) > 0.5 ? 1 : 0;
      if (gThr || gBrk || Math.abs(gs) > 0 || gDrift || gItem) source = 'gamepad';
      extra.padName = p.id || 'gamepad';
    }

    /* touch */
    if (tState.active) {
      if (tState.steer) { steerT = tState.steer; analogue = true; }
      throttle = Math.max(throttle, tState.throttle);
      brake = Math.max(brake, tState.brake);
      drift = Math.max(drift, tState.drift);
      item = Math.max(item, tState.item);
      look = Math.max(look, tState.look);
      if (tState.throttle || tState.drift || tState.item) source = 'touch';
    }
    // consumed here so it fires for exactly one poll, the same edge the Escape key produces
    if (tState.pauseTap) { pause = 1; tState.pauseTap = false; source = 'touch'; }
    if (keyboardActive) source = 'keyboard';

    /* steering: analogue passes straight through, digital ramps and self-centres */
    if (analogue) {
      steerSmoothed = steerT;
    } else {
      const want = kSteer || steerT;
      const rate = want === 0 ? O.steerReturn : O.steerRate;
      const k = 1 - Math.exp(-rate * dt);
      steerSmoothed += (want - steerSmoothed) * k;
      if (want === 0 && Math.abs(steerSmoothed) < 0.004) steerSmoothed = 0;
    }

    out.throttle = clamp(throttle, 0, 1);
    out.brake = clamp(brake, 0, 1);
    // Steering sign. The vehicle model and the AI both use a convention where a POSITIVE steer
    // produces a positive yaw rate, and with `yaw = atan2(fwd.x, fwd.z)` over a +X-east/+Z-south
    // world that is a turn to the driver's LEFT. Measured, not assumed: tools/sim/_steersign.mjs
    // drives the real vehicle and reports +79.6 deg of yaw for steer +1.
    //
    // So the player's "right" is negative here. Only this mapping was wrong — flipping the
    // physics instead would inverse the AI, which computes its own steer in the same convention
    // and currently drives the circuit correctly.
    out.steer = clamp(-steerSmoothed, -1, 1);
    out.drift = drift > 0.5 ? 1 : 0;
    out.item = item > 0.5 ? 1 : 0;
    out.look = look > 0.5 ? 1 : 0;
    out.reset = reset > 0.5;
    out.pause = pause > 0.5;
    out.source = source;

    extra.source = source;
    extra.steerRaw = steerT;
    extra.hopEdge = out.drift === 1 && prevDrift === 0;
    extra.itemEdge = out.item === 1 && prevItem === 0;
    extra.resetEdge = out.reset && !prevReset;
    extra.anyPress = !!(out.throttle || out.brake || out.drift || out.item || kSteer);
    prevDrift = out.drift; prevItem = out.item; prevReset = out.reset ? 1 : 0; prevPause = pause;
    pressedEdge.clear();
    return out;
  }

  /* ---------------------------------------------------------------- menus -- */
  const menuState = { up: false, down: false, left: false, right: false, confirm: false, back: false, start: false };
  const navPrev = { x: 0, y: 0 };
  let navRepeat = 0;
  function menu(dt = 1 / 60) {
    for (const k in menuState) menuState[k] = false;
    if (tapped(['ArrowUp', 'KeyW'])) menuState.up = true;
    if (tapped(['ArrowDown', 'KeyS'])) menuState.down = true;
    if (tapped(['ArrowLeft', 'KeyA'])) menuState.left = true;
    if (tapped(['ArrowRight', 'KeyD'])) menuState.right = true;
    if (tapped([...BINDINGS.confirm, 'Space'])) menuState.confirm = true;
    if (tapped(BINDINGS.back)) menuState.back = true;
    if (tapped(BINDINGS.pause)) menuState.start = true;
    const p = readPad();
    if (p) {
      const ax = p.axes || [];
      const nx = Math.abs(ax[0] || 0) > 0.55 ? Math.sign(ax[0]) : ((btn(p, PAD.right) > 0.5) - (btn(p, PAD.left) > 0.5));
      const ny = Math.abs(ax[1] || 0) > 0.55 ? Math.sign(ax[1]) : ((btn(p, PAD.down) > 0.5) - (btn(p, PAD.up) > 0.5));
      navRepeat -= dt;
      const fire = (nx !== navPrev.x || ny !== navPrev.y) || (navRepeat <= 0 && (nx || ny));
      if (fire) {
        if (nx > 0) menuState.right = true; else if (nx < 0) menuState.left = true;
        if (ny > 0) menuState.down = true; else if (ny < 0) menuState.up = true;
        navRepeat = (nx !== navPrev.x || ny !== navPrev.y) ? 0.42 : 0.13;
      }
      navPrev.x = nx; navPrev.y = ny;
      if (btn(p, PAD.a) > 0.5 && !padPrev[PAD.a]) menuState.confirm = true;
      if (btn(p, PAD.b) > 0.5 && !padPrev[PAD.b]) menuState.back = true;
      if (btn(p, PAD.start) > 0.5 && !padPrev[PAD.start]) menuState.start = true;
      for (let i = 0; i < 16; i++) padPrev[i] = btn(p, i) > 0.5 ? 1 : 0;
    }
    pressedEdge.clear();
    return menuState;
  }

  return {
    poll, menu, state: out, extra,
    get gamepad() { return padConnected; },
    get source() { return source; },
    get touchVisible() { return !!touchUI; },
    setTouchVisible(v) {
      if (v && !touchUI) buildTouch();
      else if (touchUI) touchUI.root.style.display = v ? '' : 'none';
    },
    keyHeld: code => keys.has(code),
    /** Feed synthetic input (sim harness, replays, AI takeover). */
    inject(v) { Object.assign(tState, v, { active: true }); },
    clearInject() { tState.active = false; tState.steer = tState.throttle = tState.brake = tState.drift = tState.item = 0; },
    dispose() {
      if (target) {
        target.removeEventListener('keydown', down);
        target.removeEventListener('keyup', up);
        target.removeEventListener('blur', blur);
        target.removeEventListener?.('gamepadconnected', onPadConnect);
        target.removeEventListener?.('gamepaddisconnected', onPadDisconnect);
      }
      touchUI?.dispose();
      keys.clear();
    },
  };
}

/* ------------------------------------------------------------ touch chrome -- */

const TOUCH_HTML = `
<div class="kr-stick"><div class="kr-ring"></div><div class="kr-nub"></div></div>
<button class="kr-b kr-pause" data-tap="pause" aria-label="Pause"><span>❚❚</span></button>
<div class="kr-pads">
  <button class="kr-b kr-item" data-btn="item"><span>ITEM</span></button>
  <button class="kr-b kr-look" data-btn="look"><span>LOOK</span></button>
  <button class="kr-b kr-drift" data-btn="drift"><span>DRIFT</span></button>
</div>`;

const TOUCH_CSS = `
.kr-touch{position:fixed;inset:0;pointer-events:none;z-index:60;
  font:700 12px/1 'Trebuchet MS',DejaVu Sans,Verdana,system-ui,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.kr-touch .kr-stick{position:absolute;left:3.2vmin;bottom:3.2vmin;width:34vmin;height:34vmin;
  max-width:220px;max-height:220px;pointer-events:auto;touch-action:none;display:grid;place-items:center}
.kr-touch .kr-ring{position:absolute;inset:8%;border-radius:50%;
  background:radial-gradient(circle at 50% 38%,rgba(255,250,238,.30),rgba(35,35,28,.30));
  border:3px solid rgba(255,250,238,.55);box-shadow:0 6px 18px rgba(0,0,0,.35),inset 0 2px 10px rgba(0,0,0,.25)}
.kr-touch .kr-nub{position:relative;width:38%;height:38%;border-radius:50%;
  background:linear-gradient(180deg,#FFF8E7,#E2CFA6);border:3px solid rgba(35,35,28,.45);
  box-shadow:0 4px 12px rgba(0,0,0,.4);transition:transform .06s linear}
.kr-touch .kr-pads{position:absolute;right:3.2vmin;bottom:3.2vmin;display:grid;gap:2vmin;
  grid-template-columns:repeat(2,auto);align-items:end;justify-items:end;pointer-events:none}
.kr-touch .kr-b{pointer-events:auto;touch-action:none;border:0;color:#2A2A20;
  font:800 max(11px,1.7vmin)/1 inherit;letter-spacing:.06em;border-radius:999px;
  width:17vmin;height:17vmin;max-width:112px;max-height:112px;
  box-shadow:0 5px 0 rgba(0,0,0,.28),0 10px 22px rgba(0,0,0,.3);
  transition:transform .09s cubic-bezier(.34,1.56,.64,1),box-shadow .09s ease}
.kr-touch .kr-b.on{transform:translateY(4px);box-shadow:0 1px 0 rgba(0,0,0,.28),0 4px 10px rgba(0,0,0,.3)}
.kr-touch .kr-drift{grid-column:2;background:linear-gradient(180deg,#FFD46B,#E9A32F);width:22vmin;height:22vmin;max-width:150px;max-height:150px}
.kr-touch .kr-item{grid-column:1;background:linear-gradient(180deg,#8FD3F4,#3FA9E0)}
.kr-touch .kr-look{grid-column:1;background:linear-gradient(180deg,#EBDCC0,#C6AE86);width:13vmin;height:13vmin}
/* A phone has no Escape key, no P and no gamepad Start, so without this button the pause
   menu — and with it Restart Race and Quit — is simply unreachable on a touch device. */
.kr-touch .kr-pause{position:absolute;top:2.4vmin;right:2.4vmin;width:11vmin;height:11vmin;
  max-width:56px;max-height:56px;border-radius:50%;font-size:3.4vmin;line-height:1;
  background:linear-gradient(180deg,#F2E7D0,#CBB894);opacity:.82}
`;

export default createInput;
