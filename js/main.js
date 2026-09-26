// App wiring: state, mode dispatch, render loop, device management.

import { OPEN_MIDI, midiName, inferString, setTuning, setTuningValues, TUNINGS, currentTuningName, STRING_NAMES } from './theory.js';
import { MidiEngine, VirtualJamstik, MidiRecorder, MidiPlayer, parseSmf } from './midi.js';
import { SynthEngine, RealInput, Metronome, SessionRecorder, PRESETS, PRESET_CATS, VELOCITY_CURVES } from './audio.js';
import { Fretboard } from './fretboard.js';
import { drawScope, drawSpectrum, drawWavetable, drawWaterfall, drawStaff, Spectrogram } from './viz.js';
import { FreePlay, ChordTrainer, ScaleDrill, Tuner, Quiz, ChordChanges, RiffDrill, RhythmDrill } from './modes.js';

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
// Control registry + localStorage persistence so presets, tuning, FX,
// and header options survive a reload.
const ui = {};
const SETKEY = 'jamstik-tutor-settings-v1';

function saveSettings() {
  try {
    localStorage.setItem(SETKEY, JSON.stringify({
      tuning: [1, 2, 3, 4, 5, 6].map(s => OPEN_MIDI[s]),
      transpose: app.transpose,
      curve: app.synth.curveName,
      fx: { ...app.synth.fx },
      master: app.synth.masterLevel,
      presets: { ...app.synth.presetByString },
      chanMode: $('chan-mode').value,
      flip: $('flip').checked,
      bend: $('bend-range').value,
      bpm: $('bpm').value,
    }));
  } catch { /* storage unavailable */ }
}

function restoreSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETKEY)); } catch { return; }
  if (!s) return;
  if (s.flip != null) $('flip').checked = !!s.flip;
  if (s.bend != null) $('bend-range').value = s.bend;
  if (s.bpm != null) $('bpm').value = s.bpm;
  if (s.chanMode != null) $('chan-mode').value = s.chanMode;
  if (Array.isArray(s.tuning)) setTuningValues(s.tuning);
  if (s.transpose != null) app.transpose = +s.transpose;
  if (s.curve) app.synth.curveName = s.curve;
  if (s.fx) Object.assign(app.synth.fx, s.fx);
  if (s.master != null) app.synth.masterLevel = s.master;
  if (s.presets) for (const [str, name] of Object.entries(s.presets)) {
    if (PRESETS[name]) app.synth.presetByString[+str] = name;
  }
  // Reflect everything into the rebuilt panel controls.
  if (ui.tunSel) {
    ui.tunSel.value = currentTuningName();
    ui.customRow.style.display = ui.tunSel.value === 'custom' ? '' : 'none';
    ui.syncCustom();
  }
  if (ui.trSel) ui.trSel.value = (app.transpose > 0 ? '+' : '') + app.transpose;
  if (ui.velSel) ui.velSel.value = `vel: ${app.synth.curveName}`;
  if (ui.fx_drive) ui.fx_drive.value = app.synth.fx.drive * 100;
  if (ui.fx_tone) ui.fx_tone.value = app.synth.fx.tone;
  if (ui.fx_delay) ui.fx_delay.value = app.synth.fx.delay * 100;
  if (ui.fx_reverb) ui.fx_reverb.value = app.synth.fx.reverb * 100;
  if (ui.fx_master) ui.fx_master.value = app.synth.masterLevel * 100;
}

// Daily drill tallies, persisted so practice history survives reloads.
app.bump = (kind, hit, lat) => {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const all = JSON.parse(localStorage.getItem('jamstik-tutor-stats') || '{}');
    const k = (all[day] ??= {})[kind] ??= { h: 0, t: 0, lat: 0 };
    k.t++;
    if (hit) { k.h++; k.lat += lat; }
    localStorage.setItem('jamstik-tutor-stats', JSON.stringify(all));
    return k;
  } catch { return null; }
};

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
    app.held.set(key, { str, midi, rawMidi, vel, bend: 0, inferred, amp: 1 });
    app.history.push({ key, str, midi, vel, t0: performance.now(), t1: null, inferred });
    if (app.history.length > 2000) app.history.shift();
    app.midiRec?.add(true, inferred ? null : str, midi, vel, rawMidi);
    app.synth.noteOn(key, midi, vel, str);
    app.fretboard.active.set(str, { midi, bend: 0, amp: 1 });
    app.mode?.onNoteOn?.(str, midi, vel);
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
    app.midiRec?.add(false, n.inferred ? null : n.str, n.midi, 64, n.rawMidi);
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
    if (!Number.isFinite(semis)) return;
    app.midiRec?.bend(str, semis);
    if (str == null) {
      app.synth.bendAll(semis);
      for (const n of app.held.values()) n.bend = semis;
      for (const f of app.fretboard.active.values()) f.bend = semis;
      logMidi(`bend all ${semis >= 0 ? '+' : ''}${semis.toFixed(2)}`);
      app.mode?.onBend?.(str, semis);
      return;
    }
    const hit = [...app.held.entries()].find(([, v]) => v.str === str);
    if (hit) hit[1].bend = semis;
    const f = app.fretboard.active.get(str);
    if (f) f.bend = semis;
    app.synth.bend(hit ? hit[0] : `s${str}`, semis);
    app.mode?.onBend?.(str, semis);
    logMidi(`bend s${str} ${semis >= 0 ? '+' : ''}${semis.toFixed(2)}`);
  },
  // CC11 from the Jamstik: the string's measured amplitude, 0-1.
  // Per-string in multi-channel mode; in single-channel it applies to
  // whatever is currently ringing (channel-wide semantics).
  onExpression(str, v) {
    if (!Number.isFinite(v)) return;
    if (str != null) {
      const n = app.held.get(`s${str}`);
      if (n) n.amp = v;
      const f = app.fretboard.active.get(str);
      if (f) f.amp = v;
      app.synth.setExpression(`s${str}`, v);
      return;
    }
    for (const [k, n] of app.held) { n.amp = v; app.synth.setExpression(k, v); }
    for (const f of app.fretboard.active.values()) f.amp = v;
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
const MODES = { free: FreePlay, chords: ChordTrainer, scales: ScaleDrill, riffs: RiffDrill, rhythm: RhythmDrill, tuner: Tuner, quiz: Quiz, changes: ChordChanges };

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
  tunSel.append(el('option', '', 'custom'));
  tunSel.value = currentTuningName();
  tunSel.title = 'tuning';
  const customRow = el('div', 'row');
  customRow.style.display = 'none';
  const syncCustom = () => {
    for (const cs of customRow.querySelectorAll('select')) cs.value = OPEN_MIDI[cs.dataset.str];
  };
  const applyCustom = () => {
    const vals = [];
    for (const cs of customRow.querySelectorAll('select')) vals[+cs.dataset.str - 1] = +cs.value;
    setTuningValues(vals);
    setMode(app.modeName);
    saveSettings();
  };
  for (const s of [6, 5, 4, 3, 2, 1]) {
    const cs = el('select');
    cs.dataset.str = s;
    cs.title = `open note of the ${STRING_NAMES[s]} string`;
    for (let m = 24; m <= 72; m++) {
      const o = el('option', '', midiName(m));
      o.value = m;
      cs.append(o);
    }
    cs.value = OPEN_MIDI[s];
    cs.onchange = applyCustom;
    customRow.append(el('span', 'fx-label', STRING_NAMES[s]), cs);
  }
  tunSel.onchange = () => {
    if (tunSel.value === 'custom') {
      customRow.style.display = '';
      syncCustom();
      applyCustom();
    } else {
      customRow.style.display = 'none';
      setTuning(tunSel.value);
      syncCustom();
      setMode(app.modeName);
    }
    saveSettings();
  };
  const trSel = el('select');
  for (let i = -12; i <= 12; i++) trSel.append(el('option', '', (i > 0 ? '+' : '') + i));
  trSel.value = '0';
  trSel.title = 'transpose (semitones)';
  trSel.onchange = () => { app.transpose = +trSel.value; saveSettings(); };
  const velSel = el('select');
  for (const n of Object.keys(VELOCITY_CURVES)) velSel.append(el('option', '', `vel: ${n}`));
  velSel.onchange = () => { app.synth.curveName = velSel.value.slice(5); saveSettings(); };
  row1.append(tunSel, trSel, velSel);
  p.append(row1);
  p.append(customRow);
  ui.tunSel = tunSel; ui.trSel = trSel; ui.velSel = velSel; ui.customRow = customRow; ui.syncCustom = syncCustom;

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
        saveSettings();
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
    s.oninput = () => { cb(+s.value); saveSettings(); };
    row.append(s);
    ui[`fx_${label}`] = s;
    p.append(row);
  };
  slider('drive', 0, 100, 0, v => { app.synth.fx.drive = v / 100; app.synth.applyFX(); });
  slider('tone', 800, 12000, 12000, v => { app.synth.fx.tone = v; app.synth.applyFX(); });
  slider('delay', 0, 100, 0, v => { app.synth.fx.delay = v / 100; app.synth.applyFX(); });
  slider('reverb', 0, 100, 0, v => { app.synth.fx.reverb = v / 100; app.synth.applyFX(); });
  slider('master', 0, 100, 80, v => {
    app.synth.masterLevel = v / 100;
    if (app.synth.master) app.synth.master.gain.value = v / 100;
  });

  // record
  const rec = el('button', '', '⏺ record');
  rec.onclick = async () => {
    app.recorder ??= new SessionRecorder(app.synth);
    if (!app.recorder.running) { app.recorder.start(); rec.textContent = '■ recording…'; }
    else { await app.recorder.stop(); rec.textContent = '⏺ record'; }
  };
  const midRec = el('button', '', '⏺ .mid');
  const midPlay = el('button', '', '▶ take');
  midPlay.disabled = true;
  midRec.onclick = () => {
    app.midiRec ??= new MidiRecorder();
    if (!app.midiRec.running) { app.midiRec.start(); midRec.textContent = '■ midi…'; }
    else {
      const events = app.midiRec.events.slice();
      const blob = new Blob([app.midiRec.stop()], { type: 'audio/midi' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `jamstik-${Date.now()}.mid`;
      a.click();
      URL.revokeObjectURL(a.href);
      midRec.textContent = '⏺ .mid';
      app.lastMidi = events;
      midPlay.disabled = !events.length;
    }
  };
  const loopLbl = el('label', 'hint');
  const loopChk = el('input');
  loopChk.type = 'checkbox';
  loopLbl.append(loopChk, ' loop');
  let manualStop = false;
  const startPlay = () => {
    manualStop = false;
    app.midiPlayer.play(app.lastMidi, () => {
      if (!manualStop && loopChk.checked && app.lastMidi?.length) startPlay();
      else midPlay.textContent = '▶ take';
    });
    midPlay.textContent = '■ playing…';
  };
  midPlay.onclick = () => {
    app.midiPlayer ??= new MidiPlayer(handlers);
    if (app.midiPlayer.playing) { manualStop = true; app.midiPlayer.finish(); }
    else if (app.lastMidi?.length) {
      app.synth.ensure();
      startPlay();
    }
  };
  const loadLbl = el('label', 'file-btn', 'open .mid');
  const fileIn = el('input');
  fileIn.type = 'file';
  fileIn.accept = '.mid,.midi,audio/midi';
  fileIn.style.display = 'none';
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const events = parseSmf(new Uint8Array(await f.arrayBuffer()));
      if (!events.length) throw new Error('no note events');
      app.lastMidi = events;
      midPlay.disabled = false;
      loadLbl.textContent = `loaded ${f.name.length > 16 ? f.name.slice(0, 14) + '…' : f.name}`;
    } catch (err) {
      loadLbl.textContent = 'bad .mid';
      setTimeout(() => { loadLbl.textContent = 'open .mid'; }, 1500);
    }
    fileIn.value = '';
  };
  loadLbl.append(fileIn);
  p.append(el('div', 'cat-label', 'capture'));
  p.append(rec, midRec, midPlay, loadLbl, loopLbl);
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
  drawStaff($('staff'), [...app.held.values()].map(n => n.midi));
  // Session tally, refreshed ~once a second.
  if ((frame.n = (frame.n || 0) + 1) % 60 === 0) {
    try {
      const all = JSON.parse(localStorage.getItem('jamstik-tutor-stats') || '{}');
      const day = all[new Date().toISOString().slice(0, 10)] || {};
      const parts = Object.entries(day).map(([k, v]) => `${k} ${v.h}/${v.t}`);
      let streak = 0;
      const d = new Date();
      while (all[d.toISOString().slice(0, 10)]) { streak++; d.setDate(d.getDate() - 1); }
      const suffix = streak >= 2 ? ` · ${streak}-day streak` : '';
      $('session').textContent = parts.length ? `today: ${parts.join(' · ')}${suffix}` : '';
    } catch { /* storage unavailable */ }
  }
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
    saveSettings();
  };
  $('flip').addEventListener('change', saveSettings);
  $('bend-range').onchange = () => {
    if (app.source instanceof MidiEngine) app.source.bendRangeSemis = +$('bend-range').value;
    saveSettings();
  };
  $('bpm').addEventListener('change', saveSettings);
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

  const taps = [];
  $('tap').onclick = () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps.length = 0;
    taps.push(now);
    if (taps.length > 4) taps.shift();
    if (taps.length >= 2) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      const bpm = Math.round(60000 / iv);
      if (bpm >= 40 && bpm <= 220) {
        $('bpm').value = bpm;
        if (metro.m?.running) metro.m.bpm = bpm;
        saveSettings();
      }
    }
  };

  restoreSettings();
  requestAnimationFrame(frame);

  // Debug/test hook: inspect app state and inject events from devtools,
  // e.g. __jt.handlers.onNoteOn('n64', null, 64, 100) simulates a
  // single-channel (mono) device sending middle C.
  window.__jt = { app, handlers };
}

init();
