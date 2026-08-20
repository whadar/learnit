/**
 * Kat Racing — audio system.
 *
 *   import { createAudio } from './audio/audio.js';
 *   const audio = createAudio({ character: 'mitzi' });
 *   audio.init(camera);                       // safe to call before any user gesture
 *   audio.update(dt, { vehicle, rivals, race, listener: camera });
 *   audio.play('boost', { tier: 3 });
 *
 * Everything is synthesised (see dsp.js / engineSynth.js / surface.js / sfx.js / music.js);
 * there are no audio files anywhere in this repo.
 *
 * Contract notes:
 *  - No sound is produced until a user gesture: the AudioContext is created suspended and a
 *    one-shot pointer/key listener resumes it. Nothing is scheduled while it is suspended, so
 *    a blocked or device-less context (the screenshot harness) costs nothing and throws nothing.
 *  - Every method is a no-op when audio is unavailable; `audio.blocked` says so.
 *  - `update()` reads the vehicle/race state shapes the rest of the game already produces
 *    (src/physics/vehicle.js `state`, src/game/race.js `state`) and raises its own cues from
 *    state edges, so wiring it up is one call per frame.
 */
import { clamp, lerp, dbToGain, gainNode, filter, roomImpulse, crowdBuffer, follow, clearCache } from './dsp.js';
import { createEngineVoice, engineCharacter, firingHz } from './engineSynth.js';
import { createSurfaceVoice } from './surface.js';
import { createMusic } from './music.js';
import { playCue, cueId, CUE_IDS } from './sfx.js';

const BUSES = ['engine', 'surface', 'sfx', 'music', 'ambience'];
/** Minimum seconds between retriggers, per cue. Stops any state edge machine-gunning. */
const COOLDOWN = {
  bump: 0.11, wall_hit: 0.22, wall_scrape: 0.16, land: 0.12, hop: 0.10,
  item_roulette: 0.04, hit_spin: 0.35, hit_slip: 0.35, drift_charge_1: 0.25,
  drift_charge_2: 0.25, drift_charge_3: 0.25, boost: 0.20, lap_chime: 1.0,
  crowd_cheer: 3.0, horn: 0.25, wrong_way: 1.2,
};
const DEFAULTS = {
  master: 0.7, engine: 0.46, surface: 0.46, sfx: 0.95, music: 0.36, ambience: 0.34,
  seed: 7, character: 'mitzi', maxRivals: 4, reverb: true, offline: false, context: null,
  autoMusic: true, crowd: true, rolloff: 34,
};

/** Deterministic per-character seed so 'mitzi' always sounds like mitzi. */
function charSeed(id) {
  let h = 2166136261;
  for (const ch of String(id || 'kart')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

export function createAudio(opts = {}) {
  const O = { ...DEFAULTS, ...opts };
  let ctx = null, blocked = false, inited = false, disposed = false;
  let master = null, comp = null, limiter = null, verb = null, verbSend = null;
  const bus = {}, duck = {};
  let engineVoice = null, surfaceVoice = null, music = null, crowd = null, crowdGain = null;
  const rivalVoices = new Map();
  const lastPlayed = new Map();
  let simTime = 0;                       // offline clock
  let musicOverride = null, duckUntil = 0, duckAmount = 1;
  let gestureBound = false, resumeTries = 0, lastListenerT = 0;
  const listenerPos = { x: 0, y: 0, z: 0 };
  const listenerVel = { x: 0, y: 0, z: 0 };

  /* ---- edge-detection memory for state-driven cues ---- */
  const prev = {
    tier: 0, boostT: 0, grounded: true, drifting: false, hop: false, lap: -1,
    phase: '', countdown: 99, itemCount: 0, item: null, finished: false, wall: 0, bump: 0,
    started: false, place: 0,
  };
  const S = {
    ready: false, running: false, rpm: 0, speed: 0, surface: 'tarmac', intensity: 0,
    cues: 0, voices: 0, lastCue: null,
  };

  const now = () => (O.offline ? simTime : (ctx ? ctx.currentTime : 0));

  /* ------------------------------------------------------------------ graph ---- */
  function buildGraph() {
    master = gainNode(ctx, O.master);
    /**
     * Master chain. Chrome's DynamicsCompressor ducks short transients hard (measured: a
     * 0.24-peak 200 ms thump comes out 12 dB down even below threshold), so the compressor
     * glues the *bed* only — engine, tyres, music, crowd — and one-shot cues run dry into the
     * master. The ceiling is a soft-clip curve: transparent below -3 dBFS, mathematically
     * incapable of passing 0 dBFS, and free of the compressor's transient artefacts.
     */
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3;
    comp.attack.value = 0.008; comp.release.value = 0.25;
    comp.connect(master);

    limiter = ctx.createWaveShaper();
    const N = 4096, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x);
      const y = a <= 0.7 ? a : 0.7 + (1 - Math.exp(-(a - 0.7) * 3.2)) * 0.28;
      curve[i] = Math.sign(x) * y;
    }
    limiter.curve = curve; limiter.oversample = '2x';
    // nothing useful lives below 32 Hz; letting it through only eats headroom
    const rumbleCut = filter(ctx, 'highpass', 32, 0.6, 0, limiter);
    master.connect(rumbleCut); limiter.connect(ctx.destination);

    for (const b of BUSES) {
      duck[b] = gainNode(ctx, 1, b === 'sfx' ? master : comp);
      bus[b] = gainNode(ctx, O[b], duck[b]);
    }
    if (O.reverb && ctx.createConvolver) {
      verb = ctx.createConvolver();
      verb.buffer = roomImpulse(ctx, { seconds: 1.4, decay: 3.4, seed: 99 });
      const vg = gainNode(ctx, 0.5, master);
      verb.connect(vg);
      // sends run through a high-pass so the reverb never muddies the low end
      const pre = filter(ctx, 'highpass', 260, 0.7, 0, verb);
      verbSend = gainNode(ctx, 1, pre);
    }
  }

  function buildVoices() {
    const seed = charSeed(O.character) + O.seed;
    engineVoice = createEngineVoice(ctx, bus.engine, { seed, gain: 1 });   // silent until a vehicle reports in
    surfaceVoice = createSurfaceVoice(ctx, bus.surface, { seed: seed + 3 });
    music = createMusic(ctx, bus.music, { seed: 1234 + (seed % 97), send: verbSend, sendAmount: 0.18 });
    if (O.crowd) {
      crowdGain = gainNode(ctx, 0.0001, bus.ambience);
      const lp = filter(ctx, 'lowpass', 2600, 0.7, 0, crowdGain);
      const src = ctx.createBufferSource();
      src.buffer = crowdBuffer(ctx, { seed: 51, seconds: 4 });
      src.loop = true; src.connect(lp);
      try { src.start(0); } catch (e) { /* */ }
      crowd = src;
    }
  }

  /* ----------------------------------------------------------------- listener ---- */
  function setListener(l) {
    if (!ctx || !l) return;
    let px = 0, py = 0, pz = 0, fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0;
    if (Array.isArray(l)) { [px, py, pz] = l; }
    else if (l.isObject3D || l.matrixWorld) {
      const m = l.matrixWorld.elements;
      px = m[12]; py = m[13]; pz = m[14];
      fx = -m[8]; fy = -m[9]; fz = -m[10];
      ux = m[4]; uy = m[5]; uz = m[6];
    } else if (l.pos) {
      [px, py, pz] = l.pos;
      if (l.forward) [fx, fy, fz] = l.forward;
      if (l.up) [ux, uy, uz] = l.up;
    } else if (typeof l.x === 'number') { px = l.x; py = l.y; pz = l.z; }
    const dtl = Math.max(1e-3, now() - lastListenerT);
    if (lastListenerT > 0) {
      listenerVel.x = (px - listenerPos.x) / dtl;
      listenerVel.y = (py - listenerPos.y) / dtl;
      listenerVel.z = (pz - listenerPos.z) / dtl;
    }
    lastListenerT = now();
    listenerPos.x = px; listenerPos.y = py; listenerPos.z = pz;
    const L = ctx.listener, t = now();
    if (L.positionX) {
      follow(L.positionX, px, t, 0.02); follow(L.positionY, py, t, 0.02); follow(L.positionZ, pz, t, 0.02);
      follow(L.forwardX, fx, t, 0.02); follow(L.forwardY, fy, t, 0.02); follow(L.forwardZ, fz, t, 0.02);
      follow(L.upX, ux, t, 0.02); follow(L.upY, uy, t, 0.02); follow(L.upZ, uz, t, 0.02);
    } else if (L.setPosition) {
      L.setPosition(px, py, pz); L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  function makePanner(pos) {
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';           // cheap and stable under software rendering
    p.distanceModel = 'inverse';
    p.refDistance = 6; p.maxDistance = 420; p.rolloffFactor = 1.1;
    if (p.positionX) { p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; }
    else if (p.setPosition) p.setPosition(pos[0], pos[1], pos[2]);
    return p;
  }
  function movePanner(p, pos, t) {
    if (p.positionX) {
      follow(p.positionX, pos[0], t, 0.03); follow(p.positionY, pos[1], t, 0.03); follow(p.positionZ, pos[2], t, 0.03);
    } else if (p.setPosition) p.setPosition(pos[0], pos[1], pos[2]);
  }

  /* --------------------------------------------------------------------- init ---- */
  function init(listener, o = {}) {
    if (inited || disposed) { if (listener) setListener(listener); return api; }
    try {
      ctx = O.context || new (globalThis.AudioContext || globalThis.webkitAudioContext)({ latencyHint: 'interactive' });
      if (!ctx) throw new Error('no AudioContext');
      buildGraph();
      buildVoices();
      inited = true;
      S.ready = true;
    } catch (e) {
      blocked = true; S.ready = false;
      return api;
    }
    if (!O.offline) armGesture();
    if (listener) setListener(listener);
    if (o.music !== false && (ctx.state === 'running' || O.offline)) music.start(now());
    return api;
  }

  function armGesture() {
    if (gestureBound || typeof window === 'undefined' || !window.addEventListener) return;
    gestureBound = true;
    const kick = () => {
      if (!ctx || disposed) return;
      try {
        ctx.resume().then(() => { if (music && !music.playing) music.start(now()); }).catch(() => {});
      } catch (e) { /* */ }
      if (ctx.state === 'running' || ++resumeTries > 6) {
        for (const ev of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) window.removeEventListener(ev, kick, true);
        gestureBound = false;
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) window.addEventListener(ev, kick, true);
  }

  /* --------------------------------------------------------------------- play ---- */
  /**
   * @param {string} id  cue id or alias (see sfx.js CUE_ALIAS)
   * @param {{pos?:number[], gain?:number, delay?:number, tier?:number, force?:number,
   *          dur?:number, bus?:string}} o
   */
  function play(id, o = {}) {
    if (!S.running || !ctx) return null;
    const key = cueId(id);
    if (!key) return null;
    const t = now() + Math.max(0, o.delay || 0);
    const cd = COOLDOWN[key] ?? 0.03;
    const last = lastPlayed.get(key);
    if (last !== undefined && t - last < cd) return null;
    lastPlayed.set(key, t);

    const busName = o.bus || 'sfx';
    const dest = bus[busName] || bus.sfx;
    let head = dest;
    if (o.pos && ctx.createPanner) {
      const pan = makePanner(o.pos);
      pan.connect(dest);
      head = pan;
    }
    // every cue gets its own voice gain, so its reverb send cannot leak the whole bus
    const node = gainNode(ctx, clamp(o.gain ?? 1, 0, 4), head);
    if (verbSend) node.connect(gainNode(ctx, o.wet ?? 0.16, verbSend));
    const res = playCue(ctx, node, key, t, o);
    if (res) { S.cues++; S.lastCue = key; }
    return res;
  }

  /** Duck the bed under a headline cue (finish fanfare, lightning). */
  function duckBuses(amount, seconds, buses = ['music', 'engine', 'surface', 'ambience']) {
    if (!S.running) return;
    const t = now();
    duckUntil = Math.max(duckUntil, t + seconds);
    duckAmount = amount;
    for (const b of buses) {
      const g = duck[b]; if (!g) continue;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(amount, t, 0.05);
      g.gain.setTargetAtTime(1, t + seconds * 0.75, 0.25);
    }
  }

  /* ------------------------------------------------------------------- update ---- */
  function readVehicle(state) {
    const v = state?.vehicle ?? state?.kart ?? state;
    if (!v) return null;
    return v.state && v.state.pos ? v.state : v;
  }

  function update(dt, state = {}) {
    if (blocked || disposed || !inited) return api;
    const running = O.offline ? true : (ctx.state === 'running');
    S.running = running;
    if (O.offline) simTime += Math.max(0, dt || 0);
    if (!running) {
      // context blocked / suspended: keep the last state, schedule nothing, cost nothing
      if (ctx.state === 'suspended' && !gestureBound && !O.offline) armGesture();
      return api;
    }
    const t = now();
    const step = clamp(dt || 0.016, 0.0005, 0.25);

    if (state.listener || state.camera) setListener(state.listener || state.camera);

    /* ---------- the player's kart ---------- */
    const v = readVehicle(state);
    if (!v) engineVoice.setGain(0, t, 0.25);
    if (v) {
      engineVoice.setGain(0.62, t, 0.25);
      const speed = v.speed ?? 0;
      const thr = clamp(v.throttle ?? 0, 0, 1);
      const wheelRpm = clamp(v.rpm ?? clamp(speed / 25, 0, 1), 0, 1.15);
      // clutch feel: blipping the throttle at a standstill still revs the motor
      const rpm = clamp(Math.max(wheelRpm, thr * 0.42 * (1 - clamp(speed / 12, 0, 1)) + wheelRpm * 0.7), 0, 1.12);
      const boostT = v.boost?.time ?? 0;
      const spool = clamp(boostT > 0 ? 1 : 0, 0, 1);
      S.rpm = rpm; S.speed = speed; S.surface = v.surface || 'tarmac';
      engineVoice.update(step, {
        rpm, throttle: thr, load: clamp(v.engineLoad ?? thr, 0, 1),
        boost: lerp(engineVoice.state.boost, spool, 1 - Math.exp(-step * (spool > engineVoice.state.boost ? 6 : 2.2))),
        gain: 1, cut: v.drift?.hop ? 1 : 0,
      }, t);

      const slipRaw = v.skid ?? 0;
      const drifting = !!v.drift?.active;
      const slip = clamp(Math.max(slipRaw, drifting ? 0.55 + clamp(Math.abs(v.driftSlipDeg ?? 20) / 40, 0, 0.55) : 0), 0, 1.3);
      surfaceVoice.update(step, {
        speed, surface: v.surface, grounded: v.grounded !== false, slip,
        kerb: (v.surface === 'kerb' || v.surface === 'rumble') ? 1 : clamp((v.rumble ?? 0) * 1.2, 0, 1),
        gain: 1,
      }, t);

      /* ---------- state-edge cues ---------- */
      const tier = v.drift?.tier ?? 0;
      if (tier > prev.tier && tier >= 1 && tier <= 3) play('drift_charge_' + tier);
      prev.tier = tier;

      if (boostT > prev.boostT + 0.01 && boostT > 0.05) {
        const src = String(v.boost?.source || '');
        const tr = src.startsWith('miniturbo') ? clamp(+src.slice(-1) || 1, 1, 3) : 2;
        play('boost', { tier: tr });
      }
      prev.boostT = boostT;

      const hop = !!v.drift?.hop;
      if (hop && !prev.hop) play('hop');
      prev.hop = hop;

      const grounded = v.grounded !== false;
      if (grounded && !prev.grounded) {
        const f = clamp((v.landImpact ?? 0.4) * 1.3 + clamp(speed / 40, 0, 0.4), 0.12, 1.3);
        play('land', { force: f });
      }
      prev.grounded = grounded;

      const wall = v.wallImpact ?? 0;
      if (wall > prev.wall + 0.25 && wall > 0.5) {
        if (wall > 4) play('wall_hit', { force: clamp(wall / 8, 0.3, 1.4) });
        else play('wall_scrape', { force: clamp(wall / 4, 0.15, 1), dur: 0.3 });
      }
      prev.wall = wall;

      const bumpI = v.bumpImpact ?? 0;
      if (bumpI > prev.bump + 0.2 && bumpI > 0.35) play('bump', { force: clamp(bumpI / 3, 0.2, 1.3) });
      prev.bump = bumpI;
    }

    /* ---------- rivals ---------- */
    updateRivals(state.rivals, t, step);

    /* ---------- race state ---------- */
    const race = state.race || state.raceState || null;
    if (race) updateRace(race, t);

    /* ---------- music ---------- */
    if (music) {
      let target = musicOverride;
      if (target === null || target === undefined) target = O.autoMusic ? autoIntensity(race, v) : music.state.target;
      music.setIntensity(target);
      S.intensity = music.intensity;
      music.update(step, t);
    }

    /* ---------- ambience ---------- */
    if (crowdGain) {
      let amt = 0.10;
      if (race) {
        const ph = race.phase || race.state?.phase;
        amt = ph === 'countdown' ? 0.55 : ph === 'racing' ? 0.16 : ph === 'finished' || ph === 'results' ? 0.6 : 0.12;
      }
      if (state.crowdProximity !== undefined) amt *= clamp(state.crowdProximity, 0, 1.4);
      follow(crowdGain.gain, amt, t, 0.6);
    }

    if (duckUntil && t > duckUntil + 0.6) {
      duckUntil = 0;
      for (const b of BUSES) follow(duck[b].gain, 1, t, 0.2);
    }
    S.voices = rivalVoices.size;
    return api;
  }

  function autoIntensity(race, v) {
    if (!race) return 0.42;
    const phase = race.phase || race.state?.phase || 'racing';
    if (phase === 'idle' || phase === 'intro') return 0.16;
    if (phase === 'countdown') return 0.34;
    if (phase === 'results') return 0.30;
    if (phase === 'finished') return 0.55;
    const laps = race.laps ?? 3;
    const lap = race.lap ?? (laps - (race.lapsLeft ?? laps) + 1);
    const u = clamp(race.lapProgress ?? race.u ?? 0, 0, 1);
    if (lap >= laps) return u > 0.68 ? 1.0 : 0.86;         // final lap, then the last bend
    if (lap >= laps - 1 && u > 0.85) return 0.72;
    return 0.56;
  }

  function updateRivals(list, t, dt) {
    if (!Array.isArray(list) || !list.length) {
      for (const [id, rv] of rivalVoices) { rv.voice.dispose(); rivalVoices.delete(id); }
      return;
    }
    // nearest N only: a twelve-kart field is far too many engines to keep alive
    const scored = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const p = r.pos || r.position || (r.state && r.state.pos) || null;
      if (!p) continue;
      const px = p.x ?? p[0], py = p.y ?? p[1], pz = p.z ?? p[2];
      const dx = px - listenerPos.x, dy = py - listenerPos.y, dz = pz - listenerPos.z;
      // closing speed along the line of sight -> Doppler; PannerNode dropped its own in 2017
      const vv = r.vel || r.velocity || (r.state && r.state.vel) || null;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      let closing = 0;
      if (vv) {
        const vx = (vv.x ?? vv[0] ?? 0) - listenerVel.x;
        const vy = (vv.y ?? vv[1] ?? 0) - listenerVel.y;
        const vz = (vv.z ?? vv[2] ?? 0) - listenerVel.z;
        closing = -(vx * dx + vy * dy + vz * dz) / d;
      }
      scored.push({ r, id: r.id ?? i, d2: dx * dx + dy * dy + dz * dz, pos: [px, py, pz], closing });
    }
    scored.sort((a, b) => a.d2 - b.d2);
    const keep = scored.slice(0, O.maxRivals);
    const alive = new Set();
    for (const s of keep) {
      alive.add(s.id);
      let rv = rivalVoices.get(s.id);
      if (!rv) {
        const pan = makePanner(s.pos);
        pan.connect(bus.engine);
        const voice = createEngineVoice(ctx, pan, { seed: charSeed(String(s.id)) + 11, rival: true });
        voice.setGain(0.0001, t, 0.01);
        rv = { voice, pan };
        rivalVoices.set(s.id, rv);
      }
      movePanner(rv.pan, s.pos, t);
      const st = s.r.state || s.r;
      const dist = Math.sqrt(s.d2);
      const g = clamp(1 - dist / O.rolloff, 0, 1);
      rv.voice.setGain(g * 0.55, t, 0.12);
      // 343 m/s: a rival closing at 25 m/s lifts its pitch about 7%
      const dopp = clamp(343 / (343 - clamp(s.closing, -60, 60)), 0.85, 1.18);
      rv.voice.update(dt, {
        doppler: dopp,
        rpm: clamp(st.rpm ?? clamp((st.speed ?? 0) / 25, 0, 1), 0, 1.1),
        throttle: clamp(st.throttle ?? 0.8, 0, 1),
        load: clamp(st.engineLoad ?? 0.7, 0, 1),
        gain: 1,
      }, t);
    }
    for (const [id, rv] of rivalVoices) {
      if (alive.has(id)) continue;
      rv.voice.dispose();
      try { rv.pan.disconnect(); } catch (e) { /* */ }
      rivalVoices.delete(id);
    }
  }

  function updateRace(race, t) {
    const phase = race.phase || race.state?.phase || '';
    const cd = race.countdown ?? 99;
    if (phase === 'countdown') {
      const n = Math.ceil(clamp(cd, 0, 3));
      if (n !== prev.countdown && n >= 1 && n <= 3) play('countdown_' + n);
      prev.countdown = n;
    }
    if (phase !== prev.phase) {
      if (phase === 'racing' && (prev.phase === 'countdown' || prev.phase === '')) {
        play('countdown_go');
        play('crowd_cheer', { gain: 0.7, bus: 'ambience' });
      }
      if (phase === 'finished' || phase === 'results') {
        if (!prev.finished) {
          prev.finished = true;
          duckBuses(0.30, 3.6);
          play('finish_fanfare', { gain: 1.0, delay: 0.12 });
          play('crowd_cheer', { gain: 1.0, bus: 'ambience', dur: 4.5 });
        }
      }
      prev.phase = phase;
    }
    const laps = race.laps ?? 3;
    const lap = race.lap ?? null;
    if (lap !== null && lap !== prev.lap) {
      if (prev.lap >= 0 && lap > prev.lap) {
        if (lap >= laps) play('final_lap');
        else play('lap_chime');
      }
      prev.lap = lap;
    }
    if (race.wrongWay && !prev.wrongWay) play('wrong_way');
    prev.wrongWay = !!race.wrongWay;
  }

  /* ---------------------------------------------------------------- volume/api ---- */
  function setMasterVolume(v) {
    O.master = clamp(v, 0, 1.5);
    if (master) follow(master.gain, O.master, now(), 0.05);
    return api;
  }
  function setVolume(name, v) {
    if (!BUSES.includes(name)) return api;
    O[name] = clamp(v, 0, 2);
    if (bus[name]) follow(bus[name].gain, O[name], now(), 0.05);
    return api;
  }
  function setMusicIntensity(t) {
    musicOverride = (t === null || t === undefined) ? null : clamp(t, 0, 1);
    if (music && musicOverride !== null) music.setIntensity(musicOverride);
    return api;
  }
  function setCharacter(id) {
    O.character = id;
    if (!inited || !engineVoice) return api;
    const t = now();
    engineVoice.dispose();
    engineVoice = createEngineVoice(ctx, bus.engine, { seed: charSeed(id) + O.seed });
    engineVoice.setGain(0.62, t, 0.02);
    return api;
  }
  function suspend() {
    if (!ctx || blocked) return api;
    try { ctx.suspend(); } catch (e) { /* */ }
    return api;
  }
  function resume() {
    if (!ctx || blocked) return api;
    try {
      const p = ctx.resume();
      if (p && p.then) p.then(() => { if (music && !music.playing) music.start(now()); }).catch(() => {});
      else if (music && !music.playing) music.start(now());
    } catch (e) { /* */ }
    return api;
  }
  function startMusic() { if (music) music.start(now()); return api; }
  function stopMusic(fade = 0.8) { if (music) music.stop(now(), fade); return api; }
  function dispose() {
    disposed = true;
    try { engineVoice?.dispose(); } catch (e) { /* */ }
    try { surfaceVoice?.dispose(); } catch (e) { /* */ }
    try { music?.dispose(); } catch (e) { /* */ }
    for (const [, rv] of rivalVoices) { try { rv.voice.dispose(); } catch (e) { /* */ } }
    rivalVoices.clear();
    try { crowd?.stop(); } catch (e) { /* */ }
    if (ctx) { clearCache(ctx); if (!O.context && ctx.close) { try { ctx.close(); } catch (e) { /* */ } } }
    inited = false; S.ready = false; S.running = false;
    return api;
  }

  const api = {
    init, update, play, setMusicIntensity, setMasterVolume, setVolume, suspend, resume, dispose,
    setListener, setCharacter, startMusic, stopMusic, duck: duckBuses,
    state: S, cues: CUE_IDS,
    /** Test hook: the bus nodes, so tools/sim can tap the chain. */
    get buses() { return { ...bus, master, comp, limiter, verbSend }; },
    get blocked() { return blocked; },
    get ready() { return S.ready; },
    get running() { return S.running; },
    get context() { return ctx; },
    get music() { return music; },
    get engineVoice() { return engineVoice; },
    get surfaceVoice() { return surfaceVoice; },
    get time() { return now(); },
    /** Offline rendering hook: advance the virtual clock without touching the graph. */
    setTime(t) { simTime = t; return api; },
  };
  return api;
}

export { firingHz, engineCharacter, CUE_IDS };
export default createAudio;
