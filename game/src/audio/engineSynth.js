/**
 * Kat Racing — kart engine voice.
 *
 * A small single-cylinder kart engine is a *pulse train*, not a tone: each combustion excites
 * the exhaust resonances and dies away before the next one. So the core of this voice is a
 * looped buffer of eight jittered firing cycles (see engineCycleBuffer) played back at
 * playbackRate = firingHz / baseHz — granular synthesis where each grain is a bang.
 *
 * On top of that:
 *   - a second, sparser buffer for off-throttle overrun (popping, no drive)
 *   - intake roar: noise bandpassed at the 2nd order, tracking rpm, gated by throttle
 *   - chain / gear whine: a saw at ~6.5x firing, quiet, tracking
 *   - exhaust body: fixed peaking formants + an rpm-tracking lowpass
 *   - waveshaper drive scaled by engine load, so lifting off makes it thinner
 *   - turbo spool whistle + a bandpassed hiss, gain and pitch following boost
 *
 * Every constant that gives a kart its personality is derived from `seed`, so the ten drivers
 * on the grid do not sound like ten copies of one kart.
 */
import {
  clamp, lerp, gainNode, filter, shaper, noiseBuffer, loopSource, engineCycleBuffer,
  grainBuffer, follow,
} from './dsp.js';
import { rng } from '../core/mathx.js';

export const ENGINE_BASE_HZ = 50;      // the pitch the cycle buffer is authored at
export const IDLE_HZ = 36;             // firing rate at idle  (~2200 rpm on a single)
export const MAX_HZ = 196;             // firing rate at the limiter (~11800 rpm)

/** rpm (0..1) -> combustion frequency in Hz. Slightly convex: the top end feels longer. */
export function firingHz(rpm) {
  const t = clamp(rpm, 0, 1.12);
  return IDLE_HZ + (MAX_HZ - IDLE_HZ) * (t * 0.78 + t * t * 0.22);
}

/** Deterministic per-driver engine personality. */
export function engineCharacter(seed = 1) {
  const r = rng((seed * 2654435761 + 17) >>> 0);
  const bore = 0.75 + r() * 0.5;                     // small & buzzy .. big & lumpy
  return {
    seed,
    res1: 240 + r() * 170,                           // primary exhaust resonance
    res2: 560 + r() * 420,                           // secondary / header ring
    decay1: 150 + r() * 160,
    decay2: 430 + r() * 380,
    pulses: r() < 0.34 ? 2 : 1,                      // twin-port kart karts fire twice a cycle
    jitter: 0.10 + r() * 0.16,
    growl: 0.3 + r() * 0.6,
    whineRatio: 5.4 + r() * 2.4,
    whineGain: 0.018 + r() * 0.035,
    intake: 0.35 + r() * 0.4,
    turboHz: 3200 + r() * 2400,
    detune: (r() * 2 - 1) * 0.035,                   // no two engines are on the same pitch
    bodyQ: 1.6 + r() * 2.2,
    bright: 0.7 + r() * 0.6,
    bore,
  };
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} dest
 * @param {{seed?:number, gain?:number, rival?:boolean, character?:object}} opts
 */
export function createEngineVoice(ctx, dest, opts = {}) {
  const C = opts.character || engineCharacter(opts.seed ?? 1);
  const rival = !!opts.rival;
  const out = gainNode(ctx, 0.0001, dest);

  /* ---- exhaust body: formants then an rpm-tracking lowpass ---- */
  const lowpass2 = filter(ctx, 'lowpass', 1300, 0.6, 0, out);     // 24 dB/oct in total, so idle
  const lowpass = filter(ctx, 'lowpass', 900, 0.9, 0, lowpass2);   // is genuinely dark, not fizzy
  const form2 = filter(ctx, 'peaking', C.res2, C.bodyQ, 3.5, lowpass);
  const form1 = filter(ctx, 'peaking', C.res1, C.bodyQ * 0.8, 4.5, form2);
  const hpf = filter(ctx, 'highpass', 62, 0.7, 0, form1);
  // Level control lives AFTER the saturator: driving a tanh harder does not make it louder,
  // it only makes it fuzzier, so putting the throttle/rpm gain in front would flatten the
  // whole dynamic range of the engine (measured: 4.9x of pre-gain became 1.3x of output).
  const level = gainNode(ctx, 0.0001, hpf);
  const drive = shaper(ctx, rival ? 0.18 : 0.34, level);

  /* ---- core firing loops ---- */
  const cyc = { baseHz: ENGINE_BASE_HZ, cycles: 8, seed: C.seed * 13 + 1, res1: C.res1, res2: C.res2,
    decay1: C.decay1, decay2: C.decay2, pulses: C.pulses, jitter: C.jitter, growl: C.growl };
  const bufLoad = engineCycleBuffer(ctx, cyc);
  const bufOver = engineCycleBuffer(ctx, { ...cyc, overrun: 1, seed: C.seed * 13 + 2, jitter: C.jitter * 1.5 });

  const gLoad = gainNode(ctx, 0.85, drive);
  const gOver = gainNode(ctx, 0.0001, drive);
  const srcLoad = loopSource(ctx, bufLoad, gLoad, { rate: 1 });
  const srcOver = loopSource(ctx, bufOver, gOver, { rate: 1 });

  /* ---- idle lope: slow granular amplitude wobble so idle is never a steady drone ---- */
  const lope = loopSource(ctx, grainBuffer(ctx, { seed: C.seed * 7 + 3, seconds: 1.3, density: 7, sharp: 9, level: 0.5, smooth: 1 }), null, { rate: 1 });
  const lopeAmt = gainNode(ctx, 0.0, null);
  lope.connect(lopeAmt); lopeAmt.connect(level.gain);

  /* ---- intake roar ---- */
  const noise = noiseBuffer(ctx, { seconds: 2.5, seed: 4242, kind: 'white' });
  const gIntake = gainNode(ctx, 0.0001, hpf);
  const bpIntake = filter(ctx, 'bandpass', 300, 1.4, 0, gIntake);
  const srcIntake = loopSource(ctx, noise, bpIntake, { rate: 1 });

  /* ---- chain / gear whine ---- */
  let whine = null, gWhine = null;
  if (!rival) {
    gWhine = gainNode(ctx, 0.0001, hpf);
    const lpW = filter(ctx, 'lowpass', 5200, 0.8, 0, gWhine);
    whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.value = 600;
    whine.connect(lpW);
    try { whine.start(0); } catch (e) { /* */ }
  }

  /* ---- turbo: spool whistle + hiss ---- */
  let turbo = null, gTurbo = null, gTurboHiss = null;
  if (!rival) {
    gTurbo = gainNode(ctx, 0.0001, out);
    turbo = ctx.createOscillator();
    turbo.type = 'sine';
    turbo.frequency.value = C.turboHz;
    const tq = filter(ctx, 'bandpass', C.turboHz, 12, 0, gTurbo);
    turbo.connect(tq);
    const t2 = ctx.createOscillator();
    t2.type = 'sine'; t2.frequency.value = C.turboHz * 1.5;
    const tg2 = gainNode(ctx, 0.35, tq); t2.connect(tg2);
    gTurboHiss = gainNode(ctx, 0.0001, out);
    const bpH = filter(ctx, 'bandpass', C.turboHz * 1.7, 3.5, 0, gTurboHiss);
    loopSource(ctx, noise, bpH, { rate: 1.13 });
    try { turbo.start(0); t2.start(0); } catch (e) { /* */ }
    turbo.__second = t2;
  }

  /* ---- state ---- */
  const S = { rpm: 0, load: 0, throttle: 0, boost: 0, gain: 0, alive: true };
  let lastRate = -1;

  /**
   * @param {number} dt
   * @param {{rpm:number, throttle:number, load?:number, boost?:number, gain?:number,
   *          grounded?:boolean, cut?:number}} p
   * @param {number} now  audio-clock time to schedule against
   */
  function update(dt, p, now) {
    if (!S.alive) return;
    const rpm = clamp(p.rpm ?? 0, 0, 1.1);
    const thr = clamp(p.throttle ?? 0, 0, 1);
    const load = clamp(p.load ?? thr, 0, 1);
    const boost = clamp(p.boost ?? 0, 0, 1);
    const vol = clamp(p.gain ?? 1, 0, 4);
    S.rpm = rpm; S.throttle = thr; S.load = load; S.boost = boost;

    const f = firingHz(rpm) * (1 + C.detune) * (p.cut ? 0.86 : 1) * (p.doppler ?? 1);
    const rate = f / ENGINE_BASE_HZ;
    if (Math.abs(rate - lastRate) > 0.0015) {
      // short glide: engine pitch is continuous, never stepped
      follow(srcLoad.playbackRate, rate, now, 0.035);
      follow(srcOver.playbackRate, rate, now, 0.035);
      lastRate = rate;
    }

    // load vs overrun crossfade — off throttle at revs is where the popping lives
    const over = clamp((1 - thr) * clamp((rpm - 0.18) / 0.5, 0, 1), 0, 1);
    follow(gLoad.gain, 0.85 * (1 - over * 0.7), now, 0.05);
    follow(gOver.gain, over * 0.9, now, 0.06);
    // post-saturator level: a lopey quiet idle, a screaming top end
    const lv = lerp(0.45, 1.0, load) * (1 - over * 0.4) * (0.10 + 0.95 * Math.pow(rpm, 0.85));
    follow(level.gain, lv * vol, now, 0.05);

    // idle lope fades out as revs rise
    follow(lopeAmt.gain, (1 - clamp(rpm / 0.35, 0, 1)) * 0.05 * vol, now, 0.12);

    // brightness: more revs and more load open the exhaust up
    const cutoff = lerp(360, 7600, Math.pow(rpm, 1.05)) * lerp(0.78, 1.18, load) * C.bright;
    follow(lowpass.frequency, clamp(cutoff, 240, 15000), now, 0.05);
    follow(lowpass2.frequency, clamp(cutoff * 1.5, 260, 18000), now, 0.05);
    follow(lowpass.Q, lerp(0.8, 2.2, load * rpm), now, 0.1);

    // intake: bandpass rides the second harmonic of the firing rate
    follow(bpIntake.frequency, clamp(f * 2.2, 60, 9000), now, 0.05);
    follow(bpIntake.Q, lerp(1.1, 3.2, rpm), now, 0.1);
    follow(gIntake.gain, C.intake * (0.10 + 0.9 * thr) * (0.25 + 0.85 * rpm) * 0.55 * vol, now, 0.05);

    if (whine) {
      follow(whine.frequency, clamp(f * C.whineRatio, 60, 12000), now, 0.04);
      follow(gWhine.gain, C.whineGain * (0.3 + 0.7 * load) * clamp(rpm * 1.4, 0, 1) * vol, now, 0.06);
    }
    if (turbo) {
      const spool = clamp(boost, 0, 1);
      const tf = C.turboHz * lerp(0.55, 1.55, spool) * lerp(0.85, 1.15, rpm);
      follow(turbo.frequency, tf, now, 0.08);
      follow(turbo.__second.frequency, tf * 1.5, now, 0.08);
      follow(gTurbo.gain, Math.pow(spool, 1.5) * 0.055 * vol, now, 0.07);
      follow(gTurboHiss.gain, Math.pow(spool, 1.2) * 0.05 * vol, now, 0.07);
    }

    S.gain = vol;
  }

  function setGain(v, now, tau = 0.08) { follow(out.gain, clamp(v, 0, 4), now, tau); }

  function dispose() {
    S.alive = false;
    for (const n of [srcLoad, srcOver, srcIntake, lope, whine, turbo, turbo && turbo.__second]) {
      if (!n) continue;
      try { n.stop(); } catch (e) { /* */ }
      try { n.disconnect(); } catch (e) { /* */ }
    }
    try { out.disconnect(); } catch (e) { /* */ }
  }

  return { out, update, setGain, dispose, character: C, state: S, get output() { return out; } };
}

export default createEngineVoice;
