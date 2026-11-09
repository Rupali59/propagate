# Changelog

All notable changes to propagate are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/) (before 1.0 a feature or a breaking change bumps the minor number), and commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). `propagate release notes --write` drafts each section from the commits; a person edits it.

Releases v0.15.50 to v0.15.59 were backfilled once, from their tags' ranges (`git log vA..vB` per consecutive pair; v0.15.50 has no earlier tag in this list, so it lists only the commit it points at). Where a tag sits on a follow-up commit rather than the feature (v0.15.53), the section follows the actual range. From 0.16.0 each section is drafted by `propagate release notes --write --version X`. Older releases are in `git log`.

## [Unreleased]

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
