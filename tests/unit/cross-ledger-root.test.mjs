/**
 * cross-ledger-root.test.mjs — which directory holds the cross-repo ledger.
 *
 * ISSUES N117, and it is N101 IN A SECOND PLACE. `artifactPath()` resolved
 * `ECOSYSTEM.md` from `SEARCH_ROOTS[0]` and was fixed by taking `hubRoot`
 * explicitly. The cross-ledger had the identical derivation and was not swept,
 * so the fix went to the site where the symptom was observed rather than to the
 * class — which is the failure `lib/edges/ledger.mjs`'s own comment describes
 * about a different bug in the same file.
 *
 * Measured 2026-09-30 on this machine, where `config.yml` lists
 * `Rupali/Experiments` first:
 *
 *   CROSS_LEDGER_JSONL -> Rupali/Experiments/PROPAGATION_CROSS_LEDGER.jsonl
 *                         (never existed, and inside a GITIGNORED directory)
 *   the real file      -> <hub>/propagation/PROPAGATION_CROSS_LEDGER.jsonl
 *                         (owned by nobody, so doctor reported its rows as
 *                          invisible to status/reconcile)
 *
 * Two comments already ASSERTED hub derivation while the code did not do it —
 * `ledger.mjs`: "derived from the hub", and `cli.mjs`'s freeze branch: "shares
 * the hub's propagation/ dir". `freeze-ledger --cross --apply` writes through
 * this value, so the write went to the gitignored path.
 *
 * WHY THE RESOLVER TAKES `roots` AND IGNORES IT. The property is "the hub wins
 * over whichever search root sorts first". A resolver accepting only `hubRoot`
 * makes the violating input inexpressible, and the test then asserts nothing
 * while looking thorough — rule:mutate-behind-the-fixture-builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { crossLedgerRoot } from "../../lib/core/config.mjs";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));

const HUB = "/tmp/hub";
const NESTED = "/tmp/hub/Rupali/Experiments";

test("the cross-ledger goes to the declared HUB, not to whichever search root sorts first", () => {
  const got = crossLedgerRoot({ hubRoot: HUB, roots: [NESTED, HUB] });
  assert.equal(got, HUB);
  assert.ok(!String(got).startsWith(NESTED), `resolved inside a nested search root: ${got}`);
});

test("search-root ORDER cannot move the cross-ledger", () => {
  // The bug was entirely an ordering accident, so ordering is the axis to pin.
  const a = crossLedgerRoot({ hubRoot: HUB, roots: [NESTED, HUB] });
  const b = crossLedgerRoot({ hubRoot: HUB, roots: [HUB, NESTED] });
  assert.equal(a, b, "the same tree must resolve identically whatever the walk order");
});

test("no hub falls back to roots[0] — the pre-hubRoot install, and my first version broke it", () => {
  // THIS ASSERTION WAS BACKWARDS AT FIRST. I asserted null here, which nulled the
  // cross-ledger on every install that declares searchRoots and no hubRoot — G24 says
  // that is every install predating the key — and it reddened EIGHT tests in
  // tests/portability/cross-ledger-cascade.test.mjs, including one named "the exact
  // regression that was caught". The suite caught what the unit test asserted wrongly.
  // artifactPath() keeps the same fallback, so the two sibling paths stay consistent.
  assert.equal(crossLedgerRoot({ hubRoot: null, roots: [NESTED] }), NESTED);
  assert.equal(crossLedgerRoot({ hubRoot: null, roots: [NESTED, HUB] }), NESTED, "first root, as before");
});

test("G24's sentinel survives: NEITHER a hub nor any root resolves to null", () => {
  // Null is the loud refusal — readLedgerWithStats is the single choke point that
  // absorbs it. A plausible wrong path would find nothing and report healthy, which
  // is the failure this tool exists to catch.
  assert.equal(crossLedgerRoot({ hubRoot: null, roots: [] }), null);
  assert.equal(crossLedgerRoot({ hubRoot: null }), null, "roots is optional");
});

test("THE WIRING, on a fixture whose searchRoots[0] is NOT the hub", async () => {
  // The pure tests above pass against a function; the defect was in the WIRING, so
  // this asserts the constant that production actually reads.
  //
  // IT USES A FIXTURE, NOT THE LIVE TREE, AND THE FIRST VERSION OF THIS TEST WAS
  // DECORATIVE BECAUSE IT DID NOT. It read the live config and opened with
  // `if (!HUB_ROOT) return;` — and under `npm test` the scoped state dir has no
  // config at all, so HUB_ROOT is null, SEARCH_ROOTS is [], and the whole test
  // returned in 0.4ms asserting nothing while reporting a pass. That is the exact
  // trap doctor-census-parity.test.mjs records about its own first draft, and it
  // survived a mutation that reddened every other test in this file.
  const dir = mkdtempSync(path.join(tmpdir(), "xledger-cfg-"));
  try {
    const hub = path.join(dir, "tree");
    const nested = path.join(hub, "Rupali", "Experiments");
    mkdirSync(path.join(hub, "propagation"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    // The relocated layout is conditional on the FILE existing, not the directory —
    // `crossLedgerRelocated` stats the file. The first version of this test created
    // only the directory and then asserted the relocated path, so it failed for a
    // reason that was about the fixture rather than the defect. Both branches are
    // asserted below; what must hold in EITHER is "under the hub, never under the
    // nested search root".
    writeFileSync(path.join(hub, "propagation", "PROPAGATION_CROSS_LEDGER.jsonl"), "", "utf8");
    // searchRoots deliberately lists the NESTED root first — the real config.yml on
    // the machine where this bug lived does exactly that, for discovery reasons.
    writeFileSync(
      path.join(dir, "config.yml"),
      `hubRoot: ${hub}\nsearchRoots:\n  - ${nested}\n  - ${hub}\n`,
      "utf8",
    );
    const script =
      'import("' + pathToFileURL(path.join(SKILL_DIR, "lib", "core", "config.mjs")).href + '")' +
      '.then(c=>console.log(JSON.stringify({hub:c.HUB_ROOT,roots:c.SEARCH_ROOTS,x:c.CROSS_LEDGER_JSONL})))';
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: dir },
    });
    assert.equal(r.status, 0, `config failed to load:\n${r.stderr}`);
    const got = JSON.parse(r.stdout.trim());
    assert.equal(got.hub, hub, "the fixture's hubRoot must be the one config read");
    assert.equal(got.roots[0], nested, "and searchRoots[0] must be the NESTED root, or this proves nothing");
    assert.ok(
      got.x.startsWith(path.join(hub, "propagation")),
      `cross-ledger resolved outside the hub's propagation/: ${got.x}`,
    );
    assert.ok(
      !got.x.startsWith(nested),
      `cross-ledger resolved inside SEARCH_ROOTS[0] — the N101 defect is back: ${got.x}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the LEGACY (un-relocated) layout also stays under the hub", async () => {
  // With no `propagation/PROPAGATION_CROSS_LEDGER.jsonl` on disk, config falls back
  // to the hub-root filename. That fallback had the same SEARCH_ROOTS[0] bug, so it
  // needs its own case — fixing only the relocated branch would leave every install
  // that never migrated pointing into a nested root.
  const dir = mkdtempSync(path.join(tmpdir(), "xledger-legacy-"));
  try {
    const hub = path.join(dir, "tree");
    const nested = path.join(hub, "Rupali", "Experiments");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yml"),
      `hubRoot: ${hub}\nsearchRoots:\n  - ${nested}\n  - ${hub}\n`,
      "utf8",
    );
    const script =
      'import("' + pathToFileURL(path.join(SKILL_DIR, "lib", "core", "config.mjs")).href + '")' +
      '.then(c=>console.log(JSON.stringify({x:c.CROSS_LEDGER_JSONL})))';
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: dir },
    });
    assert.equal(r.status, 0, `config failed to load:\n${r.stderr}`);
    const got = JSON.parse(r.stdout.trim());
    assert.equal(got.x, path.join(hub, "PROPAGATION_CROSS_LEDGER.jsonl"));
    assert.ok(!got.x.startsWith(nested), `legacy path resolved inside a nested root: ${got.x}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
