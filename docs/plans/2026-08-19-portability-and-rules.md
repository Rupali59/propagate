<!-- Written 2026-08-19. Status: ACTIVE. -->

> **Why this file exists in the repo rather than `~/.claude/plans/`.** Session-scratch plans rot,
> and this skill already carries the proof: `lib/graph.mjs:4` cites
> `~/.claude/plans/okay-pln-these-out-zany-rain.md` as its design source of truth, and that file's
> contents were later overwritten by an unrelated design. A dangling citation in a tool whose
> thesis is traceability. Plans that govern this repo live here and are linked from `STATE.md`.
>
> **Status:** ACTIVE — Phase 0 complete (this file). Phases 1-6 pending.
> Supersede by editing this file's status line; do not delete.

# Make propagate portable, own the global-rules lifecycle, and conform to skill-creation guidelines

## Context

propagate works on this machine and would fail **silently** on any other. The same defect sits
in it and in the rules checker, and it is precisely the failure the skill exists to catch:

- `lib/config.mjs:52` — `return usable.length ? usable : candidates`. With `~/Documents/GitHub`
  absent and `PROPAGATE_SEARCH_ROOTS` unset, the nonexistent root is carried anyway, discovery
  walks nothing, `WORKSPACES = []`, and `doctor` reports **healthy**. The comment at `:33-38`
  predicts this verbatim — *"discovery on another machine silently finds zero workspaces and the
  watcher reports healthy forever."* The warning was written; the detection never was.
- `rules/_check.mjs:33` — `TREE` hardcoded, **no env override**. On a fresh machine it scans an
  empty tree, finds 0 restatements, and **exits 0 — reporting success.** G1 in the enforcement layer.

Decisions taken: propagate **owns the rule lifecycle**; the core goes **cross-platform with
scheduling optional**; install is the **existing Claude plugin plus a real `propagate init`**.

**Hard constraints.** Every default must reproduce today's behaviour exactly — this machine keeps
working. `STATE.md:164-165`: a throw at `config.mjs` module load bricks watcher, CLI and UI
simultaneously, so config loading must never throw.

---

## Phase 0 — Write the plan down where it survives

`~/.claude/plans/` is session scratch, and propagate already has a **dangling citation** proving
it: `lib/graph.mjs:4` cites `~/.claude/plans/okay-pln-these-out-zany-rain.md`, whose contents were
later overwritten by an unrelated design.

Create `docs/plans/` (propagate has none) and commit this plan as
`docs/plans/2026-08-19-portability-and-rules.md`. Link it from `STATE.md` per
`rule:state-and-decisions`, so it is discoverable rather than remembered.

**Found while doing Phase 0 — a portability defect in its own right.** Nine code comments cite
`~/.claude/plans/*.md` as their design source of truth (`cli.mjs:3102`, `lib/monitor.mjs:4`,
`lib/graph.mjs`, `lib/content-id.mjs:4`, `lib/graph-html.mjs`, `lib/reconcile.mjs:4`,
`lib/bootstrap.mjs:5,7`, `lib/events.mjs:5`). Those files live **outside the repo**, so no other
user has them — the authority a reader is pointed at is unavailable on any machine but this one.

Worse, file-exists is not citation-valid: all three cited plans still exist, but
`okay-pln-these-out-zany-rain.md` was **overwritten** by the monitor design and says so in its own
first lines. The same citation is therefore *correct* for `lib/monitor.mjs` and *dangling* for
`lib/graph.mjs` and `lib/graph-html.mjs`. Both repointed 2026-08-19; the remaining seven resolve to
current content and are left, but Phase 2 should move the design notes into `docs/` so they travel
with the repo.

## Phase 1 — Fail loud, then make it configurable

**1a · Distinguish "root missing" from "root has no markers"** — the RED test for everything else.
`lib/config.mjs` keeps `SEARCH_ROOTS` non-throwing but exports `SEARCH_ROOTS_DIAGNOSTIC`
(`ok | roots-missing | no-markers | unconfigured`). `doctor`/`status` surface `roots-missing` as a
**failure**. Do this first: until a broken install says so, no later fix is verifiable.

**1b · Config file** at `$PROPAGATE_STATE_DIR/config.yml` (default `~/.propagate/config.yml`),
parsed with the existing `yaml` dep. Precedence **env > file > defaults**, so current env users are
unaffected. This is the landing spot `docs/DECISIONS.md:356` already deferred.

```yaml
searchRoots: [~/Documents/GitHub]   # hardcoded at config.mjs:47
maxDepth: 2                          # discovery.mjs:49, not overridable today
rulesDir: ~/Documents/GitHub/rules   # this machine keeps its dir; default <STATE_DIR>/rules
scheduler: launchd                   # launchd | systemd | none
conventions:                         # all hardcoded, none configurable today
  decisions: [docs/DECISIONS.md, DECISIONS.md]
  state: [STATE.md]
  gotchas: [docs/GOTCHAS.md]
  marker: .propagates.yml
crossAllow: []                       # replaces the checked-in cross-allow.yml
integrations:                        # absent => feature skips, never errors
  marketplaceDir: null               # skills-lifecycle.mjs:43
  portsFile: null                    # inventory.mjs:54
  notifier: auto                     # PATH-resolved
```

Reuse the existing `auditSkill` `{ran:false}` pattern for "not configured → skip".

## Phase 2 — De-personalise the code

Identical pattern throughout: read from config, skip cleanly when unset.

| File | Literal | Fix |
|---|---|---|
| `digest.mjs:67` | `GITHUB_ROOT = ~/Documents/GitHub` | route through `SEARCH_ROOTS` — digest ignores it entirely today |
| `digest.mjs:74-82` | 9 cache paths, 6 under `~/Library` | skip unless `platform === "darwin"` |
| `digest.mjs:1249` | `~/.claude/skills/telegram` | `integrations.telegram` |
| `lib/inventory.mjs:71` | `/opt/homebrew/bin/rg` | PATH-resolve |
| `lib/inventory.mjs:54` | `~/Documents/GitHub/ports.yml` | `integrations.portsFile` |
| `lib/skills-lifecycle.mjs:43-45` | `~/Documents/GitHub/skills-marketplace` | `integrations.marketplaceDir` |
| `lib/skills-lifecycle.mjs:50` | `~/.claude/skills/propagate/SKILLS_LIFECYCLE.jsonl` | derive from `STATE_DIR` — **hardcodes the skill's own install path, defeating `SKILL_DIR`; already broken under marketplace install or worktree** |
| `lib/notify.mjs:12` | `/opt/homebrew/bin/terminal-notifier` | PATH-resolve → `osascript` → stderr |
| `lib/discovery.mjs:56-71` (+ `refs.mjs:200`, `edges.mjs:52`, `ledger.mjs:540`) | `.gstack-backup-1779072805` etc. | pattern, **de-duplicated into one exported list** |
| `cross-allow.yml` | 3 personal repos, checked in | → `config.crossAllow`; delete |
| `com.rupali.propagate-digest.plist` | tracked; `/Users/rupali.b`, `/opt/homebrew/bin/node` | **generate** via `lib/plist.mjs` (already uses `process.execPath`); delete the file. Reconcile the label — file says `com.rupali.propagate-digest`, `docs/REFERENCE.md:26` says `com.tathya.propagate.digest` |
| `cli.mjs:1691,1693` | emits `node ~/.claude/skills/propagate/cli.mjs` into sidecars | use `SKILL_DIR` |

**Docs stay as they are.** 79 personal-path mentions across 10 files are evidence citations in
incident write-ups; scrubbing them destroys the traceability that makes these docs worth reading.
Add one preamble line noting example paths are the author's layout.

## Phase 3 — Cross-platform core, optional scheduling

- `digest.mjs:116-127` shells `find -exec stat -f %m` — **BSD only** (GNU is `-c %Y`). Replace with
  `fs.statSync().mtimeMs`; also removes a spawn, per G6.
- `scheduler: none` is a **fully supported** mode. The v1 watcher is retired,
  `rule:delegation-criteria` §2 prefers derive-on-demand, and `reconcile` runs in ~1.2s — a machine
  with no scheduler loses only proactive notification.
- `launchctl` (`lib/plist.mjs:170-192`, `cli.mjs:448,927`) guards on
  `scheduler === "launchd" && platform === "darwin"`; otherwise reports `not-configured`, never a
  failure. `systemd` stays declarable-but-unimplemented so the gap is visible rather than assumed.

## Phase 4 — `propagate init`

Today: install plugin → `status` → 0 workspaces → no error → nothing works, and
`docs/REFERENCE.md:255` (the only install doc) opens by saying most of it is retired.

`init` — idempotent, safe to re-run:
1. Write `~/.propagate/config.yml`; never clobber without `--force`.
2. Resolve roots: `--roots`, else probe common layouts, else prompt.
3. **Verify discovery finds ≥1 workspace and refuse to report success otherwise**, naming the roots walked.
4. Seed `rulesDir` if empty; register the SessionStart hook.
5. Print what was written and what is unconfigured.

Add a `bin` entry to `package.json` (`bin: NONE` today).

## Phase 5 — Absorb the rules lifecycle

Coherent because `docs/LIFECYCLE.md:117-121,196` already defines **PROMOTE**, whose destination
*is* a rule file with `id`/`scope`/`status`/`fingerprint` and a green selftest. propagate owns the
concept already; it does not own the code.

- Move `_check.mjs` in as `lib/rules-check.mjs`, replacing hardcoded `TREE` with `SEARCH_ROOTS` —
  the fix that stops it exiting 0 on an empty tree. Keep `--selftest`: its five override cases are
  an executable spec that already caught a real `\b` bug.
- Ship `hooks/load-rules.mjs` (already portable — only `os.homedir()`), registered by `init`.
- New `propagate rules <list|check|selftest|promote>`.
- **`rulesDir` is config; this machine keeps pointing at `~/Documents/GitHub/rules`.** Do not
  migrate the 16 existing rules or touch the `~/.claude/rules` symlink. Additive, reversible.
- Ship the 15 `scope: global` rules as seed content. Three bodies name specific repos
  (`nextjs-dev-server-port.md:23`, `state-and-decisions.md:21,25,40`) — re-`scope:` or annotate as
  examples; do not delete the evidence.

**Worth acting on:** adoption is concentrated in exactly the two rules that have `.propagates.yml`
edges — `tool-priority` (20 CLAUDE.md files), `secrets-source-of-truth` (6). The other 14 have
**zero** pointer sites, and `_check.mjs` runs on manual invocation only (`docs/SYSTEMS.md:50`
classes it *active-unadopted*). Wiring `rules check` into the pre-commit gate is what would make
the mechanism real.

---

## Phase 6 — Skill-creation conformance

Per `superpowers:writing-skills` and `rule:description-standard`.

**6a · The description is non-conformant, and propagate is the enforcement point.** Current:

> `description: Manage the propagation ledger — drain open drift events, check system health…, declare sidecars, init new directories.`

That is a **workflow summary**, which the guideline forbids outright: *"NEVER summarize the
skill's process or workflow"* — testing showed agents follow the description **instead of reading
the skill**. It must be "Use when…" plus triggering conditions only. Sharpest part: the canonical
text of `rule:description-standard` is extracted verbatim from propagate's own
`lib/skills-create.mjs:206-209`, so the tool that enforces this on generated skills does not
satisfy it itself. (Length is fine — 349 of 1024 chars.)

**6b · The Iron Law applies to edits, not just new skills.** `SKILL.md` gains a Setup section and a
new description; both are behaviour-shaping. So: run the **baseline first** — a fresh-context
subagent given only the current `SKILL.md` and asked to install propagate on a new machine.
Capture verbatim what it does (expected: never finds `PROPAGATE_SEARCH_ROOTS`, declares success on
zero workspaces). That transcript is the RED. Only then write the Setup section, and re-run to
confirm GREEN.

**6c · Match the form to the failure.** The baseline failure here is *omission* (no setup step
exists), not indiscipline. Per the guideline's table that calls for a **structural** fix — a
REQUIRED slot in the flow — not prohibitions. Concretely: `init` is the structure, and SKILL.md's
Setup section points at it. Do not write "don't forget to configure roots".

---

## Verification

**The headline test is a sandboxed fresh-machine simulation — never against the real `$HOME`.**

```
HOME=$(mktemp -d) PROPAGATE_STATE_DIR=$HOME/.propagate node cli.mjs status
```
must **fail loudly** with `roots-missing`. Then `init --roots <tmp>` then `status` must succeed.
Both halves get asserted; asserting only the success half is how a guard that cannot fail ships.

- **RED before GREEN.** Write the failing fresh-machine test *first*, watch it pass-when-it-should-fail
  under today's code, and only then change `config.mjs`. Same for 6b's subagent baseline.
- **No regression here** — capture `doctor --json`, `graph --all --json`, `reconcile --json`,
  `status --all --json` before any change; diff after each phase. Defaults must reproduce exactly.
- **Config precedence** — env beats file beats default; a malformed or absent `config.yml` degrades
  to defaults **without throwing** (`STATE.md:164-165`).
- **Mutation-test the new guard** — force `SEARCH_ROOTS_DIAGNOSTIC` to `ok` and confirm the
  fresh-machine test goes red. A silent-failure guard that cannot itself fail is the bug it prevents.
- **`rules check` on an empty tree must exit non-zero**, not 0. Keep `--selftest` green throughout.
- **Suite stays green** — 662 pass, 0 fail. `tests/plist-watch-roots.test.mjs` and the plist helper
  need updating when the digest plist becomes generated.
- **Cross-platform smoke** — run `reconcile`, `graph`, `check`, `graph-index` with `scheduler: none`
  and confirm no `launchctl` / `osascript` / BSD-`stat` path is reached.

## Out of scope

- Scrubbing personal paths from docs — they are incident evidence (Phase 2).
- Implementing systemd units; `scheduler: systemd` becomes declarable, implementation is a separate call.
- Migrating rules out of `~/Documents/GitHub/rules`, or touching the symlink / `settings.json` here.
- Publishing to npm. The `bin` entry makes it runnable; publishing is a separate decision.
- The `Affects:` vocabulary gap (316 of 445 tokens resolve to no project) — real, already recorded
  in `v_coverage_gap`, orthogonal to portability.
