# Demo video (Remotion)

A product video made from one scripted take of the real editor: `../riffs/vernon.mid` (97 bpm, Vernon 100 an octave
down) is played through the app while a pointer goes through the shots, then Remotion pans and zooms over the take and
adds the brand at the start and the end. Dev only: nothing here ships with the app. Not finished (the user switched to
the in-app Demo patch); see the 2026-10-20 section of the old session log, `git show 057c70d:docs/NOTES.md`.

- `npm i` (Remotion, Playwright; `npx playwright install chromium` once).
- With the dev server running (`npm run dev` in `web/`, http://localhost:5173): `node scripts/record.mjs` records the take
  (frames, the app's own audio, the shots) into `public/take/`, then `node scripts/make-take.mjs` makes `take.mp4` and
  `take.wav` (needs ffmpeg).
- `npx remotion render Demo out/trial.mp4 --scale=0.5 --crf=26` for a quick look, `npx remotion render Demo out/demo.mp4
  --crf=16` at 1920 x 1080; `npm run dev` opens Remotion Studio.

`scripts/setup.mjs` opens the patch (Vernon 100 at 97 bpm, the ARP button free, the canvas at 125 %), `scripts/rig.mjs`
builds the drums before the take (switched off, their tracks filled), `src/Demo.tsx` is the camera and the brand.
`public/take/` and `out/` are not kept.
