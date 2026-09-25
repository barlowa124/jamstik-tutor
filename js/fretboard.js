// Canvas fretboard: horizontal strings, log-spaced frets, live notes,
// pitch-bend indicators, and target-shape overlay for the chord trainer.

import { OPEN_MIDI, STRING_NAMES, FRET_COUNT, midiName, pcName } from './theory.js';

export class Fretboard {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.active = new Map();  // string -> {midi, bend}
    this.targets = null;      // {string: fret|null} hollow markers
    this.scaleOverlay = null; // [{string,fret,isRoot}]
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (this.cv.width !== r.width * dpr) {
      this.cv.width = r.width * dpr;
      this.cv.height = r.height * dpr;
    }
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
  }

  fretX(f) {
    // Physical string: position of fret f along the nut->bridge span.
    const usable = this.w - 60;
    if (f === 0) return 44;
    const span = 2 - Math.pow(2, -FRET_COUNT / 12); // normalizer at last fret
    return 44 + usable * (1 - Math.pow(2, -f / 12)) / span;
  }

  // Center of fret f's playing space: open notes sit on the nut, fret f
  // occupies the space between wires f-1 and f.
  fretCenter(f) {
    if (f <= 0) return 44;
    return (this.fretX(f - 1) + this.fretX(f)) / 2;
  }

  stringY(s) {
    const top = 34, bottom = this.h - 30;
    return top + (6 - s) * (bottom - top) / 5; // string 1 (high e) on top
  }

  draw() {
    const g = this.g;
    this.resize();
    g.clearRect(0, 0, this.w, this.h);

    // frets
    g.strokeStyle = '#3a4356';
    g.fillStyle = '#8892a8';
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    for (let f = 0; f <= FRET_COUNT; f++) {
      const x = this.fretX(f);
      g.lineWidth = f === 0 ? 5 : 1.5;
      g.beginPath();
      g.moveTo(x, this.stringY(1) - 12);
      g.lineTo(x, this.stringY(6) + 12);
      g.stroke();
      if (f > 0 && f <= 12) g.fillText(f, this.fretCenter(f), this.h - 8);
    }

    // inlay dots at fret positions 3,5,7,9,15 and the octave pair at 12
    g.fillStyle = '#232c3f';
    for (const f of [3, 5, 7, 9, 15]) {
      g.beginPath();
      g.arc(this.fretCenter(f), (this.stringY(1) + this.stringY(6)) / 2, 5, 0, 7);
      g.fill();
    }
    for (const y of [0.32, 0.68]) {
      g.beginPath();
      g.arc(this.fretCenter(12),
            this.stringY(1) + y * (this.stringY(6) - this.stringY(1)), 5, 0, 7);
      g.fill();
    }

    // strings (thicker toward low E)
    for (let s = 1; s <= 6; s++) {
      g.strokeStyle = '#5b6478';
      g.lineWidth = 1 + (s - 1) * 0.45;
      g.beginPath();
      g.moveTo(44, this.stringY(s));
      g.lineTo(this.w - 14, this.stringY(s));
      g.stroke();
      g.fillStyle = '#8892a8';
      g.textAlign = 'right';
      g.fillText(STRING_NAMES[s], 34, this.stringY(s) + 3);
    }

    // scale overlay: muted dots for in-scale positions
    if (this.scaleOverlay) {
      for (const p of this.scaleOverlay) {
        const x = this.fretCenter(p.fret);
        const y = this.stringY(p.string);
        g.beginPath();
        g.arc(x, y, 6, 0, 7);
        g.fillStyle = p.isRoot ? 'rgba(94,234,212,0.35)' : 'rgba(96,140,255,0.22)';
        g.fill();
      }
    }

    // target chord shape: hollow rings + X/O above the nut
    if (this.targets) {
      for (const [s, f] of Object.entries(this.targets)) {
        const y = this.stringY(+s);
        if (f === null) {
          g.fillStyle = '#f87171';
          g.textAlign = 'center';
          g.fillText('×', 44, y - 10);
          continue;
        }
        const x = this.fretCenter(f);
        g.beginPath();
        g.arc(x, y, 9, 0, 7);
        g.strokeStyle = '#fbbf24';
        g.lineWidth = 2;
        g.stroke();
        if (f === 0) {
          g.fillStyle = '#94a3b8';
          g.fillText('o', 44, y - 10);
        }
      }
    }

    // live notes: filled dots; bend shifts the dot vertically
    for (const [s, n] of this.active) {
      const fret = n.midi - OPEN_MIDI[s];
      if (fret < 0 || fret > FRET_COUNT) continue;
      const x = this.fretCenter(fret);
      const y = this.stringY(s) - (n.bend || 0) * 6;
      g.beginPath();
      g.arc(x, y, 10, 0, 7);
      g.fillStyle = '#5eead4';
      g.fill();
      g.fillStyle = '#0b1120';
      g.textAlign = 'center';
      g.font = 'bold 9px ui-monospace, monospace';
      g.fillText(pcName(n.midi), x, y + 3);
      g.font = '10px ui-monospace, monospace';
      if (Math.abs(n.bend) > 0.05) {
        g.fillStyle = '#fbbf24';
        g.fillText(`${n.bend > 0 ? '+' : ''}${n.bend.toFixed(2)}`, x, y - 14);
      }
    }
  }
}
