// Teaching modes: FreePlay (live chord naming), ChordTrainer (shape
// prompts + verdict coaching), ScaleDrill (in-key feedback + ordered runs).

import {
  CHORD_SHAPES, chordFromLabel, chordGap, detectChord, currentTuningName,
  midiName, OPEN_MIDI, pcName, SCALES, scalePositions, scaleRun, STRING_NAMES,
} from './theory.js';
import { Metronome } from './audio.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ── Free play ───────────────────────────────────────────────────────────
export class FreePlay {
  constructor(app) { this.app = app; }
  activate(panel) {
    this.app.fretboard.targets = null;
    this.app.fretboard.scaleOverlay = null;
    panel.append(el('div', 'hint',
      'Play anything. Held notes are named live; stable voicings resolve to a chord.'));
    this.readout = el('div', 'big-readout', 'no notes held');
    this.readout.style.color = '#334155';
    this.notes = el('div', 'held-notes', '');
    this.strum = el('div', 'hint', '');
    panel.append(this.readout, this.notes, this.strum);
    // Backing loop: strums a progression through the synth on the beat.
    // Synth-only voices — held notes and chord detection stay yours.
    const bkRow = el('div', 'row');
    this.bkSel = el('select');
    for (const k of Object.keys({
      'C–G–Am–F': 1, 'I–V–vi–IV in G': 1, 'ii–V–I in C': 1, '12-bar blues in E': 1 })) {
      this.bkSel.append(el('option', '', `backing: ${k}`));
    }
    this.bkBtn = el('button', '', '▶ play');
    this.bkBtn.onclick = () => this.backing ? this.stopBacking() : this.startBacking();
    bkRow.append(this.bkSel, this.bkBtn);
    panel.append(bkRow);
    this.debounce = null;
    this.refresh();
  }
  deactivate() { this.stopBacking(); }

  startBacking() {
    const map = {
      'backing: C–G–Am–F': ['C maj', 'G maj', 'A min', 'F maj'],
      'backing: I–V–vi–IV in G': ['G maj', 'D maj', 'E min', 'C maj'],
      'backing: ii–V–I in C': ['D min', 'G 7', 'C maj'],
      'backing: 12-bar blues in E': ['E maj', 'A maj', 'B 7', 'A maj'],
    };
    this.backing = { seq: map[this.bkSel.value] || map['backing: C–G–Am–F'], ix: 0, timer: null };
    this.bkBtn.textContent = '■ stop';
    const bar = () => {
      if (!this.backing) return;
      const bpm = Math.max(40, Math.min(220, +document.getElementById('bpm').value || 80));
      const barMs = (60000 / bpm) * 4;
      const shape = CHORD_SHAPES[this.backing.seq[this.backing.ix % this.backing.seq.length]];
      this.backing.ix++;
      if (shape) {
        let d = 0;
        for (const [s, f] of Object.entries(shape)) {
          if (f == null) continue;
          const str = +s, midi = OPEN_MIDI[str] + f;
          setTimeout(() => this.app.synth.noteOn(`bk${str}`, midi, 72, str), d);
          setTimeout(() => this.app.synth.noteOff(`bk${str}`, midi), d + barMs - 120);
          d += 22;
        }
      }
      this.backing.timer = setTimeout(bar, barMs);
    };
    bar();
  }

  stopBacking() {
    if (!this.backing) return;
    clearTimeout(this.backing.timer);
    this.backing = null;
    // null midi = unconditional release; passing a pitch risks a
    // stale-off rejection and an orphaned ringing voice.
    for (let s = 1; s <= 6; s++) this.app.synth.noteOff(`bk${s}`, null);
    this.bkBtn.textContent = '▶ play';
  }

  onNotesChange() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 70);
  }
  refresh() {
    const midis = [...this.app.held.values()].map(n => n.midi);
    this.notes.textContent = midis.length
      ? [...this.app.held.values()]
          .map(n => `${STRING_NAMES[n.str]}${n.inferred ? '?' : ''}:${midiName(n.midi)}`)
          .join('  ')
      : '';
    if (!midis.length) {
      this.readout.textContent = 'no notes held';
      this.readout.style.color = '#334155';
      return;
    }
    const c = detectChord(midis);
    this.readout.textContent = c ? c.label : midis.map(midiName).join(' ');
    this.readout.style.color = c ? '#5eead4' : '#94a3b8';
    // Strum timing: the most recent onset cluster (notes within 90ms of
    // each other) — a clean strum lands all strings within ~35ms.
    const evs = this.app.history;
    const onsets = [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const t = evs[i].t0;
      if (onsets.length && onsets[onsets.length - 1] - t > 90) break;
      onsets.push(t);
    }
    if (onsets.length >= 3) {
      const spread = Math.round(Math.max(...onsets) - Math.min(...onsets));
      this.strum.textContent =
        `last strum: ${onsets.length} notes over ${spread}ms` +
        (spread <= 35 ? ' — tight' : spread >= 90 ? ' — wide' : '');
    } else this.strum.textContent = '';
  }
}

// ── Chord trainer ───────────────────────────────────────────────────────
export class ChordTrainer {
  constructor(app) { this.app = app; }
  activate(panel) {
    // Open-shape fingerings are standard-tuning-specific; in other
    // tunings we keep pitch-class verdicts but hide the shape overlay.
    this.standardTuning = currentTuningName() === 'standard';
    this.score = { tries: 0, hits: 0, streak: 0, latencies: [] };
    this.progression = ['C maj', 'G maj', 'A min', 'F maj'];
    this.ix = 0;
    this.promptT = performance.now();
    this.judged = false;
    this.timer = null;

    const row = el('div', 'row');
    const sel = el('select');
    for (const name of Object.keys(CHORD_SHAPES)) sel.append(el('option', '', name));
    const prog = el('select');
    for (const [label, list] of Object.entries({
      'single chords': null,
      'C–G–Am–F': ['C maj', 'G maj', 'A min', 'F maj'],
      'I–V–vi–IV in G': ['G maj', 'D maj', 'E min', 'C maj'],
      'ii–V–I in C': ['D min', 'G 7', 'C maj'],
      '12-bar blues in E': ['E maj', 'A maj', 'B 7', 'A maj'],
    })) prog.append(el('option', '', label));
    prog.value = 'C–G–Am–F';
    this.singleSel = sel;
    const hear = el('button', '', 'hear it');
    hear.onclick = () => this.playTarget();
    const skip = el('button', '', 'next');
    skip.onclick = () => this.next();
    row.append(prog, sel, hear, skip);
    panel.append(row);

    if (!this.standardTuning) {
      panel.append(el('div', 'hint',
        `Tuning is ${currentTuningName()} — shape diagrams assume standard; ` +
        `verdicts still check chord tones.`));
    }
    this.target = el('div', 'big-readout', '');
    this.verdict = el('div', 'verdict', '');
    this.stats = el('div', 'stats', '');
    panel.append(this.target, this.verdict, this.stats);
    prog.onchange = () => {
      const map = {
        'C–G–Am–F': ['C maj', 'G maj', 'A min', 'F maj'],
        'I–V–vi–IV in G': ['G maj', 'D maj', 'E min', 'C maj'],
        'ii–V–I in C': ['D min', 'G 7', 'C maj'],
        '12-bar blues in E': ['E maj', 'A maj', 'B 7', 'A maj'],
      };
      this.progression = map[prog.value] || null;
      this.next();
    };
    sel.onchange = () => { this.progression = null; this.show(sel.value); };
    this.show(this.progression[0]);
  }

  deactivate() {
    this.app.fretboard.targets = null;
    clearTimeout(this.timer);
  }

  playTarget() {
    const shape = CHORD_SHAPES[this.cur];
    for (const [s, f] of Object.entries(shape)) {
      if (f === null) continue;
      const delay = (6 - +s) * 25;
      const midi = OPEN_MIDI[s] + f;
      // hp keys: audition voices must not clobber a real held note on
      // the same string (s* keys belong to played notes).
      setTimeout(() => this.app.synth.noteOn(`hp${s}`, midi, 92, +s), delay);
      setTimeout(() => this.app.synth.noteOff(`hp${s}`, midi), delay + 1800);
    }
  }

  show(label) {
    this.cur = label;
    const shape = CHORD_SHAPES[label];
    this.app.fretboard.targets = this.standardTuning ? shape : null;
    this.target.textContent = label;
    this.target.style.color = '#fbbf24';
    this.verdict.textContent = 'strum the shape shown';
    this.verdict.style.color = '#94a3b8';
    this.promptT = performance.now();
    this.judged = false;
  }

  next() {
    if (this.progression) {
      this.ix = (this.ix + 1) % this.progression.length;
      this.show(this.progression[this.ix]);
    } else {
      this.show(this.singleSel.value);
    }
  }

  onNotesChange() {
    if (this.judged) {
      if (!this.app.held.size) { this.judged = false; this.next(); }
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.judge(), 160);
  }

  judge() {
    if (!this.app.held.size || this.judged) return;
    const midis = [...this.heldMidis()];
    const parsed = chordFromLabel(this.cur);
    const gap = chordGap(parsed.root, parsed.suffix, midis);
    const shape = CHORD_SHAPES[this.cur];
    const heldArr = [...this.app.held.values()];
    // Single-channel MIDI does not name the string; per-string coaching
    // would compare against inferred positions, so skip it then.
    const stringsKnown = this.standardTuning && heldArr.every(n => !n.inferred);
    const perString = [];
    if (stringsKnown) {
      for (const [s, f] of Object.entries(shape)) {
        const held = heldArr.find(n => n.str === +s);
        if (f === null) {
          if (held) perString.push(`${STRING_NAMES[s]} string should be muted — heard ${midiName(held.midi)}`);
        } else if (!held) {
          perString.push(`${STRING_NAMES[s]} string silent — expected fret ${f}`);
        } else {
          const heard = held.midi - OPEN_MIDI[s];
          if (heard !== f) perString.push(`${STRING_NAMES[s]} fret ${heard} — expected ${f}`);
        }
      }
    }
    this.score.tries++;
    const latency = (performance.now() - this.promptT) / 1000;
    if (gap.exact && !perString.some(p => p.includes('mute'))) {
      this.score.hits++;
      this.score.streak++;
      this.score.latencies.push(latency);
      this.verdict.textContent = `✓ ${this.cur} in ${latency.toFixed(1)}s — release to continue`;
      this.verdict.style.color = '#34d399';
      this.judged = true;
    } else {
      this.score.streak = 0;
      const bits = [];
      if (gap.missing.length) bits.push(`missing ${gap.missing.join(', ')}`);
      if (gap.extra.length) bits.push(`extra ${gap.extra.join(', ')}`);
      this.verdict.textContent = [...bits, ...perString].join(' · ') || '…';
      this.verdict.style.color = '#f87171';
    }
    const lat = this.score.latencies;
    this.stats.textContent =
      `${this.score.hits}/${this.score.tries} correct · streak ${this.score.streak}` +
      (lat.length ? ` · avg ${(lat.reduce((a, b) => a + b) / lat.length).toFixed(1)}s` : '');
  }

  *heldMidis() { for (const n of this.app.held.values()) yield n.midi; }
}

// ── Scale drills ────────────────────────────────────────────────────────
export class ScaleDrill {
  constructor(app) { this.app = app; }
  activate(panel) {
    this.stats = { hits: 0, misses: 0 };
    const row = el('div', 'row');
    this.keySel = el('select');
    for (const n of ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#']) {
      this.keySel.append(el('option', '', n));
    }
    this.keySel.value = 'A';
    this.scaleSel = el('select');
    for (const n of Object.keys(SCALES)) this.scaleSel.append(el('option', '', n));
    this.scaleSel.value = 'minor pentatonic';
    this.modeSel = el('select');
    this.modeSel.append(el('option', '', 'freeform (any scale tone)'));
    this.modeSel.append(el('option', '', 'run (ascend & descend)'));
    const hear = el('button', '', 'hear scale');
    hear.onclick = () => this.hearScale();
    row.append(this.keySel, this.scaleSel, this.modeSel, hear);
    panel.append(row);
    this.feedback = el('div', 'verdict', '');
    this.statLine = el('div', 'stats', '');
    this.progress = el('div', 'hint', '');
    panel.append(this.feedback, this.statLine, this.progress);

    const rebuild = () => this.build();
    this.keySel.onchange = rebuild;
    this.scaleSel.onchange = rebuild;
    this.modeSel.onchange = rebuild;
    this.build();
  }

  hearScale() {
    const run = scaleRun(this.rootPc(), this.scaleSel.value, 0, 6);
    run.forEach((p, i) => {
      const midi = OPEN_MIDI[p.string] + p.fret;
      setTimeout(() => this.app.synth.noteOn('sc', midi, 84, p.string), i * 220);
      setTimeout(() => this.app.synth.noteOff('sc', midi), i * 220 + 190);
    });
  }

  rootPc() {
    return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(this.keySel.value);
  }

  build() {
    const root = this.rootPc();
    const scale = this.scaleSel.value;
    this.scalePcs = scalePositions(root, scale).map(p => p.pc);
    this.app.fretboard.scaleOverlay = scalePositions(root, scale);
    this.app.fretboard.targets = null;
    this.runMode = this.modeSel.value.startsWith('run');
    this.run = this.runMode ? scaleRun(root, scale, 0, 6) : null;
    this.runIx = 0;
    this.stats = { hits: 0, misses: 0 };
    this.feedback.textContent = this.runMode
      ? `play the ${this.keySel.value} ${scale} run, low E to high e and back`
      : `improvise in ${this.keySel.value} ${scale} — lit dots are in-key`;
    this.progress.textContent = '';
    this.updateStats();
  }

  deactivate() { this.app.fretboard.scaleOverlay = null; }

  onNoteOn(str, midi) {
    const pc = ((midi % 12) + 12) % 12;
    if (!this.runMode) {
      const inKey = this.scalePcs.includes(pc);
      inKey ? this.stats.hits++ : this.stats.misses++;
      this.feedback.textContent = inKey ? `${midiName(midi)} ✓` : `${midiName(midi)} — out of key`;
      this.feedback.style.color = inKey ? '#34d399' : '#f87171';
      this.updateStats();
      return;
    }
    const want = this.run[this.runIx];
    if (!want) return;
    const wantMidi = OPEN_MIDI[want.string] + want.fret;
    if (str === want.string && midi === wantMidi) {
      this.stats.hits++;
      this.runIx++;
      this.feedback.style.color = '#34d399';
      this.feedback.textContent = this.runIx >= this.run.length
        ? `run complete — ${this.stats.hits}/${this.stats.hits + this.stats.misses} clean`
        : `${midiName(midi)} ✓  next: ${STRING_NAMES[this.run[this.runIx].string]} string fret ${this.run[this.runIx].fret}`;
      if (this.runIx >= this.run.length) this.runIx = 0;
    } else {
      this.stats.misses++;
      this.feedback.style.color = '#f87171';
      const rightNote = pc === (wantMidi % 12);
      this.feedback.textContent = rightNote
        ? `${midiName(midi)} is in the scale, but the run wants ${STRING_NAMES[want.string]} fret ${want.fret}`
        : `expected ${midiName(wantMidi)} on ${STRING_NAMES[want.string]} string fret ${want.fret} — heard ${midiName(midi)}`;
    }
    this.progress.textContent = `position ${this.runIx}/${this.run.length}`;
    this.updateStats();
  }

  onNotesChange() {}

  updateStats() {
    const { hits, misses } = this.stats;
    const total = hits + misses;
    this.statLine.textContent = total
      ? `${hits}/${total} in-key (${Math.round(100 * hits / total)}%)`
      : '';
  }
}

// ── Tuner ───────────────────────────────────────────────────────────────
// Pitch readout from MIDI: the sounded note plus its live bend in cents.
// Matches the Jamstik app's tuner role; with real audio-in enabled the
// input path is visualized on the scope rather than pitch-tracked.
export class Tuner {
  constructor(app) { this.app = app; }

  activate(panel) {
    this.app.fretboard.targets = null;
    this.app.fretboard.scaleOverlay = null;
    panel.append(el('div', 'hint',
      'Play a string. The needle shows live pitch bend in cents (±100).'));
    this.noteEl = el('div', 'big-readout', '—');
    this.cv = el('canvas', 'tuner-cv');
    this.detail = el('div', 'stats', '');
    panel.append(this.noteEl, this.cv, this.detail);
    this.lastStr = null;
  }

  deactivate() {}

  onNoteOn(str) { this.lastStr = str; }
  onNotesChange() {}

  frame() {
    const g = this.cv.getContext('2d');
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.cv.width !== w * dpr) { this.cv.width = w * dpr; this.cv.height = h * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // ticks at -50, -25, 0, 25, 50 cents
    for (const c of [-50, -25, 0, 25, 50]) {
      const x = w / 2 + (c / 50) * (w / 2 - 14);
      g.strokeStyle = c === 0 ? '#5eead4' : '#334155';
      g.beginPath(); g.moveTo(x, h - 18); g.lineTo(x, h - 6); g.stroke();
      g.fillStyle = '#64748b'; g.font = '9px ui-monospace, monospace'; g.textAlign = 'center';
      g.fillText(c, x, h - 20);
    }

    const held = [...this.app.held.values()];
    const entry = held.find(n => n.str === this.lastStr) || held[held.length - 1];
    if (!entry) { this.noteEl.textContent = '—'; this.detail.textContent = ''; return; }

    const cents = (entry.bend || 0) * 100;
    const clamped = Math.max(-50, Math.min(50, cents));
    const x = w / 2 + (clamped / 50) * (w / 2 - 14);
    const inTune = Math.abs(cents) < 6;
    g.strokeStyle = inTune ? '#34d399' : '#fbbf24';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, h - 34); g.lineTo(x, 4); g.stroke();
    this.noteEl.textContent = midiName(entry.midi);
    this.noteEl.style.color = inTune ? '#34d399' : '#cbd5e1';
    this.detail.textContent =
      `${STRING_NAMES[entry.str]} string · ${entry.midi - OPEN_MIDI[entry.str]} fret` +
      ` · ${cents >= 0 ? '+' : ''}${cents.toFixed(0)} cents` +
      (entry.inferred ? ' · position inferred' : '');
  }
}

// ── Note quiz ───────────────────────────────────────────────────────────
// Fretboard-knowledge drills: "play any F#" or "play fret 7 on the D
// string". Tracks latency and streaks.
export class Quiz {
  constructor(app) { this.app = app; }

  activate(panel) {
    this.app.fretboard.targets = null;
    this.app.fretboard.scaleOverlay = null;
    this.score = { tries: 0, hits: 0, streak: 0, latencies: [] };
    const row = el('div', 'row');
    this.kindSel = el('select');
    for (const [v, label] of [['mixed', 'mixed drills'], ['note', 'note names'],
      ['spot', 'exact positions'], ['bend', 'bend targets'], ['arp', 'arpeggio runs'],
      ['dyn', 'dynamics'], ['ear', 'intervals by ear'], ['cear', 'chords by ear']]) {
      this.kindSel.append(el('option', '', label));
      this.kindSel.lastChild.value = v;
    }
    const skip = el('button', '', 'skip');
    skip.onclick = () => this.ask();
    row.append(this.kindSel, skip);
    this.prompt = el('div', 'big-readout', '');
    this.verdict = el('div', 'verdict', '');
    this.stats = el('div', 'stats', '');
    panel.append(row, this.prompt, this.verdict, this.stats);
    // Interval answer grid, only meaningful during ear targets.
    this.IV_NAMES = ['minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th',
      'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'];
    this.earRow = el('div', 'row');
    this.earRow.style.display = 'none';
    for (let iv = 1; iv <= 12; iv++) {
      const b = el('button', 'chip', this.IV_NAMES[iv - 1].replace('perfect ', 'P').replace('major ', 'M').replace('minor ', 'm'));
      b.onclick = () => this.answerEar(iv);
      this.earRow.append(b);
    }
    const replay = el('button', '', '↻ hear again');
    replay.onclick = () => this.playEar();
    this.earRow.append(replay);
    // Chord-quality answers for the 'cear' kind.
    this.CEAR_NAMES = { maj: 'major', min: 'minor', 7: 'dom 7' };
    this.cearRow = el('div', 'row');
    this.cearRow.style.display = 'none';
    for (const q of ['maj', 'min', '7']) {
      const b = el('button', 'chip', this.CEAR_NAMES[q]);
      b.onclick = () => this.answerCear(q);
      this.cearRow.append(b);
    }
    const replay2 = el('button', '', '↻ hear again');
    replay2.onclick = () => this.playEar();
    this.cearRow.append(replay2);
    panel.append(this.earRow, this.cearRow);
    panel.append(el('div', 'hint',
      'Note drills accept the pitch class on any string. Position drills ' +
      'need multi-channel MIDI — in single-channel mode they match pitch only.'));
    this.ask();
  }

  deactivate() { this.app.fretboard.targets = null; }

  ask() {
    let kind = this.kindSel.value;
    if (kind === 'mixed') {
      kind = ['note', 'spot', 'bend', 'arp', 'dyn', 'ear', 'cear'][Math.floor(Math.random() * 7)];
    }
    this.promptT = performance.now();
    this.app.fretboard.targets = null;
    this.earRow.style.display = kind === 'ear' ? '' : 'none';
    this.cearRow.style.display = kind === 'cear' ? '' : 'none';
    if (kind === 'ear' || kind === 'cear') {
      if (kind === 'ear') {
        this.target = { kind, iv: 1 + Math.floor(Math.random() * 12), base: 50 + Math.floor(Math.random() * 14) };
        this.prompt.textContent = 'which interval?';
      } else {
        const q = ['maj', 'min', '7'][Math.floor(Math.random() * 3)];
        this.target = { kind, q, root: 48 + Math.floor(Math.random() * 12) };
        this.prompt.textContent = 'major, minor, or dominant 7th?';
      }
      this.playEar();
      this.verdict.textContent = '';
      return;
    }
    if (kind === 'dyn') {
      const [name, lo, hi] = [['a soft note', 1, 54], ['a medium note', 55, 99], ['a hard note', 100, 127]][Math.floor(Math.random() * 3)];
      this.target = { kind, name, lo, hi };
      this.prompt.textContent = `play ${name}`;
      this.verdict.textContent = '';
      return;
    }
    if (kind === 'note') {
      this.target = { kind, pc: Math.floor(Math.random() * 12) };
      this.prompt.textContent = `play any ${pcName(this.target.pc)}`;
    } else if (kind === 'spot') {
      const str = 1 + Math.floor(Math.random() * 6);
      const fret = Math.floor(Math.random() * 8);
      this.target = { kind, str, fret, midi: OPEN_MIDI[str] + fret };
      this.prompt.textContent = `play fret ${fret} on the ${STRING_NAMES[str]} string`;
    } else if (kind === 'bend') {
      const steps = [0.5, 1, 1, 2][Math.floor(Math.random() * 4)];
      this.target = { kind, steps };
      this.prompt.textContent = `play a note, then bend it up ${steps === 0.5 ? 'a quarter' : steps === 1 ? 'a half' : 'a whole'} step`;
    } else {
      const chord = ['C maj', 'G maj', 'A min', 'E min', 'D maj'][Math.floor(Math.random() * 5)];
      const shape = CHORD_SHAPES[chord] ?? {};
      const seq = [6, 5, 4, 3, 2, 1].filter(s => shape[s] != null);
      this.target = { kind, chord, seq, progress: 0 };
      this.app.fretboard.targets = CHORD_SHAPES[chord] ?? null;
      this.prompt.textContent = `pick ${chord} one string at a time, low to high`;
    }
    this.verdict.textContent = '';
  }

  hit(lat, label) {
    this.score.tries++;
    this.score.hits++;
    this.score.streak++;
    this.score.latencies.push(lat);
    this.today = this.app.bump?.('quiz', true, lat) ?? this.today;
    this.verdict.textContent = `✓ ${label} in ${lat.toFixed(1)}s`;
    this.verdict.style.color = '#34d399';
    this.showStats();
    setTimeout(() => this.ask(), 700);
  }

  miss(label) {
    this.score.tries++;
    this.score.streak = 0;
    this.today = this.app.bump?.('quiz', false, 0) ?? this.today;
    this.verdict.textContent = label;
    this.verdict.style.color = '#f87171';
    this.showStats();
  }

  showStats() {
    const latArr = this.score.latencies;
    let wk = '';
    try {
      const all = JSON.parse(localStorage.getItem('jamstik-tutor-stats') || '{}');
      let h = 0, t = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        if (all[d]?.quiz) { h += all[d].quiz.h; t += all[d].quiz.t; }
      }
      if (t) wk = ` · 7d ${h}/${t}`;
    } catch { /* storage unavailable */ }
    this.stats.textContent =
      `${this.score.hits}/${this.score.tries} · streak ${this.score.streak}` +
      (latArr.length ? ` · avg ${(latArr.reduce((a, b) => a + b) / latArr.length).toFixed(1)}s` : '') +
      (this.today ? ` · today ${this.today.h}/${this.today.t}` : '') + wk;
  }

  onNoteOn(str, midi, vel = 64) {
    const t = this.target;
    if (!t) return;
    if (t.kind === 'arp') {
      if (t.done) return;
      const shape = CHORD_SHAPES[t.chord];
      const held = [...this.app.held.values()].find(n => n.midi === midi);
      if (held?.inferred) {
        // Inferred positions: picking order is unknowable, so accept the
        // chord when every required tone is sounding at once.
        const cf = chordFromLabel(t.chord);
        const req = cf && chordGap(cf.root, cf.suffix, [...this.app.held.values()].map(n => n.midi));
        if (req?.exact) { t.done = true; this.hit((performance.now() - this.promptT) / 1000, `${t.chord} tones`); }
        return;
      }
      const wantStr = t.seq[t.progress];
      const wantFret = shape?.[wantStr];
      if (str === wantStr && wantFret != null && midi === OPEN_MIDI[wantStr] + wantFret) {
        t.progress++;
        this.verdict.textContent = `${STRING_NAMES[str]} ✓ (${t.progress}/${t.seq.length})`;
        this.verdict.style.color = '#5eead4';
        if (t.progress >= t.seq.length) {
          t.done = true;
          this.hit((performance.now() - this.promptT) / 1000, `${t.chord} run`);
        }
      } else {
        t.progress = 0;
        this.miss(`expected the ${STRING_NAMES[wantStr]} string next — run restarted`);
      }
      return;
    }
    let ok = false;
    if (t.kind === 'dyn') {
      ok = vel >= t.lo && vel <= t.hi;
      const lat = (performance.now() - this.promptT) / 1000;
      if (ok) this.hit(lat, `${t.name} (vel ${vel})`);
      else this.miss(`velocity ${vel} — ${t.name} is ${t.lo}-${t.hi}`);
      return;
    }
    if (t.kind === 'note') {
      ok = ((midi % 12) + 12) % 12 === t.pc;
    } else if (t.kind === 'spot') {
      const held = this.app.held.get(`s${str}`) || [...this.app.held.values()].find(n => n.midi === midi);
      ok = held && !held.inferred ? str === t.str && midi === t.midi : midi === t.midi;
    } else {
      return; // bend target: judged in onBend, not on onset
    }
    const lat = (performance.now() - this.promptT) / 1000;
    if (ok) this.hit(lat, midiName(midi));
    else this.miss(`heard ${midiName(midi)} — try again`);
  }

  playEar() {
    const t = this.target;
    if (!t) return;
    this.app.synth.ensure();
    const play = (key, midi, at, dur) => {
      setTimeout(() => this.app.synth.noteOn(key, midi, 92, null), at);
      setTimeout(() => this.app.synth.noteOff(key, midi), at + dur);
    };
    if (t.kind === 'ear') {
      play('ear', t.base, 0, 800);
      play('ear2', t.base + t.iv, 650, 1000);
    } else if (t.kind === 'cear') {
      const intervals = { maj: [0, 4, 7], min: [0, 3, 7], 7: [0, 4, 7, 10] }[t.q];
      intervals.forEach((iv, i) => play(`ce${i}`, t.root + iv, 0, 1400));
    }
  }

  answerCear(q) {
    const t = this.target;
    if (!t || t.kind !== 'cear' || t.done) return;
    const lat = (performance.now() - this.promptT) / 1000;
    if (q === t.q) {
      t.done = true;
      this.hit(lat, this.CEAR_NAMES[t.q]);
    } else {
      this.miss(`that was ${this.CEAR_NAMES[q]} — listen again`);
    }
  }

  answerEar(iv) {
    const t = this.target;
    if (!t || t.kind !== 'ear' || t.done) return;
    const lat = (performance.now() - this.promptT) / 1000;
    if (iv === t.iv) {
      t.done = true;
      this.hit(lat, this.IV_NAMES[t.iv - 1]);
    } else {
      this.miss(`that was a ${this.IV_NAMES[iv - 1]} — listen again`);
    }
  }

  onBend(str, semis) {
    const t = this.target;
    if (!t || t.kind !== 'bend' || t.done) return;
    // Hit when any held note sits within ±12 cents of the target bend.
    const hit = [...this.app.held.values()].some(n => Math.abs(n.bend - t.steps) <= 0.12);
    if (hit) {
      t.done = true;
      this.hit((performance.now() - this.promptT) / 1000, `${t.steps} step bend`);
    }
  }

  onNotesChange() {}
}

// ── Chord changes ───────────────────────────────────────────────────────
// Timed switching drill: the board shows the target shape and the panel
// shows what's next; the clock runs until the held notes resolve to the
// exact chord tones.
export class ChordChanges {
  constructor(app) { this.app = app; }

  activate(panel) {
    this.app.fretboard.scaleOverlay = null;
    this.standardTuning = currentTuningName() === 'standard';
    this.PROG = {
      'C–G–Am–F': ['C maj', 'G maj', 'A min', 'F maj'],
      'I–V–vi–IV in G': ['G maj', 'D maj', 'E min', 'C maj'],
      'ii–V–I in C': ['D min', 'G 7', 'C maj'],
      '12-bar blues in E': ['E maj', 'A maj', 'B 7', 'A maj'],
    };
    const sel = el('select');
    for (const k of Object.keys(this.PROG)) sel.append(el('option', '', k));
    sel.onchange = () => { this.seq = this.PROG[sel.value]; this.ix = 0; this.ask(); };
    this.seq = this.PROG[Object.keys(this.PROG)[0]];
    this.times = [];
    this.ix = 0;
    this.prompt = el('div', 'big-readout', '');
    this.nextUp = el('div', 'hint', '');
    this.verdict = el('div', 'verdict', '');
    this.stats = el('div', 'stats', '');
    panel.append(sel, this.prompt, this.nextUp, this.verdict, this.stats);
    panel.append(el('div', 'hint',
      'Strum the named chord as soon as it appears. The clock runs ' +
      'until the held notes are exactly its chord tones, then the next ' +
      'name appears. Position coaching is not part of this drill.'));
    this.ask();
  }

  deactivate() { this.app.fretboard.targets = null; }

  ask() {
    const cur = this.seq[this.ix % this.seq.length];
    const nxt = this.seq[(this.ix + 1) % this.seq.length];
    this.cur = cur;
    this.prompt.textContent = `→ ${cur}`;
    this.nextUp.textContent = `next: ${nxt}`;
    this.app.fretboard.targets = this.standardTuning ? CHORD_SHAPES[cur] ?? null : null;
    this.promptT = performance.now();
    this.done = false;
  }

  onNotesChange() {
    if (this.done) return;
    const midis = [...this.app.held.values()].map(n => n.midi);
    if (midis.length < 3) return;
    const cf = chordFromLabel(this.cur);
    const gap = cf && chordGap(cf.root, cf.suffix, midis);
    if (gap?.exact) {
      const dt = (performance.now() - this.promptT) / 1000;
      this.times.push(dt);
      const today = this.app.bump?.('changes', true, dt);
      this.verdict.textContent = `${this.cur} in ${dt.toFixed(1)}s`;
      this.verdict.style.color = '#34d399';
      const avg = this.times.reduce((a, b) => a + b) / this.times.length;
      this.stats.textContent =
        `${this.times.length} changes · last ${this.times.slice(-4).map(t => t.toFixed(1)).join('s, ')}s · avg ${avg.toFixed(1)}s` +
        (today ? ` · today ${today.h}/${today.t}` : '');
      this.done = true;
      this.ix++;
      setTimeout(() => this.ask(), 350);
    }
  }

  onNoteOn() {}
}

// Short melodic patterns judged note by note. Single-string steps only:
// power chords and double-stops would need a chord-step verdict layer.
const RIFFS = {
  'blues shuffle in A': [[5, 0], [4, 0], [4, 2], [4, 0], [4, 4], [4, 0], [4, 2], [4, 0]],
  'pentatonic walk-up in A': [[5, 0], [4, 2], [4, 0], [3, 2], [3, 0], [4, 0], [5, 3], [5, 0]],
  'G run walk-down': [[6, 3], [5, 0], [5, 2], [4, 0]],
  'travis pick in C': [[5, 3], [3, 0], [4, 2], [3, 0], [6, 3], [3, 0], [4, 2], [3, 0]],
  'power riff in E': [[6, 0], [6, 0], [6, 3], [6, 0], [5, 5], [5, 7]],
};

export class RiffDrill {
  constructor(app) { this.app = app; }

  activate(panel) {
    panel.innerHTML = '';
    panel.append(el('h2', '', 'riff drills'));
    const row = el('div', 'row');
    this.sel = el('select');
    for (const k of Object.keys(RIFFS)) this.sel.append(el('option', '', k));
    this.sel.onchange = () => this.reset();
    const hear = el('button', '', 'hear it');
    hear.onclick = () => this.playRiff();
    row.append(this.sel, hear);
    this.prompt = el('div', 'prompt');
    this.verdict = el('div', 'verdict');
    this.stats = el('div', 'stats');
    panel.append(row, this.prompt, this.verdict, this.stats);
    panel.append(el('div', 'hint',
      'Play the lit position, then the next. Wrong notes cost a miss but ' +
      'never your place in the pattern.'));
    this.reset();
  }

  deactivate() { this.app.fretboard.targets = null; }

  reset() {
    this.ix = 0;
    this.t0 = performance.now();
    this.hits = 0;
    this.misses = 0;
    this.verdict.textContent = '';
    this.showStep();
  }

  showStep() {
    const steps = RIFFS[this.sel.value];
    const [str, fret] = steps[this.ix];
    this.app.fretboard.targets = { [str]: fret };
    this.prompt.textContent =
      `${this.ix + 1}/${steps.length} · ${STRING_NAMES[str]} string fret ${fret} (${midiName(OPEN_MIDI[str] + fret)})`;
    this.stats.textContent = `${this.hits} clean · ${this.misses} off`;
  }

  playRiff() {
    this.app.synth.ensure();
    const steps = RIFFS[this.sel.value];
    steps.forEach(([str, fret], i) => {
      const midi = OPEN_MIDI[str] + fret;
      setTimeout(() => this.app.synth.noteOn(`rf${i}`, midi, 90, str), i * 260);
      setTimeout(() => this.app.synth.noteOff(`rf${i}`, midi), i * 260 + 230);
    });
  }

  onNoteOn(str, midi) {
    const steps = RIFFS[this.sel.value];
    const [wStr, wFret] = steps[this.ix];
    const wantMidi = OPEN_MIDI[wStr] + wFret;
    const held = this.app.held.get(`s${str}`) || [...this.app.held.values()].find(n => n.midi === midi);
    const exact = held && !held.inferred ? str === wStr && midi === wantMidi : midi === wantMidi;
    if (exact) {
      this.hits++;
      this.ix++;
      this.verdict.textContent = `${midiName(midi)} ✓`;
      this.verdict.style.color = '#34d399';
      if (this.ix >= steps.length) {
        const dt = (performance.now() - this.t0) / 1000;
        this.verdict.textContent =
          `riff complete — ${this.hits}/${this.hits + this.misses} in ${dt.toFixed(1)}s`;
        this.app.bump?.('riffs', this.misses === 0, dt);
        this.ix = 0;
        this.t0 = performance.now();
        this.hits = 0;
        this.misses = 0;
      }
      this.showStep();
      return;
    }
    this.misses++;
    const samePc = ((midi - wantMidi) % 12 + 12) % 12 === 0;
    this.verdict.textContent = samePc
      ? `right pitch, wrong spot — ${STRING_NAMES[wStr]} fret ${wFret}`
      : `heard ${midiName(midi)} — expected ${midiName(wantMidi)}`;
    this.verdict.style.color = '#f87171';
    this.stats.textContent = `${this.hits} clean · ${this.misses} off`;
  }
}

// Strum on the beat against a click; each onset is scored by its
// distance to the nearest beat on the grid.// Strum on the click. Free grids score each onset's offset in ms;
// named patterns split the bar into eighth-note slots and score
// which slots got hits.
const STRUM_PATTERNS = {
  'free quarters': { free: 1 },
  'free eighths': { free: 2 },
  'steady 8ths': { pat: [1, 1, 1, 1, 1, 1, 1, 1] },
  'on the quarters': { pat: [1, 0, 1, 0, 1, 0, 1, 0] },
  'folk strum': { pat: [1, 0, 1, 1, 0, 1, 1, 0] },
  'syncopated': { pat: [1, 0, 0, 1, 0, 0, 1, 0] },
};

export class RhythmDrill {
  constructor(app) { this.app = app; }

  activate(panel) {
    panel.innerHTML = '';
    panel.append(el('h2', '', 'rhythm drill'));
    const row = el('div', 'row');
    this.btn = el('button', '', '\u25b6 start click');
    this.btn.onclick = () => this.running ? this.stop() : this.start();
    this.patSel = el('select');
    for (const k of Object.keys(STRUM_PATTERNS)) this.patSel.append(el('option', '', k));
    this.patSel.onchange = () => this.buildSlots();
    row.append(this.btn, this.patSel);
    this.slotRow = el('div', 'row');
    this.slots = [];
    for (let i = 0; i < 8; i++) {
      const c = el('span', 'chip', '\u00b7');
      c.style.cursor = 'default';
      this.slotRow.append(c);
      this.slots.push(c);
    }
    this.verdict = el('div', 'verdict');
    this.stats = el('div', 'stats');
    panel.append(row, this.slotRow, this.verdict, this.stats);
    panel.append(el('div', 'hint',
      'Free grids score every onset in ms. Patterns score each eighth ' +
      'slot: green hit, red missed target, amber extra hit on a rest. ' +
      'BPM is the header field.'));
    this.running = false;
    this.resetCounters();
    this.buildSlots();
  }

  get pat() {
    const p = STRUM_PATTERNS[this.patSel.value];
    return p.pat || null;
  }

  get freeDiv() {
    const p = STRUM_PATTERNS[this.patSel.value];
    return p.free || 0;
  }

  resetCounters() {
    this.barsDone = 0;
    this.offs = [];
    this.pendingEdge = false;
    this.stats.textContent = '';
  }

  buildSlots() {
    const pat = this.pat;
    this.slotState = Array(8).fill(0); // 0 pending, 1 hit, 2 missed, 3 extra
    this.curSlot = 0;
    for (let i = 0; i < 8; i++) {
      const c = this.slots[i];
      const target = pat ? pat[i] === 1 : true;
      c.textContent = pat ? (target ? '\u25cf' : '\u25cb') : '\u00b7';
      c.style.opacity = pat ? (target ? 1 : 0.4) : 0.4;
      c.style.color = '#94a3b8';
    }
  }

  start() {
    this.app.synth.ensure();
    this.metro = this.metro || new Metronome(this.app.synth.ctx);
    this.metro.bpm = +document.getElementById('bpm').value || 80;
    this.beatTimes = [];
    this.base = null;
    this.barIx = -1;
    this.metro.onTick = (b, t) => {
      const wall = performance.now() + (t - this.app.synth.ctx.currentTime) * 1000;
      if (this.base === null) this.base = wall; // first tick is beat 0
      this.beatTimes.push({ beat: b, wall });
      if (this.beatTimes.length > 20) this.beatTimes.shift();
    };
    this.metro.start();
    this.running = true;
    this.btn.textContent = '\u25a0 stop click';
    this.verdict.textContent = 'on the click \u2014';
    this.verdict.style.color = '#94a3b8';
    this.resetCounters();
    this.buildSlots();
  }

  stop() {
    this.metro?.stop();
    this.running = false;
    this.btn.textContent = '\u25b6 start click';
  }

  deactivate() { this.stop(); }

  // Slot arithmetic from the first beat tick: bar N starts at
  // base + N * 4 beats. Never re-anchors, so frame() cannot spin
  // phantom bars while waiting for the next beat-0 tick.
  slotPos(now) {
    if (this.base === null) return null;
    const period = 60000 / this.metro.bpm / 2;
    const f = (now - this.base) / period;
    return { f, ix: Math.floor(f), slot: ((Math.floor(f) % 8) + 8) % 8, period };
  }

  finalizeSlot(ix) {
    if (this.slotState[ix] !== 0) return;
    this.slotState[ix] = this.pat[ix] ? 2 : 0;
    const c = this.slots[ix];
    if (this.pat[ix]) { c.style.color = '#f87171'; c.style.opacity = 1; }
  }

  frame() {
    if (!this.running || !this.pat) return;
    const pos = this.slotPos(performance.now());
    if (!pos) return;
    const barIx = Math.floor(pos.ix / 8);
    if (this.barIx === -1) this.barIx = barIx;
    if (barIx !== this.barIx) {
      // The previous bar is done: finalize all its slots and score it.
      for (let i = 0; i < 8; i++) this.finalizeSlot(i);
      const hits = this.slotState.filter((s, i) => s === 1 && this.pat[i]).length;
      const targets = this.pat.filter(Boolean).length;
      const extra = this.slotState.filter((s, i) => s === 3 && !this.pat[i]).length;
      this.barsDone++;
      this.stats.textContent =
        `bar ${this.barsDone}: ${hits}/${targets} on-pattern` +
        (extra ? `, ${extra} extra` : '');
      this.barIx = barIx;
      this.buildSlots();
      // An onset landed just ahead of slot 0 while the previous bar was
      // still the current one — it belongs to this bar's first slot.
      if (this.pendingEdge) {
        this.pendingEdge = false;
        this.slotState[0] = this.pat[0] ? 1 : 3;
        this.slots[0].style.color = this.pat[0] ? '#34d399' : '#fbbf24';
        this.slots[0].style.opacity = 1;
        this.curSlot = 1;
      }
    }
    // Finalize elapsed slots in the current bar.
    while (this.curSlot < pos.slot) {
      this.finalizeSlot(this.curSlot);
      this.curSlot++;
    }
  }

  onNoteOn() {
    if (!this.running) return;
    const now = performance.now();
    this.metro.bpm = +document.getElementById('bpm').value || this.metro.bpm;
    const pat = this.pat;
    if (pat) {
      const pos = this.slotPos(now);
      if (!pos) return;
      const f = pos.f - Math.floor(pos.f / 8) * 8;
      const ix = Math.round(f);
      if (ix < 0) return;
      if (ix >= 8) {
        // Early hit on next bar's slot 0: remember it until the bar rolls.
        if (Math.abs(f - 8) * pos.period <= 140) this.pendingEdge = true;
        return;
      }
      if (Math.abs(f - ix) * pos.period <= 140) {
        if (this.pat[ix]) {
          this.slotState[ix] = 1;
          this.slots[ix].style.color = '#34d399';
          this.slots[ix].style.opacity = 1;
          this.verdict.textContent = `slot ${ix + 1} hit ${Math.round((f - ix) * pos.period)}ms`;
          this.verdict.style.color = '#34d399';
        } else {
          this.slotState[ix] = 3;
          this.slots[ix].style.color = '#fbbf24';
          this.slots[ix].style.opacity = 1;
          this.verdict.textContent = `slot ${ix + 1} was a rest`;
          this.verdict.style.color = '#fbbf24';
        }
      } else {
        this.verdict.textContent = 'off the grid';
        this.verdict.style.color = '#f87171';
      }
      return;
    }
    // Free grid: signed offset to nearest grid point in ms.
    const div = this.freeDiv || 1;
    const period = (60000 / this.metro.bpm) / div;
    let best = null;
    for (const { wall } of this.beatTimes || []) {
      for (let k = 0; k < div; k++) {
        const d = now - (wall + k * period);
        if (Math.abs(d) < Math.abs(best ?? Infinity)) best = d;
      }
    }
    if (best === null) return;
    const off = Math.round(best);
    const onBeat = Math.abs(off) <= 70;
    this.offs.push(off);
    if (this.offs.length > 24) this.offs.shift();
    this.verdict.textContent = onBeat ? 'on the beat \u2713' : `${Math.abs(off)}ms ${off > 0 ? 'late' : 'early'}`;
    this.verdict.style.color = onBeat ? '#34d399' : '#fbbf24';
    const avg = this.offs.reduce((a, b) => a + b) / this.offs.length;
    const hits = this.offs.filter(o => Math.abs(o) <= 70).length;
    this.stats.textContent =
      `${hits}/${this.offs.length} on-beat \u00b7 avg ${avg >= 0 ? '+' : ''}${avg.toFixed(0)}ms ` +
      `(${avg > 8 ? 'dragging' : avg < -8 ? 'pushing ahead' : 'centered'})`;
  }
}
