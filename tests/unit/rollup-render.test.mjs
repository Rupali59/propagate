/**
 * lib/report/rollup.mjs — the upstream "what have we built / what is open"
 * view. This file covers what the module's own header promises and nothing
 * it does not: the five renderings that must never collapse into each other,
 * the coverage invariant (no lost item, no double-assignment across nested
 * owners), the footer's round-trip (render -> parse -> re-derive the same
 * hash), `compareInputs`'s four transition buckets, `parseFooter`'s
 * three-way outcome (parsed / malformed / absent — never malformed-as-null),
 * and self-inclusion (`rule:enforcement-watches-itself`: this tool must
 * appear in its own output).
 *
 * Fixture-based tests build a small synthetic tree under a temp directory
 * and drive `backlog()` for real over it (fast — a handful of tiny files),
 * passing a minimal synthetic `inventoryResult` so `rollup()` never has to
 * run the real, slow, machine-specific `inventory()` walk (skills/plugins/
 * repos scanning) just to test the render/attribution logic.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { backlog } from "../../lib/report/backlog.mjs";
import * as rollupMod from "../../lib/report/rollup.mjs";

const {
  rollup,
  renderRollup,
  bodyHash,
  parseFooter,
  compareInputs,
  ROLLUP_BODY_MARK,
  ROLLUP_FOOTER_MARK,
} = rollupMod;

// ─────────────────────────────────────────────────────────────────────────
// Fixture tree — one directory per rendering this module must distinguish,
// plus a nested Parent/Child pair for the attribution (coverage) tests.
// ─────────────────────────────────────────────────────────────────────────

// realpathSync'd immediately: on macOS, os.tmpdir() lives under `/var`,
// which is itself a symlink to `/private/var`. `nearestOwner`
// (lib/core/discovery.mjs) always resolves the FILE side of its comparison
// through realpathSync, so an owner root built from the raw (non-resolved)
// tmpdir path would never match -- every item in this fixture would
// misattribute to "(outside any known root)". Caught by this exact fixture
// before this line existed; see rollup.mjs's `resolveOwnerRoot` doc comment
// for the production-code half of this fix.
const FIXTURE_ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "rollup-render-")));

function mkGitOwner(rel) {
  const dir = path.join(FIXTURE_ROOT, rel);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function mkMarkerOwner(rel) {
  const dir = path.join(FIXTURE_ROOT, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  return dir;
}

function writeFile(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body, "utf8");
}

// W1 — items-found: a STATE.md with real bullets under a live section.
const W1 = mkGitOwner("W1-items");
writeFile(W1, "STATE.md", "# W1 — State\n\n## Now\n\n- first open thing\n- second open thing\n");

// W2 — empty: a STATE.md whose live section has a heading and no bullets.
const W2 = mkGitOwner("W2-empty");
writeFile(W2, "STATE.md", "# W2 — State\n\n## Now\n\nNothing currently in flight here.\n");

// W3 — pointer stub: matches isPointerStubText's "now lives at" phrasing.
const W3 = mkGitOwner("W3-stub");
writeFile(W3, "STATE.md", "# W3 — State\n\nState now lives at `elsewhere/STATE.md`.\n");

// W4 — unreadable: a DIRECTORY named STATE.md forces readFileSync to throw
// EISDIR, portably, without relying on chmod (which does not reliably block
// reads for the file's own owner on every platform this suite runs on).
const W4 = mkGitOwner("W4-unreadable");
mkdirSync(path.join(W4, "STATE.md"), { recursive: true });

// W5 — unparsed: a TODOS.md with real, long-enough prose that matches none
// of the recognised shapes (no checkbox, no ID heading, not a stub marker).
// DELIBERATELY avoids the literal substrings STUB_EXPLICIT_RE matches ("none
// open", "nothing open", "no open", "no items") even in passing prose -- an
// earlier draft of this fixture described what it was avoiding using those
// exact words, which made backlog.mjs classify it as a STUB via its own
// window match. Same shape as the bug backlog.mjs's own STUB_EXPLICIT_RE
// comment warns about, one layer up: this fixture almost became the bug it
// exists to catch.
const W5 = mkGitOwner("W5-unparsed");
writeFile(
  W5,
  "TODOS.md",
  "This file records ongoing considerations as free-form prose. It carries " +
    "neither a checkbox marker nor an identifier-keyed heading such as " +
    "PROJ-001, and its opening paragraph is deliberately long enough that a " +
    "reader must not mistake it for a short signpost -- so it should fall " +
    "through every recognised shape this parser knows about and land as " +
    "content whose format is simply unrecognised, not as blank.\n",
);

// W6 — no register at all: an owner with no STATE.md/TODOS.md/ISSUES.md
// anywhere under it.
mkGitOwner("W6-noregister");

// Parent / Parent/Child — nested owners, each with their own STATE.md, used
// to prove attribution is nearest-owner and not a string-prefix split.
const PARENT = mkMarkerOwner("Parent");
writeFile(PARENT, "STATE.md", "# Parent — State\n\n## Now\n\n- parent-level item\n");
const CHILD = mkMarkerOwner("Parent/Child");
writeFile(CHILD, "STATE.md", "# Child — State\n\n## Now\n\n- child-level item\n");

after(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const EMPTY_INVENTORY_RESULT = {
  categories: { skills: [], plugins: [], repos: [], standalone: [] },
  counts: {},
  probeLimits: {},
  dropped: [],
  budgetExceeded: false,
};

function buildFixtureRollup() {
  const backlogResult = backlog({ searchRoots: [FIXTURE_ROOT] });
  const result = rollup({
    searchRoots: [FIXTURE_ROOT],
    backlogResult,
    inventoryResult: EMPTY_INVENTORY_RESULT,
  });
  return { backlogResult, result, rendered: renderRollup(result) };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. The five renderings — each must produce a visibly, distinctly labelled
//    output. Asserted on the label substrings `renderRollup` emits, not on
//    exact whole-file text (which would make this test rot on any cosmetic
//    rewording).
// ─────────────────────────────────────────────────────────────────────────

test("renderRollup: five renderings never collapse into each other", () => {
  const { rendered } = buildFixtureRollup();

  assert.match(rendered, /\[OPEN\]/, "items-found (W1) must render distinctly");
  assert.match(rendered, /\[EMPTY\]/, "genuinely-empty (W2) must render distinctly");
  assert.match(rendered, /\[POINTER STUB\]/, "pointer stub (W3) must render distinctly");
  assert.match(rendered, /\[UNREADABLE\]/, "unreadable (W4) must render distinctly");
  assert.match(rendered, /\[UNPARSED\]/, "unparsed (W5) must render distinctly");
  assert.match(rendered, /NO REGISTER/, "no-register-at-all (W6) must render distinctly");

  // Every label is a genuinely different string -- not, e.g., "unreadable"
  // and "unparsed" both stringifying to the same word.
  const labels = ["[OPEN]", "[EMPTY]", "[POINTER STUB]", "[UNREADABLE]", "[UNPARSED]", "NO REGISTER"];
  assert.equal(new Set(labels).size, labels.length, "the six labels are not distinct strings");

  // Spot-check each is attached to the RIGHT owner, not just present
  // somewhere in the document by coincidence.
  const w1Section = rendered.slice(rendered.indexOf("W1-items"));
  assert.match(w1Section.slice(0, 400), /\[OPEN\].*2 open item\(s\)/s);

  const w6Idx = rendered.indexOf("W6-noregister");
  assert.ok(w6Idx !== -1);
  assert.match(rendered.slice(w6Idx, w6Idx + 300), /NO REGISTER/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Coverage invariant + nested-owner attribution (nearestOwner, not a
//    string-prefix split). THIS is the test the mutation drill (brief
//    verification step 3) targets: reverting `ownerKeyFn` to
//    `split("/")[0]` must turn the nested-owner assertions below red.
// ─────────────────────────────────────────────────────────────────────────

test("rollup: coverage invariant holds -- every ranked item counted exactly once, none lost", () => {
  const { backlogResult, result } = buildFixtureRollup();

  assert.equal(result.coverage.rankedLength, backlogResult.ranked.length);
  assert.equal(
    result.coverage.summedItems,
    backlogResult.ranked.length,
    "sum(perOwnerItemCount) must equal backlogResult.ranked.length",
  );
  assert.equal(result.coverage.listed, backlogResult.ranked.length);
  assert.equal(result.coverage.duplicateAssignment, false);
  assert.equal(result.coverage.ok, true);

  // Independent recount, not trusting `coverage` on its own say-so: walk
  // every owner group and confirm each (file, line) pair from the ranked
  // list appears in EXACTLY ONE group.
  const seen = new Map(); // "file#line" -> owner key
  for (const o of result.perOwner) {
    for (const item of o.items) {
      const key = `${item.file}#${item.line}`;
      assert.ok(
        !seen.has(key),
        `item ${key} assigned to both "${seen.get(key)}" and "${o.owner}"`,
      );
      seen.set(key, o.owner);
    }
  }
  for (const item of backlogResult.ranked) {
    const key = `${item.file}#${item.line}`;
    assert.ok(seen.has(key), `ranked item ${key} missing from every owner group`);
  }
  assert.equal(seen.size, backlogResult.ranked.length);
});

test("rollup: nested owners are attributed by nearestOwner, not a string-prefix split (Parent vs Parent/Child)", () => {
  const { result } = buildFixtureRollup();

  const parentEntry = result.perOwner.find((o) => o.owner === PARENT);
  const childEntry = result.perOwner.find((o) => o.owner === CHILD);

  assert.ok(parentEntry, `no owner group for ${PARENT} -- got keys: ${result.perOwner.map((o) => o.owner).join(", ")}`);
  assert.ok(childEntry, `no owner group for ${CHILD} -- got keys: ${result.perOwner.map((o) => o.owner).join(", ")}`);
  assert.notEqual(parentEntry.owner, childEntry.owner, "Parent and Parent/Child must be DIFFERENT owner groups");

  const parentTexts = parentEntry.items.map((i) => i.briefText);
  const childTexts = childEntry.items.map((i) => i.briefText);
  assert.ok(parentTexts.some((t) => t.includes("parent-level item")), "Parent's own item must land in Parent's group");
  assert.ok(childTexts.some((t) => t.includes("child-level item")), "Child's own item must land in Child's group");
  assert.ok(!parentTexts.some((t) => t.includes("child-level item")), "Child's item must NOT be attributed up to Parent");
  assert.ok(!childTexts.some((t) => t.includes("parent-level item")), "Parent's item must NOT leak down into Child");
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Footer round-trip: render -> parse -> the recomputed body hash matches
//    what the footer claims, and every declared input round-trips exactly.
// ─────────────────────────────────────────────────────────────────────────

test("renderRollup -> parseFooter round-trips every input and the body hash", () => {
  const { result, rendered } = buildFixtureRollup();

  assert.match(rendered, new RegExp(ROLLUP_BODY_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, new RegExp(ROLLUP_FOOTER_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const parsed = parseFooter(rendered);
  assert.ok(parsed, "footer must parse");
  assert.equal(parsed.malformed, undefined, "a well-formed footer must not report malformed");

  assert.equal(parsed.alg, "sha256-12");
  assert.match(parsed.generator, /^propagate /);
  assert.match(parsed.walk, /backlog depth=6 budget=20000ms/);
  assert.match(parsed.walk, /inventory depth=3 budget=20000ms/);

  assert.equal(parsed.inputs.size, result.inputs.size);
  for (const [key, value] of result.inputs) {
    assert.ok(parsed.inputs.has(key), `parsed footer is missing input "${key}"`);
    assert.equal(parsed.inputs.get(key), value, `input "${key}" round-tripped with a different value`);
  }

  const recomputed = bodyHash(rendered);
  assert.ok(recomputed, "bodyHash must find both markers in a real render");
  assert.equal(parsed.body, recomputed.slice(0, 12), "footer's declared body hash must match a fresh bodyHash() over the same text");

  // Re-render from the SAME result and confirm the body hash is stable --
  // this function must be pure, not time-seeded (no `generatedAt` leaking
  // into the hashed body).
  const renderedAgain = renderRollup(result);
  assert.equal(bodyHash(renderedAgain), recomputed, "renderRollup must be pure over the same result");
});

test("bodyHash returns null when either marker is missing, rather than hashing the whole text silently", () => {
  assert.equal(bodyHash("no markers anywhere in this text"), null);
  assert.equal(bodyHash(ROLLUP_BODY_MARK + "\nbody with no footer marker at all\n"), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. parseFooter: three distinguishable outcomes -- absent (null),
//    malformed (a distinguishable object, never collapsed into null), and
//    parsed. Task 3 requires this explicitly; see the doc comment in
//    rollup.mjs on why this is NOT what the plan's own prose line says
//    ("or null if absent/malformed") -- reported as a brief/code
//    discrepancy, resolved here in favour of the more specific, more
//    defensible Task 3 requirement.
// ─────────────────────────────────────────────────────────────────────────

test("parseFooter: absent marker returns null (not a malformed object, not a throw)", () => {
  assert.equal(parseFooter("# ECOSYSTEM.md\n\nNo footer here at all.\n"), null);
  assert.equal(parseFooter(""), null);
});

test("parseFooter: a marker present but missing required fields is 'malformed', never null-as-absent", () => {
  const brokenNoClose = `${ROLLUP_FOOTER_MARK}\nalg: sha256-12\nbody: aaaaaaaaaaaa\n`; // no closing -->
  const r1 = parseFooter(brokenNoClose);
  assert.notEqual(r1, null, "a present-but-broken marker must not read as absent");
  assert.equal(r1.malformed, true);
  assert.equal(typeof r1.reason, "string");
  assert.ok(r1.reason.length > 0);

  const missingBody = `${ROLLUP_FOOTER_MARK}\nalg: sha256-12\ngenerator: propagate 0.3.0\nwalk: x\ninputs:\n  a :: ABSENT\n-->`;
  const r2 = parseFooter(missingBody);
  assert.notEqual(r2, null);
  assert.equal(r2.malformed, true);
  assert.match(r2.reason, /body/);

  const zeroInputs = `${ROLLUP_FOOTER_MARK}\nalg: sha256-12\nbody: aaaaaaaaaaaa\ngenerator: propagate 0.3.0\nwalk: x\ninputs:\n-->`;
  const r3 = parseFooter(zeroInputs);
  assert.notEqual(r3, null);
  assert.equal(r3.malformed, true);
});

test("parseFooter: never throws on adversarial input", () => {
  const inputs = [
    ROLLUP_FOOTER_MARK, // marker with nothing after it at all
    ROLLUP_FOOTER_MARK + "\n" + ROLLUP_FOOTER_MARK, // marker inside itself
    null,
    undefined,
    12345,
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseFooter(input), `parseFooter threw on ${JSON.stringify(input)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. compareInputs -- all four named transitions, including the two the
//    brief calls out explicitly (ABSENT -> hash, and hash -> UNREADABLE).
// ─────────────────────────────────────────────────────────────────────────

test("compareInputs: detects appeared, vanished, changed, and becameUnreadable", () => {
  const stored = new Map([
    ["a", "ABSENT"], // will appear
    ["b", "111111111111"], // will become unreadable
    ["c", "222222222222"], // unchanged
    ["d", "333333333333"], // will change to a new hash
    ["e", "555555555555"], // will vanish
  ]);
  const current = new Map([
    ["a", "aaaaaaaaaaaa"],
    ["b", "UNREADABLE:EACCES: permission denied"],
    ["c", "222222222222"],
    ["d", "444444444444"],
    // "e" omitted entirely -- must be read the same as an explicit ABSENT.
  ]);

  const diff = compareInputs(stored, current);

  assert.equal(diff.appeared.length, 1);
  assert.equal(diff.appeared[0].key, "a");
  assert.equal(diff.appeared[0].before, "ABSENT");
  assert.equal(diff.appeared[0].after, "aaaaaaaaaaaa");

  assert.equal(diff.becameUnreadable.length, 1);
  assert.equal(diff.becameUnreadable[0].key, "b");
  assert.match(diff.becameUnreadable[0].after, /^UNREADABLE:/);

  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].key, "d");

  assert.equal(diff.vanished.length, 1);
  assert.equal(diff.vanished[0].key, "e");
  assert.equal(diff.vanished[0].after, "ABSENT");

  // "c" is unchanged and must appear in NONE of the four buckets.
  for (const bucket of ["changed", "appeared", "vanished", "becameUnreadable"]) {
    assert.ok(!diff[bucket].some((d) => d.key === "c"), `unchanged key "c" leaked into ${bucket}`);
  }
});

test("compareInputs: an UNREADABLE input becoming readable is reported, not dropped silently", () => {
  const stored = new Map([["x", "UNREADABLE:EACCES"]]);
  const current = new Map([["x", "bbbbbbbbbbbb"]]);
  const diff = compareInputs(stored, current);
  const all = [...diff.changed, ...diff.appeared, ...diff.vanished, ...diff.becameUnreadable];
  assert.equal(all.length, 1, "the UNREADABLE -> hash transition must be reported in exactly one bucket, not zero");
  assert.equal(all[0].key, "x");
});

test("compareInputs: identical maps produce zero entries in every bucket", () => {
  const m = new Map([["a", "ABSENT"], ["b", "aaaaaaaaaaaa"]]);
  const diff = compareInputs(m, new Map(m));
  assert.deepEqual(diff, { changed: [], appeared: [], vanished: [], becameUnreadable: [] });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Self-inclusion (rule:enforcement-watches-itself): run against the LIVE
//    tree and assert propagate's own repo shows up as an owner with real,
//    non-zero items -- not merely "does not crash".
//
// NOT `rollup()` with no args. `npm run test:propagate` sets
// PROPAGATE_STATE_DIR to a scoped tmp dir specifically so tests never touch
// the production event store (docs/GOTCHAS.md G56) -- but `config.mjs`
// derives its OWN config file location from that same variable
// (`$PROPAGATE_STATE_DIR/config.yml`), and the scoped test dir has no
// config.yml. So under the real test harness, the ambient `SEARCH_ROOTS`
// this module would otherwise default to resolves to `[]`, not the live
// tree -- confirmed directly: `rollup()` with no override built exactly ONE
// owner (propagate itself, via the unconditional self-inclusion fallback)
// and the assertion below failed for a hollow reason (0 owners discovered,
// not a real attribution bug). The live hub root is derived instead from
// THIS FILE's own location (`tests/unit/` -> repo root -> parent = hub),
// which is what "the live tree" means on the machine this test runs on and
// does not depend on ambient env/config at all.
// ─────────────────────────────────────────────────────────────────────────

const PROPAGATE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_HUB_ROOT = path.resolve(PROPAGATE_REPO_ROOT, "..");

test("rollup against the live tree: propagate appears in its own output with items.length > 0", { timeout: 60_000 }, () => {
  const result = rollup({ searchRoots: [LIVE_HUB_ROOT] });

  const propagateOwner = result.owners.find((o) => o.root.endsWith(`${path.sep}propagate`));
  assert.ok(propagateOwner, `no discovered owner root ends in /propagate -- got: ${result.owners.map((o) => o.root).join(", ")}`);

  const propagateEntry = result.perOwner.find((o) => o.owner === propagateOwner.key);
  assert.ok(propagateEntry, `no perOwner group for key "${propagateOwner.key}"`);
  assert.ok(
    propagateEntry.items.length > 0,
    `propagate's own group has 0 items -- the tool does not appear in its own output`,
  );

  // Belt-and-suspenders: the render must show it too, not just the structured
  // result.
  //
  // Asserts on `display`, NOT on `owner`/`key`. Changed 2026-08-31 with the render.
  // The key is `shortPath(root)`, which only shortens when the path sits under
  // SEARCH_ROOTS[0]; under a scoped PROPAGATE_STATE_DIR the config resolves a
  // different search root (G56: CONFIG_PATH derives from STATE_DIR), so the key is
  // the ABSOLUTE path. Headings were therefore rendering as
  // `### /Users/<name>/Documents/GitHub/propagate` — a machine-specific path leaking
  // into a TRACKED file, and the only row that did so. The heading is now a display
  // name. This assertion follows that contract rather than re-encoding the defect.
  const rendered = renderRollup(result);
  const shown = propagateEntry.display ?? propagateOwner.key;
  assert.match(rendered, new RegExp(`### ${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));

  // And assert the defect itself cannot come back: no heading may be an absolute path.
  const absHeadings = rendered.split("\n").filter((l) => /^### \//.test(l));
  assert.deepEqual(absHeadings, [], `headings must be names, not absolute paths -- got: ${absHeadings.join(", ")}`);
});
