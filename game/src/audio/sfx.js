/**
 * Kat Racing — the one-shot cue library.
 *
 * Every cue is a small synth patch built on demand and left to garbage-collect once its
 * envelope has run. `CUES[id].build(ctx, dest, t0, o)` returns the audio-clock time the cue
 * finishes, which is what tools/sim/audio.mjs measures against.
 *
 * The palette is deliberately Israeli-village-cartoon: citrus thwips, clay-pot clonks, hijaz
 * chimes — not sci-fi lasers.
 */
import {
  clamp, lerp, hz, gainNode, filter, shaper, noiseBuffer, pluckBuffer, drumBuffer, jingleBuffer,
  crowdBuffer, hit, adsr, dbToGain,
} from './dsp.js';

/* ------------------------------------------------------------------ tiny patch helpers --- */
function osc(ctx, type, f, dest) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
  if (dest) o.connect(dest); return o;
}
/** Pitched blip / sweep. */
function tone(ctx, dest, t0, o = {}) {
  const { type = 'sine', f0 = 440, f1 = f0, dur = 0.2, peak = 0.3, a = 0.004, curve = 'exp', detune = 0 } = o;
  const g = gainNode(ctx, 0.0001, dest);
  const s = osc(ctx, type, f0, g);
  if (detune) s.detune.value = detune;
  if (f1 !== f0) {
    s.frequency.setValueAtTime(f0, t0);
    if (curve === 'lin') s.frequency.linearRampToValueAtTime(f1, t0 + dur);
    else s.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
  }
  const end = hit(g.gain, t0, peak, dur, a);
  s.start(t0); s.stop(end + 0.05);
  return end;
}
/** Filtered noise burst / whoosh. */
function nz(ctx, dest, t0, o = {}) {
  const { dur = 0.3, f0 = 900, f1 = f0, q = 1, type = 'bandpass', peak = 0.3, a = 0.004, seed = 7, rate = 1, swell = 0 } = o;
  const g = gainNode(ctx, 0.0001, dest);
  const f = filter(ctx, type, f0, q, 0, g);
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, { seconds: 2.5, seed, kind: 'white' });
  s.loop = true; s.playbackRate.value = rate;
  s.connect(f);
  if (f1 !== f0) {
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
  }
  let end;
  if (swell) {
    // rises into the hit instead of starting at full tilt — whooshes, scrapes, sand
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak * 0.35, t0 + dur * 0.18);
    g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.00008, t0 + dur * 1.15);
    end = t0 + dur * 1.15;
  } else {
    end = hit(g.gain, t0, peak, dur, a);
  }
  s.start(t0); s.stop(end + 0.05);
  return end;
}
/** Two-operator FM bell — the workhorse for chimes and sparkles. */
function bell(ctx, dest, t0, o = {}) {
  const { f = 880, ratio = 2.76, index = 380, dur = 0.7, peak = 0.28, a = 0.003, decayMod = 14 } = o;
  const g = gainNode(ctx, 0.0001, dest);
  const car = osc(ctx, 'sine', f, g);
  const mg = gainNode(ctx, index, car.frequency);
  const mod = osc(ctx, 'sine', f * ratio, mg);
  hit(mg.gain, t0, index, dur / decayMod * 4, 0.001);
  const end = hit(g.gain, t0, peak, dur, a);
  car.start(t0); mod.start(t0); car.stop(end + 0.05); mod.stop(end + 0.05);
  return end;
}
/** Plucked oud note from the Karplus-Strong bank. */
function pluck(ctx, dest, t0, o = {}) {
  const { f = 293.66, peak = 0.5, seed = 3, t60 = 1.0, bright = 0.55, dur = 0 } = o;
  const g = gainNode(ctx, peak, dest);
  const s = ctx.createBufferSource();
  s.buffer = pluckBuffer(ctx, f, { seed, t60, bright, seconds: Math.min(2.2, t60 * 1.6 + 0.3) });
  s.connect(g); s.start(t0);
  const end = t0 + s.buffer.duration;
  if (dur > 0) { g.gain.setValueAtTime(peak, t0 + dur); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.12); }
  return dur > 0 ? t0 + dur + 0.12 : end;
}
/** Percussion from the drum bank. */
function drum(ctx, dest, t0, kind = 'dum', peak = 0.6, tune = 1, seed = 11) {
  const g = gainNode(ctx, peak, dest);
  const s = ctx.createBufferSource();
  s.buffer = drumBuffer(ctx, kind, { seed, tune });
  s.connect(g); s.start(t0);
  return t0 + s.buffer.duration;
}
/** Comb-filtered metal: kart panels, kerb strikes, shakshuka pans. */
function metal(ctx, dest, t0, o = {}) {
  const { dur = 0.4, combHz = 260, fb = 0.72, peak = 0.3, bright = 3000, seed = 13, excite = 0.02 } = o;
  const g = gainNode(ctx, 1, dest);
  const bp = filter(ctx, 'bandpass', bright, 0.9, 0, g);
  const d = ctx.createDelay(0.05); d.delayTime.value = 1 / combHz;
  const fbg = gainNode(ctx, fb, d);
  d.connect(fbg); d.connect(bp);
  const eg = gainNode(ctx, 0.0001, d);
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, { seconds: 2.5, seed, kind: 'white' });
  s.loop = true; s.connect(eg);
  hit(eg.gain, t0, peak, excite, 0.001);
  const end = t0 + dur;
  g.gain.setValueAtTime(1, t0); g.gain.exponentialRampToValueAtTime(0.0001, end);
  s.start(t0); s.stop(end + 0.05);
  return end;
}

/* -------------------------------------------------------------------------- the scale --- */
/** Hijaz on D — the maqam the whole soundtrack lives in, so cues sit in the music. */
export const HIJAZ = [0, 1, 4, 5, 7, 8, 10];
const D4 = -7;                              // semitones from A4 to D4
export const scaleHz = (deg, oct = 0) => hz(D4 + HIJAZ[((deg % 7) + 7) % 7] + 12 * (oct + Math.floor(deg / 7)));

/* ------------------------------------------------------------------------------- cues --- */
export const CUES = {
  /* ---------------- race control ---------------- */
  countdown_3: { bus: 'sfx', build: (c, d, t) => countBeep(c, d, t, 0) },
  countdown_2: { bus: 'sfx', build: (c, d, t) => countBeep(c, d, t, 1) },
  countdown_1: { bus: 'sfx', build: (c, d, t) => countBeep(c, d, t, 2) },
  countdown_go: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      // bright fifth + octave stack, plus a drum accent and a crowd bark
      for (const [f, p, dt] of [[880, 0.26, 0], [1318.5, 0.20, 0], [1760, 0.14, 0.005]]) {
        e = Math.max(e, tone(c, d, t + dt, { type: 'triangle', f0: f, dur: 0.55, peak: p, a: 0.004 }));
      }
      e = Math.max(e, tone(c, d, t, { type: 'sine', f0: 220, f1: 440, dur: 0.25, peak: 0.22, curve: 'lin' }));
      e = Math.max(e, drum(c, d, t, 'dum', 0.5, 1.1));
      e = Math.max(e, nz(c, d, t, { dur: 0.5, f0: 5200, f1: 1400, q: 0.7, peak: 0.10, seed: 88 }));
      return e;
    },
  },
  lap_chime: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      e = Math.max(e, bell(c, d, t, { f: scaleHz(4, 1), ratio: 3.01, index: 260, dur: 0.55, peak: 0.20 }));
      e = Math.max(e, bell(c, d, t + 0.12, { f: scaleHz(7, 1), ratio: 3.01, index: 220, dur: 0.75, peak: 0.17 }));
      return e;
    },
  },
  final_lap: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      const seq = [[0, 0], [3, 0.10], [4, 0.20], [7, 0.30]];
      for (const [deg, dt] of seq) {
        e = Math.max(e, bell(c, d, t + dt, { f: scaleHz(deg, 1), ratio: 2.01, index: 300, dur: 0.6, peak: 0.19 }));
        e = Math.max(e, pluck(c, d, t + dt, { f: scaleHz(deg, 0), peak: 0.34, seed: 5 + deg, t60: 0.8 }));
      }
      e = Math.max(e, drum(c, d, t, 'dum', 0.45, 1.0));
      e = Math.max(e, drum(c, d, t + 0.30, 'tek', 0.35, 1.0));
      return e;
    },
  },
  finish_fanfare: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      const bus = gainNode(c, 1, d);
      // brassy hijaz fanfare: saw stack + oud doubling + darbuka roll + shimmer
      const line = [[0, 0.00, 0.26], [4, 0.16, 0.26], [7, 0.32, 0.30], [8, 0.52, 0.30], [7, 0.72, 0.62], [11, 1.02, 1.10]];
      for (const [deg, dt, dur] of line) {
        const f = scaleHz(deg, 1);
        for (const [mul, det, gn] of [[1, -7, 0.13], [1, 7, 0.13], [0.5, 0, 0.09]]) {
          const g = gainNode(c, 0.0001, bus);
          const lp = filter(c, 'lowpass', 3200, 0.8, 0, g);
          const s = osc(c, 'sawtooth', f * mul, lp); s.detune.value = det;
          const end = adsr(g.gain, t + dt, { a: 0.02, d: 0.10, s: 0.7, r: 0.22, peak: gn, dur });
          s.start(t + dt); s.stop(end + 0.05);
          e = Math.max(e, end);
        }
        e = Math.max(e, pluck(c, bus, t + dt, { f, peak: 0.28, seed: 9 + deg, t60: 0.9 }));
      }
      // darbuka roll into the last hit
      for (let i = 0; i < 8; i++) {
        e = Math.max(e, drum(c, bus, t + 0.62 + i * 0.05, i % 2 ? 'ka' : 'tek', 0.10 + i * 0.028, 1.0, 11 + i));
      }
      e = Math.max(e, drum(c, bus, t + 1.02, 'dum', 0.62, 0.95));
      e = Math.max(e, drum(c, bus, t + 1.02, 'slap', 0.30, 1.0));
      // cymbal shimmer
      const jg = gainNode(c, 0.30, bus);
      const js = c.createBufferSource(); js.buffer = jingleBuffer(c, { seed: 77, dur: 1.4, bright: 0.8 });
      js.connect(jg); js.start(t + 1.0);
      e = Math.max(e, t + 1.0 + js.buffer.duration);
      return e;
    },
  },
  crowd_cheer: {
    bus: 'ambience',
    build(c, d, t, o = {}) {
      const dur = o.dur ?? 2.6;
      const g = gainNode(c, 0.0001, d);
      const bp = filter(c, 'bandpass', 900, 0.6, 0, g);
      const s = c.createBufferSource();
      s.buffer = crowdBuffer(c, { seed: 51, seconds: 4 });
      s.loop = true; s.playbackRate.value = 1.06; s.connect(bp);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.35);
      g.gain.setValueAtTime(0.5, t + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0002, t + dur);
      s.start(t); s.stop(t + dur + 0.05);
      return t + dur;
    },
  },
  respawn: {
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.5, f0: 380, f1: 3600, q: 1.6, peak: 0.16, a: 0.3, seed: 31 });
      e = Math.max(e, tone(c, d, t + 0.36, { type: 'sine', f0: 320, f1: 780, dur: 0.22, peak: 0.22 }));
      e = Math.max(e, bell(c, d, t + 0.42, { f: scaleHz(4, 1), ratio: 2.0, index: 200, dur: 0.5, peak: 0.16 }));
      return e;
    },
  },
  wrong_way: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      for (let i = 0; i < 2; i++) e = Math.max(e, tone(c, d, t + i * 0.18, { type: 'square', f0: 330, dur: 0.14, peak: 0.12 }));
      return e;
    },
  },

  /* ---------------- drift / boost ---------------- */
  drift_charge_1: { bus: 'sfx', build: (c, d, t) => chargeChime(c, d, t, 1) },
  drift_charge_2: { bus: 'sfx', build: (c, d, t) => chargeChime(c, d, t, 2) },
  drift_charge_3: { bus: 'sfx', build: (c, d, t) => chargeChime(c, d, t, 3) },
  boost: {
    bus: 'sfx',
    build(c, d, t, o = {}) {
      const tier = clamp(o.tier ?? 1, 1, 3);
      const p = 0.30 + tier * 0.09;
      let e = 0;
      // whoosh: band sweeping up then away, plus a low thump and a rising tail
      e = Math.max(e, nz(c, d, t, { dur: 0.5 + tier * 0.1, f0: 260, f1: 3400 + tier * 900, q: 1.5, peak: p, swell: 1, seed: 41 }));
      e = Math.max(e, nz(c, d, t + 0.05, { dur: 0.42, f0: 5200, f1: 900, q: 0.8, peak: p * 0.5, a: 0.02, seed: 42 }));
      e = Math.max(e, tone(c, d, t, { type: 'sine', f0: 90, f1: 46, dur: 0.30, peak: 0.34 }));
      e = Math.max(e, tone(c, d, t + 0.02, { type: 'triangle', f0: 320, f1: 1180 + tier * 220, dur: 0.34, peak: 0.10 }));
      if (tier >= 3) e = Math.max(e, bell(c, d, t, { f: 1568, ratio: 1.41, index: 700, dur: 0.5, peak: 0.10 }));
      return e;
    },
  },
  hop: {
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.10, f0: 1500, f1: 500, q: 1.2, peak: 0.20, seed: 51 });
      e = Math.max(e, tone(c, d, t, { type: 'sine', f0: 190, f1: 120, dur: 0.11, peak: 0.22 }));
      return e;
    },
  },
  trick: {
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.32, f0: 700, f1: 4200, q: 1.1, peak: 0.22, swell: 1, seed: 52 });
      e = Math.max(e, tone(c, d, t + 0.05, { type: 'triangle', f0: 520, f1: 1560, dur: 0.28, peak: 0.11 }));
      return e;
    },
  },

  /* ---------------- impacts ---------------- */
  bump: {
    bus: 'sfx',
    build(c, d, t, o = {}) {
      const k = clamp(o.force ?? 0.6, 0.15, 1.4);
      let e = tone(c, d, t, { type: 'sine', f0: 150 * lerp(0.8, 1.2, k), f1: 62, dur: 0.16 * lerp(0.7, 1.3, k), peak: 0.34 * k });
      e = Math.max(e, nz(c, d, t, { dur: 0.09, f0: 1600, f1: 420, q: 0.8, peak: 0.22 * k, seed: 61 }));
      e = Math.max(e, metal(c, d, t, { dur: 0.26, combHz: 190, fb: 0.6, peak: 0.16 * k, bright: 1800, seed: 62 }));
      return e;
    },
  },
  wall_hit: {
    bus: 'sfx',
    build(c, d, t, o = {}) {
      const k = clamp(o.force ?? 0.7, 0.2, 1.5);
      let e = tone(c, d, t, { type: 'sine', f0: 110, f1: 44, dur: 0.34, peak: 0.42 * k });
      e = Math.max(e, nz(c, d, t, { dur: 0.20, f0: 900, f1: 220, q: 0.7, peak: 0.28 * k, seed: 63 }));
      e = Math.max(e, metal(c, d, t, { dur: 0.55, combHz: 128, fb: 0.78, peak: 0.22 * k, bright: 1400, seed: 64 }));
      return e;
    },
  },
  wall_scrape: {
    bus: 'sfx',
    build(c, d, t, o = {}) {
      const dur = clamp(o.dur ?? 0.32, 0.08, 2.0), k = clamp(o.force ?? 0.5, 0.1, 1.2);
      const g = gainNode(c, 1, d);
      const e1 = nz(c, g, t, { dur, f0: 2600, f1: 1500, q: 3.2, peak: 0.75 * k, swell: 1, seed: 65 });
      const e2 = metal(c, g, t, { dur: dur + 0.2, combHz: 340, fb: 0.8, peak: 0.45 * k, bright: 3200, seed: 66, excite: dur * 0.8 });
      return Math.max(e1, e2);
    },
  },
  land: {
    bus: 'sfx',
    build(c, d, t, o = {}) {
      const k = clamp(o.force ?? 0.5, 0.08, 1.3);
      // suspension bottoming + tyre slap + a little chirp on a fast landing
      let e = tone(c, d, t, { type: 'sine', f0: 128, f1: 52, dur: 0.20 * lerp(0.8, 1.4, k), peak: 0.30 * k });
      e = Math.max(e, nz(c, d, t, { dur: 0.13, f0: 1100, f1: 300, q: 1.0, peak: 0.20 * k, seed: 67 }));
      if (k > 0.45) e = Math.max(e, nz(c, d, t + 0.01, { dur: 0.22 * k, f0: 1700, f1: 2300, q: 5, peak: 0.10 * k, a: 0.02, seed: 68 }));
      e = Math.max(e, metal(c, d, t, { dur: 0.22, combHz: 420, fb: 0.55, peak: 0.09 * k, bright: 2600, seed: 69 }));
      return e;
    },
  },

  /* ---------------- items ---------------- */
  item_roulette: { bus: 'sfx', build: (c, d, t) => tone(c, d, t, { type: 'square', f0: 1400, dur: 0.05, peak: 0.16 }) },
  item_get: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      const degs = [0, 2, 4, 6];
      for (let i = 0; i < degs.length; i++) {
        e = Math.max(e, bell(c, d, t + i * 0.045, { f: scaleHz(degs[i], 1), ratio: 2.0, index: 240, dur: 0.4, peak: 0.13 }));
      }
      e = Math.max(e, nz(c, d, t, { dur: 0.22, f0: 3000, f1: 8000, q: 1.2, peak: 0.06, a: 0.02, seed: 71 }));
      return e;
    },
  },
  item_box: {
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.28, f0: 4200, f1: 1400, q: 1.0, peak: 0.20, seed: 72 });
      e = Math.max(e, metal(c, d, t, { dur: 0.42, combHz: 830, fb: 0.7, peak: 0.16, bright: 4200, seed: 73 }));
      e = Math.max(e, bell(c, d, t, { f: 1760, ratio: 3.5, index: 900, dur: 0.4, peak: 0.14 }));
      return e;
    },
  },
  shell_fire: {           // Jaffa orange: a citrus "thwip" with a whoosh behind it
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.28, f0: 800, f1: 3800, q: 1.4, peak: 0.30, a: 0.008, seed: 74 });
      e = Math.max(e, tone(c, d, t, { type: 'triangle', f0: 620, f1: 220, dur: 0.22, peak: 0.16 }));
      e = Math.max(e, tone(c, d, t + 0.01, { type: 'sine', f0: 1500, f1: 480, dur: 0.14, peak: 0.10 }));
      return e;
    },
  },
  homing_fire: {          // Sabra missile: rising zip with a prickly edge
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.45, f0: 500, f1: 5200, q: 2.4, peak: 0.16, a: 0.02, seed: 75 });
      e = Math.max(e, tone(c, d, t, { type: 'sawtooth', f0: 240, f1: 1400, dur: 0.38, peak: 0.10 }));
      e = Math.max(e, tone(c, d, t + 0.04, { type: 'square', f0: 1800, f1: 3200, dur: 0.20, peak: 0.05 }));
      return e;
    },
  },
  drop_item: {            // hummus slick / pardes crate hitting the road
    bus: 'sfx',
    build(c, d, t) {
      let e = tone(c, d, t, { type: 'sine', f0: 300, f1: 90, dur: 0.16, peak: 0.24 });
      e = Math.max(e, nz(c, d, t, { dur: 0.20, f0: 700, f1: 240, q: 1.1, peak: 0.16, seed: 76 }));
      return e;
    },
  },
  shield_up: {            // shakshuka pan: struck iron
    bus: 'sfx',
    build(c, d, t) {
      let e = metal(c, d, t, { dur: 0.9, combHz: 196, fb: 0.86, peak: 0.24, bright: 2200, seed: 77 });
      e = Math.max(e, bell(c, d, t, { f: 392, ratio: 4.1, index: 600, dur: 0.8, peak: 0.14 }));
      return e;
    },
  },
  lightning: {            // the field-wide zap
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.10, f0: 9000, f1: 4000, q: 0.6, type: 'highpass', peak: 0.85, a: 0.001, seed: 78 });
      e = Math.max(e, nz(c, d, t + 0.02, { dur: 1.5, f0: 320, f1: 70, q: 0.7, type: 'lowpass', peak: 0.62, a: 0.01, seed: 79 }));
      e = Math.max(e, tone(c, d, t + 0.02, { type: 'sawtooth', f0: 180, f1: 40, dur: 0.9, peak: 0.28 }));
      e = Math.max(e, nz(c, d, t + 0.30, { dur: 1.1, f0: 1600, f1: 300, q: 0.5, peak: 0.10, a: 0.06, seed: 80 }));
      return e;
    },
  },
  star: {                 // invincibility sting: a bright hijaz run
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      const degs = [0, 1, 2, 3, 4, 5, 6, 7];
      for (let i = 0; i < degs.length; i++) {
        const dt = t + i * 0.055;
        e = Math.max(e, bell(c, d, dt, { f: scaleHz(degs[i], 1), ratio: 2.0, index: 300, dur: 0.45, peak: 0.12 }));
        e = Math.max(e, tone(c, d, dt, { type: 'triangle', f0: scaleHz(degs[i], 2), dur: 0.18, peak: 0.05 }));
      }
      e = Math.max(e, nz(c, d, t, { dur: 0.7, f0: 2000, f1: 9000, q: 0.9, peak: 0.06, a: 0.2, seed: 81 }));
      return e;
    },
  },
  rush: {                 // hoopoe rush: wing flutter + a bird call
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      for (let i = 0; i < 7; i++) e = Math.max(e, nz(c, d, t + i * 0.06, { dur: 0.09, f0: 900, f1: 380, q: 1.4, peak: 0.10, seed: 82 + i }));
      for (let i = 0; i < 3; i++) e = Math.max(e, tone(c, d, t + 0.42 + i * 0.11, { type: 'sine', f0: 640, dur: 0.09, peak: 0.12 }));
      return e;
    },
  },
  kite: {                 // afifon glide: airy rise
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 0.7, f0: 400, f1: 2600, q: 0.8, peak: 0.26, swell: 1, seed: 90 });
      e = Math.max(e, tone(c, d, t, { type: 'sine', f0: 440, f1: 880, dur: 0.7, peak: 0.06 }));
      return e;
    },
  },
  sandstorm: {            // khamsin devil
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 1.4, f0: 700, f1: 1800, q: 0.6, peak: 0.30, swell: 1, seed: 91 });
      e = Math.max(e, nz(c, d, t, { dur: 1.4, f0: 180, f1: 320, q: 0.8, type: 'lowpass', peak: 0.18, swell: 1, seed: 92 }));
      return e;
    },
  },

  /* ---------------- getting hit ---------------- */
  hit_spin: {
    bus: 'sfx',
    build(c, d, t) {
      let e = tone(c, d, t, { type: 'sine', f0: 140, f1: 50, dur: 0.3, peak: 0.32 });
      e = Math.max(e, nz(c, d, t, { dur: 0.16, f0: 2000, f1: 500, q: 0.8, peak: 0.22, seed: 93 }));
      // comic tumble: a warble falling away
      const g = gainNode(c, 0.0001, d);
      const s = osc(c, 'triangle', 900, g);
      const lfo = osc(c, 'sine', 11, null); const la = gainNode(c, 220, s.frequency); lfo.connect(la);
      s.frequency.setValueAtTime(900, t); s.frequency.exponentialRampToValueAtTime(200, t + 0.9);
      const end = hit(g.gain, t + 0.03, 0.13, 0.9, 0.01);
      s.start(t); lfo.start(t); s.stop(end + 0.05); lfo.stop(end + 0.05);
      return Math.max(e, end);
    },
  },
  hit_slip: {             // hummus slick / banana: squeaky slide then a bump
    bus: 'sfx',
    build(c, d, t) {
      const g = gainNode(c, 0.0001, d);
      const s = osc(c, 'sine', 700, g);
      s.frequency.setValueAtTime(700, t);
      s.frequency.exponentialRampToValueAtTime(1500, t + 0.18);
      s.frequency.exponentialRampToValueAtTime(420, t + 0.5);
      const end = hit(g.gain, t, 0.16, 0.55, 0.01);
      s.start(t); s.stop(end + 0.05);
      let e = Math.max(end, nz(c, d, t, { dur: 0.5, f0: 2200, f1: 1200, q: 6, peak: 0.12, a: 0.04, seed: 94 }));
      e = Math.max(e, tone(c, d, t + 0.5, { type: 'sine', f0: 170, f1: 60, dur: 0.22, peak: 0.26 }));
      return e;
    },
  },
  hit_blind: {
    bus: 'sfx',
    build(c, d, t) {
      let e = nz(c, d, t, { dur: 1.1, f0: 2200, f1: 600, q: 0.8, peak: 0.2, a: 0.02, seed: 95 });
      e = Math.max(e, tone(c, d, t, { type: 'sawtooth', f0: 300, f1: 90, dur: 0.5, peak: 0.10 }));
      return e;
    },
  },
  hit_stall: {            // cat-nap cloud: everything goes sleepy
    bus: 'sfx',
    build(c, d, t) {
      let e = tone(c, d, t, { type: 'triangle', f0: 520, f1: 130, dur: 0.9, peak: 0.16 });
      e = Math.max(e, tone(c, d, t + 0.05, { type: 'sine', f0: 260, f1: 65, dur: 0.9, peak: 0.12 }));
      e = Math.max(e, nz(c, d, t, { dur: 0.8, f0: 900, f1: 300, q: 1.2, peak: 0.08, a: 0.1, seed: 96 }));
      return e;
    },
  },

  /* ---------------- kart / ui ---------------- */
  engine_start: {
    bus: 'engine',
    build(c, d, t) {
      let e = 0;
      // starter crank: pulsed noise + a rising motor whine, then the engine catches
      for (let i = 0; i < 6; i++) {
        e = Math.max(e, nz(c, d, t + i * 0.085, { dur: 0.07, f0: 300 + i * 40, f1: 180, q: 2.0, peak: 0.16, seed: 97 + i }));
        e = Math.max(e, tone(c, d, t + i * 0.085, { type: 'sawtooth', f0: 70 + i * 8, f1: 50, dur: 0.08, peak: 0.10 }));
      }
      e = Math.max(e, nz(c, d, t + 0.52, { dur: 0.5, f0: 260, f1: 900, q: 1.2, peak: 0.22, a: 0.02, seed: 110 }));
      e = Math.max(e, tone(c, d, t + 0.52, { type: 'sawtooth', f0: 55, f1: 150, dur: 0.45, peak: 0.20 }));
      return e;
    },
  },
  horn: {
    bus: 'sfx',
    build(c, d, t) {
      let e = 0;
      for (const [f, det] of [[520, 0], [660, 6]]) {
        const g = gainNode(c, 0.0001, d);
        const lp = filter(c, 'lowpass', 2400, 0.8, 0, g);
        const s = osc(c, 'square', f, lp); s.detune.value = det;
        const end = adsr(g.gain, t, { a: 0.012, d: 0.05, s: 0.8, r: 0.06, peak: 0.13, dur: 0.30 });
        s.start(t); s.stop(end + 0.05); e = Math.max(e, end);
      }
      return e;
    },
  },
  ui_move: { bus: 'sfx', build: (c, d, t) => tone(c, d, t, { type: 'triangle', f0: 880, dur: 0.09, peak: 0.20 }) },
  ui_select: {
    bus: 'sfx',
    build(c, d, t) {
      let e = bell(c, d, t, { f: scaleHz(4, 1), ratio: 2.0, index: 260, dur: 0.35, peak: 0.16 });
      e = Math.max(e, bell(c, d, t + 0.06, { f: scaleHz(7, 1), ratio: 2.0, index: 200, dur: 0.4, peak: 0.13 }));
      return e;
    },
  },
  ui_back: { bus: 'sfx', build: (c, d, t) => tone(c, d, t, { type: 'triangle', f0: 520, f1: 300, dur: 0.14, peak: 0.12 }) },
};

/* --------------------------------------------------------------------- shared builders --- */
function countBeep(c, d, t, i) {
  const f = 700;
  let e = 0;
  // a held beep with a sharp edge: sine body, square edge, tiny stick transient
  for (const [type, peak] of [['sine', 0.30], ['square', 0.09]]) {
    const g = gainNode(c, 0.0001, d);
    const lp = filter(c, 'lowpass', 4200, 0.8, 0, g);
    const s = osc(c, type, f, lp);
    const end = adsr(g.gain, t, { a: 0.004, d: 0.02, s: 0.88, r: 0.06, peak, dur: 0.17 });
    s.start(t); s.stop(end + 0.05);
    e = Math.max(e, end);
  }
  e = Math.max(e, nz(c, d, t, { dur: 0.04, f0: 3200, f1: 1600, q: 1.2, peak: 0.08, seed: 21 + i }));
  return e;
}
/** Mini-turbo charge tiers: blue, orange, purple — each brighter and denser than the last. */
function chargeChime(c, d, t, tier) {
  const base = [scaleHz(4, 1), scaleHz(7, 1), scaleHz(9, 1)][tier - 1];
  const peak = [0.13, 0.15, 0.17][tier - 1];
  let e = 0;
  const notes = tier === 1 ? [0, 0.06] : tier === 2 ? [0, 0.05, 0.10] : [0, 0.045, 0.09, 0.135];
  for (let i = 0; i < notes.length; i++) {
    const f = base * Math.pow(2, i / 12 * (tier === 3 ? 4 : 3));
    e = Math.max(e, bell(c, d, t + notes[i], { f, ratio: tier === 3 ? 1.41 : 2.0, index: 200 + tier * 120, dur: 0.34 + tier * 0.06, peak }));
  }
  if (tier >= 2) e = Math.max(e, nz(c, d, t, { dur: 0.28, f0: 3400, f1: 8200, q: 1.1, peak: 0.05 * tier, a: 0.05, seed: 100 + tier }));
  if (tier === 3) e = Math.max(e, tone(c, d, t, { type: 'triangle', f0: base * 0.5, f1: base * 1.5, dur: 0.4, peak: 0.07 }));
  return e;
}

/* -------------------------------------------------------------------------- aliases --- */
/** Game-side names (item ids from src/game/items.js, generic names) -> cue ids. */
export const CUE_ALIAS = {
  banana_slip: 'hit_slip', hummus: 'drop_item', hummus_slip: 'hit_slip',
  jaffa: 'shell_fire', jaffa3: 'shell_fire', shell: 'shell_fire',
  sabra: 'homing_fire', missile: 'homing_fire',
  pan: 'shield_up', pardes: 'drop_item',
  khamsin: 'sandstorm', catnap: 'hit_stall', duchifat: 'rush', afifon: 'kite',
  hamsa: 'star', avatiach: 'star', invincible: 'star', falafel: 'boost', falafel3: 'boost',
  thunder: 'lightning', zap: 'lightning',
  spin: 'hit_spin', slip: 'hit_slip', blind: 'hit_blind', stall: 'hit_stall',
  crash: 'wall_hit', scrape: 'wall_scrape', landing: 'land',
  countdown_go_go: 'countdown_go', go: 'countdown_go',
  lap: 'lap_chime', finish: 'finish_fanfare', win: 'finish_fanfare',
  turbo: 'boost', miniturbo: 'boost', miniturbo1: 'boost', miniturbo2: 'boost', miniturbo3: 'boost',
  pad: 'boost', charge1: 'drift_charge_1', charge2: 'drift_charge_2', charge3: 'drift_charge_3',
  cheer: 'crowd_cheer', crowd: 'crowd_cheer',
};
export const cueId = id => (CUES[id] ? id : CUE_ALIAS[id] || null);

/**
 * Build a cue into `dest` at audio-clock time `t0`.
 * @returns {{id:string, end:number, dur:number}|null}
 */
export function playCue(ctx, dest, id, t0, opts = {}) {
  const key = cueId(id);
  if (!key) return null;
  const cue = CUES[key];
  let end = t0;
  try { end = cue.build(ctx, dest, t0, opts) || t0 + 0.3; }
  catch (e) { return null; }
  return { id: key, end, dur: end - t0 };
}

export const CUE_IDS = Object.keys(CUES);
export default { CUES, CUE_IDS, CUE_ALIAS, playCue, cueId, scaleHz, HIJAZ };
