# The preset demo

`npm run demo` (in `web/`) plays every FM-1 factory patch's presets on the editor's Emulator view (EMU) in under two
minutes, in a Chrome window sized for a screen recording. The window shows the FM-1 panel alone, under a caption with
the patch's and the preset's names: the sidebar, the status line and the other editor controls are hidden.

## Run it

```sh
cd web
npm run demo -- --dry-run      # the plan only: every preset's role, octave and bars, the tempo, the total time
npm run demo                   # the demo, in a Chrome window of 1600 x 900
```

It uses the dev server that is already running on `http://[::1]:5173`. When nothing answers there, the script starts a
dev server of this checkout on a free port. It never starts one on 5173. `--url URL` uses another editor. That editor
must be a dev server of a checkout that has the demo's page hook (`__m1test` in `src/main.ts`).

The server's `public/fm1-ui.wasm` (the FM-1's UI that the Emulator view runs) must be built from current firmware:
`npm run fm1-wasm` in that server's `web/`. It is not rebuilt when the firmware changes. In a build from before #395
(2026-10-29) PRESET steps patches instead of presets. The script stops at the first preset when that happens, and says
so. `--wasm public/fm1-ui.wasm` makes the page run this checkout's build instead, without touching the server.

## What it plays

Everything runs on one beat grid, so a change of preset lands on a bar line and the demo sounds like one track changing
instruments.

1. It opens `#emu` and starts the audio with a click on the screen.
2. **Patches played from the keys** come first. Opening a patch takes a beat. Then the PRESET encoder steps its engine's
   factory presets, one click a bar, and the LCD shows `PRESET <NAME>`. Each preset plays one bar of the song on the
   panel's keys. OCT- and OCT+ move the keys to where that bar's notes are, just before the bar. All of a patch's
   presets play before the next patch.
3. **Patches that play from a pattern** come last: the drum machines and kits. Opening one takes two beats, in which
   the demo sets Main's tempo to the demo's tempo with PLAY held + PRESET, as on the FM-1 (never stored). Then PLAY runs
   the pattern on a bar line, and PRESET steps the presets, a bar each. A patch with no presets (the 808 Kit, the
   909 Kit, `<7PH`) runs its pattern for one bar.

The split is read from each patch, not from a list. A patch plays from a pattern when the pattern its Steps track plays
on PLAY (pattern 1) has notes. Every other patch is played from the keys. A patch from the keys with no factory presets
(Init, Simple FM, Plucked String) is left out. The engine is the first top-level engine assembly with factory presets.
An engine whose keys reach a Drum map and no Voicing (8 Lire, Elvira 2: one voice per row) is played on the black keys,
as on the FM-1, where black key n plays row n ([D-520](../../docs/ledger/steps.md#D-520)).

The caption over the panel is the demo's own. The FM-1 shows a patch's name only when PRESET or a program change loads
it, which the demo does not use.

## Time

The tempo is the song's own, raised to the lowest whole number of beats a minute that fits `--seconds` (117 by
default). The plan prints both. With the default song every preset gets one bar of two beats: 269 beats in all, so
138 bpm, 0.87 s a preset, 1:57. At the song's own 100 bpm the demo would take 2:41. `--tempo BPM` sets the tempo
whatever the time.

Options:

| Option | Default | What it does |
|---|---|---|
| `--song NAME` | `loop` | the song: `web/demo/songs/NAME.json` |
| `--seconds S` | 117 | the time budget; the tempo is raised to fit it |
| `--tempo BPM` | | this tempo, whatever the time |
| `--drum-beats N` | a bar | how long each pattern step runs |
| `--load-beats N` | 1 | beats to open a patch (a pattern patch gets one more) |
| `--init` | off | include each engine's Init preset |
| `--only "Io 4,Cassia 1"` | | only these patches |
| `--skip "909 Kit"` | | leave these patches out |
| `--size WxH` | `1600x900` | the window's page size in CSS pixels |
| `--wasm FILE` | | the Emulator view runs this build of the FM-1's UI instead of the server's |
| `--dry-run` | | print the plan and stop |
| `--headless` | | no window (for checks) |
| `--shots` | | one screenshot per patch into `build/demo/` |
| `--notes N`, `--chords`, `--rhythm` | 3, off, off | for a song that is a list of notes (below) |

At the end the script prints the time played against the plan. It also lists any preset that made no sound, and any
preset whose values the editor did not see arrive.

## Recording

- The default page is 1600 x 900 CSS pixels (16:9), in a window about 90 pixels taller for Chrome's bar. It fits a
  1728 x 1117 MacBook screen. On a smaller screen use `--size 1440x810`; on a bigger one `--size 1920x1080` gives 1080p
  at a scale of 1.
- The sound is the browser's audio engine, the same as when you press the EMU panel's keys. Record the system audio, for
  example with QuickTime and a loopback device, or with OBS. MASTER is left where it was.

## Leaving your state alone

- The page's Web MIDI sees no ports, so a connected FM-1 is never reached. Nothing is sent, stored or saved to the bank.
- The window is Playwright's own Chrome with a new, empty profile, deleted when it closes. What the page stores there
  (the open patch, a card marked as seen) never reaches your Chrome, whatever address it opens. Your own tabs on the
  same server are not affected either.

## Songs

A song is one JSON file in `web/demo/songs/`. `--song NAME` picks `NAME.json`. There are two kinds.

**A chord loop** (`loop.json`, the default: i–VI–III–VII in A minor, Am F C G). One chord a bar, looped across presets
and patches. Each preset plays a bar in a role:

| Role | What it plays |
|---|---|
| `pad` | holds the chord (a pad, strings, brass, an organ) |
| `bass` | a root riff, low (root, root, octave, root) |
| `lead` | a short melody over the chord |
| `arp` | the chord as an arpeggio (a bell, a pluck, keys) |
| `drone` | rows on the black keys, counted from the bar's chord (engines with a Drum map, set by the patch) |

```json
{
  "tempo": 100,
  "beatsPerBar": 2,
  "chords": ["Am", "F", "C", "G"],
  "roles": { "bass": { "from": "C2", "phrase": [[0, 0.5, [0]], [0.5, 0.5, [0]], [1, 0.5, [3]], [1.5, 0.5, [0]]] } },
  "guess": [["bass", ["bass", "sub", "303", "acid"]]],
  "default": "pad",
  "higher": { "words": ["bell", "glass"], "shift": 12 },
  "overrides": { "Silver Box": "bass", "Canvas > Easel Bongos": { "role": "arp", "shift": -12 } }
}
```

- A chord is a root (`A` to `G`, with `#` or `b`) and `m` for minor or `dim`.
- A role's `phrase` is one bar of `[start beat, length in beats, [chord tones]]`. Tone 0 is the root, 1 the third, 2 the
  fifth, 3 the root an octave up, and so on. `from` is the lowest note the role's root may take; the role's bars sit
  there, which puts the bass low and the leads and bells higher.
- A preset's role is guessed from the words of its name, by the first `guess` entry with one of them, else `default`.
  `higher` moves a preset whose name has one of its words up by `shift` semitones (bells and glass sound best high).
  `overrides` set a role, and a shift, by patch or by `"patch > preset"`, for the presets the guess gets wrong.
- An engine with fewer voices than a chord plays the chord's lowest tones (a mono synth holds the root).
- `--dry-run` prints every preset's role (`(set)` when an override gave it), the panel's octave, the notes and the bars.

**A list of notes** (`moonlight.json`: the left hand of the first movement of Beethoven's Piano Sonata No. 14, Op. 27
No. 2, transcribed from the Mutopia Project's LilyPond source, which the file names). Each preset plays the next
`--notes` notes, a beat each (`--rhythm`: the song's own lengths), and the song carries on across presets.

```json
{ "tempo": 108, "notes": [[["C#3", "C#2"], 4, 1], ["E2", 1, 13], [52, 0.5]] }
```

Each entry is `[pitch or [pitches], beats]`, and an optional bar number that is only for reading. A pitch is a MIDI
number or a name such as `C#3`, `Db3`, `E#1` or `F##2` (C4 is MIDI 60). Several pitches play as one key, the lowest,
unless the song has `"chords": true` or `--chords` is given. The keys sit at the octave that holds most of the song; a
note outside it is moved an octave in. On a Drum map engine the song's pitches become rows by their order.
