# The preset demo

`npm run demo` (in `web/`) plays every FM-1 factory patch's presets on the editor's Emulator view (EMU) in under two
minutes, in a Chrome window sized for a screen recording. The window shows the FM-1 panel alone: the sidebar, the status
line and the other editor controls are hidden.

## Run it

```sh
cd web
npm run demo -- --dry-run      # the plan only: patches, presets, note length, total time
npm run demo                   # the demo, in a Chrome window of 1600 x 900
```

It uses the dev server that is already running on `http://[::1]:5173`. The `[::1]` address keeps its browser storage
apart from `localhost` and `127.0.0.1`, so your own patch, bank and progress are not touched. When nothing answers there,
the script starts a dev server of this checkout on a free port. It never starts one on 5173. `--url URL` uses another
editor. That editor must be a dev server of a checkout that has the demo's page hook (`__m1test` in `src/main.ts`).

What it does:

1. It opens `#emu`, starts the audio with a click on the screen, and sets the octave with OCT- / OCT+. It chooses the
   octave that holds most of the song (the Moonlight left hand needs -2).
2. **Patches played from the keys** come first. Each one is opened as the FM-1's PRESET opens it. Then the PRESET
   encoder steps its engine's factory presets, one click each, and the LCD shows `PRESET <NAME>`. Each preset plays the
   next notes of the song (3 by default) on the panel's keys. The song carries on across presets and patches. It starts
   again from the top when it runs out.
3. **Patches that play from a pattern** come last: the drum machines and kits. PLAY runs the pattern, and PRESET steps
   the presets, each one for `--drum-seconds`. A patch with no presets (the 808 Kit, the 909 Kit, `<7PH`) runs its
   pattern once for the same time.

The split is read from each patch, not from a list. A patch plays from a pattern when the pattern its Steps track plays
on PLAY (pattern 1) has notes. Every other patch is played from the keys. A patch from the keys with no factory presets
(Init, Simple FM, Plucked String) is left out. The engine is the first top-level engine assembly with factory presets.

Options:

| Option | Default | What it does |
|---|---|---|
| `--song NAME` | `moonlight` | the piece: `web/demo/songs/NAME.json` |
| `--notes N` | 3 | notes for each preset |
| `--seconds S` | 117 | the time budget; the note length is worked out from it |
| `--rhythm` | off | keep the song's note lengths, scaled to fit the budget (by default every note is as long as the next, so every preset is heard as long) |
| `--tempo BPM` | | play the song's lengths at this tempo instead of fitting the budget |
| `--drum-seconds S` | 1.5 | how long each pattern step runs |
| `--init` | off | include each engine's Init preset |
| `--only "Io 4,Cassia 1"` | | only these patches |
| `--skip "909 Kit"` | | leave these patches out |
| `--size WxH` | `1600x900` | the window's page size in CSS pixels |
| `--dry-run` | | print the plan and stop |
| `--headless` | | no window (for checks) |
| `--shots` | | one screenshot per patch into `build/demo/` |

The plan is printed before anything plays. At the end the script prints the time played against the plan. It also
lists any preset that made no sound, and any preset whose values the editor did not see arrive.

## Recording

- The default page is 1600 x 900 CSS pixels (16:9), in a window about 90 pixels taller for Chrome's bar. It fits a
  1728 x 1117 MacBook screen. On a smaller screen use `--size 1440x810`; on a bigger one `--size 1920x1080` gives 1080p
  at a scale of 1.
- The sound is the browser's audio engine, the same as when you press the EMU panel's keys. Record the system audio, for
  example with QuickTime and a loopback device, or with OBS. MASTER is left where it was.
- Close other tabs of the `[::1]:5173` editor first. Two copies of the editor on one storage would write over each
  other's open patch.

## Leaving your state alone

- The page's Web MIDI sees no ports, so a connected FM-1 is never reached. Nothing is sent, stored or saved to the bank.
- Opening patches writes the editor's open patch, and a sandbox patch marks its card as seen. The script saves the
  origin's storage before the page runs, and puts it back when the demo ends, also after Ctrl-C. It then prints which
  keys it put back.

## Songs

A song is one JSON file in `web/demo/songs/`. `--song NAME` picks `NAME.json`.

```json
{
  "title": "…",
  "source": "where it was transcribed from",
  "tempo": 108,
  "notes": [
    [["C#3", "C#2"], 4, 1],
    ["E2", 1, 13],
    [52, 0.5]
  ]
}
```

Each entry of `notes` is one onset: `[pitch or [pitches], beats]`, and an optional bar number that is only for reading.
A pitch is a MIDI number or a name such as `C#3`, `Db3`, `E#1` or `F##2` (C4 is MIDI 60). Several pitches make a dyad or
a chord. Beats are quarter notes. `tempo` is the piece's own tempo, for reading: the script fits the notes to the budget, or
plays them at `--tempo`.
Notes outside the octave the script chooses are moved an octave in, so the FM-1's 27 keys can play them; the plan says
how many.

`moonlight.json` is the left hand of the first movement of Beethoven's Piano Sonata No. 14, Op. 27 No. 2, as written.
It was transcribed from the Mutopia Project's LilyPond source; the file names the source.
