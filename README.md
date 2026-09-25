# Jamstik Tutor

Live guitar tutor driven by the Jamstik MIDI guitar. It listens to what
you play over MIDI, shows it on a fretboard in real time, names the notes
and chords you're holding, coaches chord shapes and scale drills, and
renders the audio picture, meaning waveform, spectrum, spectrogram, and
the wavetable behind the synth voice, as you play.

## Run

```
python3 -m http.server 8123
# open http://localhost:8123 in Chrome or Edge
```

Web MIDI requires a secure context and a Chromium-based browser.
`localhost` qualifies. `file://` and LAN IPs do not, and Safari and
Firefox do not implement Web MIDI at all.

## Jamstik connection

USB: plug in, click **connect**, pick "Jamstik" from the device list
(auto-detect prefers it by name).

BLE MIDI: pair the guitar first in *Audio MIDI Setup → MIDI Studio →
Bluetooth Configuration*. Once macOS exposes it as a CoreMIDI device,
the browser sees it too.

Channel handling is automatic by default (`ch: auto`):

- **Multi-channel mode** (Jamstik Creator's default: string 1 = channel 1
  through string 6 = channel 6) gives exact string/fret display and
  per-string coaching. If your unit maps low-to-high, tick
  **flip strings**.
- **Single-channel mode** (all strings on channel 1) used to collapse
  everything into one sounding note. The app now detects it, becomes
  polyphonic, and infers fret positions from pitch (marked `?` in the
  held-notes readout). Chord verdicts still work, while per-string
  coaching is skipped because the device does not say which string
  sounded.
- **MPE mode** (notes spread across channels) plays polyphonically with
  inferred positions.

Force a mode with the **ch** selector if auto-detection misfires.
Pitch bend defaults to ±2 semitones. Set ±4/±12/±24 to match your
Jamstik app's bend range.

**Virtual Jamstik (demo)**: connect with no hardware. The demo panel
strums common chords, runs an A-minor-pentatonic scale, and does a bend
sweep. You can also click frets on the board directly.

## Modes

- **Free play**: live note names and bend amounts on the fretboard, plus
  a chord readout that resolves stable voicings (including slash chords
  and no-5th voicings like x32310 C7).
- **Chord trainer**: prompts a shape, draws the target fingering, listens
  for your strum, and reports the verdict. Feedback covers exact matches,
  missing or extra chord tones, and per-string faults (wrong fret,
  unmuted string). Progressions: C G Am F, I V vi IV in G, ii V I in C,
  12-bar blues in E.
- **Scale drills**: lights every in-key position on the board. *Freeform*
  scores each note as in or out of key. *Run* walks a position box up
  and down and tracks position-accurate progress.

## Audio

- **Synth** (default): a wavetable engine with one monophonic voice per
  string. `PeriodicWave` tables are shaped like a plucked string (1/n
  harmonic decay with a ~1/7 pluck-position null). Velocity picks
  bright/mid/mellow tables, and per-string pitch bend maps to detune.
- **Input** (optional): *enable audio in* captures the Jamstik's analog
  out, or any interface, via `getUserMedia` for real-waveform
  visualization. It is never routed to speakers, so no feedback loop.

## Visualizations

Waveform (time domain), spectrum (log-spaced FFT bars), scrolling
spectrogram, and the wavetable frames the synth uses. Synth and real-input
traces overlay in teal and pink.

## Layout

```
index.html          shell + canvases
js/theory.js        tuning, chord dictionary/detection, scale tables
js/midi.js          Web MIDI engine, channel->string map, VirtualJamstik
js/audio.js         wavetable synth, real-input capture, metronome
js/fretboard.js     canvas board: notes, bends, targets, scale overlay
js/viz.js           scope / spectrum / spectrogram / wavetable frames
js/modes.js         free play, chord trainer, scale drills
```

## Limits

- Chord detection requires every sounding pitch class to be a chord tone.
  The perfect 5th may be omitted. Voicings with foreign notes show the
  raw note names instead of guessing a name.
- Latency on real hardware is Jamstik-side (string sensing). USB is
  tighter than BLE.
- The synth is a plucked-string approximation, not a model of the guitar's
  analog output. The *input* path shows the real signal when connected.
