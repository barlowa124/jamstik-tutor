// Audio engine: wavetable synth for MIDI notes, real-input capture path,
// shared analysers for the visualizations, and a metronome.
//
// Synth design: one monophonic voice per string. Each voice is an
// OscillatorNode driven by a PeriodicWave whose harmonics approximate a
// plucked string (1/n decay, brightness scaled by velocity). Pitch bend
// maps to detune cents so Jamstik bends/slides track audibly.

const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

// Harmonic spectrum of a plucked string. `brightness` in (0,1] sets how
// fast harmonics decay; pluck position ~1/7 carves the 7th-harmonic null
// heard in real plucks.
export function pluckSpectrum(brightness = 0.6, harmonics = 40) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const pluckAt = 1 / 7;
  for (let n = 1; n <= harmonics; n++) {
    const envelope = Math.pow(1 / n, 1.2 + (1 - brightness) * 1.6);
    const pluckNull = Math.abs(Math.sin(Math.PI * n * pluckAt));
    imag[n] = envelope * pluckNull;
  }
  return { real, imag };
}

// Reconstruct one period of a PeriodicWave from its Fourier coefficients —
// this is what the wavetable visualization draws.
export function waveFrame(real, imag, n = 256) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    let v = 0;
    for (let k = 1; k < real.length; k++) {
      v += real[k] * Math.cos(k * t) + imag[k] * Math.sin(k * t);
    }
    out[i] = v;
  }
  const peak = Math.max(...out.map(Math.abs)) || 1;
  return out.map(x => x / peak);
}

export class SynthEngine {
  constructor() {
    this.ctx = null;
    // Voices keyed by an opaque id: 's<n>' per string in multi-channel
    // mode (monophonic per string, like a real guitar), 'n<midi>' per
    // note in single-channel mode (polyphonic, since the device does
    // not tell us which string sounded).
    this.voices = new Map();
    this.stringGain = 0.28;
    this.waves = null;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.7;
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.waves = {
        bright: this.ctx.createPeriodicWave(...Object.values(pluckSpectrum(0.9))),
        mid:    this.ctx.createPeriodicWave(...Object.values(pluckSpectrum(0.6))),
        mellow: this.ctx.createPeriodicWave(...Object.values(pluckSpectrum(0.3))),
      };
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  waveFor(vel) {
    return vel > 96 ? this.waves.bright : vel > 56 ? this.waves.mid : this.waves.mellow;
  }

  noteOn(key, midi, vel = 100) {
    if (!this.ensure()) return;
    this.noteOff(key, null, 0.03); // retrigger: release the old voice
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.waveFor(vel));
    osc.frequency.value = midiToFreq(midi);
    const g = this.ctx.createGain();
    const peak = (vel / 127) * this.stringGain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(peak * 0.55, t + 0.02, 0.9); // long pluck tail
    osc.connect(g).connect(this.master);
    osc.start(t);
    this.voices.set(key, { osc, gain: g, midi });
  }

  noteOff(key, midi = null, release = 0.12) {
    const v = this.voices.get(key);
    if (!v) return;
    if (midi !== null && v.midi !== midi) return; // stale off
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, release / 3);
    v.osc.stop(t + release * 4);
    this.voices.delete(key);
  }

  bend(key, semis) {
    const v = this.voices.get(key);
    if (!v) return;
    v.osc.detune.setTargetAtTime(semis * 100, this.ctx.currentTime, 0.01);
  }

  bendAll(semis) {
    for (const key of this.voices.keys()) this.bend(key, semis);
  }

  allOff() { for (const s of [...this.voices.keys()]) this.noteOff(s, null, 0.05); }
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
    this.analyser.fftSize = 2048;
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

// Lookahead metronome: schedules clicks ahead of real time so beats stay
// rock-steady regardless of the rAF cadence.
export class Metronome {
  constructor(ctx) {
    this.ctx = ctx;
    this.bpm = 80;
    this.running = false;
    this.onTick = null; // (beatIndex, tickTime) -> visual flash
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
      const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => this.onTick?.(b, t), delay);
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

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }
}
