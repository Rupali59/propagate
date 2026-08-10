# propagate — Decisions

Append-only. Newest last. Each entry: **What / Why / Affects / Refs.**
`**Affects:**` is machine-read — it drives cross-repo relay rows and is enforced
as a pre-commit gate by `PanditPawanKaushik/scripts/decisions-check.sh`.

---

## 2026-08-10: renderMarkdown is idempotent; the staleness banner can no longer freeze

**What:** `renderMarkdown` now diffs the rendered body against the file,
excluding the generated-at footer, and returns `false` without writing when
nothing changed. Loop protection moved out of the callers' event-count
bookkeeping and into the renderer; all three call sites (one workspace, two
cross-ledger) now render unconditionally.

**Why:** the MD header carries a time-derived tripwire, but the render was gated
on "this workspace produced new events." A ledger that went silent therefore
froze its own banner — `PROPAGATION_CROSS_LEDGER.md` read *"Last entry: today.
Watcher healthy."* for four weeks. **The alarm was only updatable by the thing it
was meant to detect.**

**Gotchas:** calling it unconditionally was not an option — that reintroduces the
B0 feedback loop (write ticks mtime → launchd `WatchPaths` re-triggers → ~5s fire
loop). A naive content-compare also fails, because the footer stamps a fresh ISO
timestamp every render. Hence the footer-excluded body diff. Both *cross-ledger*
call sites had the same gate; fixing only the workspace one would have left the
ledger that motivated the finding still frozen.

**Verified:** live cross-ledger self-corrected in production from "today" to
"28 days ago". 80/80 tests pass, 4 new.

**Affects:** propagate
**Refs:** `lib/ledger.mjs`, `watcher.mjs`, `tests/ledger-render-staleness.test.mjs`, commit `9cb5e34`

---

## 2026-08-10: workspace roots become explicit, rather than inferred from marker presence

**What:** add an optional `workspace: boolean` to `propagates.schema.json`.
`discoverWorkspacesSync` keys on that field instead of on the mere existence of
`.propagates.yml`, and **always descends** rather than halting at the first
marker found.

**Why:** `.propagates.yml` currently means two different things — "here are edge
declarations" (19 places on disk) and "here is a ledger boundary" (7 places).
Discovery read the first as the second, so the hub's own root marker halted the
walk and swallowed five workspaces. Result: 93 open rows with 71 misfiled into
the hub ledger under foreign `source` paths.

**Gotchas:** the obvious fix — recurse past the marker — is **worse**. It
promotes all 19, including `Vipin Kaushik/docs/`, which has no `docs/docs`, so
`makeWorkspaceRecord` resolves it to `docs/.propagation/ledger.jsonl` — a brand
new empty ledger beside the real 327-row one, orphaning it. Same bug one level
deeper and much harder to see. Schema must ship before any marker gains the
field, because `additionalProperties: false` makes `loadSidecar` reject it and
the watcher then **silently** stops firing that sidecar's edges.

**Affects:** propagate, Vipin Kaushik, PanditPawanKaushik, ManavDaehi, Keerti
**Refs:** `lib/discovery.mjs:84-101`, `lib/config.mjs:24-44`, `propagates.schema.json:52`

---

## 2026-08-10: the local web UI is cut; ship machine-readable output and a pushed digest instead

**What:** a designed local web UI (Node, port 8791, own token and LaunchAgent)
was **removed from the plan before implementation**. Replaced by
`cli.mjs status --all --json` plus a daily since-last-run digest delivered to a
surface already in use.

**Why:** its direct precedent has never been used. `~/.claude/pending-queue.json`
mtime *equals* its birth time; the queue UI's token was created **16 minutes
after the last write that queue ever received**; its log was deleted by macOS for
inactivity while the process still held it open; and
`claude-queue-ui.py:255` is `def log_message(self, *a): pass` — it is
architecturally unable to emit the `last_invoked` field an adoption probe needs.
Seven write endpoints, 11+ days, zero writes.

The workload is also not per-row: `Vipin Kaushik`'s ledger holds **269 wontfix
rows across 38 distinct seconds, 66 in one second** — scripted bulk dismissal. A
per-row triage UI would serve a workload never once handled per-row.

The real complaint behind "no UI" was that the system was invisible — because
**5 of 8 ledgers were invisible to `status`**, not because output went to a
terminal. Part A fixes that; `--json` and a digest make it consumable.

**Gotchas:** any future UI is gated on (1) retrofitting request logging to the
existing queue UI so the adoption question can be settled with evidence, and (2)
two weeks of demonstrated engagement with the digest. If built, it should be a
tab in the existing process — the "different blast radii" argument for a separate
one was inverted, since 8790 exposes the switch that arms unattended autonomous
execution while a propagate surface is append-only.

**Affects:** propagate, scripts
**Refs:** `~/.claude/plans/claude-we-have-a-memoized-acorn.md` Phase 1a

---

## 2026-08-10: the 69 misfiled hub rows are deferred, and may only ever be closed-and-re-emitted

**What:** fix discovery now; leave the 71 existing hub rows (69 of which belong
to other workspaces) where they are. When migrated, it must be append-only
close-and-re-emit with a manifest and a rollback path — never an in-place rewrite.

**Why:** ids are per-file sequential; `source` is workspace-relative and must be
re-written per destination; `status_change` history would have to be re-pointed;
and `markStatus` against the wrong file **silently no-ops**, so a half-applied
migration is invisible. Once discovery is correct, new drift files correctly and
the old rows are honest history.

**Gotchas:** because `hasOpenDuplicateDrift` is scoped to a single file and
`source` is workspace-relative, the same drift can now be open in two ledgers
simultaneously — one row per subsequent edit of an affected file. So "total open
stays 93" is true only at the instant of promotion, **not** a steady-state
invariant. A `duplicateOpenAcrossLedgers` doctor check ships in the same phase so
the deferral has an expiry signal.

**Affects:** propagate
**Refs:** `lib/ledger.mjs:110`, `watcher.mjs:220`

---

## 2026-08-10: Part A landed — 7 workspaces discovered, verified by the system routing its own drift

**What:** shipped the `workspace: true` predicate, always-descend walk, ledger
path pinning, `{workspaces, markersSeen, degraded, suspiciousMarkers}` return
shape, 5 new doctor checks, and `status --all --json`. WORKSPACES 2 → 7. Tests
80 → 116.

**Why it is believed correct, not just green:** after promotion the watcher fired
and wrote two `code_drift` rows for `SSJK-mb/.env.example` and
`server/config/index.js` into **SSJK-mb's own ledger**, with `source` relative to
SSJK-mb rather than to the hub. Those are rows that would previously have been
misfiled. Cross-checking every open row's resolved absolute path across all
ledgers found **zero** files open in more than one ledger, so this is correct
routing rather than the duplicate class. Discovery previously had **zero** test
coverage, which is why 80/80 green had never been evidence of anything here.

**Gotchas:**
- Open rows went 93 → 95. That is legitimate new drift, and 93 was only ever an
  at-the-instant-of-promotion figure. `duplicateOpenAcrossLedgers` is the check
  that would catch the real regression.
- `cli.mjs init` calls `regeneratePlist` + `reloadLaunchd` as a side effect and
  will silently re-arm launchd. An agent hit this while testing. It should be
  split so `init` scaffolds and `reload` reloads.
- The plist's `WatchPaths` had already drifted to list neither current workspace
  root — the system had been running on `StartInterval 60` alone. Now regenerated
  and covered by a doctor check.
- `DISCOVERY_DEGRADED` intentionally still trips only on total collapse; partial
  loss is surfaced through `suspiciousMarkers` instead, so one workspace dropping
  out is loud rather than invisible.

**Affects:** propagate, Vipin Kaushik, PanditPawanKaushik, ManavDaehi, Keerti
**Refs:** `lib/discovery.mjs`, `lib/config.mjs`, `lib/edges.mjs`, `cli.mjs`, `tests/discovery.test.mjs`, `tests/edges-nesting.test.mjs`, `tests/cli-json.test.mjs`
