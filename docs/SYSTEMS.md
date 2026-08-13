# Systems Ledger

> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

Append-only record of every automated/background component in the ecosystem.
This is the adoption gate: a component is not "done" when it works, it is
done when it has a record here with a real liveness probe and, eventually,
an adoption date. See `docs/DECISIONS.md` 2026-08-10 "the local web UI is cut" —
this file exists because that decision's whole argument was "we shipped
things and never checked whether anyone used them."

Columns:
- **id** — stable slug, referenced elsewhere.
- **kind** — launchd agent / CLI / MCP-adjacent tool / library.
- **status** — `active` | `active-unadopted` | `proposed` | `dormant` | `retired` |
  `installed-never-invoked`.
- **supersedes / superseded_by** — lineage, blank if none.
- **artifacts** — paths, launchd labels, ports. This is where to look before
  believing a status claim.
- **liveness_probe** — the actual command to run to check current state
  yourself. Not prose — a command.
- **last_verified** — date the probe was last actually run (not the date the
  component was built).
- **adoption_date** — date a human confirmed real, repeated use. Blank means
  not yet earned, regardless of how long the component has existed.
- **retirement_checklist_done** — per `.templates/NEW-CLIENT-CHECKLIST.md`'s
  retirement counterpart (hub `DECISIONS.md` 2026-08-10 "retirement gets a
  checklist"): unload+disable LaunchAgent, remove code-review-graph registry
  entry, remove `.propagates.yml`, update hub repo map, record here.

---

| id | kind | status | supersedes / superseded_by | artifacts | liveness_probe | last_verified | adoption_date | retirement_checklist_done |
|---|---|---|---|---|---|---|---|---|
| `propagate` | launchd agent (Node, StartInterval 60) | active | — | `~/Library/LaunchAgents/com.tathya.propagate.watcher.plist`; `~/.claude/skills/propagate/heartbeat`; `watcher.mjs` | `heartbeat age <70s`: `node -e "console.log((Date.now()-Number(require('fs').readFileSync(process.env.HOME+'/.claude/skills/propagate/heartbeat','utf8').trim()))/1000)"` | 2026-08-13 | 2026-08-10 (watcher itself; predates this ledger but has continuous heartbeat evidence) | n/a |
| `propagate-digest` | launchd agent (Node, StartCalendarInterval 09:00) | active | — | `~/Documents/GitHub/... /propagate/digest.mjs`; installed as `~/Library/LaunchAgents/com.tathya.propagate.digest.plist` (mtime 2026-08-11); state at `~/.claude/propagate-digest-state.json`; delivery to `~/.claude/DAILY.md` + osascript notification. **Naming discrepancy:** the repo still ships a committed plist at the skill root under the old naming scheme — prefix `com.rupali` + suffix `.propagate-digest.plist` — which is not the installed plist (that's `com.tathya.propagate.digest.plist`, generated/labeled per `lib/plist.mjs`'s `LABEL` convention) and is the last place the old `com.rupali` naming survives in this repo. Not deleted here; flagged for reconciliation. | `launchctl list \| grep com.tathya.propagate.digest` (expect a loaded entry) AND `tail -1 ~/.claude/DAILY.md` shows a run newer than 25h ago AND `/tmp/propagate-digest.log` has no fatal lines since last install | 2026-08-13 (verified directly: plist loaded via `launchctl list`, `~/.claude/DAILY.md` has an entry timestamped `2026-08-13T03:57:19Z`, `~/.claude/propagate-digest-state.json`'s `lastRunAt` matches) | **BLANK — do not fill until 2 weeks of demonstrated engagement with the digest are observed. Installed-and-running (confirmed 2026-08-13) is not the same claim as adopted.** | n/a |
| `queue-ui` | Python HTTP server (LaunchAgent) | **active-unadopted** | — | `~/Library/LaunchAgents/com.tathya.claude-queue-ui.plist`; `~/.claude/pending-queue.json`; `~/.claude/queue-ui.token`; `claude-queue-ui.py` | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8790/` (process reachable) — reachability is NOT the same as use; `claude-queue-ui.py:255` (`def log_message(self,*a): pass`) makes it structurally unable to log a hit, so this probe can only prove the process is up, never that anyone used it | 2026-08-10 | **BLANK** | not started |
| `queue-runner` | Node CLI + LaunchAgent (`claude-next.sh`) | dormant | — | `scripts/claude-next.sh`; `scripts/claude-queue-onboard.sh`; `~/.claude/pending-queue.json` (37 items) | `python3 -c "import json;print(json.load(open('/Users/rupali.b/.claude/pending-queue.json')).get('armed'))"` — expect `false` | 2026-08-10 | n/a (never adopted) | not started |
| `cross-repo-relay` | Node module, fires from `propagate` watcher | dormant | — | `PROPAGATION_CROSS_LEDGER.jsonl` (5 rows), `PROPAGATION_CROSS_LEDGER.md`, `lib/cross-repo.mjs` | `node cli.mjs status --cross` — expect the single 2026-07-13 burst and silence since | 2026-08-10 | n/a (never adopted) | not started |
| `md-watcher` | Python script + LaunchAgent | retired | → nothing (dead end, not replaced) | `~/Library/LaunchAgents/com.markdown.watcher.plist` (still present, mtime 25 Mar); target `~/.local/bin/markdown_watcher/markdown_watcher.py` (still present, executable, mtime 25 Mar — **the plist does NOT point at a missing file**, this is subtler than "dead"); `~/Library/Logs/markdown_watcher.stdout.log` **24,164,062 bytes**, `markdown_watcher.log` 24.2MB, both last written 25 Mar; NOT currently loaded (`launchctl list \| grep markdown` returns nothing) | `launchctl list \| grep com.markdown.watcher` (expect empty = not loaded) AND `stat -f %Sm ~/Library/Logs/markdown_watcher.stdout.log` (expect a March date, not recent) | 2026-08-10 (verified directly: plist exists, script exists, not loaded, logs are the 22.7MB stale artifact, unchanged since March) | n/a | **not done** — LaunchAgent plist itself was never removed, only unloaded; script and 22.7MB logs still on disk |
| `chaukidar-utility` | Node/shell utility (unrelated to Motherboard's `chaukidar` service) | retired 2026-08-10 | — | source lost (could not be relocated at retirement time); wrote 37MB of stderr over 6 weeks before being stopped | n/a — source gone, nothing to invoke | 2026-08-10 | n/a | done (crash loop stopped; see task #1 in session history) |
| `chaukidar-motherboard` | Go service, `motherboard-coordination/services/chaukidar` | active | unrelated domain to `chaukidar-utility` above — name collision only | `Motherboard/motherboard-coordination/services/chaukidar` | `docker compose ps chaukidar` inside `Motherboard/` (or the service's own health endpoint per Motherboard's own conventions) | 2026-08-10 (path confirmed to exist in code-review-graph's registered repo list) | pre-existing, in production use | n/a |
| `harry-potter-theme` | LaunchAgent, unknown original purpose | retired 2026-08-10 | — | target was under `Utility/` which is itself archived (`_archive/2026-06-28/`); LaunchAgent exited 127 (command not found) | n/a — target archived, agent removed | 2026-08-10 | n/a | done (LaunchAgent stopped; see task #10) |
| `code-review-graph` | CLI (`~/.local/bin/code-review-graph`) + per-repo `.code-review-graph/graph.db` + MCP server | active | — | `~/.code-review-graph/registry.json`; per-repo `.code-review-graph/graph.db` (6 built, confirmed via `repos` subcommand listing Motherboard services + Vipin Kaushik projects); **hub graph at `~/Documents/GitHub/.code-review-graph/graph.db` exists on disk (151KB) but `status` reports it near-empty** — 18 nodes / 308 edges / 3 files as of 2026-07-16, JS/TS repos registered but not rebuilt since; registry has entries pointing at repos not all still present | `~/.local/bin/code-review-graph status` (per-repo, run from inside each registered repo) | 2026-08-10 (ran `status` and `repos` directly) | in active use for Python repos | n/a |
| `ollama` | local model runtime | installed-never-invoked | — | `gemma4:latest` (9.6GB), `nomic-embed-text:latest` (274MB), both pulled ~3 months ago per `ollama list` | `ollama ps` (expect empty — nothing currently loaded) and `ollama list` (models present but `MODIFIED` timestamp is the pull date since these are static, not evidence of use — check actual invocation via shell history/logs if a real usage question comes up) | 2026-08-10 | never | n/a |
| `skill-registry` | Node lib + CLI modes in `propagate`, reaper rides the existing digest | **proposed** | — | `lib/skills-scan.mjs`, `lib/skills-lifecycle.mjs`, `lib/skills-create.mjs`; `~/Documents/GitHub/skills-marketplace/`; `SKILLS_LIFECYCLE.jsonl`; `skill` table in `index.db`; kill switch `~/.claude/skills-registry.off` | `node cli.mjs skills` lists 92 skills and both lifecycle tiers; `node cli.mjs skills-reap` names only unused skills older than 14d | 2026-08-11 | **BLANK — no skill has yet been promoted, and nothing has been reaped. Fill only when a quarantined skill completes the full quarantine -> 3 uses -> promoted path without being hand-held.** | n/a |

---

## Notes on this seed

- Every `active`/`active-unadopted`/`dormant` row above was checked directly
  against the filesystem/launchctl/CLI on 2026-08-10, not copied from the
  brief without verification. The one place the brief's phrasing needed
  correction: **`md-watcher`'s LaunchAgent plist and target script are still
  present on disk and the plist is well-formed** — it is simply not currently
  loaded into launchd, and its logs are an unchanged 22.7MB artifact from
  March. "Dead 10 months" (STATE.md's phrase, referring to the hub
  `.md-watcher/` directory) is correct for that directory; it does not mean
  the LaunchAgent + script pair no longer exist — they do, unloaded but
  intact, which is exactly the "subtler than dead" case the brief warned
  about.
- `propagate-digest`'s `adoption_date` must stay blank until genuine
  engagement is observed for two weeks — filling it in early defeats the
  entire point of this ledger existing.
