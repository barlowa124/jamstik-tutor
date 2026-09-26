// Music theory core: tuning, note naming, chord detection, scale tables.
// All functions are pure; no Web APIs imported here.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const pcName = pc => NOTE_NAMES[((pc % 12) + 12) % 12];

export const midiName = m => pcName(m) + (Math.floor(m / 12) - 1);

// Standard tuning: string number -> open-string MIDI note.
// String 1 = high E (thinnest), string 6 = low E.
export const OPEN_MIDI = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
export const STRING_NAMES = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };
export const STRING_COUNT = 6;
export const FRET_COUNT = 15;

// Alternate tunings, open MIDI per string 1..6 (high e .. low E).
// setTuning mutates OPEN_MIDI in place so every consumer (inference,
// fret math, scale positions, trainer verdicts) follows automatically.
export const TUNINGS = {
  'standard':       [64, 59, 55, 50, 45, 40],
  'drop D':         [64, 59, 55, 50, 45, 38],
  'DADGAD':         [62, 57, 55, 50, 45, 38],
  'open G':         [62, 59, 55, 50, 43, 38],
  'open D':         [62, 57, 54, 50, 45, 38],
  'open C':         [64, 60, 55, 48, 43, 36],
  'open E':         [64, 59, 56, 52, 47, 40],
  'drop C':         [62, 59, 55, 50, 43, 36],
  'half-step down': [63, 58, 54, 49, 44, 39],
  'whole-step down':[62, 57, 53, 48, 43, 38],
};

export function setTuning(name) {
  const t = TUNINGS[name];
  if (!t) return false;
  for (let s = 1; s <= 6; s++) OPEN_MIDI[s] = t[s - 1];
  return true;
}

// Direct open-note values for the custom tuning editor. Values outside
// a sane open-string range are ignored rather than clamped silently.
export function setTuningValues(arr) {
  for (let s = 1; s <= 6; s++) {
    const v = arr[s - 1] | 0;
    if (v >= 12 && v <= 84) OPEN_MIDI[s] = v;
  }
}

export function currentTuningName() {
  for (const [name, t] of Object.entries(TUNINGS)) {
    if ([1, 2, 3, 4, 5, 6].every(s => OPEN_MIDI[s] === t[s - 1])) return name;
  }
  return 'custom';
}

export const fretFor = (stringNum, midi) => midi - OPEN_MIDI[stringNum];

// When the device sends single-channel MIDI it does not name the string.
// Infer the lowest-fret position that produces this pitch on a free string.
export function inferString(midi, taken = new Set()) {
  let best = null;
  for (let s = 1; s <= 6; s++) {
    if (taken.has(s)) continue;
    const f = midi - OPEN_MIDI[s];
    if (f < 0 || f > FRET_COUNT) continue;
    if (best === null || f < best.fret) best = { string: s, fret: f };
  }
  return best;
}

// Chord qualities as interval patterns (semitones from root).
// Ordered so richer qualities win ties in detection.
const CHORD_PATTERNS = [
  { suffix: 'maj9',  iv: [0, 4, 7, 11, 2] },
  { suffix: '9',     iv: [0, 4, 7, 10, 2] },
  { suffix: 'm9',    iv: [0, 3, 7, 10, 2] },
  { suffix: 'm7',    iv: [0, 3, 7, 10] },
  { suffix: 'maj7',  iv: [0, 4, 7, 11] },
  { suffix: '7',     iv: [0, 4, 7, 10] },
  { suffix: 'm7b5',  iv: [0, 3, 6, 10] },
  { suffix: 'dim7',  iv: [0, 3, 6, 9] },
  { suffix: '7sus4', iv: [0, 5, 7, 10] },
  { suffix: '6',     iv: [0, 4, 7, 9] },
  { suffix: 'm6',    iv: [0, 3, 7, 9] },
  { suffix: 'add9',  iv: [0, 4, 7, 2] },
  { suffix: 'maj',   iv: [0, 4, 7] },
  { suffix: 'min',   iv: [0, 3, 7] },
  { suffix: 'sus2',  iv: [0, 2, 7] },
  { suffix: 'sus4',  iv: [0, 5, 7] },
  { suffix: 'dim',   iv: [0, 3, 6] },
  { suffix: 'aug',   iv: [0, 4, 8] },
  { suffix: '5',     iv: [0, 7] },
];

const setOf = (root, iv) => new Set(iv.map(i => (root + i) % 12));

// Common open/first-position fingerings: chord label -> {string: fret|null(muted)}
// Null means muted; 0 means open. Used to draw target shapes in the trainer.
export const CHORD_SHAPES = {
  'C maj':   { 6: null, 5: 3, 4: 2, 3: 0, 2: 1, 1: 0 },
  'G maj':   { 6: 3, 5: 2, 4: 0, 3: 0, 2: 0, 1: 3 },
  'D maj':   { 6: null, 5: null, 4: 0, 3: 2, 2: 3, 1: 2 },
  'A maj':   { 6: null, 5: 0, 4: 2, 3: 2, 2: 2, 1: 0 },
  'E maj':   { 6: 0, 5: 2, 4: 2, 3: 1, 2: 0, 1: 0 },
  'A min':   { 6: null, 5: 0, 4: 2, 3: 2, 2: 1, 1: 0 },
  'E min':   { 6: 0, 5: 2, 4: 2, 3: 0, 2: 0, 1: 0 },
  'D min':   { 6: null, 5: null, 4: 0, 3: 2, 2: 3, 1: 1 },
  'F maj':   { 6: 1, 5: 3, 4: 3, 3: 2, 2: 1, 1: 1 },
  'G 7':     { 6: 3, 5: 2, 4: 0, 3: 0, 2: 0, 1: 1 },
  'C 7':     { 6: null, 5: 3, 4: 2, 3: 3, 2: 1, 1: 0 },
  'D 7':     { 6: null, 5: null, 4: 0, 3: 2, 2: 1, 1: 2 },
  'A 7':     { 6: null, 5: 0, 4: 2, 3: 0, 2: 2, 1: 0 },
  'E 7':     { 6: 0, 5: 2, 4: 0, 3: 1, 2: 0, 1: 0 },
  'A m7':    { 6: null, 5: 0, 4: 2, 3: 0, 2: 1, 1: 0 },
  'E m7':    { 6: 0, 5: 2, 4: 0, 3: 0, 2: 0, 1: 0 },
  'D m7':    { 6: null, 5: null, 4: 0, 3: 2, 2: 1, 1: 1 },
  'B maj':   { 6: null, 5: 2, 4: 4, 3: 4, 2: 4, 1: 2 },
  'B min':   { 6: null, 5: 2, 4: 4, 3: 4, 2: 3, 1: 2 },
  'B 7':     { 6: null, 5: 2, 4: 1, 3: 2, 2: 0, 1: 2 },
  'C min':   { 6: null, 5: 3, 4: 5, 3: 5, 2: 4, 1: 3 },
  'F# min':  { 6: 2, 5: 4, 4: 4, 3: 2, 2: 2, 1: 2 },
  'G m7':    { 6: 3, 5: 5, 4: 3, 3: 3, 2: 3, 1: 3 },
};

export const chordLabel = (rootPc, suffix) =>
  pcName(rootPc) + (suffix === 'maj' ? ' maj' : suffix === 'min' ? ' min' : ' ' + suffix);

// Detect a chord from sounding MIDI notes.
// Returns { root, suffix, label, bass, inversion, notes } or null.
// Every sounding pitch class must belong to the chord; unknown extras reject.
export function detectChord(midis) {
  const pcs = new Set(midis.map(m => ((m % 12) + 12) % 12));
  if (pcs.size < 2) return null;
  const bass = ((Math.min(...midis)) % 12 + 12) % 12;

  let best = null;
  for (const pat of CHORD_PATTERNS) {
    for (const root of pcs) {
      const req = setOf(root, pat.iv);
      if (![...pcs].every(pc => req.has(pc))) continue; // every sounding pc is a chord tone
      const fifth = (root + 7) % 12;
      const missing = [...req].filter(pc => !pcs.has(pc));
      if (missing.some(pc => pc !== fifth)) continue;   // only the perfect 5th may be omitted
      const score = pcs.size * 10 + (bass === root ? 5 : 0) + (pat.iv.length >= 4 ? 1 : 0);
      if (!best || score > best.score) {
        const inv = bass !== root;
        best = {
          score, root, suffix: pat.suffix, bass,
          inversion: inv ? pcName(bass) : null,
          label: chordLabel(root, pat.suffix)
            + (missing.length ? ' (no 5)' : '')
            + (inv ? '/' + pcName(bass) : ''),
          notes: [...req],
        };
      }
    }
  }
  return best;
}

// Coaching view for a known target chord: what is missing, what is foreign.
export function chordGap(targetRoot, targetSuffix, midis) {
  const pat = CHORD_PATTERNS.find(p => p.suffix === targetSuffix);
  if (!pat) return null;
  const req = setOf(targetRoot, pat.iv);
  const played = new Set(midis.map(m => ((m % 12) + 12) % 12));
  const missing = [...req].filter(pc => !played.has(pc)).map(pcName);
  const extra = [...played].filter(pc => !req.has(pc)).map(pcName);
  // An omitted perfect 5th is a correct voicing, not a gap.
  const fifth = pcName((targetRoot + 7) % 12);
  const realMissing = missing.filter(n => n !== fifth);
  return { required: [...req].map(pcName), missing: realMissing, extra,
           exact: realMissing.length === 0 && extra.length === 0 };
}

export function chordFromLabel(label) {
  const m = label.match(/^([A-G]#?|B♭|E♭|A♭|D♭|G♭)\s*(.*)$/);
  if (!m) return null;
  const root = NOTE_NAMES.indexOf(m[1]);
  return root < 0 ? null : { root, suffix: m[2].trim() };
}

// Scale formulas: name -> semitone pattern from tonic.
export const SCALES = {
  'major':            [0, 2, 4, 5, 7, 9, 11],
  'natural minor':    [0, 2, 3, 5, 7, 8, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'blues':            [0, 3, 5, 6, 7, 10],
  'dorian':           [0, 2, 3, 5, 7, 9, 10],
  'mixolydian':       [0, 2, 4, 5, 7, 9, 10],
  'harmonic minor':   [0, 2, 3, 5, 7, 8, 11],
};

export function scaleSet(rootPc, scaleName) {
  const iv = SCALES[scaleName];
  if (!iv) return null;
  return new Set(iv.map(i => (rootPc + i) % 12));
}

// All (string, fret) positions that produce scale tones within FRET_COUNT.
export function scalePositions(rootPc, scaleName) {
  const s = scaleSet(rootPc, scaleName);
  if (!s) return [];
  const out = [];
  for (let str = 1; str <= STRING_COUNT; str++) {
    for (let f = 0; f <= FRET_COUNT; f++) {
      const pc = (OPEN_MIDI[str] + f) % 12;
      if (s.has(pc)) out.push({ string: str, fret: f, pc, isRoot: pc === rootPc });
    }
  }
  return out;
}

// Ordered practice run: one position box (frets lo..lo+4), ascending then descending.
export function scaleRun(rootPc, scaleName, lo = 0, span = 5) {
  const positions = scalePositions(rootPc, scaleName)
    .filter(p => p.fret >= lo && p.fret < lo + span);
  const byString = new Map();
  for (const p of positions) {
    if (!byString.has(p.string)) byString.set(p.string, []);
    byString.get(p.string).push(p);
  }
  // Low string (6) to high (1), lowest fret first on each string.
  const seq = [];
  for (let s = 6; s >= 1; s--) {
    const list = (byString.get(s) || []).sort((a, b) => a.fret - b.fret);
    seq.push(...list);
  }
  return seq.concat([...seq].reverse().slice(1, -1)); // up and back down
}
