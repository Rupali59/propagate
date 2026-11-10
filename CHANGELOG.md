# Changelog

All notable changes to propagate are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/) (before 1.0 a feature or a breaking change bumps the minor number), and commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). `propagate release notes --write` drafts each section from the commits; a person edits it.

Releases v0.15.50 to v0.15.59 were backfilled once, from their tags' ranges (`git log vA..vB` per consecutive pair; v0.15.50 has no earlier tag in this list, so it lists only the commit it points at). Where a tag sits on a follow-up commit rather than the feature (v0.15.53), the section follows the actual range. From 0.16.0 each section is drafted by `propagate release notes --write --version X`. Older releases are in `git log`.

## [Unreleased]

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
