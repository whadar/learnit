/**
 * Engine, tyres and cues — synthesised, no samples.
 *
 * The engine is a sawtooth pair whose pitch tracks the firing rate, shaped by a FIXED formant
 * filter. Fixed matters: the last build baked the body resonance into a buffer it then played
 * back at up to 3.9x, so the resonance rode the pitch and the engine climbed into a mosquito
 * instead of opening up. A body resonance is a length of metal; it does not move.
 *
 * The master bus starts near silence and ramps once the context is actually running. A gain of 1
 * at construction means every voice arrives at full level the frame the browser resumes audio,
 * which is a bang in the player's ears.
 */
import { clamp, clamp01, lerp } from '../core/math.js';

export function createAudio(opts = {}) {
  const enabled = opts.enabled !== false && typeof AudioContext !== 'undefined';
  if (!enabled) return { update() {}, cue() {}, resume() {}, dispose() {}, enabled: false };

  let ctx = null, master = null, eng = null, tyre = null, ready = false;

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.0001;                    // silent until the context is really running
    master.connect(ctx.destination);

    // engine: two saws a fifth apart through a fixed formant, plus a low body sine
    const bus = ctx.createGain(); bus.gain.value = 0.32; bus.connect(master);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.8;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 180; body.Q.value = 1.1; body.gain.value = 8;
    const horn = ctx.createBiquadFilter(); horn.type = 'peaking'; horn.frequency.value = 620; horn.Q.value = 1.6; horn.gain.value = 5;
    lp.connect(body); body.connect(horn); horn.connect(bus);
    const a = ctx.createOscillator(), b = ctx.createOscillator();
    a.type = b.type = 'sawtooth'; a.frequency.value = 60; b.frequency.value = 90;
    const ga = ctx.createGain(); ga.gain.value = 0.7;
    const gb = ctx.createGain(); gb.gain.value = 0.3;
    a.connect(ga); b.connect(gb); ga.connect(lp); gb.connect(lp);
    a.start(); b.start();
    eng = { a, b, lp, bus };

    // tyres: filtered noise, opened by slip
    const n = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 1;
    for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 1073741823 - 1) * 0.6; }
    n.buffer = buf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
    const tg = ctx.createGain(); tg.gain.value = 0;
    n.connect(bp); bp.connect(tg); tg.connect(master);
    n.start();
    tyre = { g: tg, f: bp };
  }

  function resume() {
    init();
    if (ctx.state !== 'running') ctx.resume().then(raise).catch(() => {});
    else raise();
  }
  function raise() {
    if (ready || !ctx || ctx.state !== 'running') return;
    ready = true;
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(opts.volume ?? 0.55, ctx.currentTime + 0.7);
  }

  function update(dt, s, phase) {
    if (!ctx || ctx.state !== 'running') return;
    raise();
    const rpm = clamp01(Math.max(s.speed / 26, s.throttle * 0.35));
    const hz = lerp(46, 190, Math.pow(rpm, 0.86));
    const t = ctx.currentTime;
    eng.a.frequency.setTargetAtTime(hz, t, 0.05);
    eng.b.frequency.setTargetAtTime(hz * 1.5, t, 0.05);
    eng.lp.frequency.setTargetAtTime(lerp(420, 3600, Math.pow(rpm, 1.05)), t, 0.06);
    eng.bus.gain.setTargetAtTime(phase === 'racing' || phase === 'countdown' ? lerp(0.16, 0.4, rpm) : 0.06, t, 0.1);
    tyre.g.gain.setTargetAtTime(clamp(s.skid * 0.16 + (s.onTrack ? 0 : 0.05), 0, 0.24), t, 0.05);
    tyre.f.frequency.setTargetAtTime(lerp(1200, 2600, clamp01(s.speed / 26)), t, 0.08);
    void dt;
  }

  /** Short blips for the lights and the flag. */
  function cue(kind) {
    if (!kind || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = kind === 'go' ? 880 : 440;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'go' ? 0.5 : 0.16));
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.6);
  }

  return { update, cue, resume, enabled: true,
    dispose() { try { ctx?.close(); } catch { /* already gone */ } } };
}
