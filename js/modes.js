// Teaching modes: FreePlay (live chord naming), ChordTrainer (shape
// prompts + verdict coaching), ScaleDrill (in-key feedback + ordered runs).

import {
  CHORD_SHAPES, chordFromLabel, chordGap, detectChord,
  midiName, OPEN_MIDI, SCALES, scalePositions, scaleRun, STRING_NAMES,
} from './theory.js';

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
    panel.append(this.readout, this.notes);
    this.debounce = null;
    this.refresh();
  }
  deactivate() {}
  onNotesChange() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 70);
  }
  refresh() {
    const midis = [...this.app.held.values()].map(n => n.midi);
    this.notes.textContent = midis.length
      ? [...this.app.held.entries()].map(([s, n]) => `${STRING_NAMES[s]}:${midiName(n.midi)}`).join('  ')
      : '';
    if (!midis.length) {
      this.readout.textContent = 'no notes held';
      this.readout.style.color = '#334155';
      return;
    }
    const c = detectChord(midis);
    this.readout.textContent = c ? c.label : midis.map(midiName).join(' ');
    this.readout.style.color = c ? '#5eead4' : '#94a3b8';
  }
}

// ── Chord trainer ───────────────────────────────────────────────────────
export class ChordTrainer {
  constructor(app) { this.app = app; }
  activate(panel) {
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
      setTimeout(() => this.app.synth.noteOn(+s, midi, 92), delay);
      setTimeout(() => this.app.synth.noteOff(+s, midi), delay + 1800);
    }
  }

  show(label) {
    this.cur = label;
    const shape = CHORD_SHAPES[label];
    this.app.fretboard.targets = shape;
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
    const perString = [];
    for (const [s, f] of Object.entries(shape)) {
      const held = this.app.held.get(+s);
      if (f === null) {
        if (held) perString.push(`${STRING_NAMES[s]} string should be muted — heard ${midiName(held.midi)}`);
      } else if (!held) {
        perString.push(`${STRING_NAMES[s]} string silent — expected fret ${f}`);
      } else {
        const heard = held.midi - OPEN_MIDI[s];
        if (heard !== f) perString.push(`${STRING_NAMES[s]} fret ${heard} — expected ${f}`);
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
    row.append(this.keySel, this.scaleSel, this.modeSel);
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
