/**
 * Reference integrity (propagate#242). Every fixture is a literal written to a private temp dir:
 * no shared builder, so a violating input is expressible here (rule:mutate-behind-the-fixture-builder).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  checkReferences, realIO, stripComments, extractNames, splitDoc,
  IDENTIFIER_CLASSES, PATH_CLASS, SOURCE_EXTS, EXCLUDE_DIRS,
} from "../lib/reference-integrity.mjs";
import { verdict } from "../lib/report.mjs";
import { privateRoot } from "./_tmp.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

/** Write `files` (rel path -> text) under a fresh private root; return the root. */
function repoWith(files) {
  const root = privateRoot("refint-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const check = (root, docText) => checkReferences({ docText, docDir: root, repoRoot: root, io: realIO(root) });

const CODE = "export class GateOnlineGuard {}\nexport const tokenBrass = 1;\n";

test("ok: every identifier and path the doc asserts resolves", () => {
  const root = repoWith({ "src/gate.ts": CODE, "docs/x.md": "x" });
  const r = check(root, "# D\nUse `GateOnlineGuard` and `tokenBrass` in `src/gate.ts`.\n");
  assert.deepEqual(r.asserted.sort(), ["GateOnlineGuard", "src/gate.ts", "tokenBrass"]);
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.blind, false);
});

test("a missing identifier is unresolved", () => {
  const root = repoWith({ "src/gate.ts": CODE });
  const r = check(root, "Uses `GateOnlineGuard` and `PhantomWidgetThing`.\n");
  assert.deepEqual(r.unresolved, ["PhantomWidgetThing"]);
});

test("a missing path is unresolved, and a bare basename that is tracked resolves", () => {
  const root = repoWith({ "src/gate.ts": CODE, "lib/theme/tokens.dart": "// x\n" });
  const r = check(root, "See `src/missing.ts`, `lib/nope/other.dart` and `tokens.dart`.\n");
  assert.deepEqual(r.unresolved.sort(), ["lib/nope/other.dart", "src/missing.ts"]);
});

test("a name used only in comments is unresolved (the GateOnlineGuard case)", () => {
  const root = repoWith({
    "src/a.ts": "// GateOnlineGuard will wrap this\n/* and GateOnlineGuard again */\nconst x = 1;\n",
    "lib/b.dart": "/// GateOnlineGuard documented here\nvoid main() {}\n",
  });
  const r = check(root, "The `GateOnlineGuard` blocks offline entry.\n");
  assert.deepEqual(r.unresolved, ["GateOnlineGuard"], "a comment is not the build receiving the name");
});

test("a string literal containing // is not eaten as a comment", () => {
  assert.match(stripComments('const u = "http://x"; const GateOnlineGuard = 1; // gone'), /GateOnlineGuard/);
  assert.doesNotMatch(stripComments("a(); // GateOnlineGuard"), /GateOnlineGuard/);
});

test("designed-not-built exempts an unresolved name; an exempt name that resolves is a stale exemption", () => {
  const root = repoWith({ "src/gate.ts": CODE });
  const doc =
    "---\ndesigned-not-built:\n  - PhantomWidgetThing\n  - GateOnlineGuard\n---\n" +
    "Uses `PhantomWidgetThing` and `GateOnlineGuard`.\n";
  const r = check(root, doc);
  assert.deepEqual(r.unresolved, [], "the exemption removes the unresolved name");
  assert.deepEqual(r.staleExemptions, ["GateOnlineGuard"], "the exempt name now exists, so the exemption is stale");
  const inline = splitDoc("---\ndesigned-not-built: [A, B]\n---\nbody").exempt;
  assert.deepEqual(inline, ["A", "B"]);
});

test("prose, single words and hex colours extract nothing: blind, never ok", () => {
  const root = repoWith({ "src/gate.ts": CODE });
  const doc = "Plain prose about `brass`, `Button`, `#C9A227`, `e.g.` and `2px solid` with `snake_case_name`.\n";
  const r = check(root, doc);
  assert.deepEqual(r.asserted, []);
  assert.equal(r.blind, true);
  const v = verdict({ kind: "design", inDegree: 1, hubDistance: 1, integrity: r, lastTouched: { date: new Date().toISOString() } }, 30);
  assert.equal(v.flag, "NO-NAMES");
  assert.notEqual(v.flag, "ok");
  assert.equal(verdict({ kind: "design", inDegree: 1, hubDistance: 1 }, 30).flag, "NO-NAMES", "no integrity result at all is blind, not ok");
});

test("only backticked body spans count; frontmatter and plain text do not", () => {
  const n = extractNames(splitDoc("---\ntitle: `FrontmatterThing`\n---\nPlain GateOnlineGuard here, `RealThing` there.\n").body);
  assert.deepEqual(n.identifiers, ["RealThing"]);
  assert.deepEqual(n.paths, []);
});

test("verdict rows: STALE names at most 5 names, ok counts names, stale exemptions are STALE", () => {
  const base = { kind: "design", inDegree: 1, hubDistance: 1, lastTouched: { date: new Date().toISOString() } };
  const many = ["AaBb1", "AaBb2", "AaBb3", "AaBb4", "AaBb5", "AaBb6", "AaBb7"];
  const stale = verdict({ ...base, integrity: { asserted: [...many, "OkName"], unresolved: many, staleExemptions: [], blind: false } }, 30);
  assert.equal(stale.flag, "STALE");
  assert.match(stale.why, /^7 of 8 asserted names do not resolve: /);
  assert.equal((stale.why.match(/`AaBb\d`/g) ?? []).length, 5);
  const ok = verdict({ ...base, integrity: { asserted: ["AaBb1", "AaBb2"], unresolved: [], staleExemptions: [], blind: false } }, 30);
  assert.deepEqual(ok, { flag: "ok", why: "2 names resolve" });
  const exempt = verdict({ ...base, integrity: { asserted: ["AaBb1"], unresolved: [], staleExemptions: ["AaBb1"], blind: false } }, 30);
  assert.equal(exempt.flag, "STALE");
  assert.match(exempt.why, /exemption/);
});

test("a path in the WORKSPACE above the repo resolves (docs live above the repo)", () => {
  const ws = repoWith({
    ".propagates.yml": "workspace: true\nsources: {}\n",
    "docs/astro/ASSETS.md": "# assets\n",
    "app/.git/HEAD": "ref: refs/heads/main\n",
    "app/src/gate.ts": CODE,
  });
  const repo = path.join(ws, "app");
  const doc = "See `docs/astro/ASSETS.md` and `docs/astro/MISSING.md`.\n";
  const r = checkReferences({ docText: doc, docDir: repo, repoRoot: repo, io: realIO(repo) });
  assert.deepEqual(r.unresolved, ["docs/astro/MISSING.md"], "the workspace file resolves, the absent one does not");
});

test("a path that exists only ABOVE the hub does not resolve", () => {
  // outer/shared/ONLYABOVE.md exists; outer/hub is a git checkout (the hub); outer/hub/proj is a repo.
  // The walk stops at the hub, so a file above it must not count.
  const outer = repoWith({
    "shared/ONLYABOVE.md": "# above\n",
    "hub/.git/HEAD": "ref: refs/heads/main\n",
    "hub/shared/INHUB.md": "# in hub\n",
    "hub/proj/.git/HEAD": "ref: refs/heads/main\n",
    "hub/proj/src/gate.ts": CODE,
  });
  const proj = path.join(outer, "hub", "proj");
  const r = checkReferences({
    docText: "Names `shared/ONLYABOVE.md` and `shared/INHUB.md`.\n",
    docDir: proj, repoRoot: proj, io: realIO(proj),
  });
  assert.deepEqual(r.unresolved, ["shared/ONLYABOVE.md"], "the hub itself is searched, nothing above it");
});

test("age is only the fallback: an integrity-ok doc 400 days old is ok; a blind old doc says why", () => {
  const old = { date: new Date(Date.now() - 400 * 86400000).toISOString() };
  const base = { kind: "design", inDegree: 1, hubDistance: 1, lastTouched: old };
  const okRes = verdict({ ...base, integrity: { asserted: ["AaBb1"], unresolved: [], staleExemptions: [], blind: false } }, 30);
  assert.equal(okRes.flag, "ok", "400d old, every name resolves: integrity alone decides");
  const blind = verdict({ ...base, integrity: { asserted: [], unresolved: [], staleExemptions: [], blind: true } }, 30);
  assert.equal(blind.flag, "STALE");
  assert.match(blind.why, /^no assertable names; 400d since last change$/);
  const youngBlind = verdict({ ...base, lastTouched: { date: new Date().toISOString() }, integrity: { asserted: [], unresolved: [], staleExemptions: [], blind: true } }, 30);
  assert.equal(youngBlind.flag, "NO-NAMES");
});

test("the extractor classes and the search scope are the ones the plan names", () => {
  assert.equal(IDENTIFIER_CLASSES.length, 2);
  assert.ok(PATH_CLASS.test("lib/a-b/c_d.dart") && !PATH_CLASS.test("a.exe"));
  assert.ok(SOURCE_EXTS.includes("dart") && !SOURCE_EXTS.includes("md"));
  for (const d of ["node_modules", "build", ".dart_tool", ".next", ".git", ".claude", ".worktrees"]) assert.ok(EXCLUDE_DIRS.includes(d), d);
});

test("an excluded directory does not resolve a name", () => {
  const root = repoWith({ "node_modules/pkg/i.js": CODE, "build/o.js": CODE });
  assert.deepEqual(check(root, "Uses `GateOnlineGuard`.\n").unresolved, ["GateOnlineGuard"]);
});

test("end to end: the CLI report carries a design doc's integrity verdict", () => {
  const root = repoWith({
    "README.md": "[design](DESIGN.md)\n",
    "DESIGN.md": "# Design\nUses `GateOnlineGuard` and `PhantomWidgetThing`.\n",
    "src/gate.ts": CODE,
  });
  const out = execFileSync("node", [CLI, "report", root], { encoding: "utf8" });
  assert.match(out, /\| `DESIGN\.md` .*\*\*STALE\*\* — 1 of 2 asserted names do not resolve: `PhantomWidgetThing`/);
});
