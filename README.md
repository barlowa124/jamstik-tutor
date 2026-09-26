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
  and no-5th voicings like x32310 C7). A strum line reports the note
  count and millisecond spread of your last strum. A backing loop
  strums any of the four progressions through the synth at the
  metronome tempo for play-along practice.
- **Chord trainer**: prompts a shape, draws the target fingering, listens
  for your strum, and reports the verdict. Feedback covers exact matches,
  missing or extra chord tones, and per-string faults (wrong fret,
  unmuted string). Progressions: C G Am F, I V vi IV in G, ii V I in C,
  12-bar blues in E.
- **Scale drills**: lights every in-key position on the board, labeled
  by degree (R, b3, 5, and so on). *Freeform*
  scores each note as in or out of key. *Run* walks a position box up
  and down and tracks position-accurate progress. *Hear scale* auditions
  the box run through the current preset.
- **Changes**: timed chord switching. The board shows the target shape
  and the panel previews the next chord. The clock runs until the held
  notes resolve to exactly the target's chord tones. Stats track switch
  times. Same four progressions as the trainer.
- **Riff drills**: short picking patterns (blues shuffle, pentatonic
  walk-up, G run, travis pick, power riff) judged one step at a time.
  The board lights the current position. Wrong notes coach the expected
  pitch and string but never reset your place. `hear it` auditions the
  pattern. In single-channel mode steps match by pitch.
- **Rhythm drill**: strum on the click. Free grids (quarters or
  eighths) score each onset's signed offset in ms with a running
  average labeled dragging, pushing ahead, or centered. Named strum
  patterns (steady 8ths, on the quarters, folk strum, syncopated) split
  the bar into eighth-note slots shown as a chip row. Green for a hit
  on a target slot, red for a missed target, amber for an extra hit on
  a rest. Each completed bar reports on-pattern hits and extras.
- **Quiz**: fretboard-knowledge drills. *Note names* asks for a pitch
  class anywhere ("play any F#"). *Exact positions* asks for a
  string/fret pair. With multi-channel MIDI it checks string and fret.
  In single-channel mode it falls back to matching pitch because the
  device does not name the string. *Bend targets* asks for a quarter,
  half, or whole-step bend held on any string (±12 cents). *Arpeggio
  runs* draws a chord shape and times a low-to-high single-string pick.
  In single-channel mode it accepts all chord tones sounding together.
  *Intervals by ear* plays two notes through the synth and you name the
  interval from buttons, no guitar needed. *Chords by ear* plays a
  triad answered by quality (major / minor / dominant 7th). *Dynamics*
  prompts for a pick velocity band and scores the MIDI velocity.
  *Hold duration* asks for a note held one whole note at the header
  BPM, judged on release timing. *Intervals on board* lights a fret and
  asks for the note a named interval above it (m3 through P5).
  *Staff reading* shows a notehead on a treble staff and requires the
  exact octave — miss feedback names the octave distance.
  Stats shown: `hits/tries`, streak, average response seconds, a
  running `today` tally, and a 7-day total. Daily drill counts persist
  in `localStorage`, and the header shows a per-kind today line plus a
  consecutive-days streak.

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
- **Tuning**: 10 preset tunings (drop D, DADGAD, open G/D/C/E, drop C,
  half/whole-step down) plus **custom**, which opens a per-string open
  note picker. Everything downstream follows: fret positions, scale
  overlays, string labels, chord verdicts. Chord *shapes* assume standard, and the trainer
  says so when they do not apply.
- **Transpose**: ±12 semitones on incoming MIDI (capo/pitch-shift).
- **Effects**: drive (waveshaper), tone (lowpass), delay, reverb
  (generated impulse), master volume.
- **Velocity curves**: linear / soft / hard response into the synth.
- **Record**: `record` saves the synth audio as `.webm`. `.mid` records
  note-on/off and pitch-bend events with timing and exports a Standard
  MIDI File (format 0, 480 PPQ, channels 1-6 by string, bends encoded at
  the usual +/-2 wheel assumption) for any DAW. `take` replays the last
  MIDI recording through the app's own pipeline, so a take shows up on
  the board and waterfall exactly as it was played. `loop` repeats it.
  `open .mid` imports any Standard MIDI File (formats 0/1, PPQ division,
  tempo-mapped, running status). A multi-channel file maps channels 1-6
  to strings. A single-channel file plays through the inferred path.

Settings persist in `localStorage`: tuning (including custom), transpose,
velocity curve, FX levels, preset splits, channel mode, bend range, and
metronome BPM all survive a reload. The `tap` button sets BPM from
your taps (average of the last four, reset after a 2.5s pause).

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
spectrogram, the wavetable frames the synth uses, a note waterfall, and
a staff view. The waterfall scrolls per-string lanes left over the last
12 seconds, each note a colored bar from attack to release, taller when
hit harder. The staff notates held notes on treble clef with
accidentals and ledger lines, so what you play shows up as standard
notation in real time. Synth and real-input traces overlay in teal and
pink.

## Layout

```
index.html          shell + canvases
js/theory.js        tuning, chord dictionary/detection, scale tables
js/midi.js          Web MIDI engine, channel->string map, VirtualJamstik
js/audio.js         preset wavetable synth, FX chain, real-input capture,
                    recorder, metronome
js/fretboard.js     canvas board: notes, bends, targets, scale overlay
js/viz.js           scope / spectrum / spectrogram / wavetable / waterfall
js/modes.js         free play, chord trainer, scale drills, tuner, quiz
```

## Limits

- Chord detection requires every sounding pitch class to be a chord tone.
  The perfect 5th may be omitted. Voicings with foreign notes show the
  raw note names instead of guessing a name.
- Latency on real hardware is Jamstik-side (string sensing). USB is
  tighter than BLE.
- The synth is a plucked-string approximation, not a model of the guitar's
  analog output. The *input* path shows the real signal when connected.
