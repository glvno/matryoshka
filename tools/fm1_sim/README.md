# The naive-owner test

Measures how well the FM-1 teaches itself ([D-134](../../docs/ledger/releases.md#D-134)). An agent that plays a new owner tries to reach a goal on a simulated FM-1, with nothing but the screen, the panel and its ears. It writes down a forecast before every action. A grader then checks whether it reached the goal, and a judge checks which forecasts came true.

## The parts

- `firmware/test/fm1_sim.c`: the firmware's panel, screen and engine code, built for the Mac. Each run replays a list of actions from power-on: the bank's first patch, with the quick start card showing. It writes the screen, the screen once any message has gone, a state file for the grader, and what was heard. Every action takes at least 50 ms, with the engine running, before the next one: no hand is faster.
- `server.py`: the FM-1 as tools for the agent: look, press, hold, release, turn, play a key, hold a key, release a key, wait, listen, done. Every action needs a forecast (`expect`). It returns the screen as an image, never as text. It uses only Python's standard library.
- `fm1-naive-owner.md`: the agent's definition. Its only tools are those of `server.py`.
- `grade.py`: checks a goal from the session replayed from power-on (goals: `patch`, `preset`, `layer`, `tempo`, `rowboat`).
- `judge.md`: the instructions for a judge agent that scores the forecasts.
- `watch.py`: a page that shows a session live, newest action first.

## Running it

1. `tools/fm1_sim/build.sh` (again after any firmware change).
2. Install the agent: `tools/fm1_sim/install-agent.sh`. It points the agent at this checkout. Claude Code reads it when an agent starts.
3. For a live view: `tools/fm1_sim/watch.py`, then open http://localhost:8765/.
4. Before each run, `printf <label> > build/fm1_sim/NEW_SESSION`. The next action then starts a fresh session from power-on, in `build/fm1_sim/sessions/<time>-<pid>-<label>/`.
5. Ask Claude Code to start the `fm1-naive-owner` agent with a goal, for example "The FM-1 has just been switched on. Your goal: set the tempo to exactly 100 BPM."
6. `tools/fm1_sim/grade.py tempo build/fm1_sim/sessions/latest`, then give `judge.md` and the session folder to a judge agent.

Run one owner at a time. Claude Code starts `server.py` once and shares it between every copy of the agent, so two at once press buttons on the same FM-1.

## What it can't tell you

The simulator has no USB, no editor link, no MIDI clock and no real timing. "Listen" reports silence or sound, whether two or more sounds play at once (read from which devices are armed, not from the audio), and the notes a sequence plays. It assumes a perfect ear and names drum hits as notes. An agent reads every word and never tires or misclicks, so a run shows whether the information is on the FM-1 and can be found. It doesn't show whether a person on stage would find it in time.
