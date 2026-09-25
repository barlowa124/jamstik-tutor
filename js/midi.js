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
    }
    // CCs (sustain, Jamstik-specific config) are ignored for now.
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
