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
- **CC11 expression**: the Jamstik Studio streams each string's measured
  amplitude (physical decay) as CC11 per channel. The tutor applies it
  to the sounding synth voice, fades the board dot as the string dies,
  and draws the `string decay` cell: six lanes of amplitude history,
  per string. Palm muting reads as an immediate fade. Single-channel
  input applies it to all ringing notes, matching channel-wide
  semantics, and a note on channel 7 flips the layout assumption to a
  strict MPE zone (strings on 2-7). Channel aftertouch feeds the same
  amplitude path. Devices that never send expression still show
  attack/release steps, labeled honestly in the cell footer.
- **Expression recording**: CC11 is captured into takes, replays
  through playback, and exports to `.mid` as channel CC11 events.

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
- **Chord trainer**: prompts a shape, draws the target fingering (a
  `show shape` toggle hides the diagram so you find the voicing from the
  name alone, and judging is pitch-class based either way), listens
  for your strum, and reports the verdict. Feedback covers exact matches,
  missing or extra chord tones, and per-string faults (wrong fret,
  unmuted string). Progressions: C G Am F, I V vi IV in G, ii V I in C,
  12-bar blues in E.
- **Scale drills**: lights every in-key position on the board, labeled
  by degree name such as R or b3. *Freeform*
  scores each note as in or out of key. *Run* walks a position box up
  and down and tracks position-accurate progress. *Hear scale* auditions
  the box run through the current preset.
- **Changes**: timed chord switching. The board shows the target shape
  and the panel previews the next chord. The clock runs until the held
  notes resolve to exactly the target's chord tones. Stats track switch
  times. Same four progressions as the trainer.
- **Riff drills**: a library of picking exercises and melodies judged
  one step at a time, grouped in the picker. Exercises: blues shuffle,
  pentatonic walk-up, G run, travis pick, power riff, spider climb,
  low e echo, open string waltz, string hopper, rainbow arc, midnight
  drive. Public-domain tunes: twinkle twinkle, yankee doodle, au clair
  de la lune, kumbaya, skip to my lou, swing low, when the saints, ode
  to joy, amazing grace, scarborough fair, drunken sailor, sakura
  sakura, greensleeves, house of the rising sun. `hear it` auditions at
  the header BPM in eighth-note steps. Completions report elapsed time
  against a per-song best, and best times persist in `localStorage`.
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
  *Hold duration* asks for a note held a half note, whole note, or two
  bars at the header BPM, judged on release timing. *Intervals on board* lights a fret and
  asks for the note a named interval above it (m3 through P5).
  *Staff reading* shows a notehead on a treble staff and requires the
  exact octave. Miss feedback names the octave distance.
  *Fretboard sweep* gives 20s to find every position of one pitch
  class, scoring distinct spots found (unique pitches in
  single-channel mode). *Play it back* plays a 4-note pentatonic
  phrase through the synth and you repeat it by ear in order. A wrong
  note names its position and resets the attempt.
  *Let it ring* asks for a note sustained 2 or 3 seconds, judged on the
  CC11 amplitude staying above the floor (a palm on the strings ends
  it). *Choke it* asks for a note killed within 250ms of the attack, by
  mute or release. Both fall back to note on/off timing when the device
  sends no expression, and the verdict says so.
  *Vibrato* asks for a note held while the pitch bend oscillates, and
  scores cycle count, rate (2-9/s) and depth from the bend stream. With
  no bend data the verdict says the device isn't sending it.
  *Tremolo picking* asks for one note attacked 8 times inside 4 seconds
  and reports the picking rate and the worst gap between attacks.
  *Progression by ear* plays a 3-chord diatonic loop through the synth
  and you replay it chord by chord, judged on held chord tones. A wrong
  answer names what you played and the chord it wanted.
  Stats shown: `hits/tries`, streak, average response seconds, a
  running `today` tally, a 7-day total, and a per-day hit-rate bar row.
  Daily drill counts persist
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

Waveform (time domain), spectrum, scrolling spectrogram, the wavetable
frames the synth uses, a pitch-class chromagram plus its scrolling
history, a level-and-tone readout, a note waterfall, and a staff view.

The spectrum runs a true log-frequency axis across the guitar band
(60Hz to 4kHz) with a semitone grid, octave labels, and the six open
string frequencies marked along the top. While notes are held, each
string draws faint harmonic markers at 2x-6x its fundamental in its own
color, so you can watch a note's overtone stack land on real peaks. A
decaying peak-hold trace rides the bars, and the top right names the
dominant peak as nearest note plus frequency and cents off (the FFT is
8192 bins deep and peak frequency is refined by parabolic
interpolation, so cents mean something down on the low E).

The chromagram folds all FFT energy into the 12 pitch classes, one bar
each, so chord quality reads directly out of the audio; a slow energy
accumulator feeds a Krumhansl-Schmuckler key estimate next to each
source label (`est. Am`). The harmony-trail cell scrolls the same
folded energy as a 12-row heatmap per source, so chord changes and
progressions read as bands moving left. Level and tone
gives each source an RMS bar plus numbers: level in dB, spectral
centroid (brightness) in Hz, and the same dominant-peak note/cents
readout as the spectrum. Pitch track scrolls the dominant peak across
the last 8 seconds on a midi grid marked with octave lines and open
strings, so vibrato, bends, and drift show as motion in the trace and
silence breaks it; sustained oscillation gets a live rate/depth tag
(`vib 4.6Hz +/-0.3st`). The estimate runs two detectors: the spectral
peak, and a normalized autocorrelation of the time domain that picks
the smallest confident lag (the fix for the classic argmax octave-
down error). When the two disagree by a semitone the ACF wins, which
catches the spectrum locking onto a loud harmonic. Harmonics samples
the spectrum at f0*1 through f0*10 relative to the fundamental, a
timbre fingerprint that separates a plucked string's falling comb
from whatever a wavetable preset baked in, plus an inharmonicity B
coefficient fitted from measured partial frequencies. Envelope
scrolls the RMS level per source with onset ticks found by spectral
flux, so pick attacks read off the audio itself; the newest onset
gets its attack time in ms, and a run of 4+ onsets yields a tempo
estimate. The meters row also reports the ACF estimate with its
confidence, zero-crossing rate, spectral flatness (tonal comb vs
noise), and crest factor. The spectrogram runs the same
log-frequency axis with note gridlines. The waveform marks the ACF
estimate's measured period as ticks along the top edge (`T 3.0ms`),
so the estimator's answer is checkable against the raw repeat rate.

Tuner mode reads MIDI pitch bend for held Jamstik notes. With audio
input enabled and nothing held, the same needle becomes a chromatic
tuner for whatever the mic hears, driven by the combined FFT+ACF
pitch estimate.

The waterfall scrolls per-string lanes left over the last
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
js/viz.js           scope / spectrum / spectrogram / chromagram / meters /
                    pitch track / harmonics / envelope / wavetable /
                    waterfall / staff / string decay; ACF + FFT pitch
                    estimators, spectral-flux onsets
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
