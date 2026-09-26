/**
 * reminders-tags.test.mjs — the tag table, now DERIVED from `.sidecar.yml`.
 *
 * Until 2026-09-25 `lib/reminders/tags.mjs` carried a literal map of two of
 * Rupali's projects. The fact moved into each project's own sidecar, beside
 * `project`/`repo_root`/`remote`, which means the lookup is now a FILESYSTEM
 * SCAN — and a scan has failure modes a literal never had.
 *
 * The three that matter, and all three are asserted below:
 *
 *   1. A scan that reads nothing must not read as "your tags are unknown".
 *      A hardcoded table always answered; a scan can come back empty because
 *      the hub is unconfigured. If that rendered as `held-unknown-tag`, a
 *      misconfigured install would blame the user's tags
 *      (`rule:discernment-checks` §6).
 *   2. A tag claimed by TWO sidecars must resolve to NEITHER. Last-wins picks
 *      by readdir order, which is not a decision anyone made.
 *   3. The route a tag resolves to must be the INVERSE of where `sync.mjs`
 *      looks for that project's register. Get it backwards and the item routes
 *      to a real directory with no register in it, reporting
 *      `held-no-register` — a refusal that reads as a missing file rather
 *      than as a wrong derivation. That is the round trip, and it is the one
 *      property neither module can check alone.
 *
 * Hermetic: every case builds a real temp tree and scans it, so `readdirSync`
 * and `existsSync` are exercised rather than stubbed. The scan IS the thing
 * under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverTagTable, routeForSidecarDir, SIDECAR_TAGS_KEY,
} from "../../lib/reminders/tags.mjs";
import { resolveRegisterCandidates } from "../../lib/reminders/sync.mjs";

/** Build `<root>/<workspace>/propagation/state/<name>/.sidecar.yml`. */
function sidecar(root, workspace, name, body) {
  const dir = path.join(root, workspace, "propagation", "state", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".sidecar.yml"), body);
  return path.join(dir, ".sidecar.yml");
}

function withTree(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "tags-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const decl = (project, tags) =>
  `project: ${project}\n${SIDECAR_TAGS_KEY}:\n${tags.map((t) => `  - ${t}\n`).join("")}`;

/* ── discovery ────────────────────────────────────────────────────────────── */

test("a tag declared in a PROJECT sidecar routes to that project's directory", () => {
  withTree((root) => {
    mkdirSync(path.join(root, "Rupali", "claude-usage-widget"), { recursive: true });
    sidecar(root, "Rupali", "claude-usage-widget", decl("claude-usage-widget", ["ccusage"]));

    const { table, sidecarsRead, withTags, errors } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(errors, []);
    assert.equal(sidecarsRead, 1);
    assert.equal(withTags, 1);
    assert.equal(table.ccusage.project, "Rupali/claude-usage-widget");
    assert.equal(table.ccusage.path, path.join(root, "Rupali", "claude-usage-widget"));
  });
});

test("a tag declared in a WORKSPACE sidecar routes to the workspace ROOT, not to state/workspace", () => {
  withTree((root) => {
    sidecar(root, "Vipin Kaushik", "workspace", decl("workspace", ["vipinkaushik"]));
    const { table } = discoverTagTable({ githubRoot: root });
    assert.equal(table.vipinkaushik.path, path.join(root, "Vipin Kaushik"),
      "state/workspace/ describes the workspace itself — the route must not include the state path");
    assert.equal(table.vipinkaushik.project, "Vipin Kaushik");
  });
});

test("the HUB's own state dir is scanned — it is one level shallower than a workspace's", () => {
  withTree((root) => {
    // `<root>/propagation/state/scripts/` with no workspace segment. 3 of the
    // real tree's 52 sidecars live here, and a scan walking only
    // `<root>/*/propagation/state/` could never route a tag to any of them.
    const dir = path.join(root, "propagation", "state", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".sidecar.yml"), decl("scripts", ["hubscripts"]));

    const { table, sidecarsRead } = discoverTagTable({ githubRoot: root });
    assert.equal(sidecarsRead, 1, "the hub's own state dir was not scanned");
    assert.equal(table.hubscripts.path, path.join(root, "scripts"));
    assert.equal(table.hubscripts.project, "scripts");
  });
});

test("mixed case is normalised, and a QUOTED leading # is stripped", () => {
  withTree((root) => {
    sidecar(root, "W", "workspace", `project: workspace\n${SIDECAR_TAGS_KEY}:\n  - MixedCase\n  - "#Quoted"\n`);
    const { table, errors } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(errors, []);
    assert.ok(table.mixedcase, `expected a normalised key, got ${JSON.stringify(Object.keys(table))}`);
    assert.ok(table.quoted, "a quoted leading # must be stripped");
  });
});

test("an UNQUOTED `- #tag` is a YAML comment, and the error says so", () => {
  // The trap, and the reason the message is specific. `#ccusage` is how the tag
  // is written in Reminders and in every doc, so `- #ccusage` is the natural
  // thing to type in a sidecar -- and YAML turns it into a null list entry.
  // Measured: `- #x` parses to [null]. An error reading "non-string entry"
  // would send the reader to look at the wrong thing entirely.
  withTree((root) => {
    sidecar(root, "W", "workspace", `project: workspace\n${SIDECAR_TAGS_KEY}:\n  - #ccusage\n`);
    const { table, errors } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(table, {}, "the commented-out tag must not resolve");
    assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0].reason, /YAML COMMENT/,
      `the error must name the cause, not the symptom: ${errors[0].reason}`);
  });
});

/* ── the round trip: tags.mjs and sync.mjs must be inverses ──────────────── */

test("ROUND TRIP: a tag's route resolves back to the register beside its own sidecar", () => {
  withTree((root) => {
    for (const [ws, name, tag] of [
      ["Rupali", "claude-usage-widget", "ccusage"],
      ["Vipin Kaushik", "workspace", "vipinkaushik"],
    ]) {
      const declaredIn = sidecar(root, ws, name, decl(name, [tag]));
      const { table } = discoverTagTable({ githubRoot: root });

      // The forward direction: tag -> route path.
      const route = table[tag];
      assert.ok(route, `${tag} did not resolve`);

      // The inverse, which is sync.mjs's: route path -> canonical register.
      const { canonical } = resolveRegisterCandidates(
        { routePath: route.path }, { githubRoot: root });

      assert.equal(path.dirname(canonical), path.dirname(declaredIn),
        `${tag}: the register resolver looks in ${path.dirname(canonical)} but the tag was ` +
        `declared in ${path.dirname(declaredIn)} — the two derivations have drifted apart, ` +
        `so a routed item would report held-no-register against a directory that has one`);
      assert.equal(path.basename(canonical), "TODOS.md");
    }
  });
});

/* ── ambiguity is refused, not resolved by iteration order ────────────────── */

test("a tag claimed by TWO sidecars resolves to NEITHER, and says so", () => {
  withTree((root) => {
    sidecar(root, "A", "workspace", decl("workspace", ["shared"]));
    sidecar(root, "B", "workspace", decl("workspace", ["shared"]));

    const { table, errors } = discoverTagTable({ githubRoot: root });
    assert.equal(table.shared, undefined,
      "an ambiguous tag resolved anyway — readdir order decided something nobody chose");
    assert.equal(errors.length, 1, `expected one ambiguity error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0].reason, /declared by 2 sidecars/);
  });
});

/* ── absence must be attributable (the answer to D1) ─────────────────────── */

test("NO sidecars at all is reported as a broken table, NOT as unknown tags", () => {
  withTree((root) => {
    // `tagTableStatus()` reads the REAL tree and is asserted in
    // reminders-read.test.mjs; here the interest is the scanner over an empty
    // one, which must report an empty POPULATION rather than an error.
    const { table, sidecarsRead, errors } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(table, {});
    assert.equal(sidecarsRead, 0);
    assert.deepEqual(errors, [], "an empty tree is not an error — it is an empty population");
  });
});

test("sidecars present but NONE declaring the key is a DIFFERENT fact from no sidecars", () => {
  withTree((root) => {
    sidecar(root, "A", "workspace", "project: workspace\nremote: x\n");
    sidecar(root, "B", "workspace", "project: workspace\nremote: y\n");

    const { table, sidecarsRead, withTags } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(table, {});
    assert.equal(sidecarsRead, 2, "the population must be reported even when it yields nothing");
    assert.equal(withTags, 0);
    // "looked at 2 and found none" vs "looked at 0" — rule:enforcement-watches-itself §4.
    // Both give an empty table; only the counts tell them apart.
  });
});

test("an unparseable sidecar is an ERROR naming the file, never a silent skip", () => {
  withTree((root) => {
    sidecar(root, "A", "workspace", decl("workspace", ["good"]));
    sidecar(root, "B", "workspace", "project: [unclosed\n  - nope\n:::\n");

    const { table, errors, sidecarsRead } = discoverTagTable({ githubRoot: root });
    assert.equal(sidecarsRead, 2);
    assert.ok(table.good, "a broken neighbour must not lose the tags that did parse");
    assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0].sidecar, /B/);
  });
});

test("reminder_tags that is not a list is an error, not a silently-ignored string", () => {
  withTree((root) => {
    sidecar(root, "A", "workspace", `project: workspace\n${SIDECAR_TAGS_KEY}: ccusage\n`);
    const { table, errors } = discoverTagTable({ githubRoot: root });
    assert.deepEqual(table, {}, "a bare string must not be read as a one-element list");
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /must be a list/);
  });
});

/* ── routeForSidecarDir directly, including the hub shape ────────────────── */

test("routeForSidecarDir covers all three shapes", () => {
  const R = "/tmp/root";
  assert.deepEqual(routeForSidecarDir("Rupali", "claude-usage-widget", R),
    { project: "Rupali/claude-usage-widget", path: "/tmp/root/Rupali/claude-usage-widget" });
  assert.deepEqual(routeForSidecarDir("Vipin Kaushik", "workspace", R),
    { project: "Vipin Kaushik", path: "/tmp/root/Vipin Kaushik" });
  assert.deepEqual(routeForSidecarDir("", "workspace", R),
    { project: "hub", path: R });
  assert.deepEqual(routeForSidecarDir("", "scripts", R),
    { project: "scripts", path: "/tmp/root/scripts" });
});

test("a NULL hub root returns an empty population, it does not throw", () => {
  // G24 makes an unconfigured hub resolve to `null` on purpose. The first
  // version of discoverTagTable() checked for that in tagTableStatus() — which
  // runs AFTER the scan — so `path.join(null, ...)` threw a TypeError first.
  // Found by running it under `npm test`'s own state dir, which declares no
  // `hubRoot`: the unconfigured path is the one the suite actually uses, so the
  // crash was one import away from every reminders test.
  //
  // A reader whose job is to report must not be the thing that crashes on a
  // missing config (rule:discernment-checks §2).
  // `undefined` is excluded ON PURPOSE: it means "use the default", and the
  // default is the configured hub. Only an EXPLICIT falsy root is "no hub".
  for (const root of [null, ""]) {
    const r = discoverTagTable({ githubRoot: root });
    assert.deepEqual(r.table, {}, `githubRoot=${JSON.stringify(root)} should yield no tags`);
    assert.equal(r.sidecarsRead, 0);
    assert.deepEqual(r.errors, [], "a missing hub is not a sidecar error");
  }
});
