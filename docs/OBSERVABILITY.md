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
| `ledger.unknown_types` | gauge | **0** | N1 · a `manual` row invisible since 2026-06-20 |
| `ledger.duplicate_ids` | gauge | **0** | N2/N3 · id 256 existed twice |
| `ledger.rows_open_multi_ledger` | gauge | **0** | A2 · 28 live instances |
| `ledgers.swept` / `.discovered` | gauge | **equal** | B1 · an orphaned worktree ledger, 1 open row |
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

| Issue | Caught by | Layer |
|---|---|---|
| N1 unknown row types discarded | `ledger.unknown_types > 0` | M |
| N2 id race | `ledger.duplicate_ids > 0` | M |
| N3 sequential ids across branches | `ledger.duplicate_ids` + `row.fired.content_id` | M+E |
| N4 `markStatus` no-op | `close.attempted != close.verified` | M |
| N5 dedup blind to `code_drift` | `rows.fired` rate + duplicate-source ratio | M |
| N6 glob `kind: code` inert | `edges.declared != edges.enforced` · `edge.unenforced` | M+E |
| N7 zero workspaces = healthy | `workspaces.discovered == 0` · `discovery.degraded` | M+E |
| N8 worktree enum swallows | span error on `worktree.enumerate` | T |
| N9 schema rejection silent | `sidecar.rejected` · `sidecars.rejected > 0` | E+M |
| N10 wrong launchd label | `plist.label` vs `launchctl` loaded set | M |
| N11 `../` breaks on move | `downstream.unresolved` step change | M |
| N12 `Affects:` parses to nothing | `decisions.entries != decisions.with_tokens` | M |
| N13 state not scoped | `state.baseline_changed` · `state.tracked_files` drop | E+M |
| **N14 plist not scoped** | `plist.regenerated` · `plist.watchpaths == 0` | E+M |
| A1 promotion strands rows | `rows.open_multi_ledger` | M |
| A2 dup open across ledgers | same | M |
| B1 branch-local blindness | `ledgers.swept != ledgers.discovered` | M |
| C1 undeclared files unreported | `files.undeclared` (needs C1 built first) | M |
| G3 gate not installed | `check.hook_installed` | M |
| no close path (months) | `close.calls == 0` | M |
| 87% hand-written | `rows.written{writer=external}` | M |
| 39 closes with no audit trail | `rows.closed_without_transition` | M |
| `doctor` 21s | `doctor.duration_ms` p95 | M |
| the 298-rows-ignored failure | `rows.open` trend + `row.closed.age_ms` | M+E |

**Not coverable by telemetry, and worth saying so:** the lossy fold (a schema/test
problem), the docs-vs-reality drift (a doc test — `tests/skill-doc.test.mjs`), and
the premise being unstated. Telemetry catches behaviour, not meaning. Do not pretend
otherwise; that pretence is how a green dashboard becomes the new silent no-op.

---

## 6 · Build order

Cheapest first, and each is independently useful.

1. **Counters + gauges into the existing `state.json` run record.** No infrastructure
   at all. `doctor` asserts the expectations in §1. This alone covers ~15 issues.
2. **`run_id` + JSON log lines.** One field, unlocks correlation and §4 later.
3. **Events to an append-only `~/.propagate/events/telemetry.jsonl`.** Same store as
   the v2 ledger; the disposable-index discipline applies.
4. **`doctor --since <t>`** reading the above — troubleshooting becomes a query
   rather than an archaeology dig, which is what this session actually was.
5. **Spans.** Only after 1–4, and only if attribution is still slow.

**Design rule, restated because it is the whole point:** a metric without an
expectation is decoration. Every gauge above ships with the assertion that makes it
alertable, or it does not ship.
