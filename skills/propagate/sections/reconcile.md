# reconcile — declare and drain

*Section of the parent skill — Read this file when the situation below applies. It is deliberately NOT a discoverable skill: as one it declared the bare name `reconcile`, which squats a generic global name.*

**When this applies:** Use when declaring a new coupling in a `.propagates.yml` sidecar, or when closing legacy v1 ledger rows with `drain` (apply, defer, or wontfix). Triggers on "declare this edge", "drain the ledger", "close this drift row". **To settle a drifted v2 EDGE, use `sections/settle.md` instead** — `propagate settle <file>` + `verify`.

Parent skill: `propagate` (premise, Contract, Important Rules — including
"fix root-to-leaf" and "settle an edge through `verify`", which the `settle`
walkthrough executes). Routing to the underlying `cli.mjs` commands:
`sections/routing.md`.

## `declare <file>` — add a coupling (agent workflow, not a CLI command)

Open the parent directory's `.propagates.yml` (create if missing), add an
entry under `sources:` keyed by the file's basename, and list known
downstreams by hand — no graph queries yet (deferred to V2):

```yaml
sources:
  <filename>:
    propagates_to:
      - path: <relative path to downstream>
        why: <one-line reason>
        kind: prose  # or "code"
        # authority: counsel  # optional: counsel | spec | reference
```

Those are every key the schema accepts, and it is `additionalProperties: false`
— any other key rejects the **whole sidecar**, silently. `path` and `why` are
required. `authority` says the source GOVERNS the downstream, not merely couples
to it: `counsel` (legal copy, pricing — the edit-time hook BLOCKS a downstream
edit that rewords it), `spec` (intended behaviour, advisory), `reference`
(background, advisory); omit it for an ordinary drift edge. A source may also
carry `concepts:` (section anchor → list of trigger tokens). Each token must
appear literally in the source's own text — `claims check` reports one that
does not as a trigger that can never fire.

`path` may be a glob (e.g. `style/pages/**/*.md`) to declare a "this shared
doc feeds a whole tree" edge without hand-listing every consumer; a glob
matching 0 files is skipped with a log warning. `kind: code` is bidirectional
— the doc changing fires forward (verify the code), and the code file
changing fires a `code_drift` row back at the doc — for non-glob entries only;
glob `kind: code` on the code→doc direction is deferred.

## `drain` — close legacy v1 ledger rows

**Scope: v1 rows only.** `drain` reads and closes the open rows in the v1
ledgers that `status` still reads. It does **not** settle a v2 edge — a
`DRIFTED` / `REVERSED` / `DIVERGED` edge is recorded with a `verify`
disposition, walked by `sections/settle.md`. Closing a v1 row never changes an
edge's state, and `verify` never closes a v1 row; mixing the two is how a file
looks settled in one view and open in the other.

The *decisions* are the agent's job; the *writing* is `cli drain`'s. Never
hand-write a `markStatus` call — that is how rows landed in the wrong ledger
for months.

For each open row, or each correlation group:

1. Read the source doc near the section that drifted (`git log` to find the
   most recent commit touching it).
2. Read each downstream file.
3. Decide **with the user**: apply, defer, or wontfix. Never decide alone — a
   close asserts "I verified this downstream," which is the user's call.
4. **Apply:** edit the downstream, then `cli.mjs drain --close <id> --status done`.
5. **Defer:** leave it open. An open row is honest.
6. **Wontfix:** `--status wontfix --reason "<why>"` — required; the command
   refuses without it.

Prefer `--group <correlation_id>` over closing ids one at a time, with one
shared `--reason` for the batch. Bulk is the real workload — before the
command existed, bulk closes were recorded by hand as counterfeit drift rows.

## Correlation grouping

This is the parallel-coordination behaviour the parent premise describes, not
a nicety. Rows sharing a `correlation_id` (`<repo>:<path>`) are the same
logical change observed on different branches/worktrees. Group them before
presenting; show every `source_worktree`; close the whole group together once
the user verifies. Rows without a `correlation_id` (workspace docs, orphan
files) are handled per-row.

## Fix order

Verify root-to-leaf — the full rule and its exemptions live in the parent
skill's Important Rules; `graph` prints the worklist already ordered by source
layer, and `settle <file>` shows what blocks each edge, with a route. Don't verify a downstream against a source
that is itself an unsettled edge.
