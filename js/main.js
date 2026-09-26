// App wiring: state, mode dispatch, render loop, device management.

import { OPEN_MIDI, midiName, inferString, setTuning, TUNINGS, currentTuningName } from './theory.js';
import { MidiEngine, VirtualJamstik, MidiRecorder } from './midi.js';
import { SynthEngine, RealInput, Metronome, SessionRecorder, PRESETS, PRESET_CATS, VELOCITY_CURVES } from './audio.js';
import { Fretboard } from './fretboard.js';
import { drawScope, drawSpectrum, drawWavetable, drawWaterfall, Spectrogram } from './viz.js';
import { FreePlay, ChordTrainer, ScaleDrill, Tuner, Quiz } from './modes.js';

const $ = id => document.getElementById(id);

const app = {
  held: new Map(), // voiceKey -> {str, midi, vel, bend, inferred}
  history: [],     // {key, str, midi, t0, t1|null, inferred} for the waterfall
  synth: new SynthEngine(),
  real: new RealInput(),
  recorder: null,
  midiRec: null,
  fretboard: null,
  source: null,    // MidiEngine | VirtualJamstik
  mode: null,
  transpose: 0,
  modeName: 'free',
};

// ── MIDI handlers ───────────────────────────────────────────────────────
// key: voice key ('s<n>' per string, 'n<midi>' per note). str is null
// when the device sends single-channel MIDI — string is then inferred
// from pitch for display and flagged `inferred` (weaker coaching).
const handlers = {
  onNoteOn(key, str, rawMidi, vel) {
    const midi = rawMidi + app.transpose;
    let inferred = false;
    if (str == null) {
      const taken = new Set([...app.held.values()].map(n => n.str));
      const pos = inferString(midi, taken);
      if (!pos) { logMidi(`on  ${midiName(midi)} (out of range)`); return; }
      str = pos.string;
      inferred = true;
    }
    app.held.set(key, { str, midi, rawMidi, vel, bend: 0, inferred });
    app.history.push({ key, str, midi, vel, t0: performance.now(), t1: null, inferred });
    if (app.history.length > 2000) app.history.shift();
    app.midiRec?.add(true, str - 1, midi, vel);
    app.synth.noteOn(key, midi, vel, str);
    app.fretboard.active.set(str, { midi, bend: 0 });
    app.mode?.onNoteOn?.(str, midi);
    app.mode?.onNotesChange?.();
    logMidi(`on  s${str}${inferred ? '?' : ''} ${midiName(midi)} v${vel}`);
  },
  onNoteOff(key, str, rawMidi) {
    // Match on the RAW midi so a transpose change mid-hold can't orphan
    // the voice. If the key matches but the raw pitch differs, the off is
    // a stale release for a note that was already re-picked — ignore it.
    let k = key;
    let n = app.held.get(k);
    if (n && n.rawMidi !== rawMidi) return;
    if (!n) {
      const hit = [...app.held.entries()].find(([, v]) => v.rawMidi === rawMidi);
      if (hit) { k = hit[0]; n = hit[1]; }
    }
    if (!n) return;
    app.fretboard.active.delete(n.str);
    app.held.delete(k);
    const open = [...app.history].reverse().find(e => e.key === k && e.t1 === null);
    if (open) open.t1 = performance.now();
    app.midiRec?.add(false, (n.str - 1), n.midi, 64);
    app.synth.noteOff(k, n.midi); // stored pitch -> the guard always passes
    app.mode?.onNoteOff?.(n.str ?? str, n.midi);
    app.mode?.onNotesChange?.();
    logMidi(`off s${n.str} ${midiName(n.midi)}`);
  },
  onAllOff() {
    const now = performance.now();
    for (const e of app.history) if (e.t1 === null) e.t1 = now;
    app.held.clear();
    app.fretboard.active.clear();
    app.synth.allOff();
    app.mode?.onNotesChange?.();
    logMidi('all notes off');
  },
  onPitchBend(str, semis) {
    if (str == null) {
      app.synth.bendAll(semis);
      for (const n of app.held.values()) n.bend = semis;
      for (const f of app.fretboard.active.values()) f.bend = semis;
      logMidi(`bend all ${semis >= 0 ? '+' : ''}${semis.toFixed(2)}`);
      return;
    }
    const hit = [...app.held.entries()].find(([, v]) => v.str === str);
    if (hit) hit[1].bend = semis;
    const f = app.fretboard.active.get(str);
    if (f) f.bend = semis;
    app.synth.bend(hit ? hit[0] : `s${str}`, semis);
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
    eng.chanMode = $('chan-mode').value;
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
const MODES = { free: FreePlay, chords: ChordTrainer, scales: ScaleDrill, tuner: Tuner, quiz: Quiz };

function setMode(name) {
  app.mode?.deactivate?.();
  app.modeName = name;
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

// ── Sounds panel: presets, string assignment, FX, tuning ───────────────
function buildSoundsPanel() {
  const p = $('sounds-panel');
  p.innerHTML = '';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // tuning + transpose + velocity row
  const row1 = el('div', 'row');
  const tunSel = el('select');
  for (const n of Object.keys(TUNINGS)) tunSel.append(el('option', '', n));
  tunSel.value = currentTuningName();
  tunSel.title = 'tuning';
  tunSel.onchange = () => { setTuning(tunSel.value); setMode(app.modeName); };
  const trSel = el('select');
  for (let i = -12; i <= 12; i++) trSel.append(el('option', '', (i > 0 ? '+' : '') + i));
  trSel.value = '0';
  trSel.title = 'transpose (semitones)';
  trSel.onchange = () => { app.transpose = +trSel.value; };
  const velSel = el('select');
  for (const n of Object.keys(VELOCITY_CURVES)) velSel.append(el('option', '', `vel: ${n}`));
  velSel.onchange = () => { app.synth.curveName = velSel.value.slice(5); };
  row1.append(tunSel, trSel, velSel);
  p.append(row1);

  // string assignment chips: pick strings, then click a preset
  const chips = el('div', 'chips');
  const picked = new Set();
  for (const s of [1, 2, 3, 4, 5, 6]) {
    const c = el('button', 'chip', `${s}`);
    c.onclick = () => { picked.has(s) ? picked.delete(s) : picked.add(s); c.classList.toggle('on', picked.has(s)); };
    chips.append(c);
  }
  p.append(el('div', 'hint', 'pick strings (empty = all), then a preset:'));
  p.append(chips);

  // preset grid grouped by category
  for (const cat of PRESET_CATS) {
    const grid = el('div', 'preset-grid');
    for (const [name, spec] of Object.entries(PRESETS)) {
      if (spec.cat !== cat) continue;
      const b = el('button', 'preset', name);
      b.onclick = () => {
        app.synth.setPreset(name, picked.size ? [...picked] : null);
        drawWavetable($('wavetable'), app.synth);
        drawWaterfall($('waterfall'), app.history, app.held, performance.now());
        for (const c of chips.children) c.classList.remove('on');
        picked.clear();
      };
      grid.append(b);
    }
    p.append(el('div', 'cat-label', cat));
    p.append(grid);
  }

  // FX sliders
  p.append(el('div', 'cat-label', 'effects'));
  const slider = (label, min, max, val, cb) => {
    const row = el('div', 'fx-row');
    row.append(el('span', 'fx-label', label));
    const s = el('input');
    s.type = 'range'; s.min = min; s.max = max; s.value = val;
    s.oninput = () => cb(+s.value);
    row.append(s);
    p.append(row);
  };
  slider('drive', 0, 100, 0, v => { app.synth.fx.drive = v / 100; app.synth.applyFX(); });
  slider('tone', 800, 12000, 12000, v => { app.synth.fx.tone = v; app.synth.applyFX(); });
  slider('delay', 0, 100, 0, v => { app.synth.fx.delay = v / 100; app.synth.applyFX(); });
  slider('reverb', 0, 100, 0, v => { app.synth.fx.reverb = v / 100; app.synth.applyFX(); });
  slider('master', 0, 100, 80, v => { app.synth.master.gain.value = v / 100; });

  // record
  const rec = el('button', '', '⏺ record');
  rec.onclick = async () => {
    app.recorder ??= new SessionRecorder(app.synth);
    if (!app.recorder.running) { app.recorder.start(); rec.textContent = '■ recording…'; }
    else { await app.recorder.stop(); rec.textContent = '⏺ record'; }
  };
  const midRec = el('button', '', '⏺ .mid');
  midRec.onclick = () => {
    app.midiRec ??= new MidiRecorder();
    if (!app.midiRec.running) { app.midiRec.start(); midRec.textContent = '■ midi…'; }
    else {
      const blob = new Blob([app.midiRec.stop()], { type: 'audio/midi' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `jamstik-${Date.now()}.mid`;
      a.click();
      URL.revokeObjectURL(a.href);
      midRec.textContent = '⏺ .mid';
    }
  };
  p.append(el('div', 'cat-label', 'capture'));
  p.append(rec, midRec);
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
  drawWaterfall($('waterfall'), app.history, app.held, performance.now());
  app.mode?.frame?.();
  requestAnimationFrame(frame);
}

// ── Boot ────────────────────────────────────────────────────────────────
function init() {
  app.fretboard = new Fretboard($('board'));
  spectro.g = new Spectrogram($('spectrogram'));
  drawWavetable($('wavetable'), app.synth);
  fillDeviceList([]);
  buildDemoPanel();
  buildSoundsPanel();
  setMode('free');

  $('connect').onclick = connectSource;
  $('flip').onchange = () => { if (app.source instanceof MidiEngine) app.source.flip = $('flip').checked; };
  $('chan-mode').onchange = () => {
    if (app.source instanceof MidiEngine) {
      app.source.chanMode = $('chan-mode').value;
      app.source.seenCh.clear();
    }
  };
  $('bend-range').onchange = () => { if (app.source instanceof MidiEngine) app.source.bendRangeSemis = +$('bend-range').value; };
  $('board').addEventListener('pointerdown', boardClick);
  for (const b of document.querySelectorAll('.mode-tab')) {
    b.onclick = () => setMode(b.dataset.mode);
  }

  $('panic').onclick = () => handlers.onAllOff();

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

  // Debug/test hook: inspect app state and inject events from devtools,
  // e.g. __jt.handlers.onNoteOn('n64', null, 64, 100) simulates a
  // single-channel (mono) device sending middle C.
  window.__jt = { app, handlers };
}

init();
