/**
 * waiting.test.mjs — `propagate waiting` (#411). Hermetic: every gh is a fake (a function, or a script on
 * PROPAGATE_GH_BIN), every state directory a temp dir, and the fixtures are literal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectWaiting, groupStacks, readGate, renderWaiting, writeGatePass } from "../../lib/report/waiting.mjs";
import { BLOCK_LABEL } from "../../lib/report/day.mjs";
import { waitingCmd } from "../../cli/waiting.mjs";

const REPO = "acme/widgets";
const sha = (c) => c.repeat(40);
const OLD = sha("1");
const tmp = () => mkdtempSync(path.join(tmpdir(), "waiting-"));

const pr = (number, head, base, over = {}) => ({ number, title: `pr ${number}`, url: `https://example.test/${REPO}/pull/${number}`, baseRefName: base, headRefName: head, headRefOid: sha((number % 16).toString(16)), mergeable: "MERGEABLE", isDraft: false, labels: [], ...over });

/** A gh fake answering `repo view`, `pr list` and `issue list` from literal data; `fail` makes one repo's pr list exit 1. */
function fakeGh({ prs = [], issues = [], fail = null } = {}) {
  return (args) => {
    const repo = args[args.indexOf("-R") + 1];
    if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
    if (args[0] === "pr") return fail === repo ? { status: 1, stdout: "", stderr: "HTTP 502 from github" } : { status: 0, stdout: JSON.stringify(prs), stderr: "" };
    if (args[0] === "issue") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
}
const collect = (gh, dir, extra = {}) => collectWaiting({ gh, repos: [REPO], reviewsRoot: null, stateDirPath: dir, ...extra });
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n--\n");
};

test("a stacked pair gives ONE batch row, bottom first, and never recommends a squash into a non-main base", () => {
  const bottom = pr(405, "feat/a", "main");
  const top = pr(406, "feat/b", "feat/a");
  const dir = tmp();
  writeGatePass(dir, bottom.headRefOid, "unit 100/100");
  const r = collect(fakeGh({ prs: [top, bottom] }), dir);
  assert.deepEqual(r.errors, []);
  const stacks = r.rows.filter((x) => x.kind === "pr-stack");
  assert.equal(stacks.length, 1);
  assert.equal(r.rows.length, 1, "the two PRs are one row, not two");
  assert.deepEqual(stacks[0].prs, [405, 406], "bottom first");
  const rec = stacks[0].recommendation;
  assert.ok(rec.indexOf(`${REPO}#405`) < rec.indexOf(`${REPO}#406`));
  assert.match(rec, /retarget .*#406 to main/);
  assert.match(rec, /re-run the gate/);
  assert.match(rec, /Never squash into a base other than main/);
  assert.equal(stacks[0].answer, "merge");
});

test("groupStacks orders a three-deep chain bottom to top whatever the input order", () => {
  const a = pr(1, "a", "main");
  const b = pr(2, "b", "a");
  const c = pr(3, "c", "b");
  assert.deepEqual(groupStacks([c, a, b]).map((g) => g.map((p) => p.number)), [[1, 2, 3]]);
});

test("a PR with no gate pass says needs gate; a pass on its exact head says merge; a pass on an older sha says needs gate", () => {
  const p = pr(7, "feat/x", "main");
  const dir = tmp();
  const none = collect(fakeGh({ prs: [p] }), dir).rows[0];
  assert.equal(none.answer, "lane");
  assert.match(none.recommendation, /^needs gate/);
  assert.doesNotMatch(none.recommendation, /squash-merge/);

  writeGatePass(dir, OLD, "unit 90/90"); // a pass on some OTHER sha
  assert.match(collect(fakeGh({ prs: [p] }), dir).rows[0].recommendation, /^needs gate/);

  writeGatePass(dir, p.headRefOid, "unit 100/100");
  const ok = collect(fakeGh({ prs: [p] }), dir).rows[0];
  assert.equal(ok.answer, "merge");
  assert.match(ok.recommendation, /gate passed on head .*unit 100\/100.*squash-merge/);
});

test("a pass recorded against the head's old sha stops counting when the head moves", () => {
  const dir = tmp();
  const before = pr(8, "feat/y", "main");
  writeGatePass(dir, before.headRefOid, "unit 1/1");
  const moved = { ...before, headRefOid: sha("f") };
  assert.match(collect(fakeGh({ prs: [moved] }), dir).rows[0].recommendation, /^needs gate/);
});

test("a draft PR, and a PR on a non-main base nobody heads, are not recommended for merge", () => {
  const dir = tmp();
  const rows = collect(fakeGh({ prs: [pr(9, "d", "main", { isDraft: true }), pr(10, "z", "release/x")] }), dir).rows;
  assert.equal(rows.length, 1, "the draft is not waiting on anyone");
  assert.equal(rows[0].answer, "lane");
  assert.match(rows[0].recommendation, /not main.*retarget/);
});

test("a needs:x issue and a needs-x issue appear; the label suffix is not printed", () => {
  const dir = tmp();
  const issues = [
    { number: 1, title: "pick a licence", url: "u1", labels: [{ name: "needs:someone" }] },
    { number: 2, title: "pick a colour", url: "u2", labels: [{ name: "needs-someone" }] },
    { number: 3, title: "unrelated", url: "u3", labels: [{ name: "bug" }, { name: "needs" }] },
  ];
  const r = collect(fakeGh({ issues }), dir);
  assert.deepEqual(r.rows.map((x) => x.what), [`${REPO}#1 pick a licence`, `${REPO}#2 pick a colour`]);
  assert.ok(!/someone/.test(JSON.stringify(r) + renderWaiting(r).join("\n")), "no label suffix, which can name a person");
  for (const row of r.rows) assert.ok(["merge", "approve", "defer", "lane", "rater"].includes(row.answer));
});

test("the day.mjs blocker regex matches needs:x and needs-x", () => {
  assert.ok(BLOCK_LABEL.test("needs:x"));
  assert.ok(BLOCK_LABEL.test("needs-x"));
  assert.ok(!BLOCK_LABEL.test("feature"));
});

function reviewFixture(root, { adjudicated = false } = {}) {
  const dir = path.join(root, "2026-11-20-demo");
  mkdirSync(path.join(dir, "lanes"), { recursive: true });
  const screened = [];
  const screening = {};
  for (let i = 0; i < 25; i++) {
    screened.push({ url: `https://s.test/e${i}`, decision: "excluded", reason: "off topic" });
    screening[`https://s.test/e${i}`] = "exclude";
  }
  for (let i = 0; i < 4; i++) {
    screened.push({ url: `https://s.test/i${i}`, decision: "included", reason: "on topic" });
    screening[`https://s.test/i${i}`] = "include";
  }
  screening["https://s.test/e0"] = "include"; // the one disagreement: a possible missed include
  writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ protocol_sha: "p", screened, sources: [], claims: [], proposals: [] }));
  writeFileSync(path.join(dir, "agreement.json"), JSON.stringify({ schema_version: 1, protocol_sha: "p", rater: "model", rater_kind: "model-referenced", screening, support: {} }));
  writeFileSync(path.join(dir, "rater.json"), JSON.stringify({ items: { "https://s.test/e0": { reason: "meets criterion 2", why: "criterion 2" } } }));
  if (adjudicated) writeFileSync(path.join(dir, "adjudication.json"), JSON.stringify({ schema_version: 1, answers: {} }));
  return dir;
}

test("a review with pending adjudication appears, with its lines; one that has adjudication.json does not", () => {
  const dir = tmp();
  const root = tmp();
  reviewFixture(root);
  const r = collect(fakeGh(), dir, { reviewsRoot: root });
  assert.deepEqual(r.errors, []);
  const row = r.rows.find((x) => x.kind === "review");
  assert.ok(row, "the pending review is listed");
  assert.equal(row.lines.length, 1);
  assert.equal(row.answer, "rater");
  assert.match(row.what, /2026-11-20-demo: 1 disagreement/);
  const root2 = tmp();
  reviewFixture(root2, { adjudicated: true });
  assert.equal(collect(fakeGh(), dir, { reviewsRoot: root2 }).rows.filter((x) => x.kind === "review").length, 0);
});

test("a gh error exits 2 with the repo named, and prints no 'nothing waiting'", async () => {
  const out = [];
  const err = [];
  const code = await waitingCmd([], { gh: fakeGh({ fail: REPO }), repos: [REPO], reviewsRoot: null, stateDirPath: tmp(), out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.ok(err.join("\n").includes(REPO), "the failing repo is named");
  assert.ok(!out.join("\n").includes("nothing waiting"));
  assert.match(out.join("\n"), /COULD NOT READ/);
});

test("gh failing as a script on PROPAGATE_GH_BIN exits 2 (the real spawn path)", async () => {
  const bin = path.join(tmp(), "gh");
  writeFileSync(bin, "#!/bin/sh\necho 'gh: not logged in' >&2\nexit 4\n");
  chmodSync(bin, 0o755);
  const was = process.env.PROPAGATE_GH_BIN;
  process.env.PROPAGATE_GH_BIN = bin;
  try {
    const err = [];
    assert.equal(await waitingCmd(["--json"], { repos: [REPO], reviewsRoot: null, stateDirPath: tmp(), out: () => {}, err: (s) => err.push(s) }), 2);
    assert.match(err.join("\n"), new RegExp(`${REPO}.*not logged in`));
  } finally {
    if (was === undefined) delete process.env.PROPAGATE_GH_BIN;
    else process.env.PROPAGATE_GH_BIN = was;
  }
});

test("zero rows with every source read exits 0 and names the sources checked", async () => {
  const out = [];
  const code = await waitingCmd([], { gh: fakeGh(), repos: [REPO], reviewsRoot: null, stateDirPath: tmp(), out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /^nothing waiting \(sources checked: acme\/widgets PRs, acme\/widgets issues\)$/);
});

test("no repo derivable is an error, never an empty list", async () => {
  const err = [];
  assert.equal(await waitingCmd([], { gh: fakeGh(), repos: [], reviewsRoot: null, stateDirPath: tmp(), out: () => {}, err: (s) => err.push(s) }), 2);
  assert.match(err.join("\n"), /no repo could be derived/);
});

test("--json rows carry kind, what, url, recommendation and answer", async () => {
  const out = [];
  await waitingCmd(["--json"], { gh: fakeGh({ prs: [pr(7, "feat/x", "main")] }), repos: [REPO], reviewsRoot: null, stateDirPath: tmp(), out: (s) => out.push(s), err: () => {} });
  const j = JSON.parse(out.join("\n"));
  assert.equal(j.count, 1);
  for (const k of ["kind", "what", "url", "recommendation", "answer"]) assert.ok(j.rows[0][k], k);
});

test("gate-pass WITHOUT --apply writes nothing (snapshot of the state dir), across every sha shape", async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "keep.txt"), "x");
  const before = snapshot(dir);
  for (const argv of [["gate-pass", sha("a"), "--suite", "unit 1/1", "--no-run-evidence", "why"], ["gate-pass", sha("a"), "--suite", "unit 1/1", "--no-run-evidence", "why", "--json"], ["gate-pass", "abc", "--suite", "s"], ["gate-pass", sha("a")]]) {
    await waitingCmd(argv, { stateDirPath: dir, out: () => {}, err: () => {} });
    assert.equal(snapshot(dir), before, `${argv.join(" ")} must not touch the state dir`);
  }
});

test("gate-pass --apply writes gates/<sha>.json {schema_version, sha, suite, passed_at}; a prefix is refused", async () => {
  const dir = tmp();
  assert.equal(await waitingCmd(["gate-pass", "abc1234", "--suite", "s", "--no-run-evidence", "why", "--apply"], { stateDirPath: dir, out: () => {}, err: () => {} }), 2);
  assert.throws(() => readdirSync(path.join(dir, "gates")));
  assert.equal(await waitingCmd(["gate-pass", sha("a"), "--suite", "unit 5/5", "--no-run-evidence", "docs-only change", "--apply"], { stateDirPath: dir, now: Date.UTC(2026, 10, 27), out: () => {}, err: () => {} }), 0);
  const g = readGate(dir, sha("a"));
  assert.deepEqual(g.gate, { schema_version: 1, sha: sha("a"), suite: "unit 5/5", passed_at: "2026-11-27T00:00:00.000Z", no_run_evidence: "docs-only change" });
});

test("day open prints the same rows with a count, and a failed source as a line, never as nothing waiting", async () => {
  const { dayCmd } = await import("../../cli/day.mjs");
  const run = async (waiting) => {
    const lines = [];
    await dayCmd(["open"], { goalFiles: [], out: (s) => lines.push(s), err: () => {}, now: Date.UTC(2026, 10, 27), samplesRaw: "", widget: null, widgetDir: tmp(), laneRows: [], sessions: () => ({ ok: true, view: { sessions: [] } }), fetcher: { graphql: async () => ({ ok: false, error: "offline" }) }, broadcastOwner: null, stateDirPath: tmp(), waiting });
    return lines.join("\n");
  };
  const text = await run({ rows: [{ kind: "pr", what: "acme/widgets#7 pr 7", url: "u", recommendation: "needs gate", answer: "lane" }], errors: [], sources: ["x"] });
  assert.match(text, /waiting on the maintainer: 1\n\s+1\. \[pr\] acme\/widgets#7 pr 7/);
  const bad = await run({ rows: [], errors: ["acme/widgets open PRs: HTTP 502"], sources: [] });
  assert.match(bad, /waiting on the maintainer: 0 \(incomplete, a source failed\)/);
  assert.match(bad, /COULD NOT READ: acme\/widgets open PRs/);
});
