> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — observability (MELT)

What signal would have caught each known defect, and what has to be true for that
signal to mean anything.

Written 2026-08-13, after a session in which **every issue below was found by
accident** — by a human reading a file, or an agent tripping over it. Not one
produced a signal anyone could have watched.

## The failure this addresses

`docs/ISSUES.md` organizes 26 issues around one defect: the silent no-op. The
observability restatement is sharper:

> **Absence of a signal carried no information, and was read as health.**

Zero open rows meant healthy *or* discovery found nothing. A green `doctor` meant
healthy *or* blind. Empty `Affects:` tokens meant no targets *or* a regex that never
matched. `markStatus` returning meant closed *or* written to the wrong ledger.

So the goal is not "add metrics." Numbers nobody reads are how 298 open rows became
furniture. The goal is:

**Every signal ships with an expected range, and departure from that range is the
alert.** A gauge at zero is only meaningful once you have declared it should be
non-zero.

---

## 1 · Metrics — the numbers, and what each must be

Emitted per watcher run and per CLI invocation. `expectation` is the load-bearing
column; without it the metric is decoration.

> **This table is the human form of `EXPECTATIONS` in `lib/report/metrics.mjs`, and the
> `.propagates.yml` edge between them exists to keep it that way.** Measured
> 2026-08-19: 4 of 8 entries were missing here — `graph.cycles`,
> `graph.duplicate_pairs`, `docs.supersedes_unresolvable` and
> `docs.supersession_prose_only` were all asserted in code and documented nowhere.
> The edge had been DRIFTED throughout. **Adding an EXPECTATIONS entry means adding
> a row here in the same commit**; the ratchet value in particular must match, since
> the number is the whole claim.
>
> Note the row below avoids the bare word for its own metric on purpose. The detector
> greps `/supersede/i` per line and cannot tell a claim ("this replaces X") from a
> description of the check itself — so documenting the metric tripped its own ratchet,
> 103 -> 104, on the commit that added this table row (the detector later stopped counting
> fenced blocks, taking it 105 -> 101). Rewording a non-claim is not
> gaming the number; rewording an actual claim would be.

| Metric | Type | Expectation (the alert) | Catches |
|---|---|---|---|
| `workspaces.discovered` | gauge | **≥ 1 always**; any drop ≥50% run-over-run | N7 · discovery break |
| `plist.watchpaths` | gauge | **≥ workspaces.discovered**; never 0 | **N14** · the init wipe |
| `state.tracked_files` | gauge | never drops >20% run-over-run | N13 · baseline loss |
| `sidecars.loaded` / `.rejected` | counter | `rejected == 0` | N9 · schema rejection kills a sidecar |
| `edges.declared` / `.enforced` | gauge | **equal**; the gap is the unenforced set | N6 · glob `kind: code` never fires |
| `rows.fired` | rate | < 20/hour; a burst is a re-fire, not work | N13 · mass re-fire (120 in 4 min) |
| `rows.open` | gauge | trend must be flat or falling over 30d | the 298-rows-become-furniture failure |
| `close.calls{by}` | counter | **> 0 over 30d** | `markStatus` had **zero** callers for months |
| `close.verified` / `.attempted` | counter | **equal** | N4 · close that silently no-ops |
| `graph.cycles` | gauge | **== 0** | a mutually-declared pair has no fix order — verify either side and the other re-arms |
| `graph.duplicate_pairs` | gauge | **== 0** | one coupling declared twice gets two edge_ids; close one and the other stays open forever |
| `docs.supersedes_unresolvable` | gauge | **== 0** | a `supersedes:` naming a path that does not exist looks machine-checked and is not |
| `docs.supersession_prose_only` | gauge | **≤ 101**, ratchet — must not grow | a claim made only in prose is one-way: the overruled doc never learns it was replaced |
| `ledger.unknown_types` | gauge | **0** | N1 · a `manual` row invisible since 2026-06-20 |
| `ledger.duplicate_ids` | gauge | **0** | N2/N3 · id 256 existed twice |
| `ledger.rows_open_multi_ledger` | gauge | **0** | A2 · 28 live instances |
| `ledgers.swept` / `.discovered` | gauge | **equal** | B1 · an orphaned worktree ledger, 1 open row. **Resolved 2026-08-15**: `doctor`'s `no unowned ledger files` scans for the artifact instead of trusting discovery, and classifies branch snapshots so their stale rows are reported but not counted |
| `decisions.entries` / `.with_tokens` | gauge | **equal** | N12 · 8 entries, 0 tokens, gate passing on empty |
| `downstream.unresolved` | gauge | flat; a *jump* means a move, not decay | N11 · `../` edges break on a directory move |
| `rows.written{writer}` | counter | `external == 0` | 87% of the ledger was hand-written |
| `rows.closed_without_transition` | gauge | **0** | 39 rows closed with no audit trail |
| `doctor.duration_ms` | histogram | p95 < 5s | currently **21s** |
| `check.hook_installed` | gauge | 1 where the gate is enabled | G3 · documented, never installed |

Two of these would have paid for the whole exercise on their own.
`close.calls` sitting at **0 for months** is the entire missing-close-path story in
one number. `plist.watchpaths` dropping to **0** is the incident I caused today,
visible in one gauge.

## 2 · Events — discrete, attributed, and *expected to be rare*

Metrics show drift in aggregate; events say what happened and to what.

| Event | Attributes | Why it must be an event, not a log line |
|---|---|---|
| `sidecar.rejected` | path, pointer, reason | N9 kills every edge in that file. Today it is one line in `watcher.log` nobody reads |
| `state.baseline_changed` | tracked_before, after, cause | N13's fingerprint. A wipe is a *step change*, invisible in a rate |
| `plist.regenerated` | roots_before, roots_after, caller | **N14.** `init` rewrote the plist to 0 roots as a side effect |
| `row.fired` | source, type, correlation_id, content_id | the raw fact; joins to close for age |
| `row.closed` | id, disposition, closed_by, **age_ms** | time-to-close, impossible before `closed_at` existed |
| `discovery.degraded` | markers_seen, workspaces_found | N7, and distinguishes "no markers" from "markers but no workspace" |
| `edge.unenforced` | edge_id, reason | N6 · glob `kind: code`; makes "declared but inert" countable |
| `close.rejected` | id, reason | the throw `markStatus` now performs — proof the guard fires |

**Rare by design.** If `sidecar.rejected` fires routinely it stops being read, which
is the failure mode all over again. Any event whose rate rises becomes a metric.

## 3 · Logs — structured, levelled, and actually consumed

`watcher.log` already exists and already contained the evidence. The SSJK-mb sidecar
rejection was sitting in it while we discussed the symptom. The defect is not
missing logs, it is that **nothing reads them and they are unstructured**.

- JSON lines, not prose: `{ts, level, run_id, event, ...attrs}`.
- `run_id` on every line so a run's lines can be collected — the precondition for §4.
- `doctor` surfaces `ERROR`-level lines since the last run. A log nobody reads is a
  log that does not exist.

## 4 · Traces — where the time and the events actually went

A watcher run is already a pipeline; make it a span tree.

```
watcher.run  (run_id)
├── discovery                 ← N7 visible as 0 workspaces, with duration
├── sidecar.load × N          ← N9 visible per file
├── edge.expand               ← glob expansion; N6 visible as skipped
├── worktree.enumerate        ← N8's swallowed failure becomes a span error
├── mtime.check × N
├── row.fire × N              ← the 120-event burst attributable to a stage
└── ledger.render
```

Two answers this session needed and had to reconstruct by hand: *which stage
produced 120 events* (traced: the mtime stage, after a baseline reset), and *where
21 seconds of `doctor` goes* (untraced, still unknown).

Traces are the most expensive layer and the least urgent. Metrics and events cover
every issue in the matrix; traces cover **attribution** — which matters most when
something fires a lot and you need to know why, fast.

---

## 5 · Coverage — every known issue, and what catches it

> Refreshed 2026-08-13 after §6 step 1 landed (`lib/report/metrics.mjs`, wired into
> `doctor()` and `digest.mjs`). Rows below are marked **built** where the
> metric is now actually persisted and asserted, not just designed. Everything
> else in this table is still the design from the original write-up — a plan,
> not a claim of coverage. Per GOTCHAS G2, an issue with nothing in the
> "caught by" column says so explicitly rather than being left to imply a
> signal that doesn't exist.

| Issue | Caught by | Layer |
|---|---|---|
| N1 unknown row types discarded | `ledger.unknown_types == 0` — **built**, asserted every `doctor` run | M |
| N2 id race | `ledger.duplicate_ids > 0` — designed, not built | M |
| N3 sequential ids across branches | `ledger.duplicate_ids` + `row.fired.content_id` — designed, not built | M+E |
| N4 `markStatus` no-op | `close.attempted != close.verified` — designed, not built | M |
| N5 dedup blind to `code_drift` | `rows.fired` rate + duplicate-source ratio — designed, not built | M |
| N6 glob `kind: code` inert | `edges.declared != edges.enforced` · `edge.unenforced` — designed, not built | M+E |
| N7 zero workspaces = healthy | `workspaces.discovered >= 1` — **built**, asserted; `discovery.degraded` event still designed only | M+E |
| N8 worktree enum swallows | span error on `worktree.enumerate` — designed, not built (needs §4 traces) | T |
| N9 schema rejection silent | `sidecars.rejected == 0` — **built**, asserted; `sidecar.rejected` event still designed only | E+M |
| N10 wrong launchd label | `plist.label` vs `launchctl` loaded set — covered by `doctor`'s existing "plist loaded" check, not by a persisted metric | M |
| N11 `../` breaks on move | `downstream.unresolved` step change — designed, not built | M |
| N12 `Affects:` parses to nothing | `decisions.with_tokens == decisions.entries` — **built**, asserted every `doctor` run | M |
| N13 state not scoped | `state.tracked_files` — **recorded** every run, but **uncalibrated**: no run-over-run history yet to set the >20% drop threshold against; `state.baseline_changed` event still designed only | E+M |
| **N14 plist not scoped** | `plist.watchpaths >= workspaces.discovered` — **built**, asserted; `plist.regenerated` event still designed only | E+M |
| **N17** `pathProblems` never incremented | **RESOLVED 2026-08-13** (docs/ISSUES.md), before this metrics work started. `sidecars.problems` — **recorded** every run (uncalibrated: no basis yet for what count is normal) | M |
| **N18** source keys never validated to exist | none — `doctor` validates downstream paths (N17's fix) but never stats a sidecar's `sources:` keys. No metric, no check, nothing in this build touches it | — |
| **N19** 39 rows terminal with no Transition | none — `rows.closed_without_transition` is designed in §1 but not built; would need a schema-level pass over every ledger this session did not do | M (planned) |
| **N20** 87% hand-authored ledger data | none — `rows.written{writer}` is designed in §1 but not built; needs the `JSON.stringify`-spacing forensic to become a real check, not a one-off audit | M (planned) |
| **N21** glob-zero-matches must report UNMATCHED | none — `edge.unenforced` event is designed in §2 but not built; zero live instances as of the finding (2026-08-13), so this is deliberately deferred, not forgotten | E (planned) |
| **N22** glob expansion inflates raw counts | not a telemetry problem — a v2 UI grouping requirement (design note, docs/ISSUES.md). No metric will fix a display bug | — |
| **N23** `WATCHER_LOG` not test-scoped | none — a test-hygiene gap (four test files invoke `watcher.mjs` directly without `PROPAGATE_STATE_DIR`), not something a runtime metric can catch. Same family as N13/G10, but the fix is in the test files, not in telemetry | — |
| A1 promotion strands rows | `rows.open_multi_ledger` — designed, not built | M |
| A2 dup open across ledgers | `doctor`'s existing "no source open in more than one ledger" check (28 live instances, unchanged by this work) — not yet persisted as its own metric | M |
| **A4** nested-workspace multiplication is structural | none — no shared "assign to nearest owner" helper exists yet (docs/ISSUES.md's own fix note); any future metrics emitter that walks `WORKSPACES` without it inherits the same over-counting `sidecar-dedup` had to fix once already. This build's counters (`sidecars.loaded` etc.) DO walk `assignedByWsRoot`, i.e. already deduplicated — but that's inherited from `doctor`'s existing dedup, not a new fix for A4 | M |
| B1 branch-local blindness | `ledgers.swept != ledgers.discovered` — designed, not built | M |
| C1 undeclared files unreported | `files.undeclared` (needs C1 built first) — designed, not built | M |
| G3 gate not installed | `check.hook_installed` — designed, not built | M |
| no close path (months) | `close.calls == 0` — designed, not built | M |
| 87% hand-written | see N20 above | M |
| 39 closes with no audit trail | see N19 above | M |
| `doctor` duration | `doctor.duration_ms` — **recorded** every run (uncalibrated: one post-optimization data point, ~0.3–0.5s warm as of 2026-08-13, is not a p95 distribution) | M |
| the 298-rows-ignored failure | `rows.open` — **recorded** every run (uncalibrated: needs a 30-day trend before a slope threshold means anything); `row.closed.age_ms` event still designed only | M+E |

**Transitional note (v1 → v2):** `rows.open`, `close.calls`, and the row/close
vocabulary throughout this table are v1 nouns. §7 of `docs/DATA_MODEL.md`
already reframes v2 around **verifications** and **derived states** rather than
mutable rows with a `status` field — when that lands, the metrics above keyed
to "open"/"close" become metrics keyed to "unverified"/"stale", not new
concepts. Nothing in this build assumes v1's shape will last; `lib/report/metrics.mjs`
takes metric values as plain `{key: number}` pairs precisely so the v2 rename
is a relabeling, not a rewrite.

**Not coverable by telemetry, and worth saying so:** the lossy fold (a schema/test
problem), the docs-vs-reality drift (a doc test — `tests/docs/skill-doc.test.mjs`), and
the premise being unstated. Telemetry catches behaviour, not meaning. Do not pretend
otherwise; that pretence is how a green dashboard becomes the new silent no-op.

---

## 6 · Build order

Cheapest first, and each is independently useful.

1. **Counters + gauges into the existing `state.json` run record. — BUILT 2026-08-13.**
   Landed as `lib/report/metrics.mjs`, a dedicated append-only `metrics.jsonl`
   (`PROPAGATE_STATE_DIR`-scoped, not `state.json` itself — `state.json` is the
   watcher's mtime baseline and mixing a growing metrics history into it risked
   the exact "a default that moves loses state silently" failure GOTCHAS G12
   names). What actually shipped:
   - `doctor()` (`cli.mjs`) tallies twelve metrics it was already computing
     and throwing away (`workspaces.discovered`, `sidecars.loaded/.rejected/.problems`,
     `ledger.unknown_types/.malformed`, `rows.open`, `decisions.entries/.with_tokens`,
     `plist.watchpaths`, `state.tracked_files`, `doctor.duration_ms`,
     `doctor.problems`) and appends one record per run.
   - The five equality/non-zero expectations from §1 that needed no rate-style
     guessing (N7, N12, N1, N9, N14) are asserted every run, each carrying the
     concrete incident that motivated its threshold (`EXPECTATIONS` in
     `lib/report/metrics.mjs`) — not invented numbers (GOTCHAS G16).
   - Six more metrics are recorded but explicitly marked `UNCALIBRATED`
     (`rows.open`, `doctor.duration_ms`, `sidecars.loaded`, `sidecars.problems`,
     `ledger.malformed`, `state.tracked_files`) — no threshold exists for them
     yet, and per G3/G16 an invented one would be worse than none.
   - `detectVanishedKeys` catches R6: a metric key present last run and absent
     this run is its own `doctor` failure, distinct from an out-of-range value.
   - `digest.mjs` delivers both halves without recomputing them: violations
     from the newest `doctor` run feed the existing `BROKEN` section; metric
     values that changed since the *last digest cycle* (not the last `doctor`
     run — those can differ) render under a new `METRICS (doctor):` section,
     diff-only, same "report what changed" discipline as the existing
     DISK/SKILLS sections.
   - `metrics.jsonl` is capped at 3,000 records (oldest trimmed first) so it
     cannot become the next unbounded, unread artifact — the entire point of
     this section per GOTCHAS G3.
   - **Known limitation, stated rather than hidden:** `doctor` is a manual/
     point-in-time check; nothing in this codebase runs it on a schedule. The
     digest is daily. A metric that regresses between `doctor` invocations is
     invisible until someone runs `doctor` again — there is no continuous
     collection yet. §6 step 4 below (a scheduled `doctor --since`) is what
     would close that gap, not this step.

   This alone covers the five equality-shaped issues in §5 outright and
   surfaces (without yet calibrating) six more.
2. **`run_id` + JSON log lines.** One field, unlocks correlation and §4 later. Not built —
   `metrics.jsonl` records carry a `run_id` per doctor run, but `watcher.log` lines still
   do not (out of scope: watcher.mjs was explicitly off-limits for this build).
3. **Events to an append-only `~/.propagate/events/telemetry.jsonl`.** Same store as
   the v2 ledger; the disposable-index discipline applies. Not built — every §2 event
   (`sidecar.rejected`, `state.baseline_changed`, `plist.regenerated`, etc.) is still
   design-only; `doctor`'s per-run gauges are a substitute for the aggregate picture,
   not for "what happened and to what."
4. **`doctor --since <t>`** reading the above — troubleshooting becomes a query
   rather than an archaeology dig, which is what this session actually was. Not built.
   `readMetricsRecords`/`readLastMetricsRecord` (`lib/report/metrics.mjs`) already read the
   full history and the newest record respectively — a `--since` flag is a thin CLI
   layer over data that already exists, not a new storage problem.
5. **Spans.** Only after 1–4, and only if attribution is still slow. Not built.

**Design rule, restated because it is the whole point:** a metric without an
expectation is decoration. Every gauge above ships with the assertion that makes it
alertable, or it does not ship.
