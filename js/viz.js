// Visualization canvases: oscilloscope, spectrum bars, scrolling
// spectrogram, and the wavetable frame display.

import { waveFrame, PRESETS } from './audio.js';
import { midiName } from './theory.js';

function prep(canvas) {
  const g = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== r.width * dpr || canvas.height !== r.height * dpr) {
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

// Time-domain trace. `sources` = [{analyser, color, label}]
export function drawScope(canvas, sources) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const buf = new Float32Array(2048);
  for (const src of sources) {
    if (!src.analyser) continue;
    src.analyser.getFloatTimeDomainData(buf);
    g.beginPath();
    g.strokeStyle = src.color;
    g.lineWidth = 1.4;
    for (let i = 0; i < buf.length; i++) {
      const x = (i / buf.length) * w;
      const y = h / 2 + buf[i] * h * 0.45;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = src.color;
    g.font = '10px ui-monospace, monospace';
    g.fillText(src.label, 8 + sources.indexOf(src) * 60, 14);
  }
}

// Analysis helpers: reused FFT buffers, log-frequency mapping, and a
// parabolic-interpolated dominant-peak estimator. Display band is the
// guitar range, roughly E2 fundamentals to ~4kHz harmonics.
const FMIN = 60, FMAX = 4000;
const _fb = new Map(), _tb = new Map();

function freqBuf(an) {
  let b = _fb.get(an);
  if (!b || b.length !== an.frequencyBinCount) {
    b = new Float32Array(an.frequencyBinCount);
    _fb.set(an, b);
  }
  an.getFloatFrequencyData(b);
  return b;
}

function timeBuf(an) {
  let b = _tb.get(an);
  if (!b || b.length !== an.fftSize) {
    b = new Float32Array(an.fftSize);
    _tb.set(an, b);
  }
  an.getFloatTimeDomainData(b);
  return b;
}

// Dominant spectral peak in the display band, refined by parabolic
// interpolation between bins so cents are meaningful at low pitch.
function domPeak(an, sr) {
  const b = freqBuf(an), hz = sr / an.fftSize;
  const lo = Math.max(1, Math.floor(FMIN / hz));
  const hiB = Math.min(b.length - 2, Math.ceil(FMAX / hz));
  let bi = lo, bv = b[lo];
  for (let i = lo + 1; i <= hiB; i++) if (b[i] > bv) { bv = b[i]; bi = i; }
  const l = b[bi - 1], c = b[bi], r = b[bi + 1];
  const shift = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / ((l - 2 * c + r) || 1e-9)));
  const f = (bi + shift) * hz;
  return { f, db: c };
}

// Autocorrelation f0: normalized ACF over a 4x-downsampled time buffer.
// Catches the spectral peak's failure mode (locking onto a loud
// harmonic instead of the fundamental) — a periodic signal correlates
// at its true period no matter which partial is loudest.
const ACF_DS = 4;
const ACF_MIN_HZ = 60, ACF_MAX_HZ = 1400;
const _ds = new Float32Array(4096);

function acfPitch(an, sr) {
  const t = timeBuf(an);
  const n = Math.min(_ds.length, t.length / ACF_DS) | 0;
  const sre = sr / ACF_DS;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const k = i * ACF_DS;
    const v = (t[k] + t[k + 1] + t[k + 2] + t[k + 3]) / ACF_DS;
    _ds[i] = v; e += v * v;
  }
  const r0 = e / n;
  if (r0 < 1e-8) return { f: 0, conf: 0 };
  const lagLo = Math.max(2, Math.floor(sre / ACF_MAX_HZ));
  const lagHi = Math.min(n >> 1, Math.floor(sre / ACF_MIN_HZ));
  const vals = new Float32Array(lagHi + 1);
  let bv = -1;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    let s = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) s += _ds[i] * _ds[i + lag];
    const v = s / m / r0;
    vals[lag] = v;
    if (v > bv) bv = v;
  }
  // A periodic signal also correlates at 2x, 3x... its period, so the
  // global argmax tends to land an octave down. Take the smallest lag
  // that nearly matches the max instead.
  let bl = 0;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    if (vals[lag] > Math.max(0.5, 0.85 * bv)) { bl = lag; break; }
  }
  if (bl <= 0) return { f: 0, conf: 0 };
  // parabolic refinement on the correlation peak
  const ac = l => { let s = 0; const m = n - l; for (let i = 0; i < m; i++) s += _ds[i] * _ds[i + l]; return s / m / r0; };
  const l = ac(bl - 1), c = vals[bl], r = ac(bl + 1);
  const shift = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / ((l - 2 * c + r) || 1e-9)));
  return { f: sre / (bl + shift), conf: vals[bl] };
}

const ACF_CONF = 0.45; // below this the ACF estimate is noise

// Best f0 for display: ACF wins when it is confident and disagrees with
// the spectral peak by more than a semitone (harmonic lock), else the
// higher-resolution spectral estimate stays.
export function bestF0(src, sr) {
  const sp = domPeak(src.analyser, sr);
  const ac = acfPitch(src.analyser, sr);
  if (ac.conf > ACF_CONF && ac.f > 0) {
    const dm = Math.abs(12 * Math.log2(ac.f / (sp.f || 1)));
    if (dm > 1 || sp.db < -80) return { f: ac.f, db: sp.db, est: 'acf', acf: ac };
  }
  return { f: sp.f, db: sp.db, est: 'fft', acf: ac };
}

const OPEN_STRING_HZ = { E2: 82.41, A2: 110, D3: 146.83, G3: 196, B3: 246.94, E4: 329.63 };
const STRING_COLORS = { 6: '#f87171', 5: '#fb923c', 4: '#fbbf24', 3: '#34d399', 2: '#60a0ff', 1: '#a78bfa' };
const f2x = (f, w) => w * Math.log2(f / FMIN) / Math.log2(FMAX / FMIN);
const _peaks = new Map(); // canvas -> [{arr} per source]

// Log-frequency spectrum with a semitone grid, open-string labels,
// per-string harmonic markers for held notes, peak-hold, and a
// dominant-peak note readout.
export function drawSpectrum(canvas, sources, held, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const top = 14, gh = h - top - 14;

  // semitone gridlines; octave Cs get a label, open strings get names
  for (let m = 0; m < 128; m++) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    if (f < FMIN || f > FMAX) continue;
    const x = f2x(f, w);
    const isC = ((m % 12) + 12) % 12 === 0;
    g.strokeStyle = isC ? '#334155' : '#1a2436';
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + gh); g.stroke();
    if (isC) {
      g.fillStyle = '#475569';
      g.font = '8px ui-monospace, monospace';
      g.fillText(midiName(m), x + 1, h - 4);
    }
  }
  g.fillStyle = '#64748b';
  g.font = '8px ui-monospace, monospace';
  for (const [n, f] of Object.entries(OPEN_STRING_HZ)) {
    g.fillText(n, f2x(f, w) - 8, top - 3);
  }

  // harmonic markers for held notes: f0..6f0 in each note's string color
  if (held) {
    for (const n of held.values()) {
      const f0 = 440 * Math.pow(2, (n.midi + (n.bend || 0) - 69) / 12);
      for (let k = 1; k <= 6; k++) {
        const f = f0 * k;
        if (f > FMAX) break;
        const x = f2x(f, w);
        g.strokeStyle = (STRING_COLORS[n.str] || '#94a3b8') + (k === 1 ? 'cc' : '55');
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + gh); g.stroke();
      }
    }
  }

  let pkState = _peaks.get(canvas);
  if (!pkState) { pkState = []; _peaks.set(canvas, pkState); }

  sources.forEach((src, si) => {
    if (!src.analyser) return;
    const b = freqBuf(src.analyser), hz = sr / src.analyser.fftSize;
    let peaks = pkState[si];
    if (!peaks || peaks.length !== w) { peaks = new Float32Array(w); pkState[si] = peaks; }
    const hzh = h - 14;
    for (let x = 0; x < w; x += 2) {
      const f = FMIN * Math.pow(FMAX / FMIN, x / w);
      const bi = f / hz, b0 = Math.floor(bi), frac = bi - b0;
      const db = (b[b0] || -140) * (1 - frac) + (b[b0 + 1] ?? -140) * frac;
      const v = Math.max(0, Math.min(1, (db + 100) / 70));
      g.fillStyle = src.color + 'aa';
      g.fillRect(x, top + gh - v * gh, 2, v * gh);
      for (let px = x; px < Math.min(x + 2, w); px++) {
        peaks[px] = Math.max(v, peaks[px] - 0.004);
      }
    }
    g.strokeStyle = src.color;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const y = top + gh - peaks[x] * gh;
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = src.color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(src.label, 8 + si * 60, h - 4);
  });

  // dominant peak readout: nearest note + cents off, loudest source wins
  let best = null;
  for (const src of sources) {
    if (!src.analyser) continue;
    const p = domPeak(src.analyser, sr);
    if (!best || p.db > best.db) best = { ...p, color: src.color };
  }
  if (best && best.db > -90) {
    const midi = 69 + 12 * Math.log2(best.f / 440);
    const cents = Math.round((midi - Math.round(midi)) * 100);
    g.fillStyle = best.color;
    g.font = 'bold 10px ui-monospace, monospace';
    const txt = `${midiName(Math.round(midi))} ${best.f.toFixed(1)}Hz ${cents >= 0 ? '+' : ''}${cents}c`;
    g.fillText(txt, w - g.measureText(txt).width - 6, top - 3);
  }
}

// Chromagram: FFT energy folded into 12 pitch-class bars. Two source
// halves side by side (synth left, input right). Held pitch classes get
// a bright tick above their bar.
export function drawChroma(canvas, sources, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const half = w / sources.length;
  sources.forEach((src, si) => {
    if (!src.analyser) return;
    const b = freqBuf(src.analyser), hz = sr / src.analyser.fftSize;
    const energy = new Float32Array(12);
    for (let m = 24; m <= 96; m++) {
      const f = 440 * Math.pow(2, (m - 69) / 12);
      if (f > FMAX * 1.5) break;
      const bi = Math.round(f / hz);
      const amp = Math.pow(10, (b[bi] ?? -140) / 20); // dB -> linear
      energy[((m % 12) + 12) % 12] += amp;
    }
    const max = Math.max(...energy, 1e-6);
    const bw = (half - 10) / 12, x0 = si * half + 5;
    g.fillStyle = src.color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(src.label, x0, 12);
    energy.forEach((e, pc) => {
      const v = Math.sqrt(e / max); // sqrt so quiet PCs stay visible
      const bh = v * (h - 30);
      g.fillStyle = src.color + 'bb';
      g.fillRect(x0 + pc * bw, h - 16 - bh, bw - 2, bh);
      g.fillStyle = '#64748b';
      g.fillText(PC[pc], x0 + pc * bw + bw / 2 - 4, h - 4);
    });
  });
}

// Level + tone readout per source: RMS level bar and text readouts for
// RMS dB, spectral centroid (brightness), and the dominant peak's
// nearest note with cents deviation.
export function drawMeters(canvas, sources, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const rowH = h / sources.length;
  sources.forEach((src, si) => {
    if (!src.analyser) return;
    const y = si * rowH;
    const tb = timeBuf(src.analyser);
    let sum = 0;
    for (let i = 0; i < tb.length; i++) sum += tb[i] * tb[i];
    const db = 20 * Math.log10(Math.sqrt(sum / tb.length) || 1e-9);
    const b = freqBuf(src.analyser), hz = sr / src.analyser.fftSize;
    // one pass over the display band: centroid (num/den) and spectral
    // flatness (geometric vs arithmetic mean). Flatness near 0 is a
    // comb-like tonal spectrum, near 1 is noise.
    let num = 0, den = 0, lg = 0, cnt = 0;
    for (let i = Math.floor(FMIN / hz); i < Math.min(b.length, Math.ceil(FMAX / hz)); i++) {
      const a = Math.pow(10, b[i] / 20);
      num += i * hz * a; den += a;
      lg += Math.log(a + 1e-12); cnt++;
    }
    const cent = den > 0 && db > -55 ? `${(num / den).toFixed(0)}Hz` : '--';
    const flat = cnt ? Math.exp(lg / cnt) / (den / cnt + 1e-12) : 0;
    const p = domPeak(src.analyser, sr);
    const midi = p.db > -90 && db > -55 ? 69 + 12 * Math.log2(p.f / 440) : null;
    const cents = midi === null ? '' : ` ${(Math.round((midi - Math.round(midi)) * 100) >= 0 ? '+' : '')}${Math.round((midi - Math.round(midi)) * 100)}c`;

    // zero-crossing rate: fraction of samples that cross zero
    let zc = 0, peak = 0;
    for (let i = 1; i < tb.length; i++) {
      if ((tb[i - 1] < 0) !== (tb[i] < 0)) zc++;
      const a = Math.abs(tb[i]);
      if (a > peak) peak = a;
    }
    const crest = peak / (Math.sqrt(sum / tb.length) || 1e-9);
    const ac = acfPitch(src.analyser, sr);

    const lvl = Math.max(0, Math.min(1, (db + 60) / 55));
    g.fillStyle = '#1e293b';
    g.fillRect(8, y + 6, w - 16, 10);
    g.fillStyle = lvl > 0.85 ? '#f87171' : src.color;
    g.fillRect(8, y + 6, (w - 16) * lvl, 10);
    g.fillStyle = src.color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(src.label, 10, y + 32);
    g.fillStyle = '#cbd5e1';
    g.fillText(
      `${db.toFixed(1)}dB · bright ${cent}` +
      (midi === null ? ' · silence' : ` · peak ${midiName(Math.round(midi))} ${p.f.toFixed(1)}Hz${cents}`),
      58, y + 32);
    if (db > -55) {
      g.fillStyle = '#94a3b8';
      g.fillText(
        `acf ${ac.f > 0 ? ac.f.toFixed(1) + 'Hz' : '--'} ${ac.conf.toFixed(2)}` +
        ` · zcr ${(zc / tb.length * 100).toFixed(1)}% · flat ${flat.toFixed(2)}` +
        ` · crest ${crest.toFixed(1)}`,
        58, y + 46);
    }
  });
}

// Scrolling spectrogram: each frame shifts left, new column drawn at right.
export class Spectrogram {
  constructor(canvas) {
    this.cv = canvas;
    this.off = document.createElement('canvas');
  }

  draw(analyser, sr = 44100) {
    const { g, w, h } = prep(this.cv);
    if (this.off.width !== this.cv.width || this.off.height !== this.cv.height) {
      this.off.width = this.cv.width;
      this.off.height = this.cv.height;
      this.og = this.off.getContext('2d');
      this.og.fillStyle = '#0b1120';
      this.og.fillRect(0, 0, this.cv.width, this.cv.height);
    }
    const og = this.og;
    // shift left 2px
    og.drawImage(this.off, -2, 0);
    og.fillStyle = '#0b1120';
    og.fillRect(this.cv.width - 2, 0, 2, this.cv.height);
    if (analyser) {
      const b = freqBuf(analyser), hz = sr / analyser.fftSize;
      const rows = this.cv.height;
      for (let i = 0; i < rows; i++) {
        // row i from bottom maps to log frequency in the guitar band
        const f = FMIN * Math.pow(FMAX / FMIN, i / rows);
        const bi = Math.min(b.length - 1, Math.round(f / hz));
        const v = Math.max(0, Math.min(1, (b[bi] + 100) / 70));
        og.fillStyle = `hsl(${190 + v * 80}, ${40 + v * 60}%, ${8 + v * 55}%)`;
        og.fillRect(this.cv.width - 2, this.cv.height - 1 - i, 2, 1);
      }
    }
    g.drawImage(this.off, 0, 0, w, h);
    // note gridlines drawn over the scrolled image each frame
    for (let m = 0; m < 128; m++) {
      const f = 440 * Math.pow(2, (m - 69) / 12);
      if (f < FMIN || f > FMAX) continue;
      const y = h - h * Math.log2(f / FMIN) / Math.log2(FMAX / FMIN);
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? '#33415577' : '#1a243655';
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (isC) {
        g.fillStyle = '#64748b';
        g.font = '8px ui-monospace, monospace';
        g.fillText(midiName(m), 3, y - 2);
      }
    }
  }
}

const TRACK_WINDOW_MS = 8000;
const TRACK_MIDI_LO = 36, TRACK_MIDI_HI = 84; // C2..C6
const _tracks = new WeakMap(); // src -> [{t, midi}]

// Pitch track: dominant-peak note traced over the last 8s on a midi
// grid. Makes vibrato, bends, and drift visible as motion in the line.
// Silent frames break the trace rather than drawing a false pitch.
export function drawPitchTrack(canvas, sources, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const now = performance.now();
  const my = m => h - 14 - (m - TRACK_MIDI_LO) / (TRACK_MIDI_HI - TRACK_MIDI_LO) * (h - 24);
  for (let m = TRACK_MIDI_LO; m <= TRACK_MIDI_HI; m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    const y = my(m);
    g.strokeStyle = isC ? '#334155' : '#1a2436';
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    if (isC) {
      g.fillStyle = '#64748b';
      g.font = '8px ui-monospace, monospace';
      g.fillText(midiName(m), 3, y - 2);
    }
  }
  for (const [n, f] of Object.entries(OPEN_STRING_HZ)) {
    const m = 69 + 12 * Math.log2(f / 440);
    if (m >= TRACK_MIDI_LO && m <= TRACK_MIDI_HI) {
      g.fillStyle = '#94a3b8';
      g.font = '8px ui-monospace, monospace';
      g.fillText(n, w - 14, my(m) - 2);
    }
  }
  for (const src of sources) {
    if (!src.analyser) continue;
    let tr = _tracks.get(src);
    if (!tr) { tr = []; _tracks.set(src, tr); }
    const p = bestF0(src, sr);
    tr.push({ t: now, midi: p.db > -90 ? 69 + 12 * Math.log2(p.f / 440) : null });
    while (tr.length && now - tr[0].t > TRACK_WINDOW_MS) tr.shift();
    g.strokeStyle = src.color;
    g.lineWidth = 2;
    g.beginPath();
    let pen = false;
    for (const pt of tr) {
      if (pt.midi === null) { pen = false; continue; }
      const x = w - (now - pt.t) / TRACK_WINDOW_MS * w;
      const y = my(pt.midi);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = src.color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(src.label, 8 + sources.indexOf(src) * 60, h - 4);

    // vibrato readout: mean crossings + excursion in the last 3s
    const VIB_SPAN_MS = 3000;
    const pts = tr.filter(pt => pt.midi !== null && now - pt.t < VIB_SPAN_MS);
    if (pts.length > 60) {
      let mean = 0, lo = Infinity, hi = -Infinity;
      for (const pt of pts) { mean += pt.midi; if (pt.midi < lo) lo = pt.midi; if (pt.midi > hi) hi = pt.midi; }
      mean /= pts.length;
      const depth = (hi - lo) / 2;
      let cross = 0, above = pts[0].midi > mean;
      for (const pt of pts) {
        const a = pt.midi > mean;
        if (a !== above) { cross++; above = a; }
      }
      const span = (pts[pts.length - 1].t - pts[0].t) / 1000;
      const hz2 = cross / 2 / span;
      if (cross >= 4 && depth > 0.04 && hz2 > 1 && hz2 < 12) {
        g.fillStyle = src.color;
        g.font = '9px ui-monospace, monospace';
        const t2 = `vib ${hz2.toFixed(1)}Hz ±${depth.toFixed(2)}st`;
        g.fillText(t2, w - g.measureText(t2).width - 6, 11);
      }
    }
  }
}

const ENV_WINDOW_MS = 8000;
const ONSET_RATIO = 1.7, ONSET_MIN_DB = 2.0, ONSET_GAP_MS = 80;
const _env = new WeakMap(); // src -> {hist, prev, ema, onsets}

// Envelope: scrolling RMS level per source with onset ticks detected
// by spectral flux (sum of rising bin energy vs its own running mean).
// Attacks show as vertical marks, so strum timing reads off the audio
// itself rather than the MIDI event log.
export function drawEnvelope(canvas, sources, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const now = performance.now();
  const rowH = h / sources.length;
  for (const [si, src] of sources.entries()) {
    const y0 = si * rowH;
    if (!src.analyser) continue;
    let st = _env.get(src);
    if (!st) { st = { hist: [], prev: null, ema: 0, onsets: [] }; _env.set(src, st); }
    const tb = timeBuf(src.analyser);
    let s = 0;
    for (let i = 0; i < tb.length; i++) s += tb[i] * tb[i];
    const db = 20 * Math.log10(Math.sqrt(s / tb.length) || 1e-9);
    st.hist.push({ t: now, db });
    while (st.hist.length && now - st.hist[0].t > ENV_WINDOW_MS) st.hist.shift();

    const b = freqBuf(src.analyser), hz = sr / src.analyser.fftSize;
    if (st.prev) {
      const lo = Math.floor(FMIN / hz), hi = Math.min(b.length, Math.ceil(FMAX / hz));
      let f = 0;
      for (let i = lo; i < hi; i++) { const d = b[i] - st.prev[i]; if (d > 0) f += d; }
      f /= (hi - lo);
      const last = st.onsets[st.onsets.length - 1];
      if (st.ema && f > st.ema * ONSET_RATIO && f > ONSET_MIN_DB && db > -55 &&
          (last === undefined || now - last > ONSET_GAP_MS)) st.onsets.push(now);
      st.ema = st.ema * 0.9 + f * 0.1;
    }
    st.prev = b.slice();
    while (st.onsets.length && now - st.onsets[0] > ENV_WINDOW_MS) st.onsets.shift();

    const base = y0 + rowH - 8, ph = rowH - 20;
    g.strokeStyle = '#1e293b';
    g.beginPath(); g.moveTo(0, base); g.lineTo(w, base); g.stroke();
    g.fillStyle = src.color + '33';
    g.beginPath();
    g.moveTo(0, base);
    for (const pt of st.hist) {
      const x = w - (now - pt.t) / ENV_WINDOW_MS * w;
      const v = Math.max(0, Math.min(1, (pt.db + 60) / 55));
      g.lineTo(x, base - v * ph);
    }
    g.lineTo(w, base);
    g.fill();
    g.strokeStyle = src.color;
    for (const t of st.onsets) {
      const x = w - (now - t) / ENV_WINDOW_MS * w;
      g.beginPath(); g.moveTo(x, y0 + 4); g.lineTo(x, y0 + 14); g.stroke();
    }
    g.fillStyle = src.color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(`${src.label} ${db.toFixed(1)}dB`, 8, y0 + 13);

    // attack time of the newest onset: ms from onset to envelope peak
    const newest = st.onsets[st.onsets.length - 1];
    if (newest !== undefined && now - newest < 2000) {
      let pk = -Infinity, tpk = newest;
      for (const pt of st.hist) {
        if (pt.t >= newest && pt.t < newest + 400 && pt.db > pk) { pk = pt.db; tpk = pt.t; }
      }
      const x = w - (now - newest) / ENV_WINDOW_MS * w;
      g.fillStyle = '#94a3b8';
      g.fillText(`+${Math.round(tpk - newest)}ms`, Math.min(x, w - 34), y0 + 26);
    }

    // tempo estimate from median inter-onset interval
    if (st.onsets.length >= 4 && si === sources.length - 1) {
      const iv = [];
      for (let i = 1; i < st.onsets.length; i++) iv.push(st.onsets[i] - st.onsets[i - 1]);
      iv.sort((a, b) => a - b);
      const med = iv[iv.length >> 1];
      if (med > 200 && med < 1500) {
        const t2 = `~${Math.round(60000 / med)} bpm`;
        g.fillStyle = src.color;
        g.fillText(t2, w - g.measureText(t2).width - 6, y0 + 13);
      }
    }
  }
}

const HARMONIC_COUNT = 10;

// Harmonic profile: energy at f0 * 1..10 relative to the fundamental,
// for the loudest source. A timbre fingerprint: a plucked string shows
// the classic falling comb, a synth lead shows whatever the wavetable
// baked in.
export function drawHarmonics(canvas, sources, sr = 44100) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  let best = null;
  for (const src of sources) {
    if (!src.analyser) continue;
    const p = bestF0(src, sr);
    if (!best || p.db > best.db) best = { ...p, src };
  }
  if (!best || best.db <= -90) {
    g.fillStyle = '#475569';
    g.font = '10px ui-monospace, monospace';
    g.fillText('silence', 10, h / 2);
    return;
  }
  const b = freqBuf(best.src.analyser), hz = sr / best.src.analyser.fftSize;
  const amps = [], meas = [];
  for (let k = 1; k <= HARMONIC_COUNT; k++) {
    const fc = best.f * k;
    const bi = Math.round(fc / hz);
    if (bi >= b.length) break;
    // real strings ring sharp of the ideal harmonic; search +-2.5%
    const wbin = Math.max(1, Math.round(0.025 * fc / hz));
    let v = -140, bix = bi;
    for (let i = Math.max(0, bi - wbin); i <= Math.min(b.length - 1, bi + wbin); i++) {
      if (b[i] > v) { v = b[i]; bix = i; }
    }
    const l = b[bix - 1] ?? -140, r = b[bix + 1] ?? -140;
    const sh = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / ((l - 2 * v + r) || 1e-9)));
    meas.push({ k, f: (bix + sh) * hz, a: Math.pow(10, v / 20) });
    amps.push(Math.pow(10, v / 20));
  }
  // inharmonicity: f_k = k f0 sqrt(1 + B k^2), fit B amplitude-weighted
  let bsum = 0, wsum = 0;
  for (const m of meas) {
    if (m.k < 2) continue;
    const r = m.f / (m.k * best.f);
    bsum += ((r * r - 1) / (m.k * m.k)) * m.a;
    wsum += m.a;
  }
  const B = wsum > 0 ? bsum / wsum : 0;
  const ref = amps[0] || 1;
  const bw = (w - 20) / amps.length;
  const midi = 69 + 12 * Math.log2(best.f / 440);
  g.fillStyle = best.src.color;
  g.font = '9px ui-monospace, monospace';
  g.fillText(`${best.src.label} f0 ${midiName(Math.round(midi))} ${best.f.toFixed(1)}Hz · B ${(B * 1e4).toFixed(2)}e-4`, 10, 12);
  amps.forEach((a, i) => {
    const v = a / ref;
    g.fillStyle = best.src.color + 'bb';
    g.fillRect(10 + i * bw, h - 16 - v * (h - 34), bw - 2, v * (h - 34));
    g.fillStyle = '#64748b';
    g.fillText(`x${i + 1}`, 10 + i * bw + bw / 2 - 6, h - 4);
  });
}

// Wavetable viewer: one period of each preset currently assigned,
// drawn live so splits show their different tables.
export function drawWavetable(canvas, engine) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const colors = ['#5eead4', '#60a0ff', '#a78bfa', '#f472b6', '#fbbf24', '#34d399'];
  const used = engine
    ? [...new Set([1, 2, 3, 4, 5, 6].map(s => engine.presetName(s)))]
    : ['steel string'];
  const rows = used.slice(0, 6);
  const fh = h / rows.length;
  rows.forEach((name, row) => {
    const { real, imag } = PRESETS[name].wave({});
    const wave = waveFrame(real, imag);
    const color = colors[row % colors.length];
    g.beginPath();
    g.strokeStyle = color;
    g.lineWidth = 1.3;
    for (let i = 0; i < wave.length; i++) {
      const x = 10 + (i / wave.length) * (w - 20);
      const y = row * fh + fh / 2 - wave[i] * fh * 0.38;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = color;
    g.font = '9px ui-monospace, monospace';
    g.fillText(name, 12, row * fh + 11);
  });
}

// Note waterfall: per-string lanes scrolling left, bars = held duration.
// History entries: {str, midi, vel, t0, t1|null, inferred}.
export function drawWaterfall(canvas, history, active, now, windowMs = 12000) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const laneH = h / 6;
  const xOf = t => w - ((now - t) / windowMs) * w;
  const STRING_COLORS = { 6: '#f87171', 5: '#fb923c', 4: '#fbbf24', 3: '#34d399', 2: '#60a0ff', 1: '#a78bfa' };

  for (let s = 6; s >= 1; s--) {
    const y = (6 - s) * laneH;
    g.strokeStyle = '#1e293b';
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = '#475569';
    g.font = '9px ui-monospace, monospace';
    g.fillText(s === 6 ? 'E' : s === 1 ? 'e' : 'ADGB'[5 - s], 4, y + laneH - 4);
  }
  // 1-second gridlines
  for (let sec = 1; sec * 1000 < windowMs; sec++) {
    const x = xOf(now - sec * 1000);
    g.strokeStyle = 'rgba(51,65,85,0.4)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }

  const cutoff = now - windowMs;
  for (const ev of history) {
    if ((ev.t1 ?? now) < cutoff) continue;
    const x0 = Math.max(0, xOf(ev.t0));
    const x1 = Math.min(w, xOf(ev.t1 ?? now));
    if (x1 - x0 < 1.5) continue;
    const y = (6 - ev.str) * laneH;
    const col = STRING_COLORS[ev.str] || '#94a3b8';
    g.fillStyle = ev.inferred ? col + '66' : col + 'cc';
    // Bar height encodes velocity: soft taps read thinner than hits.
    const bh = Math.max(3, (laneH - 6) * (0.35 + 0.65 * (ev.vel / 127)));
    g.fillRect(x0, y + (laneH - bh) / 2, x1 - x0, bh);
    if (x1 - x0 > 22) {
      g.fillStyle = '#0b1120';
      g.font = 'bold 8px ui-monospace, monospace';
      g.fillText(midiName(ev.midi), x0 + 3, y + laneH - 6);
    }
  }
  // "now" edge
  g.strokeStyle = '#5eead4';
  g.beginPath(); g.moveTo(w - 1, 0); g.lineTo(w - 1, h); g.stroke();
}

// Treble staff with noteheads for held notes. Diatonic index drives
// vertical position; seconds offset right like real engraving.
const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const PC_SPELL = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];

export function drawStaff(canvas, midis) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const gap = h / 10;              // distance between staff lines
  const yTop = h * 0.28;
  const step = gap / 2;            // diatonic step height
  const yOf = d => yTop + (38 - d) * step; // F5 top line = diatonic 38
  const midX = w / 2;

  // staff lines: E4 G4 B4 D5 F5 = diatonic 30,32,34,36,38
  g.strokeStyle = '#475569';
  g.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = yTop + i * gap;
    g.beginPath(); g.moveTo(8, y); g.lineTo(w - 8, y); g.stroke();
  }
  // treble clef
  g.fillStyle = '#64748b';
  g.font = `${gap * 6.2}px serif`;
  g.fillText('\u{1D11E}', 10, yTop + gap * 4.55);

  if (!midis.length) return;
  const notes = midis
    .map(m => {
      const pc = ((m % 12) + 12) % 12;
      const [letter, alter] = PC_SPELL[pc];
      const oct = Math.floor(m / 12) - 1;
      return { m, d: oct * 7 + LETTER_STEP[letter], alter };
    })
    .sort((a, b) => a.d - b.d);

  const hw = step * 1.4;
  notes.forEach((n, i) => {
    const y = yOf(n.d);
    // seconds: offset the higher note to the right (engraving convention)
    const off = i > 0 && n.d - notes[i - 1].d === 1 ? hw * 1.8 : 0;
    // ledger lines for out-of-staff notes
    g.strokeStyle = '#475569';
    for (let d = 40; d <= n.d; d += 2) {
      g.beginPath(); g.moveTo(midX - hw * 1.6 + off, yOf(d)); g.lineTo(midX + hw * 1.6 + off, yOf(d)); g.stroke();
    }
    for (let d = 28; d >= n.d; d -= 2) {
      g.beginPath(); g.moveTo(midX - hw * 1.6 + off, yOf(d)); g.lineTo(midX + hw * 1.6 + off, yOf(d)); g.stroke();
    }
    if (n.alter) {
      g.fillStyle = '#5eead4';
      g.font = `bold ${gap * 1.9}px serif`;
      g.fillText('#', midX - hw * 3.4 + off, y + step * 0.7);
    }
    g.save();
    g.translate(midX + off, y);
    g.rotate(-0.28);
    g.fillStyle = '#5eead4';
    g.beginPath();
    g.ellipse(0, 0, hw, hw * 0.72, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
    // stem up for low notes, down for high
    g.strokeStyle = '#5eead4';
    g.lineWidth = 1.5;
    g.beginPath();
    if (n.d <= 34) { g.moveTo(midX + hw * 0.9 + off, y - 2); g.lineTo(midX + hw * 0.9 + off, y - gap * 3); }
    else { g.moveTo(midX - hw * 0.9 + off, y + 2); g.lineTo(midX - hw * 0.9 + off, y + gap * 3); }
    g.stroke();
    g.lineWidth = 1;
  });
}

// String decay: per-string amplitude lanes. `lanes[i]` = {cur, trail:[{t,a}]}
// — trail entries are CC11 expression values, or 1/0 attack/release steps
// when the device never sends expression (ccSeen flag distinguishes).
export function drawStrings(canvas, lanes, ccSeen, now, names, windowMs = 6000) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const STRING_COLORS = { 6: '#f87171', 5: '#fb923c', 4: '#fbbf24', 3: '#34d399', 2: '#60a0ff', 1: '#a78bfa' };
  const laneH = h / 6, labelW = 30;
  const xOf = t => labelW + (w - labelW) * (1 - (now - t) / windowMs);
  for (let s = 6; s >= 1; s--) {
    const i = s - 1, y = (6 - s) * laneH, lane = lanes[i];
    const col = STRING_COLORS[s];
    g.strokeStyle = '#1e293b';
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = '#64748b';
    g.font = '10px monospace';
    g.fillText(names?.[i] ?? `s${s}`, 6, y + laneH / 2 + 3);
    // trail: amplitude history, fading with age
    if (lane.trail.length) {
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.beginPath();
      let started = false;
      for (const p of lane.trail) {
        const x = xOf(p.t), py = y + laneH - 4 - p.a * (laneH - 8);
        if (x < labelW) continue;
        if (!started) { g.moveTo(x, py); started = true; } else g.lineTo(x, py);
      }
      g.stroke();
      g.lineWidth = 1;
    }
    // current level bar at the right edge
    const bh = Math.max(0, lane.cur) * (laneH - 8);
    g.fillStyle = col + 'cc';
    g.fillRect(w - 6, y + laneH - 4 - bh, 4, bh);
  }
  g.strokeStyle = '#1e293b';
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  g.fillStyle = '#64748b';
  g.font = '9px monospace';
  g.fillText(ccSeen ? 'CC11 string amplitude' : 'attack/release, no CC11 seen', labelW, h - 3);
}
