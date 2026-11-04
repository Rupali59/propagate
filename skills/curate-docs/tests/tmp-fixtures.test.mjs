/**
 * Every temp directory these tests make is either a private SCANNED root or marked as not scanned (#115).
 *
 * The resolver tries the tree's parent (`externalBases`), so a fixture root created directly in the shared $TMPDIR
 * answers a citation from whatever another process left there. The guard is derived, not curated: it reads every
 * `*.test.mjs` here and finds each call that creates a temp directory under the OS tmp dir, so a NEW exposed fixture fails this test
 * rather than slipping in (rule:derive-dont-curate). A call is fine when its line, or the line above it, carries
 * `// not scanned: <reason>`; a scanned root uses `privateRoot()` from _tmp.mjs and has no such call at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLinkGraph } from "../lib/link-graph.mjs";
import { discover } from "../lib/discovery.mjs";
import { loadConfig } from "../lib/config.mjs";
import { privateRoot } from "./_tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALL = new RegExp("mkdtempSync\\(.*tmpdir"); // built from a string so this file does not match itself
const MARK = /\/\/\s*not scanned:\s*\S/;

function callSites() {
  const sites = [];
  for (const f of readdirSync(HERE).filter((n) => n.endsWith(".test.mjs")).sort()) {
    const lines = readFileSync(path.join(HERE, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CALL.test(line)) sites.push({ where: `${f}:${i + 1}`, marked: MARK.test(line) || MARK.test(lines[i - 1] ?? "") });
    });
  }
  return sites;
}

test("every temp-dir call site is marked `not scanned: <reason>` (a scanned root uses privateRoot instead)", () => {
  const sites = callSites();
  assert.ok(sites.length > 0, `only ${sites.length} temp-dir call sites found in ${HERE} — the scan has gone blind, it has not found nothing`);
  const bare = sites.filter((s) => !s.marked).map((s) => s.where);
  assert.deepEqual(bare, [], "these create a directory straight under the shared tmp dir without saying why that is safe — use privateRoot(), or add `// not scanned: <reason>`");
});

test("the guard can fail: an unmarked call is reported, a marked one is not", () => {
  const call = 'const d = mkdtemp' + 'Sync(path.join(tmpdir(), "x-"));'; // assembled so this file's own text is not a call site
  const mk = (src) => src.split("\n").map((line, i, all) => CALL.test(line) && !(MARK.test(line) || MARK.test(all[i - 1] ?? "")));
  assert.deepEqual(mk(call).filter(Boolean), [true]);
  assert.deepEqual(mk(call + " // not scanned: fake home").filter(Boolean), []);
  assert.deepEqual(mk("// not scanned: fake home\n" + call).filter(Boolean), []);
});

test("privateRoot: the parent holds nothing but the root, so a stray file in the shared tmp dir cannot answer a citation", () => {
  const stray = path.join(tmpdir(), `cd-stray-${process.pid}-${Date.now()}.md`);
  writeFileSync(stray, "# stray\n");
  const name = path.basename(stray);
  const analyse = (d) => {
    writeFileSync(path.join(d, "STATE.md"), `# hub\n- [x](${name})\n`);
    const cfg = loadConfig(d, { home: privateRoot("cd-home-") }); // not scanned: a fake HOME
    return buildLinkGraph(d, { docs: discover(d, cfg).docs, cfg });
  };
  let shared;
  try {
    // Negative control: the same fixture directly in the shared tmp dir IS answered by the stray file.
    shared = mkdtempSync(path.join(tmpdir(), "cd-shared-")); // not scanned: this IS the poisoned case, proving the test can fail
    assert.equal(analyse(shared).external.length, 1, "control: a root directly under the shared tmp dir resolves the stray file as external");
    const d = privateRoot("cd-priv-");
    assert.deepEqual(readdirSync(path.dirname(d)), ["root"], "the parent holds only the root");
    const g = analyse(d);
    assert.equal(g.external.length, 0, "a private root is not answered by the shared tmp dir");
    assert.equal(g.dangling.length, 1);
  } finally {
    rmSync(stray, { force: true });
    if (shared) rmSync(shared, { recursive: true, force: true });
  }
});
