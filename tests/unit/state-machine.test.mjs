/**
 * The edge state machine, table-driven (graph-model plan, "State machine: every state x every
 * trigger"; phase 1 of #127, fixes #118).
 *
 * Every cell of the plan's table is one row here, built from LITERAL event logs plus content ids and
 * run through the same fold `reconcile` uses (`reduceLastPinning`, `reduceLastDeferred`,
 * `deferralAfterPin`, `deriveEdgeState`). No filesystem, no git: state is a function of the log and
 * the content, and the table is a claim about exactly that function.
 *
 * Triggers: t1 source moves, t2 downstream moves, t3 a side reverts, t4 a pinning verdict, t5 defer,
 * t6 decouple, t7 reword why, t8 rename, t9 a side unreadable, t10 the glob's last match disappears.
 * t7 and t8 are IDENTITY events (phases 2 and 3), so those cells are `todo`, not skipped silently:
 * each is counted, named and reported by the floor test at the bottom.
 *
 * TWO CELLS DEVIATE FROM THE PLAN'S TABLE, deliberately, and are asserted as built:
 *   - CL x t5. The table's cell says DF; the phase-1 "Change" section and the existing reconcile
 *     test say a deferral AFTER a real pin keeps the pinned state and shows the deferral. Built as
 *     CLEAN + `deferred` note.
 *   - UN x t5 and UM x t5. The table says DF, while its own DF x t9 cell says UN for the same log
 *     and content (a deferral, then an unreadable side). One derived state cannot be both. The
 *     environment wins, so a broken edge stays visible; asserted in its own test below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveEdgeState,
  deferralAfterPin,
  reduceLastPinning,
  reduceLastDeferred,
} from "../../lib/edges/reconcile.mjs";
import { divergedGuard } from "../../lib/edges/disposition.mjs";
import { EDGE_STATES } from "../../lib/edges/states.mjs";

const E = "edge-1";
const S0 = "src-v0", D0 = "dst-v0", S1 = "src-v1", D1 = "dst-v1";
let n = 0;
const ts = () => `2026-11-04T10:00:${String(n++).padStart(2, "0")}.000Z`;

const pin = (s = S0, d = D0, disposition = "propagated") =>
  ({ edge_id: E, ts: ts(), disposition, source_content: s, downstream_content: d });
const defer = (reason = "parked") => ({ edge_id: E, ts: ts(), disposition: "deferred", reason });
const decouple = () => ({ edge_id: E, ts: ts(), disposition: "decoupled", source_content: null, downstream_content: null });

/** The fold reconcile applies to one edge, over a literal log and the current content. */
function derive(log, content) {
  const last = reduceLastPinning(log).get(E) ?? null;
  const deferred = reduceLastDeferred(log).get(E) ?? null;
  const deferredAfterPinEvent = deferralAfterPin(last, deferred);
  const state = deriveEdgeState({
    unmatched: !!content.unmatched,
    unresolvable: content.unresolvable ?? null,
    last,
    deferredAfterPin: deferredAfterPinEvent,
    sourceId: content.s,
    downstreamId: content.d,
  });
  return { state, deferred: deferredAfterPinEvent };
}

/** A start state, as the literal log and content that produce it. */
const START = {
  NV: () => ({ log: [], content: { s: S0, d: D0 } }),
  CL: () => ({ log: [pin()], content: { s: S0, d: D0 } }),
  DR: () => ({ log: [pin()], content: { s: S1, d: D0 } }),
  RV: () => ({ log: [pin()], content: { s: S0, d: D1 } }),
  DV: () => ({ log: [pin()], content: { s: S1, d: D1 } }),
  DF: () => ({ log: [defer("first reason")], content: { s: S0, d: D0 } }),
  DC: () => ({ log: [pin(), decouple()], content: { s: S0, d: D0 } }),
  UN: () => ({ log: [], content: { unresolvable: "serious" } }),
  UM: () => ({ log: [], content: { unmatched: true } }),
};
const STATE_OF = { NV: "NEVER_VERIFIED", CL: "CLEAN", DR: "DRIFTED", RV: "REVERSED", DV: "DIVERGED",
  DF: "DEFERRED", DC: "DECOUPLED", UN: "UNRESOLVABLE", UM: "UNMATCHED" };
const ABBREV = Object.fromEntries(Object.entries(STATE_OF).map(([k, v]) => [v, k]));

/** The triggers, each as a transformation of {log, content}. */
const TRIGGER = {
  t1: ({ log, content }) => ({ log, content: { ...content, s: S1 } }),
  t2: ({ log, content }) => ({ log, content: { ...content, d: D1 } }),
  t4: ({ log, content }) => ({ log: [...log, pin(content.s, content.d)], content }),
  t5: ({ log, content }) => ({ log: [...log, defer("newer reason")], content }),
  t6: ({ log, content }) => ({ log: [...log, decouple()], content }),
  t9: ({ log, content }) => ({ log, content: { ...content, unresolvable: "serious" } }),
  t10: ({ log, content }) => ({ log, content: { unmatched: true } }),
};
const REVERT = {
  s: ({ log, content }) => ({ log, content: { ...content, s: S0 } }),
  d: ({ log, content }) => ({ log, content: { ...content, d: D0 } }),
  both: ({ log, content }) => ({ log, content: { ...content, s: S0, d: D0 } }),
};

// ── the table ───────────────────────────────────────────────────────────────
// null = a blank cell in the plan's table ("—"). A string is the expected state abbreviation.
// {todo: "..."} is a cell not asserted in phase 1, with its reason. {note: "..."} is a state that
// also carries a visible deferral. {any: [[revert, expected], ...]} is a cell with sub-cases.
const TODO_ID = (phase) => ({ todo: `identity event, phase ${phase}` });
const TABLE = {
  //        t1     t2     t3                                         t4     t5                          t6    t7           t8           t9    t10
  NV: { t1: "NV", t2: "NV", t3: "NV",                                  t4: "CL", t5: "DF",                 t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  CL: { t1: "DR", t2: "RV", t3: "CL",                                  t4: "CL", t5: { state: "CL", note: 1 }, t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  DR: { t1: "DR", t2: "DV", t3: { revert: "s", state: "CL" },          t4: "CL", t5: { state: "DR", note: 1 }, t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  RV: { t1: "DV", t2: "RV", t3: { revert: "d", state: "CL" },          t4: "CL", t5: { state: "RV", note: 1 }, t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  DV: { t1: "DV", t2: "DV", t3: { any: [["s", "RV"], ["d", "DR"], ["both", "CL"]] },
                                                                       t4: "CL", t5: { state: "DV", note: 1 }, t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  DF: { t1: "DF", t2: "DF", t3: "DF",                                  t4: "CL", t5: { state: "DF", note: 1 }, t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  DC: { t1: "DC", t2: "DC", t3: "DC",                                  t4: "CL", t5: "DC", t6: "DC",         t7: null,         t8: null,         t9: "DC", t10: "DC" },
  UN: { t1: null, t2: null, t3: null,                                  t4: { todo: "write-path refusal (no content to pin), not a derivation; verify's own tests" },
                                                                                     t5: { todo: "plan says DF, contradicting its DF x t9 = UN; built as UN, see the test below" },
                                                                                                                  t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: "UN", t10: "UM" },
  UM: { t1: null, t2: null, t3: null,                                  t4: { todo: "write-path refusal (no content to pin), not a derivation; verify's own tests" },
                                                                                     t5: { todo: "plan says DF, contradicting its DF x t9 = UN; built as UM, see the test below" },
                                                                                                                  t6: "DC", t7: TODO_ID(2), t8: TODO_ID(3), t9: null, t10: "UM" },
};
const TRIGGERS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"];

const cells = [];
for (const [from, row] of Object.entries(TABLE)) {
  for (const t of TRIGGERS) {
    if (row[t] === null) continue; // a blank cell in the plan's table
    cells.push({ from, t, cell: row[t] });
  }
}

/** Apply trigger `t` to the start state `from`, with the sub-case revert when the cell has one. */
function apply(from, t, revert) {
  const start = START[from]();
  if (t === "t3") return REVERT[revert ?? "both"](start);
  return TRIGGER[t](start);
}

for (const { from, t, cell } of cells) {
  if (typeof cell === "object" && cell.todo) {
    test(`${from} x ${t}: TODO (${cell.todo})`, { todo: cell.todo }, () => {
      assert.fail("not implemented in phase 1");
    });
    continue;
  }
  if (typeof cell === "object" && cell.any) {
    for (const [rev, expected] of cell.any) {
      test(`${from} x ${t} (revert ${rev}) -> ${expected}`, () => {
        const { log, content } = apply(from, t, rev);
        assert.equal(ABBREV[derive(log, content).state], expected);
      });
    }
    continue;
  }
  const expected = typeof cell === "string" ? cell : cell.state;
  const revert = typeof cell === "object" ? cell.revert : undefined;
  test(`${from} x ${t} -> ${expected}${typeof cell === "object" && cell.note ? " (deferral shown)" : ""}`, () => {
    const { log, content } = apply(from, t, revert);
    const got = derive(log, content);
    assert.equal(ABBREV[got.state], expected, `expected ${STATE_OF[expected]}, derived ${got.state}`);
    if (typeof cell === "object" && cell.note) {
      assert.ok(got.deferred, "a deferral after a real pin must stay visible on the row, never hidden");
    }
  });
}

// ── the rules the table encodes, each with the input that makes it fail ─────

test("a deferral BEFORE the latest pin is overtaken by it: no note, state from the pin", () => {
  const log = [defer("old"), pin()];
  const got = derive(log, { s: S0, d: D0 });
  assert.equal(got.state, "CLEAN");
  assert.equal(got.deferred, null);
});

test("`decoupled` is never compared as a pin: it carries no content, and reading it as one is the DIVERGED bug", () => {
  // The old fold fed the content-less decoupled event to stateFromPin, which compared
  // undefined against both files and returned DIVERGED for an edge nobody still declares.
  const got = derive([pin(), decouple()], { s: S0, d: D0 });
  assert.equal(got.state, "DECOUPLED");
  assert.notEqual(got.state, "DIVERGED");
});

test("a pin after a decoupled event re-couples the edge (DC x t4 -> CL)", () => {
  const log = [pin(), decouple()];
  assert.equal(derive([...log, pin()], { s: S0, d: D0 }).state, "CLEAN");
});

test("a broken edge stays broken after a deferral (UN x t5, UM x t5: the table contradicts itself)", () => {
  const withDeferral = (content) => derive([defer("looked at it")], content);
  assert.equal(withDeferral({ unresolvable: "serious" }).state, "UNRESOLVABLE");
  assert.equal(withDeferral({ unresolvable: "absent" }).state, "NOT_PRESENT_ON_REF");
  assert.equal(withDeferral({ unmatched: true }).state, "UNMATCHED");
});

test("DV accepts only both-reconciled as a pinning verdict (the guard behind DV x t4)", () => {
  for (const d of ["propagated", "no-change-needed", "source-corrected", "wontfix", "baselined"]) {
    assert.ok(divergedGuard("DIVERGED", d), `${d} must be refused on a DIVERGED edge`);
  }
  assert.equal(divergedGuard("DIVERGED", "both-reconciled"), null);
});

test("every state the machine can derive is in the closed vocabulary", () => {
  const seen = new Set();
  for (const from of Object.keys(START)) {
    for (const t of Object.keys(TRIGGER)) {
      const { log, content } = apply(from, t);
      seen.add(derive(log, content).state);
    }
    seen.add(derive(START[from]().log, START[from]().content).state);
  }
  seen.add(derive([], { unresolvable: "absent" }).state); // the benign "file is not there" arm of t9
  for (const s of seen) assert.ok(EDGE_STATES.includes(s), `${s} is not in EDGE_STATES`);
  assert.equal(seen.size, EDGE_STATES.length, `derived ${[...seen].sort().join(", ")}; the closed list is ${EDGE_STATES.join(", ")}`);
});

// ── the floor ───────────────────────────────────────────────────────────────

test("floor: the table's non-blank cells are all rows here, and the todo cells are named", () => {
  // The plan's table is 9 states x 10 triggers = 90 cells. Blank ("—") ones carry no claim.
  const total = Object.keys(TABLE).length * TRIGGERS.length;
  assert.equal(total, 90, "the table has gone out of shape: 9 rows x 10 triggers");
  const blank = Object.values(TABLE).flatMap((r) => TRIGGERS.filter((t) => r[t] === null)).length;
  assert.equal(cells.length, total - blank, "every non-blank cell becomes exactly one row");
  assert.ok(cells.length >= 70, `only ${cells.length} cells found: the table scan has gone blind, it has not found nothing`);
  const todo = cells.filter((c) => typeof c.cell === "object" && c.cell.todo);
  // t7 and t8 across the eight rows that have them (phases 2 and 3), plus UN/UM x t4 and t5.
  assert.deepEqual(
    todo.map((c) => `${c.from}.${c.t}`).sort(),
    ["CL", "DF", "DR", "DV", "NV", "RV", "UM", "UN"].flatMap((f) => [`${f}.t7`, `${f}.t8`])
      .concat(["UM.t4", "UM.t5", "UN.t4", "UN.t5"]).sort(),
    "the set of todo cells changed: say which cell, and why, in the TABLE",
  );
});
