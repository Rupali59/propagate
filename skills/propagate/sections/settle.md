# settle — walk a file's drifted edges to a recorded decision

*Section of the parent skill — Read this file when the situation below applies. It is deliberately NOT a discoverable skill: as one it declared the bare name `settle`, which squats a generic global name.*

**When this applies:** Use when the user wants to settle drift on a file — "settle this file", "walk me through what drifted on X", "what do I do about this DRIFTED/DIVERGED edge", "verify these edges", or after `status`/`check` named a file whose edges are not CLEAN. Triggers on a refused `verify` (out-of-order, or DIVERGED).

Parent skill: `propagate` (premise, Contract, Important Rules). Command flags: `docs/REFERENCE.md` § `settle`.

## The division of labour

`propagate settle <file>` is **read-only**. It derives the worklist: the file's edges (into AND out of it) in fix order, per edge the diff since the last pinning verify (both sides), prior reasons, which dispositions are allowed right now, what blocks the edge, and the exact `verify` command. It never prompts — a CLI cannot, and the Bash tool has no TTY — and it never writes.

**You walk the human through it.** The decision is theirs ("never decide alone" — a disposition asserts *I verified this downstream*). Recording it is `verify --apply`.

## The walk

1. **Run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs settle <file> --json`.** Re-run it after every applied verify — fix order is re-derived each run, and an edge you just settled may unblock the next. Read `allNeverVerified`, `items`, and `walk_started` (the walk's start; the `doctor` cadence gauge derives from the ledger, not from this).
   - `items` empty and `allNeverVerified` false: say "nothing to settle on this file" and stop.
   - `allNeverVerified` true: nothing has drifted, there is no diff to read; say so, and offer to baseline (`propagate bootstrap`) rather than walking edges that have no history.
   - `ok: false`/`error`: relay it. An ambiguous file lists `candidates`; ask which.
2. **Take the items in the order given.** Roots first — that order is what keeps a downstream from being pinned against an unsettled source.
3. **ONE AskUserQuestion per edge.** Show, in the question text: the edge (`sourceShort -> downstreamShort`, state, the declared `why`), the diff since the last verify for each side (summarise; quote the lines that matter), and the prior reasons. Then the options, **each carrying concrete pros (✅) and cons (❌)** — Rupali's standing rule. Offer only `allowed` dispositions (plus the `viaOutOfOrder` route when the edge is blocked, below). Typical shape for a DRIFTED edge:
   - **no-change-needed** — ✅ closes the edge in one step, pins the current pair as consistent. ❌ asserts you checked; if the source change DID need a downstream change this hides it, and `reason` is all that survives.
   - **propagated** — ✅ the honest choice after you edited the downstream. ❌ only valid once the downstream edit exists; edit it first (you never edit a downstream yourself — hand the user the diff and let them, or do it on their instruction).
   - **source-corrected** — ✅ the source was the mistake and you fixed it. ❌ re-pins against a source that just changed; confirm the fix landed.
   - **deferred** — ✅ pins nothing, the edge stays open and honest. ❌ nothing is settled; it will be back on the next walk.
   - **wontfix** / **baselined** — ✅ explicit and recorded. ❌ both **require a reason**; `baselined` means "recorded as the starting position", not "verified".
   - **decoupled** — ✅ removes the declaration (edits the sidecar). ❌ the coupling stops being watched; only when it should never have been declared.
   For a **DIVERGED** edge the only allowed disposition is `both-reconciled`; ask whether the user has looked at BOTH sides.
4. **Collect a typed reason** where `needsReason` lists the choice, and offer one for the rest — a reason is the only thing that survives in the ledger (N69: twenty verifications lost theirs).
5. **Run the printed command with `--apply`.** Take `commands[<disposition>]` from the JSON, replace the literal `'<…>'` (the JSON's `reason_placeholder`, single-quoted) with the user's reason **single-quoted, with each `'` written `'\''`**, and run it. Never build a `verify` command from scratch and never use `--glob` (it is exact equality on a field that is `null` for every literal-path edge — G74). `verify` already re-reconciles after the write and prints the edge's new state; that confirmation is the read-back, not a line count.
6. **Blocked edges.** `blockedBy` lists the unsettled upstream edges with a `route` (`propagate settle '<path>'`) — a NEVER_VERIFIED upstream has no diff but is settled the same way. Offer, in this order: settle the upstream first (run its route), then `deferred`/`decoupled` (allowed as-is), and only last `outOfOrderCommands` — which override the ordering guard and are **recorded in the event** (`out_of_order`, `bypassed_upstreams`). Do not reach for `--out-of-order` to make the list shorter; the refusal is a finding (G62).
7. **After the last edge, re-run `settle <file> --json`** and report what is left and why.

## What the events record

`by_kind: human` — a walkthrough choice is the human's decision. `executed_by: agent` and `session_id` are stamped automatically when the verify runs inside Claude Code (`docs/DATA_MODEL.md` § The v2 event record). Do not set `PROPAGATE_BY_KIND`.

## Never

Run `verify` without `--apply` and call it recorded (it is a dry run); decide an edge without asking; edit a downstream and the ledger in one step without showing the diff; retry a refused command with `--out-of-order` before reading the refusal.
