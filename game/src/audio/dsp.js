/**
 * Kat Racing — procedural audio DSP toolbox.
 *
 * There are no sound files in this project and the network is closed: every buffer here is
 * synthesised from noise, physical-ish models and additive maths. Everything takes an explicit
 * `ctx` so the same code renders through a live AudioContext or an OfflineAudioContext (see
 * src/audio/testkit.js) — that is how this module is verified without being able to hear it.
 *
 * All randomness comes from rng(seed) so two renders of the same cue are bit-identical.
 */
import { rng } from '../core/mathx.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = g => 20 * Math.log10(Math.max(1e-9, g));
/** MIDI-ish: semitones above A4 = 440. */
export const hz = semis => 440 * Math.pow(2, semis / 12);

/* ------------------------------------------------------------------ per-context cache --- */
const CACHE = new WeakMap();
export function cached(ctx, key, make) {
  let b = CACHE.get(ctx);
  if (!b) { b = new Map(); CACHE.set(ctx, b); }
  let v = b.get(key);
  if (v === undefined) { v = make(); b.set(key, v); }
  return v;
}
export function clearCache(ctx) { CACHE.delete(ctx); }

/* ----------------------------------------------------------------------------- noise --- */
/** White / pink / brown noise, cached per (kind, seconds, seed). Stereo-decorrelated. */
export function noiseBuffer(ctx, { seconds = 2.5, seed = 1234, kind = 'white', channels = 2 } = {}) {
  return cached(ctx, `noise:${kind}:${seconds}:${seed}:${channels}`, () => {
    const sr = ctx.sampleRate, n = Math.max(1, Math.round(seconds * sr));
    const buf = ctx.createBuffer(channels, n, sr);
    for (let c = 0; c < channels; c++) {
      const d = buf.getChannelData(c);
      const r = rng((seed + c * 7919) >>> 0);
      if (kind === 'pink') {
        // Paul Kellet's economy pink filter
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < n; i++) {
          const w = r() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
          b6 = w * 0.115926;
        }
      } else if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < n; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
      } else {
        for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
      }
    }
    // seamless loop: 12 ms equal-power crossfade of the tail into the head
    const fade = Math.min(Math.round(sr * 0.012), (n / 4) | 0);
    for (let c = 0; c < channels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < fade; i++) {
        const t = i / fade, a = Math.cos(t * Math.PI * 0.5), b = Math.sin(t * Math.PI * 0.5);
        d[i] = d[i] * b + d[n - fade + i] * a;
      }
    }
    return buf;
  });
}

/** Looping source wired to a destination, started at `when`. */
export function loopSource(ctx, buffer, dest, { rate = 1, when = 0, detune = 0 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = buffer; s.loop = true; s.playbackRate.value = rate;
  if (detune && s.detune) s.detune.value = detune;
  if (dest) s.connect(dest);
  try { s.start(when); } catch (e) { /* already started */ }
  return s;
}

/* -------------------------------------------------------------------------- envelopes --- */
/** Fire an envelope on a gain param: attack to `peak`, decay to `sustain`, release at `dur`. */
export function adsr(param, t0, { a = 0.005, d = 0.08, s = 0.0, r = 0.12, peak = 1, dur = 0 } = {}) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
  const sv = Math.max(peak * s, 0.00012);
  param.exponentialRampToValueAtTime(sv, t0 + a + d);
  const rel = t0 + Math.max(dur, a + d);
  if (dur > 0) param.setValueAtTime(Math.max(sv, 0.00012), rel);
  param.exponentialRampToValueAtTime(0.00008, rel + r);
  return rel + r;
}
/** Percussive one-shot envelope: instant-ish attack, exponential fall. */
export function hit(param, t0, peak = 1, decay = 0.2, attack = 0.002) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
  param.exponentialRampToValueAtTime(0.00008, t0 + attack + decay);
  return t0 + attack + decay;
}
/** Smoothed parameter follow — cheap, click-free, safe to call every frame. */
export function follow(param, value, now, tau = 0.06) {
  const v = Number.isFinite(value) ? value : 0;
  if (Math.abs(param.value - v) < 1e-5) return;
  try { param.setTargetAtTime(v, now, Math.max(tau, 0.001)); }
  catch (e) { param.value = v; }
}

/* ---------------------------------------------------------------------- node factories --- */
export function gainNode(ctx, v = 1, dest = null) {
  const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g;
}
export function filter(ctx, type, freq, q = 1, gainDb = 0, dest = null) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gainDb;
  if (dest) f.connect(dest);
  return f;
}
/** Soft saturation; `k` 0..1 goes from clean to fuzzy. */
export function shaper(ctx, k = 0.4, dest = null) {
  const ws = ctx.createWaveShaper();
  ws.curve = cached(ctx, `curve:${k.toFixed(3)}`, () => {
    const n = 2048, c = new Float32Array(n), drive = 1 + k * 22;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * drive) / Math.tanh(drive) * (1 - k * 0.25) + x * k * 0.2;
    }
    return c;
  });
  ws.oversample = '2x';
  if (dest) ws.connect(dest);
  return ws;
}
/** Stereo widener that works on every context (StereoPanner isn't in every offline impl). */
export function panner2(ctx, pan = 0, dest = null) {
  let node;
  if (ctx.createStereoPanner) { node = ctx.createStereoPanner(); node.pan.value = pan; }
  else { node = ctx.createGain(); node.pan = { value: pan, setTargetAtTime() {} }; }
  if (dest) node.connect(dest);
  return node;
}

/* ------------------------------------------------------------------------- room / IR --- */
/** Small dry Mediterranean street: early slap off stone, short bright tail. */
export function roomImpulse(ctx, { seconds = 1.5, decay = 3.2, seed = 99, spread = 1 } = {}) {
  return cached(ctx, `ir:${seconds}:${decay}:${seed}`, () => {
    const sr = ctx.sampleRate, n = Math.round(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c), r = rng((seed + c * 3371) >>> 0);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const w = r() * 2 - 1;
        lp += 0.35 * (w - lp);                       // tail darkens
        d[i] = lerp(w, lp, t) * Math.pow(1 - t, decay);
      }
      // a couple of discrete stone-wall slaps for shape
      for (const [ms, g] of [[17, 0.55], [29, 0.4], [47, 0.3], [71, 0.22]]) {
        const i = Math.round((ms + c * spread * 3) * 0.001 * sr);
        if (i < n) d[i] += g * (c ? -1 : 1);
      }
    }
    return buf;
  });
}

/* ------------------------------------------------------------------ physical models --- */
/**
 * Karplus–Strong oud string: a double course (two slightly detuned strings), risha attack
 * click, feedback damping and a fractional delay line so intonation is exact.
 */
export function pluckBuffer(ctx, freq, opts = {}) {
  const {
    seconds = 1.5, seed = 3, t60 = 1.05, bright = 0.55, detune = 0.0035,
    level = 0.85, click = 0.5,
  } = opts;
  return cached(ctx, `pluck:${freq.toFixed(2)}:${seed}:${t60}:${bright}`, () => {
    const sr = ctx.sampleRate, n = Math.round(seconds * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);
    const r = rng((seed * 2654435761) >>> 0);
    const strings = [];
    for (let k = 0; k < 2; k++) {
      const f = freq * (k === 0 ? 1 : 1 + detune);
      const L = sr / f, N = Math.ceil(L) + 4;
      const line = new Float32Array(N);
      // excitation: bandlimited noise burst, brighter at the pick point
      let lp = 0;
      const alpha = 0.18 + 0.62 * bright;
      const M = Math.floor(L);
      for (let i = 0; i < M; i++) {
        lp += alpha * ((r() * 2 - 1) - lp);
        const pick = Math.sin(Math.PI * (i / M)) * 0.5 + 0.5;
        line[i] = lp * pick;
      }
      strings.push({ line, N, L, w: M % N, lp: 0, g: Math.pow(0.001, 1 / (t60 * f)), a: 0.22 + 0.55 * bright });
    }
    let dcx = 0, dcy = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const st of strings) {
        const rp = st.w - st.L;
        const ri = ((Math.floor(rp) % st.N) + st.N) % st.N;
        const fr = rp - Math.floor(rp);
        const v = st.line[ri] * (1 - fr) + st.line[(ri + 1) % st.N] * fr;
        st.lp += st.a * (v - st.lp);
        st.line[st.w] = st.lp * st.g;
        st.w = (st.w + 1) % st.N;
        s += v * 0.5;
      }
      // risha click + soundboard body colour
      if (i < 220) s += (r() * 2 - 1) * click * 0.35 * Math.exp(-i / 45);
      dcy = s - dcx + 0.995 * dcy; dcx = s;      // DC blocker
      out[i] = Math.tanh(dcy * 1.4) * level;
    }
    // fade the very end so a stolen voice cannot click
    const f = Math.min(600, n);
    for (let i = 0; i < f; i++) out[n - f + i] *= 1 - i / f;
    return buf;
  });
}

/**
 * Darbuka / tabla-ish membrane. `kind`: 'dum' (deep centre stroke), 'tek' (edge crack),
 * 'ka' (soft off-hand), 'slap'.
 */
export function drumBuffer(ctx, kind = 'dum', opts = {}) {
  const { seed = 11, tune = 1 } = opts;
  return cached(ctx, `drum:${kind}:${seed}:${tune.toFixed(3)}`, () => {
    const sr = ctx.sampleRate;
    const P = {
      dum:  { dur: 0.55, f0: 108 * tune, f1: 58 * tune, drop: 26, dec: 9,  noise: 0.32, nf: 0.20, ring: 0.85, hp: 0.02 },
      tek:  { dur: 0.20, f0: 420 * tune, f1: 300 * tune, drop: 60, dec: 34, noise: 0.85, nf: 0.72, ring: 0.35, hp: 0.55 },
      ka:   { dur: 0.15, f0: 360 * tune, f1: 280 * tune, drop: 70, dec: 42, noise: 0.72, nf: 0.66, ring: 0.25, hp: 0.5 },
      slap: { dur: 0.30, f0: 190 * tune, f1: 120 * tune, drop: 40, dec: 18, noise: 0.95, nf: 0.5,  ring: 0.5,  hp: 0.28 },
    }[kind] || {};
    const n = Math.round(P.dur * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = rng((seed * 40503 + kind.charCodeAt(0) * 7919) >>> 0);
    let ph = 0, ph2 = 0, lp = 0, hp = 0, hpz = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = P.f1 + (P.f0 - P.f1) * Math.exp(-t * P.drop);
      ph += (2 * Math.PI * f) / sr; ph2 += (2 * Math.PI * f * 2.71) / sr;   // circular-membrane overtone
      const env = Math.exp(-t * P.dec);
      let s = (Math.sin(ph) + Math.sin(ph2) * 0.28 * P.ring) * env;
      // stick/hand transient
      const w = r() * 2 - 1;
      lp += (0.25 + 0.7 * P.nf) * (w - lp);
      const nEnv = Math.exp(-t * (P.dec * 3 + 30));
      s += lp * P.noise * nEnv;
      // high-pass the edge strokes so they cut over the mix
      hp = s - hpz + 0.98 * hp; hpz = s;
      d[i] = Math.tanh((s * (1 - P.hp) + hp * P.hp) * 1.6) * 0.9;
    }
    const f = Math.min(400, n);
    for (let i = 0; i < f; i++) d[n - f + i] *= 1 - i / f;
    return buf;
  });
}

/** Riq / tambourine jingles: a cluster of high inharmonic partials with a noise chiff. */
export function jingleBuffer(ctx, { seed = 21, dur = 0.26, bright = 1 } = {}) {
  return cached(ctx, `jingle:${seed}:${dur}:${bright}`, () => {
    const sr = ctx.sampleRate, n = Math.round(dur * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed >>> 0);
    const parts = [];
    for (let k = 0; k < 7; k++) parts.push({ f: (5200 + r() * 5200) * bright, p: r() * 6.28, a: 0.25 + r() * 0.75, dec: 14 + r() * 26 });
    let hp = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let s = 0;
      for (const p of parts) s += Math.sin(2 * Math.PI * p.f * t + p.p) * p.a * Math.exp(-t * p.dec);
      s = s / parts.length;
      s += (r() * 2 - 1) * 0.5 * Math.exp(-t * 90);
      hp = s - z + 0.99 * hp; z = s;
      d[i] = hp * 0.85;
    }
    return buf;
  });
}

/**
 * One engine firing cycle, as a loopable buffer. Each combustion event excites two exhaust
 * resonances; per-cycle jitter in gain and timing gives the uneven "brap" of a real single
 * rather than a synth tone. Played back with playbackRate = firingHz / baseHz.
 */
export function engineCycleBuffer(ctx, opts = {}) {
  const {
    baseHz = 50, cycles = 8, seed = 5, res1 = 300, res2 = 730, decay1 = 220, decay2 = 620,
    pulses = 1, jitter = 0.16, overrun = 0, growl = 0.5,
  } = opts;
  const key = `eng:${baseHz}:${cycles}:${seed}:${res1}:${res2}:${decay1}:${decay2}:${pulses}:${jitter}:${overrun}:${growl}`;
  return cached(ctx, key, () => {
    const sr = ctx.sampleRate;
    const period = sr / baseHz;
    const n = Math.round(period * cycles);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = rng((seed * 2246822519) >>> 0);
    const events = [];
    for (let c = 0; c < cycles; c++) {
      for (let p = 0; p < pulses; p++) {
        const nominal = (c + p / pulses) * period;
        const g = 1 - jitter * r();
        events.push({ t0: nominal + (r() * 2 - 1) * period * jitter * 0.10, g, sk: r() });
      }
    }
    for (const e of events) {
      const len = Math.min(n, Math.round(period * 1.4));
      for (let i = 0; i < len; i++) {
        const idx = (Math.round(e.t0) + i) % n;
        const t = i / sr;
        const a1 = Math.exp(-t * decay1), a2 = Math.exp(-t * decay2);
        const f1 = res1 * (1 + 0.35 * Math.exp(-t * 900));    // pressure pulse chirps down
        let s = Math.sin(2 * Math.PI * f1 * t) * a1
              + Math.sin(2 * Math.PI * res2 * t + 1.1) * a2 * (0.55 + growl * 0.5);
        // combustion hiss on the leading edge
        s += (r() * 2 - 1) * 0.30 * Math.exp(-t * 1500) * (0.5 + growl);
        if (overrun > 0) {
          // off-throttle: unburnt-charge pops, sparse and irregular
          if (i === 0 && e.sk < 0.30 * overrun) s += (r() * 2 - 1) * 2.2;
          s *= 0.55;
        }
        d[idx] += s * e.g;
      }
    }
    // normalise and DC-block so playbackRate changes cannot pump the level
    let dc = 0; for (let i = 0; i < n; i++) dc += d[i]; dc /= n;
    let pk = 1e-6; for (let i = 0; i < n; i++) { d[i] -= dc; pk = Math.max(pk, Math.abs(d[i])); }
    const k = 0.92 / pk;
    for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * k * 1.25) * 0.6;
    return buf;
  });
}

/**
 * Amplitude-modulation source for granular surface texture: mostly quiet with random
 * grains, looped at a playbackRate proportional to speed so gravel rattles faster the
 * faster you go. Connect to a GainNode's `gain` param (it sums with the param value).
 */
export function grainBuffer(ctx, { seed = 31, seconds = 1.0, density = 60, sharp = 26, level = 1, smooth = 0 } = {}) {
  return cached(ctx, `grain:${seed}:${seconds}:${density}:${sharp}:${level}:${smooth}`, () => {
    const sr = ctx.sampleRate, n = Math.round(seconds * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed >>> 0);
    const count = Math.max(1, Math.round(density * seconds));
    for (let g = 0; g < count; g++) {
      const at = Math.floor(r() * n);
      const amp = (0.35 + r() * 0.65) * level;
      const dec = sharp * (0.6 + r());
      const len = Math.min(n, Math.round(sr * (smooth ? 2.4 / dec : 0.25)));
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // smooth = raised-cosine swell (engine lope); otherwise a sharp grain (stones)
        const e = smooth ? 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, i / len)) : Math.exp(-t * dec);
        if (!smooth && e < 0.002) break;
        d[(at + i) % n] += amp * e;
      }
    }
    const fade = Math.min(Math.round(sr * 0.01), (n / 4) | 0);
    for (let i = 0; i < fade; i++) { const t = i / fade; d[i] = d[i] * t + d[n - fade + i] * (1 - t); }
    return buf;
  });
}

/** Periodic click train (kerb strips, cattle grid, chain rattle). Rate scales with speed. */
export function clickTrainBuffer(ctx, { seed = 41, seconds = 1.0, clicks = 24, tone = 2400, decay = 220 } = {}) {
  return cached(ctx, `clicks:${seed}:${seconds}:${clicks}:${tone}:${decay}`, () => {
    const sr = ctx.sampleRate, n = Math.round(seconds * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed >>> 0);
    const step = n / clicks;
    for (let c = 0; c < clicks; c++) {
      const at = Math.round(c * step + (r() * 2 - 1) * step * 0.06);
      const f = tone * (0.75 + r() * 0.5), amp = 0.6 + r() * 0.4;
      const len = Math.min(n, Math.round(sr * 0.05));
      for (let i = 0; i < len; i++) {
        const t = i / sr, e = Math.exp(-t * decay);
        if (e < 0.002) break;
        const idx = ((at + i) % n + n) % n;
        d[idx] += (Math.sin(2 * Math.PI * f * t) * 0.6 + (r() * 2 - 1) * 0.4) * e * amp;
      }
    }
    let pk = 1e-6; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] = d[i] / pk * 0.9;
    return buf;
  });
}

/** Crowd bed: many overlapping voice-ish formant blobs, plus sparse claps. Loops cleanly. */
export function crowdBuffer(ctx, { seed = 51, seconds = 4.0 } = {}) {
  return cached(ctx, `crowd:${seed}:${seconds}`, () => {
    const sr = ctx.sampleRate, n = Math.round(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const r = rng((seed + c * 977) >>> 0);
      // babble: filtered noise with slow random amplitude drift
      let lp1 = 0, lp2 = 0, hp = 0, z = 0, drift = 0;
      for (let i = 0; i < n; i++) {
        const w = r() * 2 - 1;
        lp1 += 0.24 * (w - lp1); lp2 += 0.12 * (lp1 - lp2);
        drift += 0.00004 * ((r() * 2 - 1) - drift * 0.5);
        const s = (lp1 * 0.6 + lp2 * 0.9) * (0.7 + drift * 60);
        hp = s - z + 0.995 * hp; z = s;
        d[i] = hp * 0.5;
      }
      // sparse claps and whistles
      const claps = Math.round(seconds * 26);
      for (let k = 0; k < claps; k++) {
        const at = Math.floor(r() * n), amp = 0.10 + r() * 0.2;
        for (let i = 0; i < 900; i++) {
          const t = i / sr;
          d[(at + i) % n] += (r() * 2 - 1) * amp * Math.exp(-t * 260);
        }
      }
      const fade = Math.round(sr * 0.05);
      for (let i = 0; i < fade; i++) { const t = i / fade; d[i] = d[i] * t + d[n - fade + i] * (1 - t); }
    }
    return buf;
  });
}

export default {
  clamp, lerp, dbToGain, gainToDb, hz, cached, noiseBuffer, loopSource, adsr, hit, follow,
  gainNode, filter, shaper, panner2, roomImpulse, pluckBuffer, drumBuffer, jingleBuffer,
  engineCycleBuffer, grainBuffer, clickTrainBuffer, crowdBuffer,
};
