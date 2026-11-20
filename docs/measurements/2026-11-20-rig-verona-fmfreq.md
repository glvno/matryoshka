# Verona Drum 1 with FM FREQ over the knob's range: test rig, 2026-11-20

The registered test rig ran the released 1.23.0 firmware (FM-1_7012300, the qualified package, installed for this run). `tools/rig_cpu_survey.py` uploaded each patch live. It held 0, 1, 4 and 8 notes over USB MIDI for 2 s each, sampled every 0.5 s, with the transport stopped and then running. It reloaded the patch for each phase. The budget is 2,902 µs a block.

- The branch's patch (PR #1147, issue #866) was measured with each of its six factory presets loaded: Init, Dance Floor, Trouser Flap, Beat Box 78, Clave and Conga and Metal Works (`cpu-survey-2026-11-20-rig-verona-fmfreq.json`, `-run.json`).
- 1.23.0's own Verona Drum 1 (main's `presets.h`) was measured in the same session for comparison (`cpu-survey-2026-11-20-rig-verona-1.23.0.json`, `-run.json`).

| | Stopped: steady | Stopped: peak | Running: steady | Running: peak | Late, overload, shed |
|---|---|---|---|---|---|
| Branch, worst of 6 presets | 54.6 % | 61.9 % | 63.0 % | 64.5 % (Metal Works) | 0 |
| 1.23.0 | 53.1 % | 60.8 % | 61.6 % | 63.7 % | 0 |

"Steady" is the largest sample after each phase's first. "Peak" includes the first block after the load. The six added modules cost about 1.5 points of steady time on the rig, where the estimate said 0.9 (66.7 % to 67.6 %).
