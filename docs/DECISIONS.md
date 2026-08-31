
---

## 2026-08-29: twelve days of monitor telemetry — the dedup key fails its stated purpose

**What:** `propagate monitor` has run **2,359 times over 11.6 days** in production,
zero crashes, zero runs that could not look. The design holds. Three of its
published numbers do not, and one is a real defect.

**The defect: 76% of notifications were noise.** 793 findings recorded across only
**188 distinct edges** — 605 of them (76%) the *same edge notified again with
changed bytes*. One edge fired **54 times**. Measured rate: **20.9
notifications/day**, peaking at 65 in a day.

The content triple `(edge_id, source_content, downstream_content)` suppresses only
when **nothing changed**. But editing a declared file *is* a content change, so
every edit cycle mints a new triple and re-notifies an edge you already knew
about. The key works exactly as specified; the specification was wrong about what
it would achieve. It was chosen to answer *"how does it avoid telling you the same
thing every five minutes?"* — and over 12 days it did not.

**The fix is a transition, not a content diff:** notify when an edge *becomes*
actionable, stay quiet while it remains actionable however much it churns, and
re-arm when it returns to CLEAN. That is still derivable per run and still cannot
invent drift — losing the memory still costs one duplicate. Not implemented here;
it changes user-visible notification behaviour and is Rupali's call.

**Correction 1 — run rate, and a correction to that correction.** Predicted
48/day from `StartInterval 1800`. Actual **203/day**.

My first explanation was that `WatchPaths` fires more than assumed. **That was
wrong: `WatchPaths` is ABSENT from the live plist** — a later session removed it,
and `doctor` now carries a check asserting it stays absent. Blaming a key that is
not in the file is the instrument failure this project keeps paying for; it was
caught only because that doctor check contradicted the sentence as it was being
written.

The measured cause: inter-run gaps are **p50 301s, with 2,171 of 2,361 gaps in
the 290-310s band**. The job runs at `ThrottleInterval` (300s), not
`StartInterval` (1800s) — so with both keys set, the throttle is the effective
cadence, not the floor I assumed it was. 288/day theoretical; 203 observed,
the shortfall being machine sleep (max gap 35,287s ≈ 9.8h, an overnight).

**Correction 2 — cost.** Published `~770ms` (warm, interactive). Production
distribution: **p50 3.75s, p95 8.3s**. So the daily budget is ~203 × 3.75s ≈
**13 minutes of CPU**, against the ~37 seconds this file originally claimed —
21x. Still modest, still far below the retired watcher's 1,440 runs/day, and the
design argument is unchanged. The number was simply measured under conditions
that were not production.

**Correction 3 — the 15-minute runs are a measurement artifact, not a hang.**
Three runs recorded ~904,000ms. `ms` is wall clock via `Date.now()` deltas, which
keeps counting while the laptop sleeps. It is not CPU time and must not be read
as one — `rule:discernment-checks` §4, the instrument answering a wider question
than the one asked.

**Also resolved:** 141 `DEP0187` (`fs.existsSync` invalid argument type) warnings
in stderr stopped at 2026-08-28 20:30 while runs continued — fixed by the
repository reorganisation, not still live.

**Affects:** propagate

**Refs:** `~/.propagate/monitor.log` (2,359 runs), `~/.propagate/notified.jsonl`
(793 records, 188 edges). `docs/SYSTEMS.md` `propagate-monitor` row.
