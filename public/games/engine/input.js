/* Little Games Engine — input: keyboard, pointer, gamepad, on-screen touch pads.
 * Games talk in terms of named actions, never raw key codes. */
(function (global) {
  'use strict';
  var E = global.E;

  var I = {
    keys: {}, keyDown: {}, keyUp: {},
    map: {},                 /* action -> {keys:[], pad:[], axis:[i, sign]} */
    actions: {},             /* action -> {held, down, up} */
    pointers: {},            /* id -> {x,y,sx,sy,down,id} in design space */
    mouse: { x: 0, y: 0, down: false, pressed: false, released: false, wheel: 0 },
    touchMode: false, padMode: false,
    stick: { x: 0, y: 0, active: false, id: null, ox: 0, oy: 0 },
    pads: [],                /* on-screen buttons: {id,x,y,r,label,action} */
    anyDown: false,
    _padHeld: {}
  };
  E.input = I;

  function code(e) { return e.code || e.key; }

  global.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var c = code(e);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].indexOf(c) >= 0) e.preventDefault();
    I.keys[c] = true; I.keyDown[c] = true; I.anyDown = true;
    I.touchMode = false;
    if (E.audio) E.audio.resume();
  });
  global.addEventListener('keyup', function (e) { var c = code(e); I.keys[c] = false; I.keyUp[c] = true; });

  function updatePointer(e, down) {
    var g = E.game; if (!g) return;
    var p = I.pointers[e.pointerId] || (I.pointers[e.pointerId] = { sx: 0, sy: 0 });
    g.toWorld(e.clientX, e.clientY, p);
    if (down) { p.sx = p.x; p.sy = p.y; }
    p.id = e.pointerId;
    p.touch = e.pointerType !== 'mouse';
    return p;
  }

  var el = function () { return E.game ? E.game.canvas : document.body; };

  global.addEventListener('pointerdown', function (e) {
    var p = updatePointer(e, true); if (!p) return;
    p.down = true; I.anyDown = true;
    if (p.touch) I.touchMode = true;
    if (!p.touch) { I.mouse.down = true; I.mouse.pressed = true; }
    if (E.audio) E.audio.resume();
    /* on-screen button? */
    var hit = pickPad(p.x, p.y);
    if (hit) { p.pad = hit.id; I._padHeld[hit.id] = true; }
    else if (p.touch && p.x < E.game.W * .45 && !I.stick.active) {
      I.stick.active = true; I.stick.id = e.pointerId; I.stick.ox = p.x; I.stick.oy = p.y;
      I.stick.x = 0; I.stick.y = 0;
    }
  }, { passive: true });

  global.addEventListener('pointermove', function (e) {
    var p = I.pointers[e.pointerId];
    if (!p) { if (e.pointerType === 'mouse') { p = updatePointer(e, false); } else return; }
    else updatePointer(e, false);
    if (!p) return;
    if (!p.touch) { I.mouse.x = p.x; I.mouse.y = p.y; }
    if (I.stick.active && I.stick.id === e.pointerId) {
      var dx = p.x - I.stick.ox, dy = p.y - I.stick.oy, len = Math.hypot(dx, dy), max = 56;
      if (len > max) { dx *= max / len; dy *= max / len; len = max; }
      I.stick.x = dx / max; I.stick.y = dy / max;
    }
  }, { passive: true });

  function endPointer(e) {
    var p = I.pointers[e.pointerId];
    if (p) {
      if (p.pad) I._padHeld[p.pad] = false;
      if (!p.touch) { I.mouse.down = false; I.mouse.released = true; }
      delete I.pointers[e.pointerId];
    }
    if (I.stick.id === e.pointerId) { I.stick.active = false; I.stick.id = null; I.stick.x = 0; I.stick.y = 0; }
  }
  global.addEventListener('pointerup', endPointer, { passive: true });
  global.addEventListener('pointercancel', endPointer, { passive: true });
  global.addEventListener('wheel', function (e) { I.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
  global.addEventListener('contextmenu', function (e) { if (e.target === el()) e.preventDefault(); });

  function pickPad(x, y) {
    for (var i = 0; i < I.pads.length; i++) {
      var b = I.pads[i];
      if (E.dist2(x, y, b.x, b.y) < (b.r * 1.25) * (b.r * 1.25)) return b;
    }
    return null;
  }

  /* bind({jump:{keys:['Space','KeyW'], pad:[0]}, left:{keys:['KeyA'], axis:[0,-1]}}) */
  I.bind = function (m) {
    I.map = m; I.actions = {};
    for (var a in m) I.actions[a] = { held: false, down: false, up: false, value: 0 };
    return I;
  };
  I.setPads = function (pads) { I.pads = pads || []; I._padHeld = {}; };

  I.beginFrame = function () {
    /* gamepad */
    var gp = null;
    if (navigator.getGamepads) {
      var list = navigator.getGamepads();
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].connected) { gp = list[i]; break; }
    }
    I.gp = gp;
    if (gp) {
      for (var b = 0; b < gp.buttons.length; b++) if (gp.buttons[b].pressed) { I.padMode = true; I.touchMode = false; }
      for (var ax = 0; ax < gp.axes.length; ax++) if (Math.abs(gp.axes[ax]) > .5) { I.padMode = true; I.touchMode = false; }
    }

    for (var a in I.map) {
      var def = I.map[a], st = I.actions[a], now = false, val = 0;
      var keys = def.keys || [];
      for (var k = 0; k < keys.length; k++) if (I.keys[keys[k]]) { now = true; val = 1; }
      if (def.pad && gp) for (var p = 0; p < def.pad.length; p++) {
        var btn = gp.buttons[def.pad[p]];
        if (btn && btn.pressed) { now = true; val = Math.max(val, btn.value || 1); }
      }
      if (def.axis && gp) {
        var v = gp.axes[def.axis[0]] || 0;
        if (v * def.axis[1] > .35) { now = true; val = Math.max(val, Math.abs(v)); }
      }
      if (def.stickX && I.stick.active) {
        var sv = I.stick.x * def.stickX;
        if (sv > .35) { now = true; val = Math.max(val, sv); }
      }
      if (def.stickY && I.stick.active) {
        var sy = I.stick.y * def.stickY;
        if (sy > .35) { now = true; val = Math.max(val, sy); }
      }
      if (def.button && I._padHeld[def.button]) { now = true; val = 1; }
      st.down = now && !st.held;
      st.up = !now && st.held;
      st.held = now; st.value = val;
    }
  };

  I.endFrame = function () {
    I.keyDown = {}; I.keyUp = {};
    I.mouse.pressed = false; I.mouse.released = false; I.mouse.wheel = 0;
    I.anyDown = false;
  };

  I.held = function (a) { var s = I.actions[a]; return !!(s && s.held); };
  I.down = function (a) { var s = I.actions[a]; return !!(s && s.down); };
  I.up = function (a) { var s = I.actions[a]; return !!(s && s.up); };
  I.value = function (a) { var s = I.actions[a]; return s ? s.value : 0; };
  I.axis = function (neg, pos) { return (I.held(pos) ? I.value(pos) : 0) - (I.held(neg) ? I.value(neg) : 0); };
  I.key = function (c) { return !!I.keys[c]; };
  I.keyPressed = function (c) { return !!I.keyDown[c]; };
  I.any = function () { return I.anyDown; };

  /* Draws the virtual stick + buttons; only visible once a touch happens. */
  I.drawTouch = function (g) {
    if (!I.touchMode) return;
    g.save();
    if (I.stick.active) {
      g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 2;
      g.beginPath(); g.arc(I.stick.ox, I.stick.oy, 56, 0, E.TAU); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.beginPath(); g.arc(I.stick.ox + I.stick.x * 56, I.stick.oy + I.stick.y * 56, 24, 0, E.TAU); g.fill();
    }
    for (var i = 0; i < I.pads.length; i++) {
      var b = I.pads[i], on = I._padHeld[b.id];
      g.fillStyle = on ? 'rgba(255,255,255,.30)' : 'rgba(255,255,255,.12)';
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, E.TAU); g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.font = '600 15px ui-monospace, Menlo, Consolas, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(b.label, b.x, b.y + 1);
    }
    g.restore();
  };
})(window);
