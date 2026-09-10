/**
 * Kat Racing — trackside ambience emitters.
 *
 * Point sources placed in the world and heard through a PannerNode: the crowd on the start
 * straight, cicadas in the pine and olive rows (the sound of a Ramot Menashe summer), wind in
 * the cypresses, and the irrigation pump in a farmyard. Each is a tiny always-on graph whose
 * gain is driven by distance, so a lap round Amikam moves through a soundscape instead of a
 * flat bed.
 */
import { clamp, lerp, gainNode, filter, noiseBuffer, loopSource, crowdBuffer, grainBuffer, follow } from './dsp.js';

export const EMITTER_KINDS = ['crowd', 'cicadas', 'trees', 'pump', 'goats'];

/** Per-kind loudness trim, so a pump does not shout down the grandstand. */
const TRIM = { crowd: 2.4, cicadas: 1.1, trees: 0.7, pump: 0.85, goats: 1.8 };

export function createEmitter(ctx, dest, kind = 'crowd', opts = {}) {
  const seed = opts.seed ?? 3;
  const trim = TRIM[kind] ?? 1;
  const out = gainNode(ctx, 0.0001, dest);
  const noise = noiseBuffer(ctx, { seconds: 2.5, seed: 7700 + seed, kind: 'white' });
  const nodes = [];
  let range = 90;

  if (kind === 'crowd') {
    const lp = filter(ctx, 'lowpass', 2400, 0.7, 0, out);
    const s = ctx.createBufferSource();
    s.buffer = crowdBuffer(ctx, { seed: 51 + seed, seconds: 4 });
    s.loop = true; s.playbackRate.value = 0.97 + (seed % 5) * 0.01;
    s.connect(lp);
    try { s.start(0); } catch (e) { /* */ }
    nodes.push(s);
    range = 120;
  } else if (kind === 'cicadas') {
    // a cicada is a buzz: narrow band up high, amplitude-modulated fast, with slow swells
    const bp = filter(ctx, 'bandpass', 5200, 3.2, 0, out);
    const am = gainNode(ctx, 0.35, bp);
    loopSource(ctx, noise, am, { rate: 1.07 });
    const modBuf = grainBuffer(ctx, { seed: seed * 13 + 5, seconds: 1.0, density: 46, sharp: 60, level: 0.9 });
    const mod = loopSource(ctx, modBuf, null, { rate: 1.9 });
    const modAmt = gainNode(ctx, 0.9, null);
    mod.connect(modAmt); modAmt.connect(am.gain);
    const swell = ctx.createOscillator(); swell.type = 'sine'; swell.frequency.value = 0.13;
    const swAmt = gainNode(ctx, 900, bp.frequency); swell.connect(swAmt);
    try { swell.start(0); } catch (e) { /* */ }
    nodes.push(mod, swell);
    range = 60;
  } else if (kind === 'trees') {
    const bp = filter(ctx, 'bandpass', 900, 0.5, 0, out);
    loopSource(ctx, noise, bp, { rate: 0.63 });
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.19;
    const amt = gainNode(ctx, 420, bp.frequency); lfo.connect(amt);
    try { lfo.start(0); } catch (e) { /* */ }
    nodes.push(lfo);
    range = 45;
  } else if (kind === 'pump') {
    // an irrigation pump: mains hum plus a lumpy mechanical beat
    const lp = filter(ctx, 'lowpass', 700, 1.1, 0, out);
    for (const [f, g] of [[50, 0.5], [100, 0.25], [150, 0.12], [237, 0.06]]) {
      const gg = gainNode(ctx, g, lp);
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(gg);
      try { o.start(0); } catch (e) { /* */ }
      nodes.push(o);
    }
    const rattle = gainNode(ctx, 0.10, lp);
    const bp = filter(ctx, 'bandpass', 380, 2.4, 0, rattle);
    loopSource(ctx, noise, bp, { rate: 0.8 });
    range = 35;
  } else if (kind === 'goats') {
    // a distant flock: sparse bleats made of a buzzy formant pair
    const lp = filter(ctx, 'lowpass', 2600, 0.8, 0, out);
    const am = gainNode(ctx, 0.0, lp);
    const bp = filter(ctx, 'bandpass', 700, 2.2, 0, am);
    loopSource(ctx, noise, bp, { rate: 0.9 });
    const modBuf = grainBuffer(ctx, { seed: seed * 29 + 3, seconds: 4.0, density: 0.9, sharp: 5, level: 1, smooth: 1 });
    const mod = loopSource(ctx, modBuf, null, { rate: 1 });
    const modAmt = gainNode(ctx, 0.85, null);
    mod.connect(modAmt); modAmt.connect(am.gain);
    const vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 17;
    const vAmt = gainNode(ctx, 90, bp.frequency); vib.connect(vAmt);
    try { vib.start(0); } catch (e) { /* */ }
    nodes.push(mod, vib);
    range = 70;
  }

  return {
    out, kind, range,
    setGain(v, now, tau = 0.35) { follow(out.gain, clamp(v * trim, 0, 4), now, tau); },
    dispose() {
      for (const n of nodes) { try { n.stop(); } catch (e) { /* */ } try { n.disconnect(); } catch (e) { /* */ } }
      try { out.disconnect(); } catch (e) { /* */ }
    },
  };
}

export default createEmitter;
