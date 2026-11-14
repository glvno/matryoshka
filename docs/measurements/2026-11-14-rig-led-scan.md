# The cheaper LED and key scan, on the registered rig, 2026-11-14

Issue #803, [D-934](../ledger/device-ui.md#D-934). The firmware is CI run 43628947934 (the pulse trim: 43633922891) of branch `docs_led-key-scan`. It was installed through `npm run device:scenarios -- --install 43628947934` after the 30-second emulator boot check ([D-123](../ledger/releases.md#D-123)). The baseline is the build with the Reverb's lines one block late, CI run 43615466841 ([the Reverb measurements](2026-11-14-rig-reverb-late.md)). The rig's LEDs were at DIM HIGH, its glow pulse 8 µs.

## What changed

The scan runs in TIMER5, every 100 µs, and that interrupt can interrupt the audio one. It clocked 16 bits into the shift register chain every tick. At DIM HIGH it also waited inside the interrupt for the rest of an 8 µs glow pulse after the shift. Now it clocks one bit a tick (16 after column 1), and a glow pulse of 4 µs or more ends in a one-shot interrupt on TIMER2. A column with a breathing LED, and the shorter glows, keep the old pulse.

## The scan's time

From `tools/m1_link.py --rig t5` (DIAG page 177), with no keys held:

| | Before | After |
|---|---:|---:|
| The scan, a tick (TIMER5 and TIMER2) | 8.7 µs | 3.5 µs |
| The scan's share of core 0 | 8.7 % | 3.5 % |
| Glow pulses a tick | 0.73 | 0.73 |
| A glow pulse (target 8 µs) | 7.8 µs | 8.05 µs |

TIMER5's time inside the audio interrupt, 8 keys held (`tools/m1_link.py --rig blocktime`): Canvas 173 → 68 µs a block, Cassia 1 → 66 µs, Oracle V → 70 µs.

The split pulse first ran 8.6 µs, longer than the target, because the one-shot's interrupt comes a little late. The tick now arms the one-shot early by that measured lateness. On CI run 43633922891 the pulses average 8.05 µs, and the scan takes 3.6 % of core 0.

## Raw data

- [Transport stopped](cpu-survey-2026-11-14-rig-scan.json).
- [Transport running](cpu-survey-2026-11-14-rig-scan-run.json).

These surveys are evidence for this change only. The estimate is refitted once, at the baseline measurements of issue #868's plan.

## Core 0's peak time

| Patch | Before, stopped | After, stopped | Before, running | After, running | Change running (points) |
|---|---:|---:|---:|---:|---:|
| Oracle V | 72.1 % | 70.3 % | 73.8 % | 71.0 % | -2.8 |
| Monolith D | 40.5 % | 40.0 % | 42.0 % | 41.2 % | -0.8 |
| Silver Box | 35.0 % | 34.0 % | 36.4 % | 35.5 % | -0.9 |
| Hera 3 | 64.0 % | 62.1 % | 64.6 % | 63.0 % | -1.6 |
| Sallen 20 | 53.3 % | 52.1 % | 54.2 % | 53.2 % | -1.0 |
| Expander S | 53.8 % | 52.3 % | 56.2 % | 53.5 % | -2.7 |
| Algo Four | 53.5 % | 51.7 % | 54.2 % | 52.2 % | -2.0 |
| Canvas | 63.4 % | 63.4 % | 65.0 % | 65.1 % | +0.1 |
| Wanderer | 48.9 % | 48.6 % | 50.9 % | 50.7 % | -0.3 |
| Briefcase 3 | 56.0 % | 54.0 % | 57.6 % | 55.3 % | -2.3 |
| Io 4 | 66.1 % | 65.0 % | 67.2 % | 65.3 % | -1.9 |
| Vernon 100 | 46.8 % | 45.7 % | 48.7 % | 47.3 % | -1.3 |
| 8 Lire | 45.5 % | 44.8 % | 48.1 % | 46.5 % | -1.6 |
| Elvira 2 | 33.5 % | 33.2 % | 35.0 % | 35.0 % | -0.1 |
| Scrounge | 45.0 % | 44.9 % | 48.4 % | 48.9 % | +0.4 |
| Meridian 8 | 38.5 % | 36.9 % | 42.2 % | 39.7 % | -2.4 |
| Perun 4 | 39.4 % | 38.7 % | 46.2 % | 43.1 % | -3.1 |
| 808 Kit | 52.2 % | 51.6 % | 55.9 % | 57.1 % | +1.1 |
| 909 Kit | 30.6 % | 30.3 % | 35.0 % | 34.8 % | -0.2 |
| Spokes 6 | 47.6 % | 46.8 % | 53.7 % | 51.8 % | -2.0 |
| Cassia 1 | 73.5 % | 72.2 % | 74.6 % | 72.3 % | -2.3 |
| Verona Drum 1 | 50.3 % | 49.6 % | 56.3 % | 55.3 % | -0.9 |

The busiest patches, Cassia 1 and Oracle V, gain about 2 to 3 points. The two patches whose peak rose, 808 Kit running (+1.1) and Scrounge running (+0.4), are within what two surveys of one build differ by.

## Not checked by the rig

The rig cannot see its LEDs or press its keys. The owner checks on the device that the glow levels (DIM LOW, DIM HIGH, the default), the breathing LEDs, the power-on sweep and every key and button behave as before ([D-934](../ledger/device-ui.md#D-934)).
