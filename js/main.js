// App wiring: state, mode dispatch, render loop, device management.

import { OPEN_MIDI, midiName } from './theory.js';
import { MidiEngine, VirtualJamstik } from './midi.js';
import { SynthEngine, RealInput, Metronome } from './audio.js';
import { Fretboard } from './fretboard.js';
import { drawScope, drawSpectrum, drawWavetable, Spectrogram } from './viz.js';
import { FreePlay, ChordTrainer, ScaleDrill } from './modes.js';

const $ = id => document.getElementById(id);

const app = {
  held: new Map(), // string -> {midi, vel, bend}
  synth: new SynthEngine(),
  real: new RealInput(),
  fretboard: null,
  source: null,    // MidiEngine | VirtualJamstik
  mode: null,
};

// ── MIDI handlers ───────────────────────────────────────────────────────
const handlers = {
  onNoteOn(str, midi, vel) {
    app.held.set(str, { midi, vel, bend: 0 });
    app.synth.noteOn(str, midi, vel);
    app.fretboard.active.set(str, { midi, bend: 0 });
    app.mode?.onNoteOn?.(str, midi);
    app.mode?.onNotesChange?.();
    logMidi(`on  s${str} ${midiName(midi)} v${vel}`);
  },
  onNoteOff(str, midi) {
    app.held.delete(str);
    app.synth.noteOff(str, midi);
    app.fretboard.active.delete(str);
    app.mode?.onNoteOff?.(str, midi);
    app.mode?.onNotesChange?.();
    logMidi(`off s${str} ${midiName(midi)}`);
  },
  onPitchBend(str, semis) {
    const n = app.held.get(str);
    if (n) n.bend = semis;
    const f = app.fretboard.active.get(str);
    if (f) f.bend = semis;
    app.synth.bend(str, semis);
    logMidi(`bend s${str} ${semis >= 0 ? '+' : ''}${semis.toFixed(2)}`);
  },
  onStateChange(text) { $('status').textContent = text; },
  onInputsChanged(inputs) { fillDeviceList(inputs); },
};

function logMidi(text) {
  const el = $('midi-log');
  el.textContent = `${text}\n` + el.textContent.split('\n').slice(0, 5).join('\n');
}

// ── Devices ─────────────────────────────────────────────────────────────
async function connectSource() {
  const sel = $('device');
  app.synth.ensure();
  app.source?.disconnect?.();
  if (sel.value === 'virtual') {
    app.source = new VirtualJamstik(handlers);
    app.source.connect();
    $('demo-panel').style.display = '';
  } else {
    $('demo-panel').style.display = 'none';
    const eng = new MidiEngine(handlers);
    eng.flip = $('flip').checked;
    eng.bendRangeSemis = +$('bend-range').value;
    app.source = eng;
    const ok = await eng.connect(sel.value === 'auto' ? null : sel.value);
    if (ok) fillDeviceList(eng.listInputs());
    else fillDeviceList([]);
  }
}

function fillDeviceList(inputs) {
  const sel = $('device');
  const cur = sel.value;
  sel.innerHTML = '';
  sel.append(new Option('virtual demo device', 'virtual'));
  for (const i of inputs) sel.append(new Option(i.name, i.id));
  if (inputs.length) sel.prepend(new Option('auto-detect (Jamstik)', 'auto'));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : sel.options[0].value;
}

// ── Modes ───────────────────────────────────────────────────────────────
const MODES = { free: FreePlay, chords: ChordTrainer, scales: ScaleDrill };

function setMode(name) {
  app.mode?.deactivate?.();
  const panel = $('mode-panel');
  panel.innerHTML = '';
  app.mode = new MODES[name](app);
  app.mode.activate(panel);
  for (const b of document.querySelectorAll('.mode-tab')) {
    b.classList.toggle('active', b.dataset.mode === name);
  }
}

// ── Demo panel (virtual device) ─────────────────────────────────────────
function buildDemoPanel() {
  const p = $('demo-panel');
  p.innerHTML = '<div class="hint">demo device — strum a chord or click frets on the board</div>';
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, shape] of Object.entries({
    'C': { 6: null, 5: 3, 4: 2, 3: 0, 2: 1, 1: 0 },
    'G': { 6: 3, 5: 2, 4: 0, 3: 0, 2: 0, 1: 3 },
    'Am': { 6: null, 5: 0, 4: 2, 3: 2, 2: 1, 1: 0 },
    'Em': { 6: 0, 5: 2, 4: 2, 3: 0, 2: 0, 1: 0 },
  })) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => app.source.strum(shape, OPEN_MIDI);
    row.append(b);
  }
  const run = document.createElement('button');
  run.textContent = 'A min-pent run';
  run.onclick = () => {
    // A minor pentatonic box 1 (open position), strings 6->1 ascending.
    // Frets per string: E:0,3 A:0,3 D:0,2 G:0,2 B:1,3 e:0,3
    const events = [];
    const positions = [
      [6, 0], [6, 3], [5, 0], [5, 3], [4, 0], [4, 2],
      [3, 0], [3, 2], [2, 1], [2, 3], [1, 0], [1, 3],
    ];
    positions.concat([...positions].reverse().slice(1))
      .forEach(([s, f], i) => events.push({ string: s, open: OPEN_MIDI[s], fret: f, ms: i * 280, dur: 250 }));
    app.source.sequence(events);
  };
  const bend = document.createElement('button');
  bend.textContent = 'bend demo';
  bend.onclick = () => {
    const midi = OPEN_MIDI[3] + 7; // G string, fret 7
    app.source.noteOn(3, midi, 100);
    let t = 0;
    for (let i = 1; i <= 20; i++) {
      setTimeout(() => app.source.bend(3, Math.sin(i / 20 * Math.PI) * 2), i * 40);
    }
    setTimeout(() => app.source.noteOff(3, midi), 1400);
  };
  row.append(run, bend);
  p.append(row);
}

// Click-to-play on the fretboard in demo mode.
function boardClick(e) {
  if (!(app.source instanceof VirtualJamstik)) return;
  const fb = app.fretboard;
  const r = fb.cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let bestStr = 1, bestD = 1e9;
  for (let s = 1; s <= 6; s++) {
    const d = Math.abs(y - fb.stringY(s));
    if (d < bestD) { bestD = d; bestStr = s; }
  }
  let fret = 0;
  for (let f = 0; f <= 15; f++) {
    if (Math.abs(x - fb.fretCenter(f)) < Math.abs(x - fb.fretCenter(fret))) fret = f;
  }
  const midi = OPEN_MIDI[bestStr] + fret;
  app.source.noteOn(bestStr, midi, 95);
  const up = () => { app.source.noteOff(bestStr, midi); removeEventListener('pointerup', up); };
  addEventListener('pointerup', up);
}

// ── Render loop ─────────────────────────────────────────────────────────
const spectro = { g: null };

function frame() {
  app.fretboard.draw();
  const synthSrc = { analyser: app.synth.analyser, color: '#5eead4', label: 'synth' };
  const realSrc = { analyser: app.real.analyser, color: '#f472b6', label: 'input' };
  drawScope($('scope'), [synthSrc, realSrc]);
  drawSpectrum($('spectrum'), [synthSrc, realSrc]);
  spectro.g.draw(app.synth.analyser);
  requestAnimationFrame(frame);
}

// ── Boot ────────────────────────────────────────────────────────────────
function init() {
  app.fretboard = new Fretboard($('board'));
  spectro.g = new Spectrogram($('spectrogram'));
  drawWavetable($('wavetable'));
  fillDeviceList([]);
  buildDemoPanel();
  setMode('free');

  $('connect').onclick = connectSource;
  $('flip').onchange = () => { if (app.source instanceof MidiEngine) app.source.flip = $('flip').checked; };
  $('bend-range').onchange = () => { if (app.source instanceof MidiEngine) app.source.bendRangeSemis = +$('bend-range').value; };
  $('board').addEventListener('pointerdown', boardClick);
  for (const b of document.querySelectorAll('.mode-tab')) {
    b.onclick = () => setMode(b.dataset.mode);
  }

  $('real-in').onclick = async () => {
    try {
      app.synth.ensure();
      await app.real.start(app.synth.ctx);
      $('real-in').textContent = 'input: live';
    } catch {
      $('real-in').textContent = 'input: denied';
    }
  };

  const metro = { m: null };
  $('metro').onclick = () => {
    app.synth.ensure();
    if (!metro.m) metro.m = new Metronome(app.synth.ctx);
    if (metro.m.running) {
      metro.m.stop();
      $('metro').textContent = '▶ metronome';
      $('metro-led').style.opacity = 0.15;
    } else {
      metro.m.bpm = +$('bpm').value || 80;
      metro.m.onTick = b => {
        $('metro-led').style.opacity = 1;
        $('metro-led').style.background = b % 4 === 0 ? '#5eead4' : '#334155';
        setTimeout(() => $('metro-led').style.opacity = 0.15, 90);
      };
      metro.m.start();
      $('metro').textContent = '■ metronome';
    }
  };

  requestAnimationFrame(frame);
}

init();
