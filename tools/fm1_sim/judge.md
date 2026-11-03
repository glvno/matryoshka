# Judging a naive-owner session's predictions

Give this file to a judge agent along with one session folder (`build/fm1_sim/sessions/<name>` or `build/fm1_sim/runs/<name>`).

Before every action, the naive owner wrote down what it expected to see or hear next (the `expect` field in `log.jsonl`). The screen that followed is the `screen` PNG on the same line. When a message or banner was showing, `settled` names a second PNG: the same screen a moment later, with nothing touched. The owner saw both, so judge a prediction against either one; a toast covering something is not a surprise when the settled screen shows it. What was heard, for a `listen`, is in `heard`. A prediction that comes true shows that the owner understood what the FM-1 would do. A wrong one is a place where the FM-1 surprised its owner, and those are the places the FM-1's own guidance (quick start, controls sheet, hint lines, messages) should be improved.

## What to do

1. Read `log.jsonl`. For each line whose `args` has an `expect`, look at that line's screen, and at the previous line's screen for comparison. For a `listen`, read `heard`.
2. Give each prediction one verdict:
   - **hit**: what it said would happen, happened. Small wording differences don't matter.
   - **partial**: part of it happened, or it happened with a difference the owner would notice.
   - **miss**: something else happened, or nothing happened when it expected a change.
   - **vague**: it predicted nothing checkable ("something happens", "not sure"). Vague isn't wrong, but it doesn't show understanding.
3. For each miss and partial, write one sentence: what it expected, what the screen showed instead.
4. Group the misses into **surprises**: the distinct things about the FM-1 that caught the owner out (for example "a new pattern is a copy of the current one, not empty"). For each one, give the steps where it happened and the screen text or element that should have told the owner, if there was one.

Judge only from the screens, the heard text and the log. Don't read the firmware source: the point is what the owner could see.

## Output

Write `judge.json` in the session folder:

```json
{
  "counts": {"hit": 0, "partial": 0, "miss": 0, "vague": 0},
  "hit_rate": 0.0,
  "steps": [{"step": 3, "verdict": "miss", "note": "expected the grid; the controls sheet opened"}],
  "surprises": [{"what": "...", "steps": [12, 31], "screen_told": "nothing / the hint line said ..."}]
}
```

`hit_rate` is hits divided by all non-vague predictions. Then reply with the counts, the hit rate and the surprises, most frequent first.
