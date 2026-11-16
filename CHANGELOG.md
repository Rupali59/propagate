# Changelog

All notable changes to propagate are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/) (before 1.0 a feature or a breaking change bumps the minor number), and commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). `propagate release notes --write` drafts each section from the commits; a person edits it.

Releases v0.15.50 to v0.15.59 were backfilled once, from their tags' ranges (`git log vA..vB` per consecutive pair; v0.15.50 has no earlier tag in this list, so it lists only the commit it points at). Where a tag sits on a follow-up commit rather than the feature (v0.15.53), the section follows the actual range. From 0.16.0 each section is drafted by `propagate release notes --write --version X`. Older releases are in `git log`.

## [Unreleased]

### Upgrading
- **Node >= 22.13 is now required** (was 22.0). `propagate work` keeps its queue in Node's built-in `node:sqlite`, which is unflagged from 22.13.0. On the 22.x line that module is still marked experimental; propagate hides only its SQLite warning. Check with `node --version` before upgrading.
- **`propagate work` creates `$PROPAGATE_STATE_DIR/work/queue.db`** (plus `-wal` and `-shm`) on first use. These files are state, not cache: never delete them as part of a cache clean.
- **The background guard now logs its refusals** to `$PROPAGATE_STATE_DIR/guard/YYYY-MM.jsonl` (#294): one row per `deny` and per backgrounded call that matched a rule, holding a program name and a 16-hex hash, never command text. An install without a `guard/` directory works unchanged; it is created on the first logged event. Every glance write deletes month files older than 90 days (#295 moved the prune there from `day open`). Nothing to migrate, and a downgrade leaves the directory harmlessly unread.
- **New `$PROPAGATE_STATE_DIR/glance.json`** (#295), written by `propagate glance`, the monitor, CLI `doctor` and `day open`. It does not exist after the upgrade until one of them runs; every reader handles the absent file (the session line says `glance: not computed yet; run propagate glance`). The first monitor pass after upgrading fills in the edges; until then a standalone `propagate glance` shows edges as unknown and exits 1. Nothing to migrate. A downgrade leaves the file harmlessly unread.
- **The SessionStart line now always ends with a glance line**, also in folders outside every workspace and with no checkouts cache, where it was silent before (ruling 2026-11-16).
- **Doctor entries may carry a `  ⚑ human id=<check_id>` marker** before any `⇒` action (#295). Unmarked lines are byte-identical; a consumer of doctor's text that splits label and detail should strip the marker the way `structure.mjs` does.
- **The monitor sends far fewer notifications; that is intended** (#296). It notifies when an edge, a backlog defect or a needs-you or broken glance item is NEW (additions only, keyed `edge:<edge_id>` and the like, never on content), stays quiet while it remains, and stays quiet for 24 h if it clears and returns. Every notification now opens its view of `propagate ui` when clicked.
- **New `$PROPAGATE_STATE_DIR/notify-state.json`** (#296), what the monitor has told you. The first monitor run after upgrading has no record, so it **seeds silently** and notifies nothing; from the next run on, only additions notify. Deleting it costs one more silent seeding run; a corrupt one costs one notification per open finding. `notified.jsonl` is kept as the audit log and is no longer read to suppress anything. A downgrade leaves the file harmlessly unread, and the old content-keyed dedupe resumes from `notified.jsonl` (its rows now carry `edge:<id>` keys, so expect one round of repeats).
- **New `$PROPAGATE_STATE_DIR/glance-acks.json`** (#296), written by `propagate glance ack` / `unack` and the web view's acknowledge and snooze. Absent means no acks. glance.json items may carry an additive `ack: {at, until}` field.
- **The digest notification's body is now the glance verdict line**, not the digest's timestamp heading (#296).
- **`doctor` (default view) prints its verdict line first**, as well as last. **`# Scheduled jobs` no longer warns on a running job** (a live pid) whose last exit was non-zero, and a warned job's line carries `check_id jobs.<label>`.
- **Plans need a `Surface:` line from 2026-11-30.** The plan-goal hook now also requires `Surface: none` or `Surface: ui|widget|command|job|skill|notification|hook`, and a non-`none` plan needs `## Need` (`Question:`, `Decision:`, `Today:`, `Retire when:`) and `## References checked` sections. Until 2026-11-30 a plan with no `Surface:` line is allowed with a warning; after it, it is denied. A plan that declares a Surface without its sections is denied now. Override with a `surface_reason: <why>` line. Grammar: `docs/REFERENCE.md` "The plan grammar". Placeholder values (`<...>`, `TODO`, `TBD`, `?`, `-`) do not count as filled.
- **The Surface gate is off by default outside the owner's tree** (no declared hub and no `plans/approvals.jsonl`), so a fresh install is not denied. Turn it on or off with `hooks.planSurfaceGate: on|off` in `config.yml` or `PROPAGATE_PLAN_SURFACE_GATE`.
- **The plan-goal hook writes `$PROPAGATE_STATE_DIR/plan-gate/YYYY-MM.jsonl`**, one `{ts, session, verdict, missing}` row per deny or warn (no plan text), and `plans/approvals.jsonl` rows gain `surface` and, when used, `surface_reason`. Older rows without them still read.
- **`doctor` adds a warn-only `# Retirement candidates` section** (#298), and the digest's ADOPTION ask now reads every discovered workspace `SYSTEMS.md`, not only propagate's own. Both parse a table by header name. A `SYSTEMS.md` whose table lacks `id`, `status`, `last_verified` or `adoption_date` is now reported as unreadable, with its path, where it used to yield 0 candidates silently. The two use different rules on one scan. The section lists every row whose status starts with `active`, whose `adoption_date` is blank, and whose first verification was more than 30 days ago. Expect it to list more rows than the digest ever asked about. The digest's ask keeps its exact statuses. A digest candidate with no leading date in `last_verified` is now `unknown: no start date`, and the digest no longer asks about it. Nothing an existing install stores changes.

## [0.19.0] — 2026-11-10

### Upgrading

- **`rules selftest` checks a `load: always | scoped | companion` line** on each propagate-format rule (one with an `id`) and on `*.evidence.md` companions, against what Claude Code does with the file. Add the line, or run the selftest to see the expected tier. Plain rule files without propagate frontmatter are tiered but never failed for lacking it.
- **`doctor` adds two sections**, both warn-only: `# Unrecorded work` (already in 0.18.0) and `# Scheduled jobs` (macOS launchd jobs that run this tree's code; elsewhere it prints one skipped line).
- **The monitor may skip `doctor`** when nothing in the tree changed. It keeps the fingerprint in a new sibling file, `doctor-snapshot.json.fingerprint.json`, and writes an optional `doctor=` field in `monitor.log`. Old snapshots and log lines still read; the first run after upgrading runs `doctor` once and writes the fingerprint.
- Nothing else an existing install stores changes.

### Added

- doctor: # Scheduled jobs section, launchd jobs running this tree's code ran within 26 h (workspace-hub#75)
- sprint: propagate sprint review, done against planned per board, carry-over moves only with --apply (#191)
- rules: rules selftest checks every rule's load: tier against what Claude Code does with it (#218)
- monitor: run doctor only when the tree changed: fingerprint skip, 24 h ceiling, SYSTEMS row (#239)

### Fixed

- rules: load: is required only of propagate-format rules and companions, so a public user's plain rule files do not fail rules selftest (#218)
- doctor: scheduled jobs: no age verdict for interval jobs; a quiet log is not a stopped job (workspace-hub#75)
- monitor: the doctor fingerprint covers every repo doctor sees, nested projects included (#239)
- release: the publish script uses the release each write returned, not a re-read list (#238)

### Changed

- test-impact: map re-recorded on main after workspace-hub#75 (3497 pass; the only red was the map's own membership test)
- monitor: the history parser's expected row carries #239's doctor field (null on pre-#239 lines); impact map re-recorded

## [0.18.0] — 2026-11-10

### Upgrading

- **Release tags change name from this release on:** `propagate-vX.Y.Z`, annotated (`rule:release-versioning`). The old `v*` tags stay where they are, are never moved or deleted, and are listed as legacy tags. Anything that pins propagate by tag should switch to `propagate-v*`.
- Nothing an existing install stores changes. The new `upgrade-path` release gate checked this: it installed v0.17.0, then ran this version's `doctor` and `status` over the same state, clean, and v0.17.0's `doctor` afterwards (the downgrade check) is also clean.
- `doctor` no longer reads sidecars inside git worktrees, and an empty unowned ledger is info, not a failure. Expect far fewer findings.

### Added

- release: upgrade-path gate: the previous tag's install must survive this version (#236)
- release: annotated propagate-vX.Y.Z tags, the release-tag gate, and the draft-to-replaced publish script (#238)
- doctor: flag records left uncommitted and branches not on a remote (#131)

### Fixed

- release: a failing TODO test is not listed as failing, so the map self-heal fires (#235)
- release: a deliberate PROPAGATE_UPGRADE_PATH_SKIP leaves the release INCOMPLETE, never READY (#236)
- doctor: an empty unowned ledger is reported, not counted; agent worktrees are gitignored (#129)
- doctor: validate sidecars with the walk status/reconcile use, so worktrees are skipped (#129)
- git: read-only git calls set GIT_OPTIONAL_LOCKS=0; migrate test snapshot ignores git's index (#102)
- skills: propagate-drift eval accepts propagate-status as a correct route (#128)

### Changed

- test-impact: map re-recorded on main after #129 (3407 pass; the only red was the map's own membership test)
- test-impact: map re-recorded on main after #102 and #73 (3405 pass / 0 fail)
- claims-judge: give the one state-writing test file its own PROPAGATE_STATE_DIR (#73)
- test-impact: map re-recorded on main after #128 and #131 (3403 pass; the only red was the map's own membership test)

## [0.17.0] — 2026-11-10

### Upgrading

- Nothing an existing install stores changes: no state, ledger, sidecar-schema or settings shape moved. `sprint plan` is new and read-only. It needs `PROPAGATE_USAGE_WIDGET_DIR` to compute a budget; without it, it exits 2 and says so.

### Added

- sprint: `propagate sprint plan` reads whether the Ready work fits the usage left (#190)

### Fixed

- sprint: "could not compute" printed once, not twice; impact map re-recorded on main
- release: a red run whose only failure is the map's own membership test rebuilds the map and passes (#235)

## [0.16.1] — 2026-11-09

### Fixed

- rules: rules check and the session banner honour the accepted-findings registry, so an accepted permanent finding stops reading as red (#219)

## [0.16.0] — 2026-11-09

### Added

- release: a release's kind derives from its commits; a commit-msg hook refuses a bump that does not match; Keep a Changelog notes

## [0.15.59] — 2026-11-09

### Added

- costs: `propagate costs window` derives a main-session item's tokens and minutes from the transcript — v0.15.59

## [0.15.58] — 2026-11-09

### Added

- gotchas: a Status marker and an untriaged ratchet; retired entries stop firing; the release suite fits its gate again — v0.15.58

## [0.15.57] — 2026-11-09

### Added

- gotcha-guard: a hit delivers title, remedy and pointer, not the whole entry; `propagate context` measures it — v0.15.57

## [0.15.56] — 2026-11-07

### Added

- status: name the repo and branch a drifted edge was last verified on, when that repo has moved branch — v0.15.56

## [0.15.55] — 2026-11-07

### Fixed

- docs: the supersession ratchet stops counting a doc's notice that it was overruled, and a doc naming itself — v0.15.55

## [0.15.54] — 2026-11-06

### Added

- instructions: --gate refuses a commit that grows a folder past the session-instruction budget — v0.15.54

## [0.15.53] — 2026-11-06

### Added

- costs: a SubagentStop hook records each finished lane's real token cost, by type, in an append-only ledger — v0.15.53

### Changed

- test-impact: map refreshed by release --check for v0.15.53
- systems: claude-usage-sample row follows widget#94's scripts/ layout, and derives the probe's exit codes
- reference: manifest's services column, the two INTEGRATIONS keys, and propagate services' findings

## [0.15.52] — 2026-11-05

### Added

- services: propagate services derives who uses each external service, and names every gap — v0.15.52

## [0.15.51] — 2026-11-05

### Fixed

- goals: letter goal ids (E, V0, S…) parse, and one heading regex serves headings and bodies — v0.15.51

## [0.15.50] — 2026-11-05

### Added

- manifest: record where credentials live, per repo, and derive each repo's framework — v0.15.50
