// Audio engine: wavetable preset library, per-string voices, FX chain
// (drive -> tone -> delay -> reverb sends), velocity curves, real-input
// capture, metronome, and audio recording.
//
// Voices keyed by an opaque id: 's<n>' per string in multi-channel mode,
// 'n<midi>' per note in single-channel mode. Each voice is one or two
// detuned OscillatorNodes driven by a PeriodicWave.

const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

// Harmonic table builders. Each returns {real, imag} Fourier arrays for
// createPeriodicWave. `decay` is the 1/n exponent; `oddOnly` kills even
// harmonics; `partials` is a drawbar-style {harmonic: gain} override.
export function spectrum({ decay = 1.2, harmonics = 40, oddOnly = false,
                           pluckAt = 0, partials = null }) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    let amp;
    if (partials) amp = partials[n] || 0;
    else {
      amp = Math.pow(1 / n, decay);
      if (oddOnly && n % 2 === 0) amp = 0;
      if (pluckAt) amp *= Math.abs(Math.sin(Math.PI * n * pluckAt));
    }
    imag[n] = amp;
  }
  return { real, imag };
}

// Preset library. env: {a attack s, sus sustain fraction, dtc decay
// time-const s, rel release s}. double: second osc detuned by N cents.
// transpose: octave/semitone shift applied at noteOn (e.g. bass -12).
export const PRESETS = {
  // guitars
  'steel string':   { cat: 'guitar', wave: o => spectrum({ decay: 1.2, pluckAt: 1 / 7, ...o }), env: { a: 0.004, sus: 0.35, dtc: 0.9, rel: 0.12 } },
  'nylon':          { cat: 'guitar', wave: o => spectrum({ decay: 2.1, harmonics: 24, pluckAt: 1 / 5, ...o }), env: { a: 0.008, sus: 0.3, dtc: 0.8, rel: 0.15 } },
  'electric clean': { cat: 'guitar', wave: o => spectrum({ decay: 0.85, harmonics: 32, ...o }), env: { a: 0.003, sus: 0.5, dtc: 1.4, rel: 0.1 } },
  '12-string':      { cat: 'guitar', wave: o => spectrum({ decay: 1.1, pluckAt: 1 / 7, ...o }), double: 7, env: { a: 0.004, sus: 0.4, dtc: 1.0, rel: 0.14 } },
  // bass
  'electric bass':  { cat: 'bass', wave: o => spectrum({ decay: 2.4, harmonics: 20, ...o }), transpose: -12, env: { a: 0.006, sus: 0.55, dtc: 1.1, rel: 0.1 } },
  'synth bass':     { cat: 'bass', wave: o => spectrum({ decay: 0.9, oddOnly: true, harmonics: 18, ...o }), transpose: -12, env: { a: 0.004, sus: 0.7, dtc: 1.5, rel: 0.09 } },
  // keys
  'piano-ish':      { cat: 'keys', wave: o => spectrum({ decay: 1.5, pluckAt: 1 / 8, ...o }), env: { a: 0.002, sus: 0.25, dtc: 1.6, rel: 0.2 } },
  'drawbar organ':  { cat: 'keys', wave: o => spectrum({ harmonics: 16, partials: { 1: 1, 2: 0.7, 3: 0.55, 4: 0.5, 5: 0.4, 6: 0.35, 8: 0.3 }, ...o }), env: { a: 0.01, sus: 0.95, dtc: 4, rel: 0.08 } },
  'vibe':           { cat: 'keys', wave: o => spectrum({ harmonics: 16, partials: { 1: 1, 2: 0.25, 3: 0.05, 4: 0.18 }, ...o }), env: { a: 0.002, sus: 0.15, dtc: 1.8, rel: 0.3 } },
  // synth
  'saw lead':       { cat: 'synth', wave: o => spectrum({ decay: 1.0, ...o }), env: { a: 0.006, sus: 0.8, dtc: 2.5, rel: 0.12 } },
  'square lead':    { cat: 'synth', wave: o => spectrum({ decay: 1.0, oddOnly: true, ...o }), env: { a: 0.006, sus: 0.75, dtc: 2.2, rel: 0.12 } },
  'soft pad':       { cat: 'synth', wave: o => spectrum({ decay: 1.6, harmonics: 16, ...o }), double: 9, env: { a: 0.35, sus: 0.85, dtc: 3, rel: 0.6 } },
  'brass pad':      { cat: 'synth', wave: o => spectrum({ decay: 0.9, harmonics: 24, ...o }), env: { a: 0.12, sus: 0.7, dtc: 2.8, rel: 0.25 } },
  'flute-ish':      { cat: 'synth', wave: o => spectrum({ harmonics: 8, partials: { 1: 1, 2: 0.12, 3: 0.05 }, ...o }), env: { a: 0.06, sus: 0.8, dtc: 2.5, rel: 0.2 } },
};
export const PRESET_CATS = ['guitar', 'bass', 'keys', 'synth'];

// Velocity response curves: input 0..127 -> gain multiplier.
export const VELOCITY_CURVES = {
  linear: v => v / 127,
  soft:   v => Math.pow(v / 127, 0.65),
  hard:   v => Math.pow(v / 127, 1.5),
};

// Reconstruct one period of a PeriodicWave — the wavetable viz draws this.
export function waveFrame(real, imag, n = 256) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    let v = 0;
    for (let k = 1; k < real.length; k++) v += real[k] * Math.cos(k * t) + imag[k] * Math.sin(k * t);
    out[i] = v;
  }
  const peak = Math.max(...out.map(Math.abs)) || 1;
  return out.map(x => x / peak);
}

export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.voices = new Map(); // key -> {oscs[], gain, midi, str, preset}
    this.stringGain = 0.28;
    this.curveName = 'linear';
    this.masterLevel = 0.8;
    this.defaultPreset = 'steel string';
    this.presetByString = {}; // string -> preset name override
    this.waveCache = new Map();
    this.fx = { drive: 0, tone: 12000, delay: 0, reverb: 0 };
  }

  presetFor(str) {
    return PRESETS[this.presetByString[str] || this.defaultPreset];
  }

  presetName(str) {
    return this.presetByString[str] || this.defaultPreset;
  }

  setPreset(name, strings = null) {
    if (!PRESETS[name]) return;
    if (!strings) for (let s = 1; s <= 6; s++) this.presetByString[s] = name;
    else for (const s of strings) this.presetByString[s] = name;
  }

  wave(name) {
    if (!this.waveCache.has(name)) {
      const { real, imag } = PRESETS[name].wave({});
      this.waveCache.set(name, this.ctx.createPeriodicWave(real, imag));
    }
    return this.waveCache.get(name);
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterLevel;

      // FX chain: master -> shaper -> tone -> dry+wet(delay,reverb) -> analyser -> out
      this.shaper = this.ctx.createWaveShaper();
      this.shaperGain = this.ctx.createGain();
      this.toneLP = this.ctx.createBiquadFilter();
      this.toneLP.type = 'lowpass';
      this.toneLP.frequency.value = this.fx.tone;
      this.delay = this.ctx.createDelay(1);
      this.delay.delayTime.value = 0.32;
      this.delayFb = this.ctx.createGain();
      this.delayFb.gain.value = 0.3;
      this.delayWet = this.ctx.createGain();
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(1.9, 2.8);
      this.verbWet = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0.7;
      this.recTap = this.ctx.createMediaStreamDestination();

      this.master.connect(this.shaperGain).connect(this.shaper).connect(this.toneLP);
      this.toneLP.connect(this.analyser);
      this.toneLP.connect(this.delay);
      this.delay.connect(this.delayFb).connect(this.delay);
      this.delay.connect(this.delayWet).connect(this.analyser);
      this.toneLP.connect(this.reverb);
      this.reverb.connect(this.verbWet).connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.analyser.connect(this.recTap);
      this.applyFX();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // drive 0..1 (tanh-ish curve), tone Hz, delay/reverb wet 0..1
  applyFX() {
    const k = this.fx.drive * 40;
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh((1 + k) * x) / Math.tanh(1 + k);
    }
    this.shaper.curve = curve;
    this.shaperGain.gain.value = 1 + this.fx.drive * 1.5;
    this.toneLP.frequency.value = this.fx.tone;
    this.delayWet.gain.value = this.fx.delay * 0.5;
    this.verbWet.gain.value = this.fx.reverb * 0.6;
  }

  makeImpulse(sec, decay) {
    const rate = this.ctx.sampleRate, len = rate * sec;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  noteOn(key, midi, vel = 100, str = null) {
    if (!this.ensure()) return;
    this.noteOff(key, null, 0.03);
    const preset = this.presetFor(str);
    const name = this.presetName(str);
    const pMidi = midi + (preset.transpose || 0);
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    const curve = VELOCITY_CURVES[this.curveName] || VELOCITY_CURVES.linear;
    const peak = curve(vel) * this.stringGain;

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + preset.env.a);
    g.gain.setTargetAtTime(Math.max(peak * preset.env.sus, 0.0001), t + preset.env.a + 0.01, preset.env.dtc);

    const oscs = [];
    const mk = detune => {
      const o = this.ctx.createOscillator();
      o.setPeriodicWave(this.wave(name));
      o.frequency.value = midiToFreq(pMidi);
      if (detune) o.detune.value = detune;
      o.connect(g);
      o.start(t);
      oscs.push(o);
      return o;
    };
    mk(0);
    if (preset.double) { mk(preset.double); mk(-preset.double); }
    // Second stage so incoming expression (CC11 string decay) can scale
    // the voice without fighting the envelope ramps on g.
    const eg = this.ctx.createGain();
    eg.gain.value = 1;
    g.connect(eg);
    eg.connect(this.master);
    this.voices.set(key, { oscs, gain: g, expr: eg, midi, pMidi, str, preset: name, peak, born: Date.now() });
  }

  noteOff(key, midi = null, release = null) {
    const v = this.voices.get(key);
    if (!v) return;
    if (midi !== null && v.midi !== midi) return; // stale off
    const rel = release ?? PRESETS[v.preset].env.rel;
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, rel / 3);
    // Expression stage releases with the voice so a leftover CC11 value
    // cannot hold an audible residue.
    v.expr.gain.cancelScheduledValues(t);
    v.expr.gain.setTargetAtTime(0.0001, t, rel / 3);
    for (const o of v.oscs) o.stop(t + rel * 4);
    this.voices.delete(key);
  }

  setExpression(key, v) {
    if (!Number.isFinite(v)) return;
    const n = this.voices.get(key);
    if (!n) return;
    n.expr.gain.setTargetAtTime(Math.max(v, 0.0001), this.ctx.currentTime, 0.04);
  }

  bend(key, semis) {
    if (!Number.isFinite(semis)) return;
    const v = this.voices.get(key);
    if (!v) return;
    for (const o of v.oscs) o.detune.setTargetAtTime(semis * 100, this.ctx.currentTime, 0.01);
  }

  bendAll(semis) { for (const key of this.voices.keys()) this.bend(key, semis); }
  allOff() { for (const s of [...this.voices.keys()]) this.noteOff(s, null, 0.05); }

  // Voice watchdog: every legitimately-ringing voice is either a held
  // note (key present in `alive`) or a short playback note whose
  // scheduled off is < ~6s out. Anything else is orphaned — a dropped
  // note-off, a stale-off rejection, a mode edge — and rings at
  // sustain level forever. Cull orphans past the grace period.
  cullOrphans(alive, graceMs = 8000) {
    const now = Date.now(), culled = [];
    for (const [key, v] of this.voices) {
      if (!alive.has(key) && now - v.born > graceMs) {
        this.noteOff(key, null, 0.4);
        culled.push(key);
      }
    }
    return culled;
  }
}

// Real guitar audio in (Jamstik analog/USB out -> interface). Visualized
// alongside the synth; never routed to speakers (feedback risk).
export class RealInput {
  constructor() { this.stream = null; this.analyser = null; }

  async start(ctx) {
    if (this.stream) return true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.7;
    src.connect(this.analyser);
    return true;
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.analyser = null;
  }
}

// MediaRecorder on the synth's master tap -> .webm download.
export class SessionRecorder {
  constructor(engine) { this.e = engine; this.rec = null; this.chunks = []; }
  get running() { return !!this.rec; }

  start() {
    this.e.ensure();
    this.chunks = [];
    this.rec = new MediaRecorder(this.e.recTap.stream);
    this.rec.ondataavailable = e => this.chunks.push(e.data);
    this.rec.start(500);
  }

  stop() {
    return new Promise(res => {
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.rec.mimeType });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `jamstik-session-${Date.now()}.webm`;
        a.click();
        this.rec = null;
        res();
      };
      this.rec.stop();
    });
  }
}

// Lookahead metronome: schedules clicks ahead of real time.
export class Metronome {
  constructor(ctx) {
    this.ctx = ctx;
    this.bpm = 80;
    this.running = false;
    this.onTick = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.beat = 0;
    this.nextT = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this.pump(), 25);
  }
  pump() {
    while (this.nextT < this.ctx.currentTime + 0.15) {
      this.click(this.nextT, this.beat % 4 === 0);
      const t = this.nextT, b = this.beat;
      setTimeout(() => this.onTick?.(b, t), Math.max(0, (t - this.ctx.currentTime) * 1000));
      this.nextT += 60 / this.bpm;
      this.beat++;
    }
  }
  click(t, strong) {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = strong ? 1320 : 880;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.setTargetAtTime(0.0001, t, 0.015);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }
  stop() { this.running = false; clearInterval(this.timer); }
}
