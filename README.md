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

- **Tuner**: sounded note, string/fret, and a cents needle driven by live
  pitch-bend data (±50 display, ±100 tracked). The Jamstik reports MIDI
  pitch, not pickup frequency, so the needle shows sounded pitch
  including bends instead of measured string frequency.
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

## Sounds

The sounds panel (right side, below the mode panel) covers the
playback-side surface of the Jamstik Creator app:

- **Presets**: 14 wavetable voices across guitar (steel, nylon,
  electric clean, 12-string), bass (electric, synth, both transposed an
  octave down), keys (piano-ish, drawbar organ, vibe), and synth
  (saw/square leads, soft/brass pads, flute-ish). Each is a PeriodicWave
  harmonic recipe plus its own envelope. Some stack detuned oscillators.
- **Assignment**: pick string chips, then a preset, for splits (e.g.
  electric bass on 4-5-6 with saw lead on 1-2-3). Empty selection
  applies to all strings.
- **Tuning**: 10 alternate tunings (drop D, DADGAD, open G/D/C/E, drop C,
  half/whole-step down). Fret positions, scale overlays, string labels,
  and chord verdicts all follow. Chord *shapes* assume standard, and the
  trainer says so when they do not apply.
- **Transpose**: ±12 semitones on incoming MIDI (capo/pitch-shift).
- **Effects**: drive (waveshaper), tone (lowpass), delay, reverb
  (generated impulse), master volume.
- **Velocity curves**: linear / soft / hard response into the synth.
- **Record**: captures the synth output to a `.webm` download.

Device-side settings the Jamstik app exposes (firmware flashing,
hammer-on thresholds, pickup sensitivity calibration) go over its
proprietary sysex/BLE channel and are intentionally not reimplemented.

## Audio

- **Synth** (default): a wavetable engine with one monophonic voice per
  string (polyphonic per note in single-channel mode). Pitch bend maps
  to detune per voice.
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
js/audio.js         preset wavetable synth, FX chain, real-input capture,
                    recorder, metronome
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
