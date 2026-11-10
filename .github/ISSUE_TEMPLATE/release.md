---
name: Release
about: Tracking issue for one propagate release (rule:release-versioning). Opened when the draft is created, closed when the release is published.
title: "Release: propagate X.Y.Z"
labels: release
---

Replace `X.Y.Z` in the title and below. The release body and this issue are the record of the release.

**Kind:** patch / minor (derived: `node cli.mjs release notes` prints the requirement)
**Previous release:** propagate-vA.B.C (or vA.B.C for a legacy tag)
**Upgrade path:** what changes on disk for an existing install, or "nothing persisted changed (evidence: ...)"

## Lifecycle

- [ ] Work commits merged (`feat:` / `fix:` ...), `VERSION` untouched
- [ ] Release commit merged: `chore(release): vX.Y.Z` with `VERSION`, the manifests, the impact map and the CHANGELOG section
- [ ] `node cli.mjs release --check` is READY (exit 0); the `upgrade-path` gate ran, or its skip is explained here
- [ ] Annotated tag on the release commit: `git tag -a propagate-vX.Y.Z -m "propagate X.Y.Z"`, checked with `git describe --tags --exact-match HEAD`
- [ ] Tag pushed (by a person): `git push origin propagate-vX.Y.Z`
- [ ] **Draft** created: `node scripts/release-publish.mjs --step draft --apply`
- [ ] **Pre-release**: `node scripts/release-publish.mjs --step pre-release --apply`; assets checked (propagate ships as a git tree, so none expected)
- [ ] **Release** (marked Latest), approved by a person: `node scripts/release-publish.mjs --step release --apply`
- [ ] **Previous release** body begins "Replaced by propagate-vX.Y.Z": `node scripts/release-publish.mjs --step replaced --apply`
- [ ] `/reload-plugins` in open sessions; this issue closed

The four steps also run in order with one command, `node scripts/release-publish.mjs --apply`. Every step reads the state first, so a re-run continues where a stopped one left off. Without `--apply` it only prints the calls.
