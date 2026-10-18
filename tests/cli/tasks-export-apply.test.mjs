/**
 * tasks-export-apply.test.mjs — `propagate tasks export --apply` (R2) end to end.
 *
 * rule:safety-flag-needs-a-test. The unsafe paths and what pins them (each measured on the SIDE
 * EFFECT — register bytes, journal lines, the fake gh's call log — never on the command's own words):
 *   - a register is rewritten ONLY when every open item has an issue (partial failure, budget, held);
 *   - the issue is journaled BEFORE the register is touched;
 *   - the write budget is never exceeded, and a rerun continues;
 *   - a heading quoted inside a fence is not an entry and survives byte-identical;
 *   - a handover file is edited only by inserted `**Moved:**` lines, on open sections that have an issue;
 *   - a rerun creates nothing.
 * Dry run staying INERT is pinned in tasks-export.test.mjs (unchanged).
 *
 * The fake gh is an injection seam (PROPAGATE_GH_BIN). It logs every argv as a JSON line and keeps
 * a small state file, so `issue list` after a create reflects the create — a fake that answered
 * from canned JSON would let a "rerun creates 0" test pass whether or not matching works.
 * The real gh is untested by construction (rule:name-what-no-test-executes): the real-tree run is
 * recorded in the lane report, against a dry run only.
 */
// @size medium — starts the CLI, git and a fake gh per scenario; run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

const FAKE_GH = (root) => `#!/usr/bin/env node
const fs = require("fs");
const R = ${JSON.stringify(root)};
const argv = process.argv.slice(2);
fs.appendFileSync(R + "/gh.log", JSON.stringify(argv) + "\\n");
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(R + "/" + f, "utf8")); } catch { return d; } };
const ctl = rd("control.json", {});
const st = rd("gh-state.json", { issues: {}, labels: {}, items: [], createCalls: 0 });
const save = () => fs.writeFileSync(R + "/gh-state.json", JSON.stringify(st));
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const [a, b] = argv;
if (a === "repo" && b === "view") {
  const repo = argv[2];
  const c = (ctl.repos || {})[repo] || {};
  process.stdout.write(JSON.stringify({ visibility: c.visibility || "PRIVATE", hasIssuesEnabled: c.hasIssuesEnabled !== false, owner: { login: c.owner || repo.split("/")[0] } }));
} else if (a === "issue" && b === "list") {
  process.stdout.write(JSON.stringify(st.issues[flag("-R")] || []));
} else if (a === "label" && b === "list") {
  process.stdout.write(JSON.stringify((st.labels[flag("-R")] || []).map((name) => ({ name }))));
} else if (a === "api" && b === "graphql") {
  const m = /owner:"([^"]+)",name:"([^"]+)"/.exec(argv.join(" "));
  const proj = (ctl.projects || {})[m[1] + "/" + m[2]];
  process.stdout.write(JSON.stringify({ data: { repository: { projectsV2: { nodes: proj ? [{ number: proj.number, owner: { login: proj.owner } }] : [] } } } }));
} else if (a === "label" && b === "create") {
  const repo = flag("-R");
  (st.labels[repo] = st.labels[repo] || []).push(argv[2]);
  save();
} else if (a === "issue" && b === "create") {
  st.createCalls++;
  if (ctl.appendOnCreate) fs.appendFileSync(ctl.appendOnCreate, "\\nconcurrent edit\\n");
  if (ctl.failIssueCreateAtCall === st.createCalls) { save(); process.stderr.write("simulated create failure\\n"); process.exit(1); }
  const repo = flag("-R");
  const list = (st.issues[repo] = st.issues[repo] || []);
  const number = list.length + 1;
  const url = "https://github.com/" + repo + "/issues/" + number;
  list.push({ number, url, body: fs.readFileSync(flag("--body-file"), "utf8"), title: flag("--title"), labels: flag("--label") });
  save();
  process.stdout.write(url + "\\n");
} else if (a === "project" && b === "item-add") {
  if (ctl.failItemAdd) { process.stderr.write("simulated item-add failure\\n"); process.exit(1); }
  st.items.push({ project: argv[2], owner: flag("--owner"), url: flag("--url") });
  save();
} else {
  process.stderr.write("unexpected gh call: " + argv.join(" ") + "\\n");
  process.exit(9);
}
`;

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

/**
 * A fresh hub per scenario. `registers` maps hub-relative paths to text; `control` configures the fake.
 * The hub's origin is hubowner/hub and is linked to project board #7 unless `control.projects` says otherwise.
 */
function scenario({ registers, control = {}, config = null, nested = null }) {
  const root = mkdtempSync(path.join(tmpdir(), "tasks-apply-"));
  const hub = path.join(root, "hub");
  const state = path.join(root, "state");
  mkdirSync(hub, { recursive: true });
  mkdirSync(state, { recursive: true });
  git(hub, "init", "-q");
  git(hub, "remote", "add", "origin", "https://github.com/hubowner/hub.git");
  git(hub, "commit", "-q", "--allow-empty", "-m", "init");
  for (const [rel, text] of Object.entries(registers)) {
    const p = path.join(hub, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  if (nested) {
    // a second git repo under the hub, with its own origin
    const dir = path.join(hub, nested.dir);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", nested.origin);
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    for (const [rel, text] of Object.entries(nested.registers)) {
      const p = path.join(dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  writeFileSync(path.join(root, "control.json"), JSON.stringify({ projects: { "hubowner/hub": { number: 7, owner: "hubowner" } }, ...control }));
  if (config) writeFileSync(path.join(state, "config.yml"), config);
  const gh = path.join(root, "gh");
  writeFileSync(gh, FAKE_GH(root));
  chmodSync(gh, 0o755);

  const run = (argv, extraEnv = {}) =>
    spawnSync(process.execPath, [CLI, "tasks", ...argv], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_HUB_ROOT: hub, PROPAGATE_SEARCH_ROOTS: hub, PROPAGATE_STATE_DIR: state, PROPAGATE_GH_BIN: gh, PROPAGATE_TASKS_THROTTLE_MS: "0", NO_COLOR: "1", ...extraEnv },
    });
  const calls = () => (existsSync(path.join(root, "gh.log")) ? readFileSync(path.join(root, "gh.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const writes = () => calls().filter((c) => (c[0] === "issue" && c[1] === "create") || (c[0] === "label" && c[1] === "create") || (c[0] === "project" && c[1] === "item-add"));
  const ghState = () => JSON.parse(readFileSync(path.join(root, "gh-state.json"), "utf8"));
  const setControl = (patch) => writeFileSync(path.join(root, "control.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "control.json"), "utf8")), ...patch }));
  const journal = () => {
    const p = path.join(state, "tasks-export.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const read = (rel) => readFileSync(path.join(hub, rel), "utf8");
  return { root, hub, state, run, calls, writes, ghState, setControl, journal, read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TWO_ITEMS = ["# TODOS", "", "## Open", "", "### PR-001 · First thing P1", "", "body one", "", "### PR-002 · Second thing", "", "body two", "", "## Finished", "", "### PR-000 · Old — DONE", "", "old", ""].join("\n");
const REG = "propagation/state/alpha/TODOS.md";

function parsed(file) {
  // the project's own reader, run in a child so the test sees what `backlog` would see
  const r = spawnSync(process.execPath, ["-e", `import("${new URL("../../lib/report/backlog.mjs", import.meta.url).href}").then((m)=>{const fs=require("fs");const p=m.parseTodoLikeFile(fs.readFileSync(process.argv[1],"utf8"),process.argv[1]);console.log(JSON.stringify({format:p.format,delegatedTo:p.delegatedTo,open:p.open}))})`, file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("CONTROL: --apply on a 2-item register creates 2 issues, adds 2 project items, journals 2 lines, delegates the register", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS } });
  try {
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = s.writes().map((c) => c.slice(0, 2).join(" "));
    // labels: task, kind:todo, project:alpha, priority:P1 (PR-001 only) -> 4 distinct; then per item issue create + item-add
    assert.deepEqual(w.filter((x) => x === "issue create"), ["issue create", "issue create"]);
    assert.deepEqual(w.filter((x) => x === "project item-add"), ["project item-add", "project item-add"]);
    assert.equal(w.filter((x) => x === "label create").length, 4);
    for (const c of s.writes().filter((c) => c[0] === "project")) assert.deepEqual(c.slice(0, 2).concat(c[2], c[3], c[4]), ["project", "item-add", "7", "--owner", "hubowner"]);
    const jr = s.journal();
    assert.equal(jr.filter((j) => j.board === false).length, 2, "each issue is journaled before its board add");
    assert.equal(jr.filter((j) => j.board === true).length, 2);
    assert.deepEqual([...new Set(jr.map((j) => j.key))].sort(), [`${REG}#PR-001`, `${REG}#PR-002`]);
    const after = s.read(REG);
    const p = parsed(path.join(s.hub, REG));
    assert.equal(p.format, "delegated");
    assert.equal(p.delegatedTo, "https://github.com/hubowner/hub/issues?q=label:project:alpha");
    assert.doesNotMatch(after, /^### PR-00[12]/m, "the open blocks left the file");
    assert.match(after, /^### PR-000 · Old — DONE/m, "finished history is kept");
    assert.match(after, /^### Moved to GitHub \d{4}-\d\d-\d\d$/m);
    for (const [id, n] of [["PR-001", 1], ["PR-002", 2]]) {
      const m = after.split("\n").filter((l) => l.startsWith(`- ${id} · `) && l.includes("**MOVED**"));
      assert.equal(m.length, 1);
      assert.match(m[0], new RegExp(`\\[#${n}\\]\\(https://github.com/hubowner/hub/issues/${n}\\)`));
    }
    const created = s.ghState().issues["hubowner/hub"];
    assert.equal(created.length, 2);
    assert.match(created[0].body, /<!-- propagate-task key=propagation\/state\/alpha\/TODOS.md#PR-001 -->/);
  } finally {
    s.cleanup();
  }
});

test("RERUN: a second --apply creates nothing and writes nothing", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS } });
  try {
    assert.equal(s.run(["export", "--all", "--apply"]).status, 0);
    const writesBefore = s.writes().length;
    const reg = s.read(REG);
    const j = s.journal().length;
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.writes().length, writesBefore, "no gh write on the second run");
    assert.equal(s.read(REG), reg);
    assert.equal(s.journal().length, j);
    assert.match(r.stdout, /already delegated/);
  } finally {
    s.cleanup();
  }
});

test("PARTIAL FAILURE: issue create fails on the 2nd item -> register byte-identical, journal has exactly 1 issue; a fixed rerun creates only the 2nd, then rewrites", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS }, control: { failIssueCreateAtCall: 2 } });
  try {
    const before = s.read(REG);
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 1, "a failed file is exit 1");
    assert.equal(s.read(REG), before, "a half-moved register must stay byte-identical");
    assert.deepEqual(s.journal().filter((j) => j.matched === false && j.board === false).length, 1);
    assert.equal(new Set(s.journal().map((j) => j.key)).size, 1, "exactly one issue journaled");
    assert.match(r.stdout, /1 of 2 moved, register untouched/);

    s.setControl({ failIssueCreateAtCall: 0 });
    const creates = () => s.calls().filter((c) => c[0] === "issue" && c[1] === "create").length;
    const before2 = creates();
    const r2 = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(creates() - before2, 1, "only the missing item is created");
    assert.equal(s.ghState().issues["hubowner/hub"].length, 2);
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
  } finally {
    s.cleanup();
  }
});

test("BUDGET: a budget smaller than needed stops BEFORE exceeding it, leaves the register, and a rerun completes", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS } });
  try {
    const before = s.read(REG);
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply", "--budget", "5"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.writes().length, 5, "exactly the budget, never past it");
    assert.equal(s.read(REG), before, "register untouched while items remain");
    assert.match(r.stdout, /STOPPED at the budget/);
    const r2 = s.run(["export", "--file", path.join(s.hub, REG), "--apply", "--budget", "50"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(s.ghState().issues["hubowner/hub"].length, 2, "no duplicate across the two runs");
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
    // every issue made it onto the board even though the first run stopped between create and item-add
    assert.equal(s.ghState().items.length, 2);
  } finally {
    s.cleanup();
  }
});

test("HELD: a file with any held item creates NOTHING, even for its clean siblings", () => {
  const dup = ["# TODOS", "", "### PR-001 · Fine", "", "ok", "", "### PR-002 · Dup open", "", "x", "", "### PR-002 · Dup done — RESOLVED", "", "y", ""].join("\n");
  const s = scenario({ registers: { [REG]: dup, "propagation/state/beta/TODOS.md": "# TODOS\n\n### PR-050 · Clean elsewhere\n\nbody\n" } });
  try {
    const before = s.read(REG);
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.read(REG), before);
    const issues = s.ghState().issues["hubowner/hub"];
    assert.equal(issues.length, 1, "only the clean file's item");
    assert.match(issues[0].body, /beta\/TODOS.md#PR-050/);
    assert.match(r.stdout, /HELD\s+.*alpha\/TODOS.md/);
    assert.match(r.stdout, /nothing is created for this file/);
  } finally {
    s.cleanup();
  }
});

test("ROUTE: an other-owner repo with a config route lands on the routed repo, project label from the ORIGINAL file", () => {
  const nested = { dir: "astro-studio", origin: "https://github.com/someoneelse/astro-studio.git", registers: { "TODOS.md": "# TODOS\n\n### AS-001 · Routed item\n\nbody\n" } };
  const config = "tasks:\n  routes:\n    someoneelse/astro-studio: hubowner/content\n";
  const s = scenario({ registers: {}, nested, config, control: { projects: { "hubowner/content": { number: 23, owner: "hubowner" } } } });
  try {
    const dry = JSON.parse(s.run(["export", "--all", "--json"]).stdout);
    const f = dry.files.find((x) => x.file.includes("astro-studio"));
    assert.equal(f.target.repo, "hubowner/content");
    assert.equal(f.target.routedFrom, "someoneelse/astro-studio");
    assert.deepEqual(f.held, []);
    assert.ok(f.notes.includes("routed from someoneelse/astro-studio"));
    assert.ok(f.items[0].labels.includes("project:astro-studio"));
    assert.equal(f.items[0].key, "someoneelse/astro-studio:TODOS.md#AS-001");

    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const issues = s.ghState().issues["hubowner/content"];
    assert.equal(issues.length, 1);
    assert.match(issues[0].labels, /project:astro-studio/);
    assert.deepEqual(s.ghState().items.map((i) => i.project), ["23"]);
    assert.equal(s.ghState().issues["someoneelse/astro-studio"], undefined, "nothing is written to the other owner's repo");
    const p = parsed(path.join(s.hub, "astro-studio/TODOS.md"));
    assert.equal(p.delegatedTo, "https://github.com/hubowner/content/issues?q=label:project:astro-studio");
  } finally {
    s.cleanup();
  }
});

test("ROUTE: without a route entry the other-owner hold stays", () => {
  const nested = { dir: "astro-studio", origin: "https://github.com/someoneelse/astro-studio.git", registers: { "TODOS.md": "# TODOS\n\n### AS-001 · Item\n\nbody\n" } };
  const s = scenario({ registers: {}, nested });
  try {
    const dry = JSON.parse(s.run(["export", "--all", "--json"]).stdout);
    const f = dry.files.find((x) => x.file.includes("astro-studio"));
    assert.deepEqual(f.held.map((h) => h.reason), ["other-owner"]);
  } finally {
    s.cleanup();
  }
});

test("a malformed tasks.routes table is refused with exit 2, before planning", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS }, config: "tasks:\n  routes:\n    notarepo: alsonot\n" });
  try {
    const r = s.run(["export", "--all"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /tasks\.routes entry/);
  } finally {
    s.cleanup();
  }
});

test("FENCE: a heading quoted inside a fence is not an entry and survives the rewrite byte-identical", () => {
  const fenceBlock = ["```md", "### X-001 · fake, inside a fence", "```"].join("\n");
  const text = ["# TODOS", "", "How an entry looks:", "", fenceBlock, "", "### PR-001 · Real one", "", "Quotes a heading:", "", "```", "## D16 · quoted, not a boundary", "```", "", "tail of PR-001", "", "### PR-002 · Real two", "", "two", ""].join("\n");
  const s = scenario({ registers: { [REG]: text } });
  try {
    const dry = JSON.parse(s.run(["export", "--all", "--json"]).stdout);
    const f = dry.files.find((x) => x.file.endsWith("alpha/TODOS.md"));
    assert.deepEqual(f.items.map((i) => i.id), ["PR-001", "PR-002"], "the fenced X-001 is not an item");
    assert.equal(f.skipped.fenced, 1);
    assert.match(f.items[0].body, /tail of PR-001/, "a fenced heading inside an entry does not truncate it");

    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = s.read(REG);
    assert.ok(after.includes(fenceBlock), "the fenced illustration is byte-identical");
    assert.equal(s.ghState().issues["hubowner/hub"].length, 2, "no issue for the fenced line");
    assert.doesNotMatch(after, /D16/, "the quoted heading travelled with its entry");
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
  } finally {
    s.cleanup();
  }
});

const HO = "HANDOVERS.md";
const HO_TEXT = [
  "# Handovers", "",
  "## 2026-10-01 · Alpha", "", "**Done when:** a works", "", "body a", "",
  "## 2026-10-02 · Beta", "", "**Done when:** b works", "", "body b", "",
  "## 2026-10-03 · Gamma", "", "prose with no marker", "",
  "## 2026-10-04 · Delta", "", "**Resolved:** 2026-10-05 — done", "",
].join("\n");

function hoParse(file) {
  const r = spawnSync(process.execPath, ["-e", `import("${new URL("../../lib/report/handovers.mjs", import.meta.url).href}").then((m)=>{const p=m.parseHandovers(process.argv[1]);console.log(JSON.stringify(p.sections.map((s)=>({t:s.title,s:s.status,m:s.moved}))))})`, file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const creates = (s) => s.calls().filter((c) => c[0] === "issue" && c[1] === "create").length;

test("HANDOVER CONTROL: 2 open + 1 unknown + 1 closed -> 2 issues (kind:handover), 2 Moved lines, unknown/closed untouched, statuses re-parse", () => {
  const s = scenario({ registers: { [HO]: HO_TEXT } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const made = s.ghState().issues["hubowner/hub"];
    assert.equal(made.length, 2);
    for (const i of made) assert.match(i.labels, /kind:handover/);
    const after = s.read(HO);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(after.includes(`## 2026-10-01 · Alpha\n**Moved:** ${today} → https://github.com/hubowner/hub/issues/1\n\n\n**Done when:** a works`), after);
    assert.ok(after.includes(`## 2026-10-02 · Beta\n**Moved:** ${today} → https://github.com/hubowner/hub/issues/2\n`));
    // unknown and closed sections are byte-identical
    assert.ok(after.includes("## 2026-10-03 · Gamma\n\nprose with no marker\n\n## 2026-10-04 · Delta\n\n**Resolved:** 2026-10-05 — done\n"));
    assert.equal((after.match(/\*\*Moved:\*\*/g) || []).length, 2);
    const st = hoParse(path.join(s.hub, HO));
    assert.deepEqual(st.map((x) => x.s), ["moved", "moved", "unknown", "closed"]);
    assert.equal(st[0].m, `${today} → https://github.com/hubowner/hub/issues/1`);
    assert.equal(s.journal().filter((j) => j.matched === false && j.board === false).length, 2);
    assert.match(r.stdout, /MARKED/);
    assert.match(r.stdout, /Gamma|2026-10-03-1/, "the held unknown section is named");
  } finally {
    s.cleanup();
  }
});

test("HANDOVER RERUN: a second --apply writes nothing (moved sections are not exported again)", () => {
  const s = scenario({ registers: { [HO]: HO_TEXT } });
  try {
    assert.equal(s.run(["export", "--all", "--apply"]).status, 0);
    const w = s.writes().length, text = s.read(HO), j = s.journal().length;
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.writes().length, w, "no gh write");
    assert.equal(s.read(HO), text, "file byte-identical");
    assert.equal(s.journal().length, j);
  } finally {
    s.cleanup();
  }
});

test("HANDOVER PARTIAL: create fails on the 2nd -> exactly 1 marker, journal 1; a fixed rerun completes the 2nd", () => {
  const s = scenario({ registers: { [HO]: HO_TEXT }, control: { failIssueCreateAtCall: 2 } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal((s.read(HO).match(/\*\*Moved:\*\*/g) || []).length, 1, "only the section with a URL is marked");
    assert.deepEqual(hoParse(path.join(s.hub, HO)).map((x) => x.s), ["moved", "open", "unknown", "closed"]);
    assert.equal(new Set(s.journal().map((j) => j.key)).size, 1);

    s.setControl({ failIssueCreateAtCall: 0 });
    const c0 = creates(s);
    const r2 = s.run(["export", "--all", "--apply"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(creates(s) - c0, 1, "only the second is created");
    assert.equal((s.read(HO).match(/\*\*Moved:\*\*/g) || []).length, 2);
    assert.deepEqual(hoParse(path.join(s.hub, HO)).map((x) => x.s), ["moved", "moved", "unknown", "closed"]);
  } finally {
    s.cleanup();
  }
});

test("HANDOVER FENCE: a heading-looking line inside a fence is no section, creates no issue and survives byte-identical", () => {
  const fenceBlock = ["```", "## 2026-01-01 · x", "**Done when:** quoted", "```"].join("\n");
  const text = ["# Handovers", "", "## 2026-10-01 · Real", "", "**Done when:** it works", "", "Example:", "", fenceBlock, "", "end", ""].join("\n");
  const s = scenario({ registers: { [HO]: text } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.ghState().issues["hubowner/hub"].length, 1, "no issue for the fenced heading");
    assert.ok(s.read(HO).includes(fenceBlock), "fenced block byte-identical");
    assert.deepEqual(hoParse(path.join(s.hub, HO)).map((x) => x.s), ["moved"]);
  } finally {
    s.cleanup();
  }
});

test("HANDOVER WINDOW: a section opening with a long Done-when paragraph still reads moved after the insert", () => {
  const text = ["# H", "", "## 2026-10-01 · Long", "", "**Done when:** condition line one", "line two", "line three", "line four", "", "tail", ""].join("\n");
  const s = scenario({ registers: { [HO]: text } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(hoParse(path.join(s.hub, HO)).map((x) => x.s), ["moved"]);
    assert.ok(s.read(HO).includes("line two\nline three\nline four\n\ntail"), "the paragraph is untouched");
  } finally {
    s.cleanup();
  }
});

test("HANDOVER ROUTED: a handover in an other-owner repo with a route lands on the routed repo", () => {
  const nested = { dir: "AuroraV3", origin: "https://github.com/someoneelse/AuroraV3.git", registers: { "HANDOVER-2026-10-02.md": "# H\n\n## 1 · Do it\n\n**Done when:** done\n\nbody\n" } };
  const config = "tasks:\n  routes:\n    someoneelse/AuroraV3: hubowner/aurora\n";
  const s = scenario({ registers: {}, nested, config, control: { projects: { "hubowner/aurora": { number: 9, owner: "hubowner" } } } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const issues = s.ghState().issues["hubowner/aurora"];
    assert.equal(issues.length, 1);
    assert.match(issues[0].labels, /kind:handover/);
    assert.equal(s.ghState().issues["someoneelse/AuroraV3"], undefined);
    const file = path.join(s.hub, "AuroraV3/HANDOVER-2026-10-02.md");
    assert.match(readFileSync(file, "utf8"), /## 1 · Do it\n\*\*Moved:\*\* \d{4}-\d\d-\d\d → https:\/\/github.com\/hubowner\/aurora\/issues\/1\n/);
    assert.deepEqual(hoParse(file).map((x) => x.s), ["moved"]);
  } finally {
    s.cleanup();
  }
});

test("HANDOVER CONCURRENT EDIT: a file changed while its issues were being created gets no Moved line; the issues stay journaled", () => {
  const s = scenario({ registers: { [HO]: HO_TEXT } });
  try {
    s.setControl({ appendOnCreate: path.join(s.hub, HO) });
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(s.read(HO).startsWith(HO_TEXT), "the original text is intact");
    assert.equal((s.read(HO).match(/\*\*Moved:\*\*/g) || []).length, 0, "no marker was written over a changed file");
    assert.ok(s.journal().length >= 1, "issues are journaled");
    assert.match(r.stdout, /changed while issues were being created/);
  } finally {
    s.cleanup();
  }
});

test("HANDOVER HELD-ONLY: a file whose only sections are unknown-status is held, byte-identical, and creates nothing", () => {
  // The verify guards themselves are pinned in tests/unit/tasks-export-handover.test.mjs with hand-written hostile outputs.
  const only = "# H\n\n## 2026-10-01 · Prose\n\njust prose\n";
  const s = scenario({ registers: { [HO]: only } });
  try {
    const r = s.run(["export", "--all", "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.read(HO), only);
    assert.equal(s.writes().length, 0);
    assert.match(r.stdout, /unknown-status/);
  } finally {
    s.cleanup();
  }
});

test("a repo with no linked project still gets its issues, noted 'no board'", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS }, control: { projects: {} } });
  try {
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /note: no board/);
    assert.equal(s.ghState().items.length, 0);
    assert.equal(s.journal().every((j) => j.board === null), true);
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
  } finally {
    s.cleanup();
  }
});

test("resume by key: an issue already in the repo (journal lost) is matched, not duplicated", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS } });
  try {
    // first run creates both but we pretend the register rewrite never happened and the journal was lost
    const orig = s.read(REG);
    assert.equal(s.run(["export", "--file", path.join(s.hub, REG), "--apply"]).status, 0);
    writeFileSync(path.join(s.hub, REG), orig);
    rmSync(path.join(s.state, "tasks-export.jsonl"));
    const creates = () => s.calls().filter((c) => c[0] === "issue" && c[1] === "create").length;
    const before = creates();
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(creates(), before, "found by hidden key");
    assert.equal(s.journal().filter((j) => j.matched === true).length >= 2, true);
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
  } finally {
    s.cleanup();
  }
});

test("--budget without --apply, and a bad --budget, are usage errors", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS } });
  try {
    assert.equal(s.run(["export", "--all", "--budget", "5"]).status, 2);
    assert.equal(s.run(["export", "--all", "--apply", "--budget", "0"]).status, 2);
    assert.equal(s.run(["export", "--apply"]).status, 2, "--apply still needs a population");
    assert.equal(s.writes().length, 0);
  } finally {
    s.cleanup();
  }
});

test("JOURNAL BEFORE REGISTER: when the board add fails after the issues exist, the journal names every issue, the register is untouched, and a rerun only retries the board", () => {
  const s = scenario({ registers: { [REG]: TWO_ITEMS }, control: { failItemAdd: true } });
  try {
    const before = s.read(REG);
    const r = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(s.read(REG), before, "register untouched");
    const rows = s.journal();
    assert.equal(rows.length >= 1, true, "the issue was journaled the moment it existed");
    assert.equal(rows.every((j) => j.board === false), true);
    const made = s.ghState().issues["hubowner/hub"].length;
    assert.equal(new Set(rows.map((j) => j.key)).size, made, "the journal names every issue the run created");

    s.setControl({ failItemAdd: false });
    const creates = () => s.calls().filter((c) => c[0] === "issue" && c[1] === "create").length;
    const c0 = creates();
    const r2 = s.run(["export", "--file", path.join(s.hub, REG), "--apply"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(s.ghState().issues["hubowner/hub"].length, 2);
    assert.equal(creates() - c0, 2 - made, "only the issues the first run never reached");
    assert.equal(s.ghState().items.length, 2, "both issues reach the board on the retry");
    assert.equal(parsed(path.join(s.hub, REG)).format, "delegated");
  } finally {
    s.cleanup();
  }
});
