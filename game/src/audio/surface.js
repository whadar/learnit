/**
 * Kat Racing — tyre / surface voice: rolling noise, granular loose-surface crackle, kerb
 * rattle and drift scrub, all from one shared noise loop plus filters.
 *
 * The vehicle reports which of the collision-world surfaces the tyres are on
 * (see SURFACES in src/physics/collision.js); each has a spectral profile below, and the
 * live values are damped toward the target so driving off tarmac into a wheat field is a
 * smear, not a jump cut.
 */
import {
  clamp, lerp, gainNode, filter, noiseBuffer, loopSource, grainBuffer, clickTrainBuffer, follow,
} from './dsp.js';

/**
 * low / mid / high  — three rolling bands
 * grain             — granular crackle amount (loose stones, stubble)
 * rough             — how much of the crackle is broadband vs pitched
 * bright            — overall spectral tilt
 * rattle            — chassis rattle from surface irregularity
 */
export const SURFACE_TONE = {
  tarmac:     { low: 0.20, mid: 0.34, high: 0.52, grain: 0.00, rough: 0.2, bright: 1.00, rattle: 0.02 },
  asphalt:    { low: 0.20, mid: 0.34, high: 0.52, grain: 0.00, rough: 0.2, bright: 1.00, rattle: 0.02 },
  road:       { low: 0.20, mid: 0.34, high: 0.52, grain: 0.00, rough: 0.2, bright: 1.00, rattle: 0.02 },
  concrete:   { low: 0.24, mid: 0.38, high: 0.46, grain: 0.06, rough: 0.3, bright: 0.95, rattle: 0.06 },
  paved:      { low: 0.26, mid: 0.40, high: 0.44, grain: 0.10, rough: 0.3, bright: 0.92, rattle: 0.10 },
  kerb:       { low: 0.34, mid: 0.52, high: 0.40, grain: 0.30, rough: 0.5, bright: 0.90, rattle: 1.00 },
  curb:       { low: 0.34, mid: 0.52, high: 0.40, grain: 0.30, rough: 0.5, bright: 0.90, rattle: 1.00 },
  rumble:     { low: 0.34, mid: 0.52, high: 0.40, grain: 0.30, rough: 0.5, bright: 0.90, rattle: 1.00 },
  dirt_track: { low: 0.52, mid: 0.50, high: 0.22, grain: 0.55, rough: 0.6, bright: 0.72, rattle: 0.35 },
  dirt:       { low: 0.55, mid: 0.48, high: 0.20, grain: 0.60, rough: 0.6, bright: 0.68, rattle: 0.38 },
  unpaved:    { low: 0.53, mid: 0.49, high: 0.21, grain: 0.58, rough: 0.6, bright: 0.70, rattle: 0.36 },
  gravel:     { low: 0.40, mid: 0.62, high: 0.50, grain: 1.00, rough: 0.9, bright: 0.88, rattle: 0.55 },
  grass:      { low: 0.46, mid: 0.34, high: 0.17, grain: 0.34, rough: 0.35, bright: 0.60, rattle: 0.22 },
  crop:       { low: 0.44, mid: 0.36, high: 0.26, grain: 0.50, rough: 0.45, bright: 0.66, rattle: 0.28 },
  scrub:      { low: 0.44, mid: 0.38, high: 0.28, grain: 0.62, rough: 0.55, bright: 0.70, rattle: 0.34 },
  forest:     { low: 0.48, mid: 0.36, high: 0.20, grain: 0.55, rough: 0.5, bright: 0.62, rattle: 0.34 },
  orchard:    { low: 0.50, mid: 0.42, high: 0.22, grain: 0.58, rough: 0.55, bright: 0.68, rattle: 0.32 },
  soil:       { low: 0.56, mid: 0.44, high: 0.18, grain: 0.50, rough: 0.5, bright: 0.62, rattle: 0.30 },
  farmyard:   { low: 0.48, mid: 0.52, high: 0.30, grain: 0.70, rough: 0.7, bright: 0.78, rattle: 0.45 },
  sand:       { low: 0.50, mid: 0.30, high: 0.40, grain: 0.30, rough: 0.3, bright: 0.74, rattle: 0.16 },
  water:      { low: 0.34, mid: 0.30, high: 0.66, grain: 0.45, rough: 0.4, bright: 0.86, rattle: 0.10 },
};
export const surfaceTone = s => SURFACE_TONE[s] || SURFACE_TONE.dirt;

const REF_SPEED = 26;      // m/s that counts as "flat out" for the rolling curve

export function createSurfaceVoice(ctx, dest, opts = {}) {
  const seed = opts.seed ?? 17;
  const rival = !!opts.rival;
  const out = gainNode(ctx, 1, dest);
  // tyre noise rolls off above a few kHz; without this the bands read as white hiss
  const tame = filter(ctx, 'lowpass', 5800, 0.6, 0, out);
  const noise = noiseBuffer(ctx, { seconds: 2.5, seed: 9001, kind: 'white' });

  /* ---- three rolling bands off one noise loop ---- */
  const gLow = gainNode(ctx, 0.0001, tame);
  const fLow = filter(ctx, 'lowpass', 240, 1.1, 0, gLow);
  const gMid = gainNode(ctx, 0.0001, tame);
  const fMid = filter(ctx, 'bandpass', 800, 0.85, 0, gMid);
  const gHigh = gainNode(ctx, 0.0001, tame);
  const fHigh = filter(ctx, 'bandpass', 3000, 0.55, 0, gHigh);
  const src = loopSource(ctx, noise, null, { rate: 1 });
  src.connect(fLow); src.connect(fMid); src.connect(fHigh);

  /* ---- granular crackle: stones and stubble, rate follows speed ---- */
  const gGrain = gainNode(ctx, 0.0001, tame);
  const fGrain = filter(ctx, 'bandpass', 1700, 1.0, 0, gGrain);
  const grainSrc = loopSource(ctx, noise, null, { rate: 1.31 });
  const grainAM = gainNode(ctx, 0.0, fGrain);
  grainSrc.connect(grainAM);
  const grainMod = loopSource(ctx, grainBuffer(ctx, { seed: seed * 3 + 1, seconds: 1.0, density: 90, sharp: 40, level: 1 }), null, { rate: 1 });
  const grainModAmt = gainNode(ctx, 0.0, null);
  grainMod.connect(grainModAmt); grainModAmt.connect(grainAM.gain);

  /* ---- kerb / cattle-grid rattle: a click train whose rate is the strip crossing rate ---- */
  const gRattle = gainNode(ctx, 0.0001, tame);
  const fRattle = filter(ctx, 'bandpass', 1500, 0.7, 0, gRattle);
  const rattleSrc = loopSource(ctx, clickTrainBuffer(ctx, { seed: seed * 5 + 2, seconds: 1, clicks: 24, tone: 1900, decay: 190 }), fRattle, { rate: 1 });
  const gThump = gainNode(ctx, 0.0001, tame);       // the low body knock that goes with it
  const fThump = filter(ctx, 'lowpass', 260, 1.2, 0, gThump);
  rattleSrc.connect(fThump);

  /* ---- drift scrub + squeal ---- */
  const gScrub = gainNode(ctx, 0.0001, tame);
  const fScrub = filter(ctx, 'bandpass', 1500, 4.5, 0, gScrub);
  const scrubSrc = loopSource(ctx, noise, fScrub, { rate: 0.87 });
  let squealA = null, squealB = null, gSqueal = null, vib = null;
  if (!rival) {
    gSqueal = gainNode(ctx, 0.0001, tame);
    const fSq = filter(ctx, 'bandpass', 1300, 3.0, 0, gSqueal);
    squealA = ctx.createOscillator(); squealA.type = 'sine'; squealA.frequency.value = 1080;
    squealB = ctx.createOscillator(); squealB.type = 'sine'; squealB.frequency.value = 1620;
    const gB = gainNode(ctx, 0.45, fSq);
    squealA.connect(fSq); squealB.connect(gB);
    vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 17;
    const vibAmt = gainNode(ctx, 26, null);
    vib.connect(vibAmt); vibAmt.connect(squealA.frequency); vibAmt.connect(squealB.frequency);
    try { squealA.start(0); squealB.start(0); vib.start(0); } catch (e) { /* */ }
  }

  /* ---- wind over an open kart: rises with speed, thickens in a slipstream ---- */
  const gWind = gainNode(ctx, 0.0001, out);
  const fWind = filter(ctx, 'bandpass', 620, 0.55, 0, gWind);
  loopSource(ctx, noise, fWind, { rate: 0.73 });

  /* ---- mini-turbo charge: a spark whine that climbs through the three tiers ---- */
  let gCharge = null, chargeOsc = null, chargeNoise = null, gChargeNz = null;
  if (!rival) {
    gCharge = gainNode(ctx, 0.0001, out);
    const fC = filter(ctx, 'bandpass', 1800, 6, 0, gCharge);
    chargeOsc = ctx.createOscillator(); chargeOsc.type = 'sawtooth'; chargeOsc.frequency.value = 320;
    chargeOsc.connect(fC);
    gChargeNz = gainNode(ctx, 0.0001, out);
    chargeNoise = filter(ctx, 'bandpass', 5200, 4, 0, gChargeNz);
    loopSource(ctx, noise, chargeNoise, { rate: 1.7 });
    try { chargeOsc.start(0); } catch (e) { /* */ }
  }

  /* ---- damped current tone, so surface changes crossfade ---- */
  const cur = { ...surfaceTone('tarmac') };
  const S = { speed: 0, surface: 'tarmac', slip: 0, kerb: 0, alive: true };

  function update(dt, p, now) {
    if (!S.alive) return;
    const speed = Math.max(0, p.speed ?? 0);
    const grounded = p.grounded !== false;
    const tgt = surfaceTone(p.surface || 'tarmac');
    const k = 1 - Math.exp(-clamp(dt, 0, 0.1) * 4.5);
    for (const key of ['low', 'mid', 'high', 'grain', 'rough', 'bright', 'rattle']) {
      cur[key] = lerp(cur[key], tgt[key], k);
    }
    S.speed = speed; S.surface = p.surface || 'tarmac';

    const v = clamp(speed / REF_SPEED, 0, 1.25);
    const roll = Math.pow(v, 0.62) * (grounded ? 1 : 0.06) * clamp(p.gain ?? 1, 0, 4);
    const tilt = lerp(0.55, 1.25, v) * cur.bright;

    follow(gLow.gain,  cur.low  * roll * 0.55, now, 0.05);
    follow(gMid.gain,  cur.mid  * roll * 0.30, now, 0.05);
    follow(gHigh.gain, cur.high * roll * 0.34, now, 0.05);
    follow(fLow.frequency,  clamp(150 + 260 * v, 80, 900), now, 0.08);
    follow(fMid.frequency,  clamp(430 * tilt + 260 * v, 160, 3500), now, 0.08);
    follow(fHigh.frequency, clamp(1750 * tilt, 700, 5200), now, 0.08);

    // crackle: louder and faster with speed, only on loose ground
    follow(grainModAmt.gain, cur.grain * 1.5, now, 0.06);
    follow(gGrain.gain, cur.grain * roll * 0.42, now, 0.05);
    follow(fGrain.frequency, clamp(1200 + 2100 * cur.rough * tilt, 300, 9000), now, 0.08);
    follow(grainMod.playbackRate, clamp(0.35 + v * 2.6, 0.2, 4), now, 0.06);

    // kerb rattle: crossing rate ~ speed / strip pitch (0.5 m), gated by the kerb flag
    const kerb = clamp(p.kerb ?? (S.surface === 'kerb' || S.surface === 'rumble' ? 1 : 0), 0, 1);
    S.kerb = kerb;
    const rattleAmt = clamp(kerb * 0.9 + cur.rattle * 0.35, 0, 1.2) * roll;
    follow(rattleSrc.playbackRate, clamp(0.25 + speed / 12, 0.2, 4.2), now, 0.05);
    follow(gRattle.gain, rattleAmt * 0.62, now, 0.04);
    follow(gThump.gain, rattleAmt * 0.85, now, 0.04);

    // scrub: follows slip angle, gets brighter and squealier the harder the tyre is worked
    const slip = clamp(p.slip ?? 0, 0, 1.4);
    S.slip = slip;
    const scrub = Math.pow(slip, 1.15) * clamp(speed / 8, 0, 1) * (grounded ? 1 : 0);
    const loose = clamp(cur.grain, 0, 1);
    follow(gScrub.gain, scrub * 0.5 * lerp(1, 0.65, loose), now, 0.035);
    follow(fScrub.frequency, clamp(1150 + 900 * slip + 260 * v, 400, 6000), now, 0.05);
    follow(fScrub.Q, lerp(2.2, 6.5, clamp(slip, 0, 1)) * lerp(1, 0.45, loose), now, 0.08);
    // wind: quadratic in speed, and a slipstream sits you in someone else's dirty air
    const draft = clamp(p.draft ?? 0, 0, 1);
    const windAmt = Math.pow(clamp(speed / 30, 0, 1.2), 1.9) * (0.6 + 0.7 * draft);
    follow(gWind.gain, windAmt * 0.16, now, 0.08);
    follow(fWind.frequency, clamp(420 + speed * 26 + draft * 300, 200, 4000), now, 0.1);

    // brake squeal on top of the scrub
    const brake = clamp(p.brake ?? 0, 0, 1) * clamp(speed / 6, 0, 1);

    if (gCharge) {
      // charge whine: pitch climbs through the tiers, sparks hiss louder each step
      const charge = clamp(p.charge ?? 0, 0, 1);
      const tier = clamp(p.tier ?? 0, 0, 3);
      const on = charge > 0.001 ? 1 : 0;
      follow(chargeOsc.frequency, 260 + 520 * charge + tier * 150, now, 0.06);
      follow(gCharge.gain, on * (0.012 + 0.030 * charge) , now, 0.05);
      follow(gChargeNz.gain, on * (0.010 + 0.045 * charge + tier * 0.012), now, 0.05);
      follow(chargeNoise.frequency, clamp(3600 + 2600 * charge, 1500, 11000), now, 0.08);
    }

    if (gSqueal) {
      // tarmac squeals; a field just hisses
      const squeal = (Math.pow(clamp(slip, 0, 1), 2.2) + brake * 0.55) * clamp(speed / 12, 0, 1) * lerp(1, 0.12, loose);
      follow(gSqueal.gain, squeal * 0.055, now, 0.05);
      follow(squealA.frequency, clamp(940 + 420 * slip + 8 * speed, 500, 3000), now, 0.06);
      follow(squealB.frequency, clamp((940 + 420 * slip + 8 * speed) * 1.5, 600, 4500), now, 0.06);
    }
  }

  function dispose() {
    S.alive = false;
    for (const n of [src, grainSrc, grainMod, rattleSrc, scrubSrc, squealA, squealB, vib, chargeOsc]) {
      if (!n) continue;
      try { n.stop(); } catch (e) { /* */ }
      try { n.disconnect(); } catch (e) { /* */ }
    }
    try { out.disconnect(); } catch (e) { /* */ }
  }

  return { out, update, dispose, state: S };
}

export default createSurfaceVoice;
