---
type: schedule
title: "Schedule — overrides and one-shot wakes"
wake: []
pause: []
cadence: {}
---

# Schedule — overrides and one-shot wakes

The due decision reads the frontmatter above at every beat:

- `wake:` — run these agents at the next beat regardless of cadence;
  consumed in the beat's own commit once the run is attempted.
- `pause:` — skip these agents until removed. Pause beats wake.
- `cadence:` — per-agent override of the concept's `heartbeat:` value
  (daily | weekly | monthly | quarterly).

Two writers share this file: the founder by hand (edit `wake:`, commit,
wait for the beat or trigger one), and Mira via a `schedule-request` block
in her reports — applied through her `schedule-update` whitelist gate and
ledgered. Next-fire time is derived from cadence and the ledger — it is
never stored here.
