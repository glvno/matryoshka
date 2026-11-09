# Changelog

## Unreleased

### Editor and FM-1

- **Harmonizer module:** one key plays a whole chord on that root, after the Telepathic Instruments Orchid. Cable it between Main's keys and a Voicing. Its chord buttons are maj, min, dim, sus2, sus4, 7 and 9, and buttons held together combine (min + 7 + 9 is a minor ninth). On the FM-1 they are its seven lowest keys, at any octave: black keys 1 to 3 pick maj, min or dim, white keys 1 to 4 add sus2, sus4, 7 or 9, and every other key plays a root; the screen names the chord (CHORD: MIN7). From a MIDI keyboard they are the seven keys under the split (F3 to B3 as made). With no button held the card's own chord plays. LOCK keeps the chord so the buttons need not be held; VOICING moves it through its inversions. A patch with a Harmonizer is saved in format 52, which needs this firmware.

### FM-1

- **The sound engine compiled for speed:** the code the audio interrupt runs (the render, every module, the mix, USB audio's copy) is built at -O2, the rest of the firmware for size as before. The firmware grows 531,088 → 546,236 B of the 581,564 B its slot holds (CI build, #798).
