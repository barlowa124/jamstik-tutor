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

// Frequency bars, log-ish spacing via linear bin subsample.
export function drawSpectrum(canvas, sources) {
  const { g, w, h } = prep(canvas);
  g.clearRect(0, 0, w, h);
  const buf = new Uint8Array(1024);
  const bars = 96;
  for (const src of sources) {
    if (!src.analyser) continue;
    src.analyser.getByteFrequencyData(buf);
    for (let b = 0; b < bars; b++) {
      // map bar -> bin with a log curve so low frequencies get room
      const bin = Math.floor(Math.pow(buf.length, b / bars));
      const v = buf[Math.min(bin, buf.length - 1)] / 255;
      g.fillStyle = src.color + 'aa';
      const bw = w / bars;
      g.fillRect(b * bw, h - v * h, bw - 1, v * h);
    }
  }
}

// Scrolling spectrogram: each frame shifts left, new column drawn at right.
export class Spectrogram {
  constructor(canvas) {
    this.cv = canvas;
    this.off = document.createElement('canvas');
  }

  draw(analyser) {
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
      const buf = new Uint8Array(256);
      analyser.getByteFrequencyData(buf);
      const dpr = window.devicePixelRatio || 1;
      for (let i = 0; i < this.cv.height; i++) {
        const bin = Math.floor(Math.pow(buf.length, 1 - i / this.cv.height));
        const v = buf[Math.min(bin, buf.length - 1)] / 255;
        og.fillStyle = `hsl(${190 + v * 80}, ${40 + v * 60}%, ${8 + v * 55}%)`;
        og.fillRect(this.cv.width - 2, this.cv.height - 1 - i, 2, 1);
      }
    }
    g.drawImage(this.off, 0, 0, w, h);
  }
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
    g.fillRect(x0, y + 3, x1 - x0, laneH - 6);
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
