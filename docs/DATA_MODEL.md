> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — data model (as built)

This document is **descriptive**: what is on disk and in the reader/writer code
today, verified against the live ledgers and cited by `file:line`. It is not the
target design — [`SPEC.md`](./SPEC.md) §4 is prescriptive and stays that way, and
now carries a pointer back here. Where the two disagree, §7 below says so in a
table rather than leaving it implied.

All counts below carry a date because counts rot. Unless marked otherwise,
every count in this document is **as of 2026-08-13**, derived by walking
`~/Documents/GitHub` for `PROPAGATION_LEDGER.jsonl` and `.propagation/ledger.jsonl`
and re-parsing every line — not copied from any prior document, including the
plan this doc was commissioned from.

---

## 1. The four coexisting schemas

Four different shapes are all called "the ledger" depending on which layer of
the system you're reading from. None of them share a schema definition.

```
                    .propagates.yml          .code-canonical.yml      .propagates-cross.yml
                    (declares edges)         (code<->doc pairs)       (cross-repo contracts)
                            │                        │                         │
                            └────────────┬───────────┴─────────────────────────┘
                                         ▼
                              watcher.mjs  (mtime + 3s re-verify)
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
     PROPAGATION_LEDGER.jsonl   PROPAGATION_CROSS_LEDGER.jsonl   state.json
     (per workspace, x7)        (hub, separate file/shape)        {mtimes, crossDecisions,
              │                          │                         lastRunAt, version}
              │                          └── adds flow, direction,
              │                              origin_repo, partner
              ▼
        readLedger()  ── fold ──►  in-memory Map<id, Event>  ──►  cli status · digest · index.db
                                                                        │
                                                                        ▼
                                                          index.db `ledger_row`
                                                          (fixed 11-column INSERT,
                                                           a THIRD shape, narrower
                                                           than either JSONL row)
```

1. **Main ledger** — `PROPAGATION_LEDGER.jsonl`, one per workspace, 7 of them as
   of this pass (§2 below covers the JSONL shape in full — it is two record
   kinds in one file).

2. **Cross ledger** — `PROPAGATION_CROSS_LEDGER.jsonl` at the hub, written by
   `processCrossRepo` (`watcher.mjs:384-`). Rows here are **not** the same shape
   as the main ledger: alongside the usual `type`/`id`/`source`/`change`/
   `downstream`/`status`/`correlation_id`, cross rows also carry `flow`
   (e.g. `"platform_contract"`, `"decision"`), `direction` (`"outbound"` /
   `"inbound"`), `origin_repo`, and `partner` — see `watcher.mjs:415-419`,
   `:434-439`, `:458-463`, `:509-514` for the four call sites that write these
   fields. **`SPEC.md` §4 lists `flow`/`direction`/`origin_repo`/`partner` as
   undeclared fields of the main `Row` typedef** — that is not what's on disk.
   They are not stray fields on the main shape; they belong to a structurally
   different row that only ever appears in the cross ledger. §7 records this
   as a delta.

3. **`index.db` `ledger_row`** — a SQLite table, rebuilt from scratch on every
   `index.db` rebuild (`lib/index-db.mjs`, `dropAndCreateTables` at `:337-343`).
   Its `INSERT` is fixed at 11 columns (`lib/index-db.mjs:390`):
   ```
   id, ledger_path, workspace, type, source, change, status,
   timestamp, correlation_id, downstream_json, pending_graph_augment
   ```
   (schema itself at `lib/index-db.mjs:242-254`). This is a *third* shape,
   narrower than either JSONL row: `downstream` is flattened to a JSON string
   column (`downstream_json`), and none of `wontfix_reason`, `notes`,
   `closed_by`, `source_worktree`, `note`, or any cross-ledger field
   (`flow`/`direction`/`origin_repo`/`partner`) has a column at all — they are
   dropped silently on ingest into the index. Unparseable/unknown-type rows go
   to the separate `ledger_unknown` table (`lib/index-db.mjs:258-265`) rather
   than being force-fit into `ledger_row`.

4. **`state.json`** — `{mtimes, crossDecisions, lastRunAt, version}`
   (`lib/state.mjs:26`, the default-state constructor). Not an event log at
   all — a single mutable document the watcher rewrites on every fire, keyed
   by absolute file path (`mtimes`) and by a first-run dedup key
   (`crossDecisions`, see `watcher.mjs:488-518`). It shares no fields with any
   ledger row.

---

## 2. One shape, two record kinds

This is a **documentation decision, not a type split**. `LedgerRow`
(`lib/ledger.mjs:34-56`) is one JSDoc typedef; nothing in the code
discriminates `Event` from `Transition` at the type level. The split below
exists only in this document, because the two record kinds carry genuinely
different fields and get folded together in a way that's easy to
misunderstand without naming them separately.

**Event** — `type: drift | code_drift | manual`, written by `watcher.mjs:231-239`
(`drift`), `:347-354` (`code_drift`), and by whatever wrote the one `manual`
row on disk (not this codebase — see §5):

```
{
  type:      "drift" | "code_drift" | "manual"
  id:        "017"
  timestamp: "2026-08-12T14:03:21.104Z"
  source:    "lib/pricing.ts"
  change:    "auto-detected edit (mtime advanced)"
  downstream: [{ path, why, kind: "prose"|"code", worktree? }]
  status:    "open"                      -- always this literal, see §3
  pending_graph_augment?: boolean
  correlation_id?: string
  source_worktree?: { branch, commit }
  git?: { sha, branch, dirty }           -- specified (SPEC §4), never written (§7)
}
```

**Transition** — `type: status_change`, written by `markStatus`
(`lib/ledger.mjs:97-105`) when it is called at all (§5 — it almost never is
in production):

```
{
  type:      "status_change"
  id:        "017"                       -- addresses an existing Event's id
  timestamp: "2026-08-12T16:40:02.881Z"
  status:    "wontfix" | "done" | "partial" | "open"
  notes?:    string                      -- inert, see §4 and §5
}
```

`wontfix_reason` and `closed_by`, which appear on **578 of 664** rows in one
ledger (§5), are not part of either shape above as the codebase defines them —
they are hand-authored additions with no writer in this codebase at all.

---

## 3. `status` means two different things

One typedef (`lib/ledger.mjs:41`, `@property {"open"|"partial"|"done"|"wontfix"} [status]`)
covers both record kinds, and that single shared field name is doing two
unrelated jobs:

- **On an Event**, `status` is the *initial* value, always the literal string
  `"open"` — set at `watcher.mjs:237` (the `drift` path) and `watcher.mjs:353`
  (the `code_drift` path). It is never authoritative after the row is
  created; whatever the row's *current* status is lives in a later Transition,
  if one exists.
- **On a Transition**, `status` is a *delta* addressed to an id. Read alone,
  outside the context of the Event it targets, a Transition's `status` field
  is meaningless — `{"type":"status_change","id":"017","status":"wontfix"}`
  says nothing about what row 017 *is*.

Because the typedef doesn't distinguish these, the only place this
distinction is recorded is prose — this section, and the fold below.

---

## 4. The fold, in detail

`lib/ledger.mjs:184-199` (`readLedgerWithStats`, which `readLedger` wraps).
Quoted in full because every property below depends on the exact order of
operations:

```js
for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    malformed++;
    continue;
  }
  if (row.type === "status_change") {
    const existing = drifts.get(row.id);
    if (existing) existing.status = row.status;
  } else if (row.type === "drift" || row.type === "code_drift") {
    drifts.set(row.id, {
      ...row,
      status: row.status || "open",
    });
  } else {
    const t = row.type === undefined ? "(missing)" : String(row.type);
    unknownTypes[t] = (unknownTypes[t] || 0) + 1;
  }
}
const rows = [...drifts.values()].sort((a, b) =>
  a.timestamp < b.timestamp ? -1 : 1,
);
```

ASCII shape of the fold:

```
file order:      Event(017,open) → Transition(017,partial) → Event(017,open) → Transition(017,wontfix)
                        │                   │                       │                    │
                        ▼                   ▼                       ▼                    ▼
   drifts map:    {017: open}      {017: status=partial}   {017: REPLACED, open}   {017: status=wontfix}
                                    (only .status copied)   (fresh spread — partial
                                                              is gone, back to open)
```

Three properties of this fold that bite in practice:

1. **Exactly one field crosses from Transition to Event: `status`.**
   `existing.status = row.status` at `:188` is the entire transfer. Every
   other Transition field — `notes`, and the hand-authored `wontfix_reason` /
   `closed_by` / `note` that live on disk (§5) — is read into `row` by
   `JSON.parse` and then dropped when the loop moves to the next line,
   because nothing ever assigns it onto `existing`.

2. **A Transition for an id not yet seen is silently discarded.** `if
   (existing)` at `:187` has no `else`. If a `status_change` row's `id`
   doesn't exist yet in the `drifts` map — because the matching Event hasn't
   been read yet, or was never written, or was mistyped by hand — the
   Transition vanishes with no signal. This is order-dependent: the fold
   walks the file top to bottom, and the eventual timestamp-sort at `:199-201`
   happens *after* the fold, so a Transition physically preceding its Event in
   the file (possible across concurrent writers, or a manually inserted line)
   is lost even though sorting would have put them in the "right" order for a
   human reading the rendered Markdown.

3. **`drifts.set` replaces on id collision.** If two Event rows share an
   `id` — a real possibility given `nextId`'s read-then-append race (§8) —
   the second `drifts.set(row.id, {...})` at `:190-193` overwrites the first
   entry wholesale, including any `status` already folded onto it from an
   intervening Transition. A `wontfix` recorded against the first Event is
   erased the moment a second Event reuses its id.

---

## 5. The orphan census

Field-by-field: who writes it, who reads it, as of 2026-08-13 across the 7
workspace-root ledgers (§9 has the exact count and file list). "Reader" means
a JS call site that consumes the field from a parsed row — not "appears in a
JSDoc typedef."

| Field | Count | Writer | Reader |
|---|---|---|---|
| `type`, `id`, `status`, `timestamp` | 1454 (100%) | `appendRow`/`appendRowWithId` | `readLedgerWithStats` fold |
| `source`, `change`, `downstream` | 594 (41%) | `watcher.mjs` (drift/code_drift paths) | rendered by `renderMarkdown`, indexed by `index-db.mjs` |
| `wontfix_reason` | 556 (38%) | **NONE** | none |
| `pending_graph_augment` | 342 (24%) | `watcher.mjs:238` | `index-db.mjs` column only |
| `notes` | 325 (22%) | two writers, different meanings — `markStatus`'s 4th arg (`lib/ledger.mjs:103`) on a Transition, and `processCodeCanonical`'s upstream-note join (`watcher.mjs:354`) on a `code_drift` Event | Event-side `notes` (from `code_drift`) is read by `renderMarkdown` indirectly via row spread; Transition-side `notes` has **zero** readers (see below) |
| `correlation_id` | 250 (17%) | `watcher.mjs:240` (drift), `:356` (code_drift), plus the four cross-repo sites | drain-grouping logic (per `SKILL.md`'s drain procedure) |
| `source_worktree` | 3 (0.2%) | `watcher.mjs:357` | **NONE** |
| `note` (singular) | 3 (0.2%) | **NONE** | none |
| `closed_by` | 1 (0.1%) | **NONE** | none |
| `git` | 0 (0%) | none — specified in `SPEC.md` §4, never implemented | n/a |
| `downstream[].glob_matched`, `downstream[].sample` | 37 of 1911 downstream entries (1.9%) | `watcher.mjs:189-190` | **NONE** |
| `downstream[].worktree` | 0 | typedef'd at `lib/ledger.mjs:30` (`WorktreeStamp` on a `DownstreamEntry`) | n/a — never populated, so never read |

**The split that matters:**

- **No writer at all**, present only because something outside this codebase
  put it there: `wontfix_reason` (556), `closed_by` (1), `note` singular (3).
  `downstream[].worktree` is the fourth "no writer" case but for a different
  reason — it's typedef'd but the code path that would populate it
  (`lib/ledger.mjs:30`'s comment says "only set for secondary worktrees") is
  never actually exercised; canonical-worktree entries never carry it and no
  call site stamps it for secondary ones either.

- **Writer but no reader**: `source_worktree` (3 rows, `watcher.mjs:357`) is
  stamped on every `code_drift` row fired from a secondary worktree, but
  nothing downstream of the write ever reads `.source_worktree` off a parsed
  row. `glob_matched`/`sample` (37 downstream entries, `watcher.mjs:189-190`)
  summarize a glob-downstream match set at write time but are never consulted
  by any reader. `notes` on a Transition (`lib/ledger.mjs:103`, `markStatus`'s
  4th parameter) has **zero** callers reading it back — this is not merely
  unexercised, it is **unreachable by construction**: the fold (§4) only ever
  copies `.status` off a Transition, so even if `markStatus` were called with
  a `notes` argument today, no reader could ever see it on the folded Event.
  The repo's own test asserts exactly this:
  `tests/ledger-activity.test.mjs:80` — `assert.equal(rows[0].notes,
  undefined, "readLedger never copies notes off status_change rows")`.

---

## 6. Why the orphans exist

`markStatus` (`lib/ledger.mjs:97`) is the only function in this codebase that
writes a Transition row, and it has **zero production callers** — it appears
in its own definition and in exactly two test files
(`tests/dedup-pathcheck.test.mjs:46`, `tests/ledger-activity.test.mjs:68,92`).
No code path in `cli.mjs`, `watcher.mjs`, or `digest.mjs` ever invokes it.

That means there has never been a supported way to close a row. Every close
that has ever happened on a real ledger was hand-written — a human or an
agent editing the JSONL file directly, or writing a one-off script against a
hand-resolved path — because the tool gave them nothing else. Each time that
happened, whoever was closing the row reached for whatever field name made
sense to them in the moment: `wontfix_reason` to justify a dismissal,
`closed_by` to record who decided, `note` instead of `notes`. No schema
authority ever saw any of it, because there was no code path for schema
authority to sit in front of.

The forensic count in §9 is the evidence for this story, not just an
illustration of it: in the Vipin Kaushik ledger, 578 of 664 rows (87%) are
hand-authored by the `JSON.stringify`-spacing tell, and **100% of the 556
`wontfix_reason` rows fall inside that hand-authored set.** The vocabulary
that has no writer in this codebase is, without exception, coming from
outside it. This is the structural explanation for the entire orphan census
in §5 — not eleven unrelated small bugs, one missing close path with eleven
symptoms.

### 6.1 A fourth pattern: administrative actions written as drift Events

Measured 2026-08-13 in the Vipin Kaushik ledger: **39 Event rows carry a
terminal status (`done` or `wontfix`) with no Transition anywhere in the file.**
All 39 are hand-authored by the spacing tell. They were written closed.

So for those rows there is no `closed_at`, no `closed_by`, and no audit trail —
the thing SPEC I2 ("the ledger is an audit trail; status changes append") exists
to guarantee. The invariant was not violated by the code; it was bypassed by
writers the code never mediated.

Some are not drift events at all. Line 23 is representative:

```json
{"type": "drift", "id": "015", "source": "watcher",
 "change": "Bulk-wontfix #008-#014 — first-run mtime baseline rows, not actual
            drift. The substantive edits they reflect are already addressed...",
 "downstream": [], "status": "done", "notes": "Drain note 2026-05-21"}
```

`source: "watcher"`, empty `downstream`, and a `change` that describes an
operator action rather than a file changing. This is a **bulk close being
recorded as a drift row**, because the data model offered no other way to say
"I closed #008-#014 together, and here is why."

That is the same root cause one layer further down, and it is direct evidence
for SPEC §6's insistence that a close path must support **batch close with a
shared reason**. The bulk workload is not hypothetical — people were already
doing it, by hand, inside a row shape that was never meant to hold it.

Consequence for any future reader: a `type: "drift"` row is not reliably a
drift observation. Until these are re-emitted under a type that means what they
say, Event counts include an unknown number of administrative annotations.

---

## 7. Delta table vs `SPEC.md` §4

| Aspect | On disk | §4 claims |
|---|---|---|
| Record kinds | **two**, one file: Event (`drift`/`code_drift`/`manual`, 595 of 1454 rows) and Transition (`status_change`, 860 of 1454 rows) — see §2 | one `Row` typedef, no kind split |
| `id` | `String(max+1).padStart(3, "0")` — sequential, minted from the max id in the *folded* (Event-only) output (`lib/ledger.mjs:154`, `:244-250`) | `ULID -- not sequential` (§4, restating I5) |
| `status` | two meanings depending on record kind — initial literal on an Event, delta on a Transition (§3) | one union type, no distinction drawn |
| `git` | **0 of 1454 rows** carry it, on any ledger, as of 2026-08-13 | required on every row; §5's whole auto-close lifecycle (intra-repo strong evidence vs cross-repo weak evidence) keys off `row.git.sha` existing |
| cross-repo fields | live in the **separate** `PROPAGATION_CROSS_LEDGER.jsonl`, a structurally different row shape (`flow`, `direction`, `origin_repo`, `partner` — §1.2) | listed in §4 as undeclared fields of the main `Row` typedef, i.e. as if they could appear on a main-ledger row |
| `wontfix_reason` / `closed_by` / `note` | on disk (556 / 1 / 3 rows respectively), 100% hand-authored, no writer in this codebase (§5, §6) | §4 says these "must be added to the typedef or removed" — correctly names them as undeclared, does not yet resolve which |
| `manual` type | 1 row, invisible to any reader until §4's own fix, caused a live id collision per §4's account | already called out as needing to become "first-class" |

---

## 8. Two id mechanisms

Two functions mint ids, with different concurrency guarantees, used by
different call sites:

**`nextId`** (`lib/ledger.mjs:244-251`) — read-then-append. Calls
`readLedger` to find the current max id, returns `max+1` zero-padded, and
*does not itself write anything or hold a lock across the gap* — the caller
reads the id, then separately calls `appendRow`, which acquires its own lock.
Two calls to `nextId` racing between the read and the write can return the
same id. Used by the two main-ledger drift paths: `watcher.mjs:227` (the
`drift`/`processMainSource` path) and `watcher.mjs:331` (the `code_drift`/
`processCodeCanonical` path).

**`appendRowWithId`** (`lib/ledger.mjs:144-161`) — atomic mint+append. Locks
the ledger once (`acquireLock(jsonlPath, {retries: 50, minDelayMs: 20,
maxDelayMs: 200})`), reads the current rows, computes `max+1` *under that same
lock*, appends, then releases. No gap between reading the max and writing the
new row. Used by all four cross-repo write sites in `processCrossRepo`
(`watcher.mjs:415`, `:434`, `:458`, `:509`).

The two differ in lock parameters as well as atomicity: `appendRow`'s default
lock (used indirectly by the `nextId` + `appendRow` pair) is `{retries: 8}`
(`lib/ledger.mjs:72`), while `appendRowWithId` retries far harder —
`{retries: 50, minDelayMs: 20, maxDelayMs: 200}` — because its own comment
(`lib/ledger.mjs:109-111`) notes the cross-ledger has many writers per watcher
fire and needs to drain a burst rather than exhaust a small retry budget.

One more consequence worth stating plainly: `nextId` derives its max from
`readLedger`'s **reduced** output (the post-fold `drifts` map, §4) — not from
the raw file. Since only Event rows ever enter that map, **the id space for
new rows on the main ledger is defined solely by existing Event ids.**
Transition rows (`status_change`) never influence what the next id will be,
which is consistent with a Transition always addressing an *existing* Event
id rather than minting a new one — but it also means a ledger containing only
malformed or unknown-type Event-shaped rows (dropped into `unknownTypes`,
§4's `else` branch) would silently under-count its true max.

---

## 9. Census methodology and numbers

Derived 2026-08-13 by a throwaway script (not checked in) that walked
`~/Documents/GitHub` for files named `PROPAGATION_LEDGER.jsonl` or ending in
`.propagation/ledger.jsonl`, parsed every line as JSON, and tabulated `type`,
top-level field presence, and `downstream[]` entry field presence.

**The walk found 8 ledgers, not 7.** Seven are workspace-root ledgers (one
per `.propagates.yml` marker with `workspace: true`, per `SPEC.md` §7):

```
354   /Users/rupali.b/Documents/GitHub/.propagation/ledger.jsonl               (hub)
 16   /Users/rupali.b/Documents/GitHub/Keerti/Keerti-portfolio/docs/PROPAGATION_LEDGER.jsonl
 10   /Users/rupali.b/Documents/GitHub/ManavDaehi/Manav-portfolio/docs/PROPAGATION_LEDGER.jsonl
  2   /Users/rupali.b/Documents/GitHub/ManavDaehi/docs/PROPAGATION_LEDGER.jsonl
  7   /Users/rupali.b/Documents/GitHub/PanditPawanKaushik/SSJK-mb/docs/PROPAGATION_LEDGER.jsonl
401   /Users/rupali.b/Documents/GitHub/PanditPawanKaushik/docs/PROPAGATION_LEDGER.jsonl
664   /Users/rupali.b/Documents/GitHub/Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl
──── = 1454 rows across the 7 workspace-root ledgers
```

The 8th is a **secondary git worktree**, not a workspace root:
`/Users/rupali.b/Documents/GitHub/PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/PROPAGATION_LEDGER.jsonl`
(79 rows) — confirmed via `git worktree list` inside
`PanditPawanKaushik/` to be a live, checked-out worktree on branch
`worktree-client-answers-propagation`, not stale or orphaned. It is a real,
independent ledger (secondary worktrees get their own `docs/` copy) but it is
outside the 7-workspace-root scope this document's counts describe. Including
it: **1533 rows across 8 files** (8 not counted separately per type here,
since it is a distinct census question from "what does the workspace-root
data model look like").

**Operationally, though, that 8th ledger is invisible to the tool.**
`discoverWorkspacesSync` returns 7 workspaces and none of them is that path,
so its rows are outside everything the skill reports. Verified 2026-08-13: the
worktree ledger holds **1 open row** that `status --all` does not list and
`doctor` reports all-green over — including `doctor`'s "no source open in more
than one ledger" assertion, which passes here only because it cannot see the
second ledger to compare against.

This is live evidence for `ISSUES.md` **B1** (sidecars are branch-local;
`doctor` is not branch-aware), re-ranked to S1 on 2026-08-13 because the
premise is coordination of parallel work. A secondary worktree holding a
divergent copy of its parent's ledger is precisely that case, and both the
census and the tool missed it — the census because a depth-limited walk
stopped short of `.claude/worktrees/<name>/docs/`, the tool because discovery
never descends there at all.

**By type, 7-ledger set (1454 rows):**

```
status_change   860   59.1%
drift           354   24.4%
code_drift      239   16.4%
manual            1   0.1%
```

This is close to, but not identical to, the shape reported by the plan this
document was commissioned from (7 ledgers, 1451 rows: status_change 860,
drift 351, code_drift 239, manual 1) — `status_change`, `code_drift`, and
`manual` match exactly; `drift` is 354 here vs 351 there, a 3-row difference
consistent with the watcher having fired a small number of additional drift
events between when that plan's census was taken and this pass, both on
2026-08-13.

**Top-level field frequency, 7-ledger set:**

```
type, id, status, timestamp        1454   100.0%
source, change, downstream          594    40.9%
wontfix_reason                      556    38.2%
pending_graph_augment               342    23.5%
notes                               325    22.4%
correlation_id                      250    17.2%
source_worktree                       3     0.2%
note                                   3     0.2%
closed_by                             1     0.1%
git                                    0     0.0%
```

**`downstream[]` entry field frequency, 1911 entries:**

```
path, why, kind          1911   100.0%
glob_matched, sample        37     1.9%
```

### Forensic provenance — Vipin Kaushik's 664-row ledger

`JSON.stringify` emits `{"type":"drift"` — no space after the colon.
Hand-authored JSON commonly has `{"type": "drift"` — with a space. Counting
each pattern as a literal substring match against
`Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl`:

```
grep -c '{"type":"'  → 86   (machine-written)
grep -c '{"type": "' → 578  (hand-authored)
86 + 578 = 664 = total row count  -- the two patterns partition the file exactly
```

**86 machine-written, 578 hand-written — 87% of this ledger did not come from
this codebase.**

Of the 556 `wontfix_reason` rows in this ledger, **all 556 (100%)** fall
inside the hand-authored (space-after-colon) set:

```
grep '{"type": "' docs/PROPAGATION_LEDGER.jsonl | grep -c wontfix_reason  → 556
grep -c wontfix_reason docs/PROPAGATION_LEDGER.jsonl                      → 556
```

This is the evidence behind §6's causal claim, not a separate finding.

---

## What this document does not do

No recommendations, no fixes, no roadmap — that's a later pass (see the plan
this document was commissioned from for what changes next). This document's
only job is to describe what is actually on disk and in the reader/writer
code, accurately enough that the next pass can trust it instead of
re-deriving it from scratch.
