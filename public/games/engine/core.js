/* Little Games Engine — core: math, RNG, storage, canvas, fixed-step loop, scenes.
 * No dependencies, no build step, no assets. */
(function (global) {
  'use strict';
  var E = global.E = global.E || {};

  /* ---------------------------------------------------------------- math */
  var TAU = Math.PI * 2;
  E.TAU = TAU;
  E.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  E.lerp = function (a, b, t) { return a + (b - a) * t; };
  /* frame-rate independent exponential smoothing */
  E.damp = function (a, b, lambda, dt) { return E.lerp(a, b, 1 - Math.exp(-lambda * dt)); };
  E.approach = function (a, b, d) { return a < b ? Math.min(a + d, b) : Math.max(a - d, b); };
  E.dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
  E.dist2 = function (ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  E.wrapAngle = function (a) { return ((a + Math.PI) % TAU + TAU) % TAU - Math.PI; };
  E.angleTo = function (a, b, t) { return a + E.wrapAngle(b - a) * t; };
  E.smoothstep = function (t) { t = E.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  E.easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  E.easeIn = function (t) { return t * t * t; };
  E.easeInOut = function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  E.easeOutBack = function (t) { var c = 2.2; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  E.easeOutElastic = function (t) {
    if (t <= 0 || t >= 1) return E.clamp(t, 0, 1);
    return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
  };

  E.rnd = function (a, b) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); };
  E.rndi = function (a, b) { return Math.floor(E.rnd(a, b + 1)); };
  E.rndSign = function () { return Math.random() < .5 ? -1 : 1; };
  E.pick = function (arr) { return arr[(Math.random() * arr.length) | 0]; };
  E.chance = function (p) { return Math.random() < p; };
  /* deterministic stream — used for level/terrain generation */
  E.seeded = function (seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };

  /* ------------------------------------------------------------- storage */
  E.store = {
    get: function (k, def) {
      try { var v = localStorage.getItem('lg.' + k); return v == null ? def : JSON.parse(v); }
      catch (e) { return def; }
    },
    set: function (k, v) { try { localStorage.setItem('lg.' + k, JSON.stringify(v)); } catch (e) { } }
  };

  /* Settings are shared by every game in the collection. */
  var defaults = { master: .8, music: .6, sfx: .9, shake: 1, crt: 1, reduce: false };
  E.settings = {};
  for (var k in defaults) E.settings[k] = defaults[k];
  var saved = E.store.get('settings', {});
  for (var k2 in saved) if (k2 in defaults) E.settings[k2] = saved[k2];
  E.saveSettings = function () {
    E.store.set('settings', E.settings);
    if (E.audio) E.audio.applySettings();
  };

  /* --------------------------------------------------------------- scene */
  function Scene() { }
  Scene.prototype.enter = function () { };
  Scene.prototype.exit = function () { };
  Scene.prototype.update = function (dt) { };
  Scene.prototype.draw = function (g) { };
  /* when true the scene below still draws (used for pause / dialog overlays) */
  Scene.prototype.transparent = false;
  E.Scene = Scene;

  /* ---------------------------------------------------------------- game */
  function Game(opts) {
    opts = opts || {};
    this.W = opts.width || 960;
    this.H = opts.height || 540;
    this.canvas = opts.canvas || document.getElementById('c');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.bg = opts.background || '#05060c';
    this.scenes = [];
    this.step = 1 / 120;      /* fixed simulation step */
    this.acc = 0;
    this.time = 0;
    this.frame = 0;
    this.dpr = 1;
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
    this.blurred = false;
    E.game = this;

    var self = this;
    this._onResize = function () { self.resize(); };
    global.addEventListener('resize', this._onResize);
    global.addEventListener('orientationchange', this._onResize);
    global.addEventListener('blur', function () { self.blurred = true; });
    global.addEventListener('focus', function () { self.blurred = false; self.last = 0; });
    this.resize();
  }

  Game.prototype.resize = function () {
    var cw = this.canvas.clientWidth || global.innerWidth;
    var ch = this.canvas.clientHeight || global.innerHeight;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    var bw = Math.round(cw * this.dpr), bh = Math.round(ch * this.dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw; this.canvas.height = bh;
    }
    this.scale = Math.min(cw / this.W, ch / this.H);
    this.ox = (cw - this.W * this.scale) / 2;
    this.oy = (ch - this.H * this.scale) / 2;
    if (E.fx) E.fx.resize(this);
  };

  /* screen (CSS px relative to canvas) -> design space */
  Game.prototype.toWorld = function (cx, cy, out) {
    var r = this.canvas.getBoundingClientRect();
    out = out || {};
    out.x = (cx - r.left - this.ox) / this.scale;
    out.y = (cy - r.top - this.oy) / this.scale;
    return out;
  };

  Game.prototype.push = function (s) {
    var top = this.scene();
    if (top && top.pause) top.pause();
    this.scenes.push(s); s.game = this; s.enter(this);
    return s;
  };
  Game.prototype.pop = function () {
    var s = this.scenes.pop();
    if (s) s.exit(this);
    var top = this.scene();
    if (top && top.resume) top.resume();
    return s;
  };
  Game.prototype.replace = function (s) {
    while (this.scenes.length) this.pop();
    return this.push(s);
  };
  Game.prototype.scene = function () { return this.scenes[this.scenes.length - 1]; };

  Game.prototype.start = function (scene) {
    if (scene) this.replace(scene);
    var self = this;
    this.last = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      if (!self.last) { self.last = now; return; }
      var dt = (now - self.last) / 1000;
      self.last = now;
      if (dt > .25) dt = .25;             /* tab was hidden: don't fast-forward */
      self._fpsAcc += dt; self._fpsN++;
      if (self._fpsAcc > .5) { self.fps = self._fpsN / self._fpsAcc; self._fpsAcc = 0; self._fpsN = 0; }
      self.tick(dt);
      self.render();
    }
    requestAnimationFrame(frame);
    return this;
  };

  Game.prototype.tick = function (dt) {
    E.input.beginFrame();
    var top = this.scene();
    if (top) {
      if (E.fx.hitstop > 0) {
        E.fx.hitstop -= dt;                /* freeze frames: everything holds still */
      } else {
        this.acc += dt;
        var steps = 0;
        while (this.acc >= this.step && steps < 8) {
          this.time += this.step;
          top = this.scene();
          if (top) top.update(this.step);
          this.acc -= this.step; steps++;
        }
        if (steps === 8) this.acc = 0;     /* give up rather than spiral */
      }
      E.fx.update(dt);
    }
    E.input.endFrame();
    this.frame++;
  };

  Game.prototype.render = function () {
    var g = this.ctx, d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width / d, this.canvas.height / d);

    /* everything below draws in design space, clipped to the 16:9 frame */
    var target = E.fx.begin(this);
    var i, first = 0;
    for (i = this.scenes.length - 1; i >= 0; i--) { first = i; if (!this.scenes[i].transparent) break; }
    for (i = first; i < this.scenes.length; i++) this.scenes[i].draw(target, this);
    E.fx.end(this);
  };

  E.Game = Game;

  /* Small helper so games can register a one-shot delayed callback. */
  E.after = function (list, t, fn) { list.push({ t: t, fn: fn }); };
  E.runTimers = function (list, dt) {
    for (var i = list.length - 1; i >= 0; i--) {
      list[i].t -= dt;
      if (list[i].t <= 0) { var f = list[i].fn; list.splice(i, 1); f(); }
    }
  };
})(window);
