/**
 * Kat Racing — the race theme, sequenced live.
 *
 * Maqam hijaz on D (D Eb F# G A Bb C) over a maqsum darbuka groove: the sound of a Ramot
 * Menashe village fete, played by an oud, a bass, a riq and a ney. Nothing is pre-rendered —
 * a lookahead scheduler posts notes onto the audio clock a quarter of a second ahead, so the
 * eight-bar phrase repeats forever with no seam and no drift.
 *
 * Intensity 0..1 drives an arrangement, not just a volume knob:
 *   0.00  menu      drone + sparse oud
 *   0.35  race      + darbuka, bass
 *   0.55  mid-race  + riq sixteenths, ney pad
 *   0.80  final lap + octave doubling, claps, busier fills
 *   1.00  last bend + tempo pushes from 104 to 120 bpm
 */
import {
  clamp, lerp, gainNode, filter, noiseBuffer, loopSource, pluckBuffer, drumBuffer, jingleBuffer,
  hit, adsr, follow, panner2,
} from './dsp.js';
import { scaleHz, HIJAZ } from './sfx.js';
import { rng } from '../core/mathx.js';

const R = -1;   // rest
/** Eight-bar oud phrase, sixteenth-note grid, values are hijaz scale degrees. */
const PHRASE = [
  [0, R, 1, 2, 3, R, 2, 1, 0, R, R, R, R, R, 0, 1],
  [2, R, 3, 4, 5, R, 4, 3, 2, R, R, 3, 4, R, 3, 2],
  [0, R, 1, 2, 3, R, 2, 1, 0, R, R, R, 6, R, 5, 4],
  [4, R, 5, 4, 3, R, 2, 3, 4, R, R, R, 2, R, 1, 0],
  [0, R, 1, 2, 3, R, 2, 1, 0, R, R, R, R, R, 0, 1],
  [2, R, 3, 4, 5, R, 4, 3, 2, R, 4, 3, 2, R, 1, 2],
  [7, R, R, 6, 5, R, 4, 3, 4, R, 3, R, 2, R, 1, R],
  [0, R, R, 4, 3, R, 2, 1, 0, R, R, R, R, R, R, R],
];
/** Per-bar bass root (scale degree). */
const BASS_ROOT = [0, 0, 3, 4, 0, 0, 5, 4];
/** Maqsum: dum on 1 and the "and" of 2, tek answering. */
const DRUM_BASE = { 0: 'dum', 2: 'tek', 6: 'tek', 8: 'dum', 12: 'tek' };
const DRUM_BUSY = { 3: 'ka', 7: 'ka', 10: 'dum', 11: 'ka', 14: 'tek', 15: 'ka' };
/** Ney pad: one long note every two bars. */
const PAD = [0, 4, 3, 4];

export function createMusic(ctx, dest, opts = {}) {
  const O = {
    seed: 1234, bpm: 104, bpmTop: 120, gain: 1, send: null, sendAmount: 0.22,
    ...opts,
  };
  const out = gainNode(ctx, O.gain, dest);
  const master = filter(ctx, 'lowpass', 12000, 0.7, 0, out);
  // post-fader send: muting the music must mute its reverb too
  const sendGain = O.send ? gainNode(ctx, O.sendAmount, O.send) : null;
  if (sendGain) out.connect(sendGain);

  /* ---- layer buses ---- */
  const L = {};
  // each player sits in its own place across the stage, the way a real band would
  const mk = (name, v, pan) => {
    const p = panner2(ctx, pan, master);
    return (L[name] = gainNode(ctx, v, p));
  };
  mk('drone', 0.0001, 0); mk('oud', 0.0001, -0.28); mk('bass', 0.0001, 0.05);
  mk('perc', 0.0001, 0.16); mk('riq', 0.0001, 0.42); mk('ney', 0.0001, -0.44); mk('extra', 0.0001, 0.3);

  /* ---- drone: a low tanbura-ish bed, always running, cheap ---- */
  const droneOscs = [];
  {
    const lp = filter(ctx, 'lowpass', 520, 0.9, 0, L.drone);
    for (const [f, g, det] of [[73.42, 0.30, 0], [110.0, 0.22, 5], [146.83, 0.16, -6], [220, 0.07, 8]]) {
      const gg = gainNode(ctx, g, lp);
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(gg);
      try { o.start(0); } catch (e) { /* */ }
      droneOscs.push(o);
    }
    // slow breathing so the drone is never static
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const la = gainNode(ctx, 140, lp.frequency); lfo.connect(la);
    try { lfo.start(0); } catch (e) { /* */ }
    droneOscs.push(lfo);
  }

  /* ---- state ---- */
  const S = {
    playing: false, step: 0, nextTime: 0, intensity: 0, target: 0.0, bpm: O.bpm,
    bars: 0, alive: true, notes: 0,
  };
  const rnd = rng(O.seed >>> 0);
  const swing = 0.012;

  function stepDur() { return 60 / S.bpm / 4; }

  /* ---- voices ---- */
  function oudNote(t, deg, oct, gainMul) {
    const f = scaleHz(deg, oct);
    const g = gainNode(ctx, 0.34 * gainMul, L.oud);
    const s = ctx.createBufferSource();
    s.buffer = pluckBuffer(ctx, f, { seed: 3 + ((deg + oct * 7) | 0), t60: 0.95, bright: 0.55, seconds: 1.3 });
    s.connect(g); s.start(t);
    S.notes++;
  }
  function bassNote(t, deg, dur) {
    const f = scaleHz(deg, -2);
    const g = gainNode(ctx, 0.0001, L.bass);
    const lp = filter(ctx, 'lowpass', 420, 1.4, 0, g);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 0.5;
    const g2 = gainNode(ctx, 0.5, lp);
    o.connect(lp); o2.connect(g2);
    const end = adsr(g.gain, t, { a: 0.008, d: 0.09, s: 0.55, r: 0.09, peak: 0.5, dur });
    o.start(t); o2.start(t); o.stop(end + 0.05); o2.stop(end + 0.05);
  }
  function percHit(t, kind, vel) {
    const g = gainNode(ctx, vel, L.perc);
    const s = ctx.createBufferSource();
    s.buffer = drumBuffer(ctx, kind, { seed: 11, tune: kind === 'dum' ? 1 : 1.04 });
    s.connect(g); s.start(t);
  }
  function riqHit(t, vel) {
    const g = gainNode(ctx, vel, L.riq);
    const s = ctx.createBufferSource();
    s.buffer = jingleBuffer(ctx, { seed: 21, dur: 0.16, bright: 1 });
    s.connect(g); s.start(t);
  }
  function clap(t, vel) {
    const g = gainNode(ctx, 0.0001, L.extra);
    const bp = filter(ctx, 'bandpass', 1500, 1.1, 0, g);
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx, { seconds: 2.5, seed: 555, kind: 'white' });
    s.loop = true; s.connect(bp);
    // three quick slaps make a hand-clap, not a noise blip
    for (let i = 0; i < 3; i++) hit(g.gain, t + i * 0.011, vel * (1 - i * 0.25), 0.05, 0.001);
    s.start(t); s.stop(t + 0.2);
  }
  function neyNote(t, deg, dur) {
    const f = scaleHz(deg, 0);
    const g = gainNode(ctx, 0.0001, L.ney);
    const bp = filter(ctx, 'lowpass', 2200, 0.9, 0, g);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = f * 3;
    const g3 = gainNode(ctx, 0.10, bp);
    o.connect(bp); o3.connect(g3);
    // breath noise gives the ney its air
    const br = gainNode(ctx, 0.0001, bp);
    const bf = filter(ctx, 'bandpass', f * 2, 3.5, 0, br);
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuffer(ctx, { seconds: 2.5, seed: 606, kind: 'white' }); ns.loop = true; ns.connect(bf);
    // vibrato
    const vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 5.2;
    const va = gainNode(ctx, f * 0.006, o.frequency); vib.connect(va);
    const end = adsr(g.gain, t, { a: 0.22, d: 0.25, s: 0.7, r: 0.5, peak: 0.28, dur });
    adsr(br.gain, t, { a: 0.25, d: 0.3, s: 0.6, r: 0.5, peak: 0.05, dur });
    o.start(t); o3.start(t); ns.start(t); vib.start(t);
    for (const n of [o, o3, ns, vib]) n.stop(end + 0.05);
  }

  /* ---- the sequencer ---- */
  function scheduleStep(i, t) {
    const bar = Math.floor(i / 16) % 8;
    const st = i % 16;
    const I = S.intensity;
    const r = rng((O.seed + i * 2654435761) >>> 0);   // deterministic per absolute step

    // oud lead
    if (I > 0.10) {
      const deg = PHRASE[bar][st];
      if (deg !== R) {
        const accent = st % 4 === 0 ? 1 : 0.72;
        oudNote(t, deg, 0, clamp(I * 1.5, 0, 1) * accent);
        if (I > 0.78 && st % 4 === 0) oudNote(t + 0.004, deg, 1, 0.42 * accent);   // octave doubling
      }
    }
    // bass
    if (I > 0.12 && (st === 0 || st === 6 || st === 8 || st === 14)) {
      const deg = BASS_ROOT[bar] + (st === 6 ? 4 : 0);
      bassNote(t, deg, st === 0 ? 0.30 : 0.18);
    }
    // darbuka
    if (I > 0.06) {
      const k = DRUM_BASE[st];
      if (k) percHit(t, k, k === 'dum' ? 0.62 : 0.34);
      if (I > 0.62) {
        const k2 = DRUM_BUSY[st];
        if (k2 && r() < 0.55 + I * 0.4) percHit(t, k2, k2 === 'dum' ? 0.34 : 0.20);
      }
      // a fill into the top of the phrase
      if (I > 0.5 && bar === 7 && st >= 12) percHit(t, st % 2 ? 'ka' : 'tek', 0.18 + (st - 12) * 0.07);
    }
    // riq sixteenths
    if (I > 0.42) {
      const accent = st % 4 === 0 ? 0.30 : st % 2 === 0 ? 0.19 : 0.12;
      riqHit(t, accent * clamp((I - 0.4) / 0.4, 0, 1));
    }
    // claps on the backbeat when the race is hot
    if (I > 0.78 && (st === 4 || st === 12)) clap(t, 0.22);
    // ney pad every two bars
    if (I > 0.5 && st === 0 && bar % 2 === 0) neyNote(t, PAD[(bar / 2) | 0], 60 / S.bpm * 8 * 0.85);

    if (st === 15) S.bars++;
  }

  /* ---- api ---- */
  function warm() {
    // pre-build every buffer the phrase can ask for, so the first bar cannot stutter
    for (let oct = 0; oct <= 1; oct++) for (let d = 0; d <= 7; d++) {
      pluckBuffer(ctx, scaleHz(d, oct), { seed: 3 + d + oct * 7, t60: 0.95, bright: 0.55, seconds: 1.3 });
    }
    drumBuffer(ctx, 'dum', { seed: 11, tune: 1 });
    drumBuffer(ctx, 'tek', { seed: 11, tune: 1.04 });
    drumBuffer(ctx, 'ka', { seed: 11, tune: 1.04 });
    jingleBuffer(ctx, { seed: 21, dur: 0.16, bright: 1 });
  }

  function start(when = 0) {
    if (S.playing) return;
    warm();
    S.playing = true;
    S.step = 0; S.bars = 0;
    S.nextTime = when + 0.08;
  }
  function stop(when = 0, fade = 0.6) {
    if (!S.playing) return;
    S.playing = false;
    follow(out.gain, 0.0001, when, fade * 0.4);
  }
  function setIntensity(t) { S.target = clamp(t, 0, 1); }

  function update(dt, now) {
    if (!S.alive) return;
    // ease the arrangement between states so layers swell instead of popping in
    S.intensity = lerp(S.intensity, S.target, 1 - Math.exp(-clamp(dt, 0, 0.2) * 1.6));
    const I = S.intensity;
    S.bpm = lerp(O.bpm, O.bpmTop, clamp((I - 0.80) / 0.20, 0, 1));

    follow(L.drone.gain, lerp(0.20, 0.07, clamp(I / 0.6, 0, 1)) * (I > 0.01 ? 1 : 0.6), now, 0.8);
    follow(L.oud.gain,   clamp((I - 0.08) / 0.3, 0, 1) * 0.62, now, 0.5);
    follow(L.bass.gain,  clamp((I - 0.10) / 0.3, 0, 1) * 0.55, now, 0.5);
    follow(L.perc.gain,  clamp((I - 0.05) / 0.35, 0, 1) * 0.72, now, 0.5);
    follow(L.riq.gain,   clamp((I - 0.42) / 0.3, 0, 1) * 0.55, now, 0.6);
    follow(L.ney.gain,   clamp((I - 0.50) / 0.3, 0, 1) * 0.42, now, 0.9);
    follow(L.extra.gain, clamp((I - 0.75) / 0.25, 0, 1) * 0.60, now, 0.5);
    follow(master.frequency, lerp(3200, 13000, clamp(I / 0.7, 0, 1)), now, 0.9);

    if (!S.playing) return;
    if (S.nextTime < now - 0.5) S.nextTime = now + 0.03;      // recover from a stalled tab
    const horizon = now + 0.28;
    let guard = 0;
    while (S.nextTime < horizon && guard++ < 64) {
      const st = S.step % 16;
      const sw = (st % 2 === 1) ? swing * (60 / S.bpm) : 0;   // light swing on the offbeats
      scheduleStep(S.step, S.nextTime + sw);
      S.nextTime += stepDur();
      S.step++;
    }
  }

  function dispose() {
    S.alive = false; S.playing = false;
    for (const o of droneOscs) { try { o.stop(); } catch (e) { /* */ } try { o.disconnect(); } catch (e) { /* */ } }
    try { out.disconnect(); } catch (e) { /* */ }
  }

  return {
    out, start, stop, update, setIntensity, dispose, state: S, layers: L,
    get intensity() { return S.intensity; },
    get bpm() { return S.bpm; },
    get playing() { return S.playing; },
    setGain(v, now) { follow(out.gain, v, now ?? 0, 0.2); },
  };
}

export default createMusic;
export { PHRASE, BASS_ROOT, DRUM_BASE, DRUM_BUSY, PAD, HIJAZ };
