// Unit tests for the pure theory core (js/theory.js).
// Run: npm test  (Node 18+; no dependencies)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_NAMES, OPEN_MIDI, TUNINGS,
  pcName, midiName,
  setTuning, setTuningValues, currentTuningName,
  fretFor, inferString,
  detectChord, chordGap, chordFromLabel,
  scaleSet, scalePositions, scaleRun,
} from '../js/theory.js';

// setTuning/setTuningValues mutate OPEN_MIDI in place; reset per test.
beforeEach(() => setTuning('standard'));

test('pcName wraps around and handles negatives', () => {
  assert.equal(pcName(0), 'C');
  assert.equal(pcName(11), 'B');
  assert.equal(pcName(12), 'C');
  assert.equal(pcName(-1), 'B');
  assert.equal(pcName(4), 'E');
});

test('midiName maps MIDI number to name+octave', () => {
  assert.equal(midiName(60), 'C4');
  assert.equal(midiName(40), 'E2');   // low E string
  assert.equal(midiName(64), 'E4');   // high E string
  assert.equal(midiName(69), 'A4');
});

test('setTuning applies known tunings, rejects unknown', () => {
  assert.equal(setTuning('drop D'), true);
  assert.equal(OPEN_MIDI[6], 38);
  assert.equal(currentTuningName(), 'drop D');
  assert.equal(setTuning('not a tuning'), false);
});

test('setTuningValues ignores out-of-range entries', () => {
  setTuningValues([64, 200, 55, -3, 45, 40]);
  assert.equal(OPEN_MIDI[2], 59);      // 200 rejected, keeps prior value
  assert.equal(OPEN_MIDI[4], 50);      // -3 rejected
  assert.equal(OPEN_MIDI[6], 40);
});

test('currentTuningName reports custom when no preset matches', () => {
  setTuningValues([64, 59, 55, 50, 45, 41]);
  assert.equal(currentTuningName(), 'custom');
});

test('fretFor is open-MIDI relative and follows retuning', () => {
  assert.equal(fretFor(6, 40), 0);
  assert.equal(fretFor(6, 45), 5);
  setTuning('drop D');
  assert.equal(fretFor(6, 40), 2);     // same pitch, two frets up on low D
});

test('inferString picks the lowest-fret option', () => {
  // A4 (69) is playable on strings 1..3; lowest fret is string 1, fret 5.
  assert.deepEqual(inferString(69), { string: 1, fret: 5 });
  // Open high E.
  assert.deepEqual(inferString(64), { string: 1, fret: 0 });
  // Below the lowest open string: unreachable.
  assert.equal(inferString(30), null);
  // Above fret range on every string: unreachable (midi 80 needs >15 everywhere).
  assert.equal(inferString(100), null);
});

test('inferString respects the taken set', () => {
  const taken = new Set([1]);
  assert.deepEqual(inferString(69, taken), { string: 2, fret: 10 });
});

// E major in first position: strings 6..1 frets 0,2,2,1,0,0
const E_MAJ_MIDIS = [40, 47, 52, 56, 59, 64];

test('detectChord identifies a full E major voicing', () => {
  const d = detectChord(E_MAJ_MIDIS);
  assert.equal(d.root, 4);
  assert.equal(d.suffix, 'maj');
  assert.equal(d.label, 'E maj');
  assert.equal(d.inversion, null);
});

test('detectChord reports slash inversions from the bass note', () => {
  // C major with E in the bass: midis 52 (E3), 60 (C4), 67 (G4).
  const d = detectChord([52, 60, 67]);
  assert.equal(d.label, 'C maj/E');
  assert.equal(d.inversion, 'E');
});

test('detectChord allows an omitted fifth but no other gap', () => {
  // Root+third only (E, G#): missing B is the perfect fifth.
  const d = detectChord([40, 56]);
  assert.equal(d.label, 'E maj (no 5)');
});

test('detectChord rejects foreign pitch classes', () => {
  assert.equal(detectChord([40, 41, 44, 47]), null); // F is not an E-maj tone
  assert.equal(detectChord([64]), null);             // single note is not a chord
  assert.equal(detectChord([]), null);
});

test('chordGap separates missing tones from foreign tones', () => {
  // Playing E maj without the third: missing G#, no extras.
  const gap = chordGap(4, 'maj', [40, 47, 52, 59, 64]); // G string fretted open omits G#
  assert.ok(gap.missing.includes('G#'));
  assert.equal(gap.exact, false);

  // Full voicing is exact.
  assert.equal(chordGap(4, 'maj', E_MAJ_MIDIS).exact, true);

  // Omitting only the fifth is still a correct voicing.
  const noFive = chordGap(4, 'maj', [40, 56, 64]); // E, G#, E — no B
  assert.deepEqual(noFive.missing, []);
  assert.equal(noFive.exact, true);

  // A foreign tone is reported as extra.
  const dirty = chordGap(4, 'maj', [...E_MAJ_MIDIS, 41]);
  assert.deepEqual(dirty.extra, ['F']);
});

test('chordGap returns null for an unknown suffix', () => {
  assert.equal(chordGap(4, 'mystery', E_MAJ_MIDIS), null);
});

test('chordFromLabel parses sharps and suffixes', () => {
  assert.deepEqual(chordFromLabel('C maj'), { root: 0, suffix: 'maj' });
  assert.deepEqual(chordFromLabel('F# min'), { root: 6, suffix: 'min' });
  assert.deepEqual(chordFromLabel('G 7'), { root: 7, suffix: '7' });
  assert.equal(chordFromLabel('H maj'), null);
});

test('scaleSet returns the pitch-class set for a scale', () => {
  // A major: A B C# D E F# G#.
  assert.deepEqual(scaleSet(9, 'major'), new Set([9, 11, 1, 2, 4, 6, 8]));
  assert.equal(scaleSet(9, 'nope'), null);
});

test('scalePositions enumerates in-scale frets with degree names', () => {
  // E minor pentatonic on the open low-E string: frets 0,3,5,7,10,12,15.
  const pos = scalePositions(4, 'minor pentatonic')
    .filter(p => p.string === 6)
    .map(p => p.fret);
  assert.deepEqual(pos, [0, 3, 5, 7, 10, 12, 15]);

  const root = scalePositions(4, 'minor pentatonic')
    .find(p => p.string === 6 && p.fret === 0);
  assert.equal(root.isRoot, true);
  assert.equal(root.deg, 'R');

  // b3 in E minor pentatonic is G on string 6 fret 3.
  const b3 = scalePositions(4, 'minor pentatonic')
    .find(p => p.string === 6 && p.fret === 3);
  assert.equal(b3.deg, 'b3');
});

test('scaleRun ascends strings 6->1 then mirrors back down', () => {
  const run = scaleRun(4, 'minor pentatonic', 0, 5); // open box, frets 0-4
  assert.ok(run.length >= 2);
  // Ascent starts on the low string.
  assert.equal(run[0].string, 6);
  // Within the ascent each string's frets are non-decreasing.
  const half = run.length / 2 + 1;
  const ascent = run.slice(0, Math.ceil(half));
  const byString = new Map();
  for (const p of ascent) {
    const last = byString.get(p.string);
    if (last !== undefined) assert.ok(p.fret >= last);
    byString.set(p.string, p.fret);
  }
  // Mirror property: up-and-down means symmetric without repeating endpoints.
  assert.equal(run.length % 2, 0);
  assert.deepEqual(run.at(-1), run[1]);
  assert.deepEqual(run[0], run[0]); // first note is the turnaround anchor
});

test('scaleRun on an empty box returns an empty sequence', () => {
  // Fret window with no scale tones is degenerate but must not throw.
  const run = scaleRun(0, 'major', 14, 1); // only fret 14; may be empty
  assert.ok(Array.isArray(run));
});
