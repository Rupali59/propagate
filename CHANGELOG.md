# Changelog

All notable changes to propagate are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/) (before 1.0 a feature or a breaking change bumps the minor number), and commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). `propagate release notes --write` drafts each section from the commits; a person edits it.

Releases v0.15.50 to v0.15.59 were backfilled once, from their tags' ranges (`git log vA..vB` per consecutive pair; v0.15.50 has no earlier tag in this list, so it lists only the commit it points at). Where a tag sits on a follow-up commit rather than the feature (v0.15.53), the section follows the actual range. From 0.16.0 each section is drafted by `propagate release notes --write --version X`. Older releases are in `git log`.

## [Unreleased]

### Added

- lane-checks: a repo's `.lane-checks` (test paths, `run: <cmd>`, `#` comments) lists the checks a lane runs before it reports; `propagate lane-checks [--repo <dir>] [--json]` runs them (exit 0 pass, 1 failed, 2 could not run, never a blind pass), and `dispatch-model` denies a code lane in such a repo whose brief has no `lane-checks:` line or `lane_checks_reason:`; gates never read the file (#453).
- worktrees: `propagate worktrees [<repo>...] [--apply]` runs the cleaner's worktree collector (dry run unless `--apply`), passes its exit through, and posts the issue comments it routes once per head; `glance` gains a `cleaner` row from the cleaner's `last-audit.json` ("not built", "never run" and "not configured" are never 0); new `cleanerDir` integration (`PROPAGATE_CLEANER_DIR`) (#274, #446).
- refs: `propagate refs record-pruned` records a branch an outside tool prunes, validated (`detected_by` allowlist, evidence JSON, head equal to the snapshot's), dry run unless `--apply`; the next `migrate-refs` drops the duplicate `pruned` or emits one `prune-incomplete`, which `doctor` warns on (#448).
- attention: `propagate attention next|list|clear` and a `Notification` hook queue the Claude Code sessions that need you, and `next` focuses the Ghostty tab of the one that has waited longest (skipping closed tabs, exit 1 when none wait); bind it to a global hotkey (#445). Needs `/reload-plugins`.
- sessions: a session's board item is derived from the work it does (`gh issue close|comment|edit`, `gh pr create|merge`, a `<type>/<n>-<slug>` branch start) by the PostToolUse hook, and the newest association wins, dispatch included; the new `session-title` UserPromptSubmit hook prefixes the session title with `owner/repo#n` (#442). Needs `/reload-plugins`.

## [0.20.0] — 2026-11-19

This release carries two pieces of work: standards increment 1 (#320, `071aebc`) and the rename of the standards and references model to the knowledge base, `kb` (#322, `f8bdd7d`). The plan was to release them separately (#332), but the rename merged before 0.20.0 was tagged, so both ship here.

### Upgrading

- **`propagate standards …` becomes `propagate kb standards …`.** The old command still works for this release. It prints one deprecation line to stderr, and its stdout is byte-identical to the new command's.
- **Config keys:** `kbStandardsFile`, `kbStandardsDir` and `kbReferencesFile` (under `integrations:`) are read first. The old `standardsFile` and `standardsDir` still resolve for one release, and `doctor` names each old key that actually supplied a value (`legacy-name`, warn).
- **Sidecars:** a `kb:` key replaces `standards:`. Both are read; a sidecar carrying both is refused with its path, never merged. `propagate kb migrate` rewrites `standards:` to `kb:` and is a dry run unless `--apply`.
- **Cached tool versions** move to `$STATE/kb/versions.json`. The old `$STATE/standards/versions.json` is still read when the new one is absent, so an existing cache survives the upgrade.
- **`doctor`'s `# Standards` section is now `# Knowledge base`.** Two declared edges change id with their renamed sources; neither had any verification events, so the new edges simply start unverified.
- Upgrade tests run an existing 0.19.x-shaped install (old hub layout, new hub layout, old config keys) through `kb standards --json` against a golden captured from the pre-rename code.

### Added

- kb: `propagate kb standards|references|migrate`; `standards` is a deprecated alias for one release (#322)
- standards increment 1: the standards core, adoption in the sidecar, doctor's standards section and root units (#269, #290, #291)

- standards: a sidecar-less workspace root is a unit; the undeclared-repo walk is unbounded (#291)
- standards: probe a workspace repo's own root for a unit; report undeclared repos one level deeper (#291)
- standards: doctor # Standards section; local rows inherit or default their State (#269, #290)
- standards: adopt, decline and remove record adoption in the sidecar (#269)
- standards: page parser reads extends: and Applies: (#269, #290)
- plan-goal: warn when a plan says Surface: none but touches a surface (#301)
- ui: the glance view: list with verdict and source filters, row menu, bulk ack and snooze, a detail route per item (#296)
- monitor: every notification opens its propagate ui route; glance additions notify after doctor; digest body is the verdict line (#296)
- glance: ack and snooze, persisted in glance-acks.json; propagate glance ack/unack (#296)
- notify: additions-only notification ids with a 24 h re-entry hold; edges re-keyed on edge_id (#296)
- doctor: retirement candidates use their own wider rule; the digest ask keeps the narrow one (#298)
- doctor: retirement candidates from one header-keyed SYSTEMS.md scan (#298)
- glance: one line per source with badges; the session line groups by source, plain (#295)
- glance: monitor, doctor and day open write the glance from what they hold; doctor prints its verdict first (#295)
- session-guide: the glance session line, last to be cut, in every folder (#295)
- glance: signals, verdict rule, glance.json contract and propagate glance (#295)
- doctor: human and check_id markers cross the text seam; a live pid is not a job failure (#295)
- plan-goal: Surface / Need / References checked plan gates (#297)
- guard: background-guard logs deny and allow-bg rows, never command text (#294)
- docs: standards pages read as doc kind "standard" (#269)
- standards: row status, tool versions, and the standards and standards versions commands (#269)
- standards: the parser reports malformed headings, stray and unknown fields, targetless checks (#269)
- standards: page and row parser, registry loader, two config keys (#269)
- work: propagate work CLI, prune, wiring and REFERENCE (#150 task 4)
- work: sync apply is linear, ids widen, markdown URLs and parked ttl fixed (#150 task 3 fix 1)
- work: canonicalUrl and the GitHub sync, fetch first then one transaction (#150 task 3)
- work: race test retries interleave under load; claims output no longer reads as a bare claim() call (#150 task 2)
- work: queue operations, token-fenced claims and a two-process race test (#150 task 2)
- work: the queue database, its v1 schema, typed errors and the Node 22.13 floor (#150 task 1)
- broadcast: session-guide shows open broadcast children and records each showing (#267)
- broadcast: a local index of open children, a shown record, and null-safe goals (#267)
- hooks: background-guard denies the foreground and shell-& forms of a long run (#224)
- sessions: `sessions new|stop|rm|stop --force`, day open's sessions lines, and a SessionStart guidance hook (#272 steps 2-4)
- sessions: `propagate sessions`, `show` and `assoc`: which Claude Code session works where (#272 step 1, read)
- broadcast: phase 1, `broadcast new` and `broadcast status`: one piece of work fanned out to many repos as GitHub sub-issues (#267)
- hooks: rule-guard also runs on Bash, narrowed by `if: Bash(*vercel*)`, so a shell-command rule trigger can fire
- goals,day: a plan must name an active goal at approval; the board reader pages past 100 (G3)
- hooks: dispatch-model refuses a subagent dispatch whose model differs from its issue's Model, and moves the item to In progress (#265)
- day: day open shows each active goal and its Ready work by Order; day close promotes only work under an active goal (#240)
- goals: `propagate goals check`, the standing check the weekly goal workflow runs (#264)
- goals: goals can close: approved Derived-by commands run, a pass writes Resolved (#55)
- agents: adversarial-reviewer, gated by check-review (#251)
- agents: doc-curator, gated by check-curator (#251)
- day: propagate day open / day close, read-only open and dry-run-by-default close with read-back (#240)
- agents: edge-settler, gated by settle --check; a read-only guard and a trigger hook (#251)
- design-workflow: the standard design-guideline workflow skill, a per-stack matrix, and reference integrity for design docs (#242)
- doctor: cross-repo edges are guarded for client isolation and .propagates-cross.yml entries fail as never-fired (#117)
- doctor: the default render folds repeated warnings and counts ok/info per section; doctor --full keeps the full detail (#107)
- hooks: propagate hooks instructions-gate puts the instruction-budget gate in every repo that commits instruction text (#221)

### Fixed

- sessions: one row per session id (a resumed or renamed session no longer shows twice), `assoc` writes to the shown row, and dispatching a lane for a board item associates the session with that item (#318)
- test-impact: the recorder keeps only probes that found a file, so a renamed test no longer survives as a dependency and the map holds no non-existent paths (#330)
- check: from a linked worktree, `check` resolves the worktree's own `.propagates.yml`; with no workspace it prints `no workspace resolved for <path>` and exits 2 (it used to exit 0 silently) (#333)
- standards: trim the PROJECT_UNKNOWN path list to three (#269)
- doctor: standards section reports a malformed adopted: once, and a throw as inconclusive (#269)
- standards: a probe capture that is not a version is recorded as null with the error; the cache age is shown (#269)
- doctor: DETECTED-NOT-ADOPTED qualifies a project name shared by two workspaces (#269)
- standards: adopt/decline/remove resolve a project by its sidecar's project: field, scoped to one workspace (#269)
- manifest: no real workspace names in a public comment; stop tracking the SDD ledger
- standards: a workspace's undeclared-repo walk stops at another discovered workspace's root (#291)
- rules: paths-guard no longer calls a glob naming a skipped directory dead
- plan-goal: match the COMMANDS identifier case-sensitively, widget on a word boundary (#301)
- guard: catch propagate invoked by a path (#300)
- tests: two tests no longer assume the checkout path contains 'propagate/' (#302)
- plan-goal: refuse unfilled template values; Surface gate off outside the owner's tree (#297)
- guard: log the program's basename, never a path (#294)
- manifest: find a unit two levels down when the directory above it is not a unit (#269)
- standards: version in use is per unit, global kinds skip toolchain-less units, and absences are attributable (#269)
- manifest: pub workspace members cannot escape the project root, and unreadable workspaces are reported (#269)
- sprint: measure a quota-reset day from the new week instead of refusing it (#279)
- manifest: the walk sees Dart projects and pub workspace members (#269)
- work: prune keeps acked tombstones, validates --older-than, leaves a read-only open byte-identical (#150 task 4 fix 1)
- broadcast: the goal lookup joins repo to state dir through .sidecar.yml and says why it found nothing (#267 fix round 2)
- broadcast: the goal lookup reads propagation/state, status names only causes it can establish, keys are case-folded (#267 fix round 1)
- sessions: assoc accepts --from with --goal, and SESSION_AMBIGUOUS names the command that ran (#277)
- hooks: background-guard loads COMMANDS only for a command that could name propagate (#224)
- hooks: background-guard derives its network commands from COMMANDS (#224)
- agent-guard: awk, sort and find can no longer write from inside their own arguments
- agent-guard: a lone `&` and process substitution no longer slip a write past the read-only guard
- sessions: an untrusted folder is SESSION_FOLDER_UNTRUSTED, matched on claude's text, never read as a launch (#272 DX-T8)
- day,sprint: the usage widget dir comes from config.yml `integrations.usageWidgetDir`, not only the env var
- day: the paging query defines only the fragment it spreads; GitHub rejected the unused one (bb58926)
- day: no goal read skips day close's promotions with a warning; closed -> Done and cost gaps still run (#240)
- goals: active no longer depends on where Done when sits; idle no-Goal boards fold into one line (#264)
- agents: every gate is runnable from any workspace: check-curator and check-review subcommands, plugin-root paths (#253)
- test: tasks-export snapshot names what changed; fixture git runs with auto-maintenance off (#252)
- agent-nudge: read persistedOutputPath, because a worklist big enough to nudge is one Claude Code truncates (#251)
- settle-check: evidence must postdate the edge's last verify (#251)
- design-workflow: workspace docs resolve, integrity outranks age, and the word budget derives its skills (#242)
- hooks: the instructions-gate block no longer exits 1 on a pass when it is the last thing in a hook (#221)
- doctor: a hook's relative node target resolves against the repo root, not doctor's cwd
- hooks: the gate hook finds propagate through its directory marketplace first; --apply updates an out-of-date gate block in place (#221)
- hooks: no owner allowlist means one doctor info line, not a warn per repo; hooks.excludeRepos keeps a repo out even when its remote is owned (#221)
- doctor: a scheduled job's last run comes from launchd's run counter, not log mtime; the monitor's doctor status goes to stdout; fingerprint git failures name their cause (workspace-hub#75, #239)

### Changed

- impact: re-record the impact map after the review fixes (#269)
- reference: qualified project, STANDARDS_PROJECT_AMBIGUOUS, doctor entry shapes (#269)
- propagates: fix the doc-kind edge's section name, declare the standards couplings (#269)
- impact: re-record the impact map after Task 7's REFERENCE section (#269)
- reference: propagate standards (#269)
- impact: re-record the impact map for the nested-workspace test (#291)
- impact: re-record the impact map for the manifest-roots tests (#291)
- impact: record the impact map for the manifest-roots tests (#291)
- impact: record the impact map for the doctor standards tests (#269)
- impact: record the impact map for the adoption tests (#269)
- impact: re-record the impact map for the fix set (gate)
- readme: the command section is generated from COMMANDS and tested (#292)
- impact: re-record the impact map on the combined glance set (gate)
- impact: re-record the impact map for glance notifications and view (#296)
- reference: notifications, the web glance view and glance ack; Upgrading notes for notify-state and acks (#296)
- glance: PR3 notification, click target, digest, ack and view tests, with their mutations recorded (#296)
- impact: re-record the impact map for retirement candidates (#298)
- impact: re-record the impact map for the glance core (#295)
- doctor: the folded view's first line is now the verdict, then the fold banner (#295)
- reference: the glance command, signals table and glance.json contract; Upgrading notes (#295)
- session-guide: T-S2 fixture fills the line to within 20 characters of CAP, so an unreserved glance overflows (#295)
- changelog: Upgrading notes for the Node 22.13 floor and the work queue's state files (#150 task 5)
- impact: re-record the impact map for the work queue (#150 task 5)
- work: bound the race child's spin, and race production's busy path too (#150 task 2 fix 1)
- work: tie the CI floor assertions to the work-node-floor job block (#150 task 1 fix)
- node: raise the floor to 22.13 and pin a CI job to it (#150 task 1)
- hooks: a registry-unavailable rules check records did-not-run with its own reason (#283)
- hooks: census records did-not-run, renders a blind scan, and always shows its age (#283)
- hooks: load-rules reads a cached rules census instead of scanning at session start (#283)
- broadcast: delivery, the shown record and the re-recorded impact map (#267)
- sessions: REFERENCE shows assoc's --from [--goal] form (#277)
- impact: re-record the impact map after 59f4755
- evals: agent-doc-curator case: a content-accuracy question dispatches doc-curator and gates it with check-curator (#251)
- agents: every agent names a gate that exists; floor 3, no stale guard names; REFERENCE rows (#251)
- day,costs: register day open/close and costs lanes; REFERENCE and routing rows; impact map (#240, #251)
- reference: regenerate the ten-kinds table from KINDS — design is maintained by reference-integrity (#242)
- test-impact: map re-recorded on main after #221 (3520 pass; the only red was the map's own membership test)
- Merge origin/main into feat/269-standards-core (unprefixed)
- Merge pull request #313 from Rupali59/fix/311-paths-guard-skip-dirs (unprefixed)
- Merge pull request #310 from Rupali59/gate/fixes-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/docs/292-readme-from-commands' into gate/fixes-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/feat/301-surface-none-warning' into gate/fixes-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/fix/300-guard-path-invocation' into gate/fixes-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/fix/302-worktree-path-tests' into gate/fixes-2026-11-16 (unprefixed)
- Glance: the analysed glance and need-first plan gates (#293) (#308) (unprefixed)
- Merge remote-tracking branch 'origin/feat/298-retirement' into gate/glance-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/feat/297-plan-gates' into gate/glance-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/feat/296-glance-notify' into gate/glance-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/feat/295-glance-core' into gate/glance-2026-11-16 (unprefixed)
- Merge remote-tracking branch 'origin/feat/294-guard-log' into gate/glance-2026-11-16 (unprefixed)

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
