// MIDI layer: real Jamstik via Web MIDI, plus a virtual Jamstik for
// hardware-free testing. Both expose the same handler interface:
//   onNoteOn(voiceKey, string|null, midi, velocity, tMs)
//   onNoteOff(voiceKey, string|null, midi, tMs)
//   onPitchBend(string|null, semitones, tMs)   // string null = all voices
//   onStateChange(statusText)
// voiceKey distinguishes simultaneous notes: 's<n>' per string in
// multi-channel mode, 'n<midi>' per note in single-channel mode.

export const NOTE_OFF = 0x80, NOTE_ON = 0x90, PITCH_BEND = 0xe0, CC = 0xb0;

// Jamstik multi-channel mode sends each string on its own channel.
// Default: channel 1 -> string 1 (high e) ... channel 6 -> string 6 (low E).
// flipStrings swaps the direction in case the device maps low-to-high.
export function stringForChannel(ch, flip = false) {
  const s = ch + 1;
  return flip ? (7 - s) : s;
}

export class MidiEngine {
  constructor(handlers) {
    this.h = handlers;
    this.flip = false;
    this.bendRangeSemis = 2; // Jamstik app default; UI exposes a switch
    this.input = null;
    this.access = null;
    // 'auto' starts single-channel-safe and upgrades to per-string the
    // moment a second channel arrives; 'multi'/'mono' force a mode.
    this.chanMode = 'auto';
    this.seenCh = new Set();
  }

  async connect(inputId = null) {
    if (!navigator.requestMIDIAccess) {
      this.h.onStateChange?.('Web MIDI unsupported — use Chrome/Edge');
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.h.onStateChange?.('MIDI permission denied');
      return false;
    }
    const inputs = [...this.access.inputs.values()];
    if (!inputs.length) {
      this.h.onStateChange?.('no MIDI devices found');
      return false;
    }
    const pick = inputId
      ? inputs.find(i => i.id === inputId)
      : inputs.find(i => /jamstik/i.test(i.name || '')) || inputs[0];
    this.setInput(pick);
    this.access.onstatechange = () => this.h.onInputsChanged?.(this.listInputs());
    return true;
  }

  listInputs() {
    return this.access ? [...this.access.inputs.values()].map(i => ({ id: i.id, name: i.name })) : [];
  }

  setInput(input) {
    if (this.input) this.input.onmidimessage = null;
    this.input = input;
    input.onmidimessage = e => this.route(e);
    this.h.onStateChange?.(`connected: ${input.name}`);
  }

  route(e) {
    const [st, d1, d2] = e.data;
    const type = st & 0xf0, ch = st & 0x0f;
    const t = e.timeStamp ?? performance.now();
    this.h.onRaw?.(e.data, t);

    this.seenCh.add(ch);
    const multi = this.chanMode === 'multi' ||
      (this.chanMode === 'auto' && this.seenCh.size > 1);
    // Only channels 1-6 name strings. Single-channel input, and MPE
    // traffic on channels >6, fall back to note-keyed voices and
    // inferred positions.
    const str = multi && ch < 6 ? stringForChannel(ch, this.flip) : null;
    const key = str !== null ? `s${str}` : `n${d1}`;

    if (type === NOTE_ON && d2 > 0) {
      this.h.onNoteOn?.(key, str, d1, d2, t);
    } else if (type === NOTE_OFF || (type === NOTE_ON && d2 === 0)) {
      this.h.onNoteOff?.(key, str, d1, t);
    } else if (type === PITCH_BEND) {
      const v14 = ((d2 << 7) | d1) - 8192;
      // Single-channel bend is global; multi-channel bend is per string.
      this.h.onPitchBend?.(multi ? str : null, (v14 / 8192) * this.bendRangeSemis, t);
    } else if (type === CC && d1 === 11) {
      // CC11 = per-string amplitude envelope on the Jamstik (MPE
      // expression carries physical string decay). Per-string in
      // multi-channel mode, global in single-channel.
      this.h.onExpression?.(multi ? str : null, d2 / 127, t);
    } else if (type === CC && (d1 === 123 || d1 === 120)) {
      this.h.onAllOff?.(); // all notes off / all sound off
    }
    // Other CCs (sustain, Jamstik-specific config) are ignored for now.
  }

  disconnect() {
    if (this.input) this.input.onmidimessage = null;
    this.input = null;
    this.h.onStateChange?.('disconnected');
  }
}

// Emits the same handler calls as MidiEngine so the whole app can be
// exercised without hardware. Strings are named by number; callers supply
// absolute MIDI notes (use theory.OPEN_MIDI + fret).
export class VirtualJamstik {
  constructor(handlers) {
    this.h = handlers;
    this.name = 'Virtual Jamstik (demo)';
  }
  connect() { this.h.onStateChange?.(`connected: ${this.name}`); }
  disconnect() { this.h.onStateChange?.('disconnected'); }

  noteOn(str, midi, vel = 96) { this.h.onNoteOn?.(`s${str}`, str, midi, vel, performance.now()); }
  noteOff(str, midi) { this.h.onNoteOff?.(`s${str}`, str, midi, performance.now()); }
  bend(str, semis) { this.h.onPitchBend?.(str, semis, performance.now()); }
  expr(str, v) { this.h.onExpression?.(str, v, performance.now()); }

  // Strum a chord shape {string: fret|null} top-down (low strings first),
  // delayMs per string, rings until release() or until durMs passes.
  strum(shape, openMidi, { delayMs = 18, vel = 96, durMs = 2200 } = {}) {
    let i = 0;
    const pressed = [];
    for (const s of [6, 5, 4, 3, 2, 1]) {
      const fret = shape[s];
      if (fret === null || fret === undefined) continue;
      const midi = openMidi[s] + fret;
      pressed.push({ s, midi });
      setTimeout(() => this.noteOn(s, midi, vel), i * delayMs);
      i++;
    }
    if (durMs > 0) setTimeout(() => this.release(pressed), i * delayMs + durMs);
    return pressed;
  }

  release(pressed) {
    for (const { s, midi } of pressed) this.noteOff(s, midi);
  }

  // Play a note sequence: [{string, fret|midi, ms, dur}] offsets from now.
  sequence(events, { vel = 90 } = {}) {
    for (const ev of events) {
      const midi = ev.midi ?? (ev.open + ev.fret);
      setTimeout(() => this.noteOn(ev.string, midi, vel), ev.ms);
      setTimeout(() => this.noteOff(ev.string, midi), ev.ms + (ev.dur ?? 400));
    }
  }
}

// Records note events and exports a Standard MIDI File (format 0,
// 480 PPQ, 120 BPM) for dropping into any DAW. `str` is the real
// string (1-6) or null when the device did not name one, so playback
// can take the inferred path instead of claiming strings. SMF channels
// map str-1, falling back to channel 1 for inferred notes.
export class MidiRecorder {
  constructor() { this.events = []; this.t0 = null; }
  get running() { return this.t0 !== null; }

  start() { this.events = []; this.t0 = performance.now(); }

  // `midi` is the sounded pitch (exported to SMF); `raw` is the
  // pre-transpose note the device sent (what playback feeds back in).
  add(on, str, midi, vel, raw = midi) {
    if (!this.running) return;
    this.events.push({ ms: performance.now() - this.t0, on, str: str ?? null, midi, raw, vel });
  }

  bend(str, semis) {
    if (!this.running) return;
    // ±2 semitone wheel assumption, the same default a DAW applies.
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (semis / 2) * 8192)));
    this.events.push({ ms: performance.now() - this.t0, bend: true, str: str ?? null, semis, v });
  }

  stop() {
    this.t0 = null;
    return buildSmf(this.events);
  }
}

// Replays recorded events through the app's normal handlers, so a take
// shows up on the board, waterfall, and readout exactly as played.
export class MidiPlayer {
  constructor(handlers) {
    this.h = handlers;
    this.timers = [];
    this.onDone = null;
  }

  get playing() { return this.timers.length > 0; }

  play(events, onDone) {
    this.stop();
    this.onDone = onDone;
    let end = 0;
    events.forEach((e, i) => {
      const t = setTimeout(() => {
        if (e.bend) this.h.onPitchBend?.(e.str, e.semis);
        else if (e.on) this.h.onNoteOn?.(`p${i}`, e.str, e.raw ?? e.midi, e.vel);
        else this.h.onNoteOff?.(`p${i}`, e.str, e.raw ?? e.midi);
      }, e.ms);
      this.timers.push(t);
      end = Math.max(end, e.ms);
    });
    this.timers.push(setTimeout(() => this.finish(), end + 50));
  }

  finish() {
    this.stop();
    this.h.onAllOff?.();
    this.onDone?.();
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

function varLen(n) {
  const b = [n & 0x7f];
  while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80);
  return b;
}

function buildSmf(events) {
  const TPQ = 480, BPM = 120;
  const msToTicks = ms => Math.round(ms * (BPM / 60000) * TPQ);
  const evs = [...events].sort((a, b) => a.ms - b.ms);
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // tempo 500000us/qn
  let last = 0;
  for (const e of evs) {
    const t = msToTicks(e.ms);
    track.push(...varLen(Math.max(0, t - last)));
    last = t;
    const ch = e.str == null ? 0 : Math.max(0, Math.min(15, e.str - 1));
    if (e.bend) track.push(0xe0 | ch, e.v & 0x7f, (e.v >> 7) & 0x7f);
    else track.push((e.on ? 0x90 : 0x80) | ch, e.midi & 0x7f, e.vel & 0x7f);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPQ >> 8, TPQ & 0xff,
                0x4d, 0x54, 0x72, 0x6b, (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
                (track.length >> 8) & 0xff, track.length & 0xff];
  return new Uint8Array([...head, ...track]);
}

// Parses a Standard MIDI File (formats 0 and 1, PPQ division) into the
// same event shape MidiPlayer consumes, so an imported file plays on
// the board like a take. Channels 1-6 map to strings, anything else
// goes through the inferred path. SMPTE-division files throw.
export function parseSmf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = p => dv.getUint32(p);
  const u16 = p => dv.getUint16(p);
  const u8 = p => dv.getUint8(p);
  if (bytes.length < 14 || u32(0) !== 0x4d546864) throw new Error('not a MIDI file');
  const hlen = u32(4);
  const ntrk = u16(10);
  const div = u16(12);
  if (div & 0x8000) throw new Error('SMPTE-division MIDI files are not supported');
  const tpq = div;
  const readVar = p => {
    let v = 0, b, n = 0;
    do { b = u8(p++); v = (v << 7) | (b & 0x7f); } while ((b & 0x80) && ++n < 4);
    return [v, p];
  };

  const tempos = [{ tick: 0, us: 500000 }];
  const raw = [];
  let pos = 8 + hlen;
  for (let t = 0; t < ntrk; t++) {
    if (pos + 8 > bytes.length || u32(pos) !== 0x4d54726b) break;
    const end = pos + 8 + u32(pos + 4);
    let p = pos + 8, tick = 0, status = 0;
    while (p < end) {
      const [d, p2] = readVar(p);
      p = p2;
      tick += d;
      let st = u8(p);
      if (st < 0x80) st = status;
      else { p++; if (st < 0xf0) status = st; }
      const kind = st & 0xf0, ch = st & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const midi = u8(p), vel = u8(p + 1); p += 2;
        const on = kind === 0x90 && vel > 0;
        raw.push({ tick, on, ch, midi, vel: on ? vel : 64 });
      } else if (kind === 0xe0) {
        raw.push({ tick, bend: true, ch, v: u8(p) | (u8(p + 1) << 7) });
        p += 2;
      } else if (kind === 0xa0 || kind === 0xb0) p += 2;
      else if (kind === 0xc0 || kind === 0xd0) p += 1;
      else if (st === 0xff) {
        const meta = u8(p++); const [len, p3] = readVar(p); p = p3;
        if (meta === 0x51 && len === 3) {
          tempos.push({ tick, us: (u8(p) << 16) | (u8(p + 1) << 8) | u8(p + 2) });
        }
        p += len;
        if (meta === 0x2f) break;
      } else if (st === 0xf0 || st === 0xf7) {
        const [len, p3] = readVar(p); p = p3 + len;
      } else p++;
    }
    pos = end;
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const msAt = tick => {
    let ms = 0, last = 0, us = tempos[0].us;
    for (const t of tempos) {
      if (t.tick >= tick) break;
      ms += (t.tick - last) * (us / 1000) / tpq;
      last = t.tick; us = t.us;
    }
    return ms + (tick - last) * (us / 1000) / tpq;
  };
  // Same convention as live input: only a genuinely multi-channel file
  // gets channel->string mapping. A single-channel file is probably a
  // piano/lead line and goes through the inferred path.
  const multiCh = new Set(raw.filter(e => !e.bend).map(e => e.ch)).size >= 2;
  const strOf = ch => multiCh && ch < 6 ? ch + 1 : null;
  const events = raw.map(e => e.bend
    ? { ms: msAt(e.tick), bend: true, str: strOf(e.ch),
        semis: ((e.v - 8192) / 8192) * 2 }
    : { ms: msAt(e.tick), on: e.on, str: strOf(e.ch), midi: e.midi, vel: e.vel });
  events.sort((a, b) => a.ms - b.ms);
  return events;
}
