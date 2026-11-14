/**
 * broadcast.test.mjs — `propagate broadcast new|status` (phase 1 of propagate#267).
 *
 * The fake gh is an in-memory GitHub that RECORDS EVERY CALL. The safety property (rule:safety-flag-needs-a-test) is
 * measured on those calls: a run without --apply must make zero mutating calls, whatever the stdout says.
 *
 * G76: no literal the make-public gate refuses appears here; the forbidden literal is assembled at runtime.
 * The hostile fixtures below are written as literals on purpose and must not be moved onto a shared builder.
 */
// @size small — pure, in-memory fake gh
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { broadcastCmd } from "../../cli/broadcast.mjs";
import { applyBroadcast, planBroadcast } from "../../lib/broadcast/new.mjs";
import { readStatus } from "../../lib/broadcast/status.mjs";
import { defaultModel, groupItemFields, keyComment, keyOfBody } from "../../lib/broadcast/model.mjs";

const FORBIDDEN_LITERAL = ["rupali", "b"].join(".");
const HUB = "hubowner/hub";
const NOW = Date.parse("2026-11-14T00:00:00Z");

/** gh calls that change anything. `api` is mutating only with -X/--method other than GET, or -f/-F fields. */
export function isMutating(args) {
  const [a, b] = args;
  if (a === "issue" && b === "create") return true;
  if (a === "label" && b === "create") return true;
  if (a === "project" && (b === "item-add" || b === "item-edit")) return true;
  if (a === "api") {
    const i = args.findIndex((x) => x === "-X" || x === "--method");
    if (i !== -1 && args[i + 1] !== "GET") return true;
    if (args.includes("-f") && !args.includes("graphql")) return true;
  }
  return false;
}

/** An in-memory GitHub. `repos` = {name: {visibility, boards}}; issues live in `issues[repo]`. */
function fakeGithub({ repos, seed = {}, failStatus = false, dropLink = null, failPost = false } = {}) {
  const calls = [];
  const issues = {};
  const labels = { [HUB]: new Set() };
  const subs = {};
  let nextId = 5000;
  let nextNum = 100;
  for (const [r, list] of Object.entries(seed)) issues[r] = list.map((i) => ({ state: "open", created_at: "2026-11-10T00:00:00Z", labels: [], ...i }));
  const find = (r, n) => (issues[r] ?? []).find((i) => i.number === n);
  const gh = (args, { input } = {}) => {
    calls.push(args);
    const ok = (o) => ({ status: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "" });
    const bad = (m) => ({ status: 1, stdout: "", stderr: m });
    const [a, b] = args;
    if (failStatus) return bad("HTTP 502");
    if (a === "repo" && b === "view") {
      const r = args[2];
      return repos[r] ? ok({ visibility: repos[r].visibility ?? "PRIVATE", hasIssuesEnabled: true, owner: { login: r.split("/")[0] } }) : bad("not found");
    }
    if (a === "issue" && b === "list") {
      const r = args[args.indexOf("-R") + 1];
      let list = issues[r] ?? [];
      if (args.includes("--label")) list = list.filter((i) => i.labels.includes(args[args.indexOf("--label") + 1]));
      if (args[args.indexOf("--state") + 1] === "open") list = list.filter((i) => i.state === "open");
      return ok(list.map(({ number, url, body, title }) => ({ number, url, body, title })));
    }
    if (a === "label" && b === "list") return ok([...(labels[args[args.indexOf("-R") + 1]] ?? [])].map((name) => ({ name })));
    if (a === "label" && b === "create") {
      (labels[args[args.indexOf("-R") + 1]] ??= new Set()).add(args[2]);
      return ok("");
    }
    if (a === "issue" && b === "create") {
      const r = args[args.indexOf("-R") + 1];
      const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
      const number = nextNum++;
      const url = `https://github.com/${r}/issues/${number}`;
      (issues[r] ??= []).push({ number, id: nextId++, url, title: args[args.indexOf("--title") + 1], body, state: "open", created_at: "2026-11-10T00:00:00Z", labels: (args[args.indexOf("--label") + 1] ?? "").split(",").filter(Boolean) });
      return ok(`${url}\n`);
    }
    if (a === "api") {
      const route = args.find((x) => x.startsWith("repos/"));
      if (args.includes("graphql")) {
        const q = args[args.indexOf("-f") + 1];
        const name = /owner:"([^"]+)",name:"([^"]+)"/.exec(q);
        const r = name ? `${name[1]}/${name[2]}` : "";
        return ok({ data: { repository: { projectsV2: { nodes: repos[r]?.boards ?? [] } } } });
      }
      const sm = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/sub_issues/.exec(route ?? "");
      if (sm && args.includes("POST")) {
        if (failPost) return bad("HTTP 422");
        const id = Number(args[args.indexOf("-F") + 1].split("=")[1]);
        (subs[`${sm[1]}#${sm[2]}`] ??= []).push(id);
        return ok({});
      }
      if (sm) {
        const ids = subs[`${sm[1]}#${sm[2]}`] ?? [];
        const all = Object.entries(issues).flatMap(([r, l]) => l.map((i) => ({ ...i, repository_url: `https://api.github.com/repos/${r}` })));
        return ok(all.filter((i) => ids.includes(i.id) && i.id !== dropLink));
      }
      const im = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(route ?? "");
      if (im) {
        const i = find(im[1], Number(im[2]));
        if (!i) return bad("Not Found");
        const ids = subs[`${im[1]}#${im[2]}`] ?? [];
        const kids = Object.values(issues).flat().filter((x) => ids.includes(x.id));
        return ok({ ...i, sub_issues_summary: { total: kids.length, completed: kids.filter((k) => k.state === "closed").length, percent_completed: 0 } });
      }
    }
    if (a === "project" && b === "item-add") return ok({ id: "ITEM1" });
    if (a === "project" && b === "field-list") {
      return ok({ fields: [
        { id: "F-goal", name: "Goal", options: [{ id: "o-g3", name: "G3" }] },
        { id: "F-pri", name: "Priority", options: [{ id: "o-p1", name: "P1" }] },
        { id: "F-mod", name: "Model", options: [{ id: "o-op", name: "Opus" }, { id: "o-so", name: "Sonnet" }, { id: "o-ha", name: "Haiku" }] },
      ] });
    }
    if (a === "project" && b === "item-edit") return ok("");
    void input;
    return bad(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls, issues, subs, labels };
}

const BOARD = [{ id: "PVT_1", number: 7, closed: false, owner: { login: "o" } }];
const repoSet = (...names) => Object.fromEntries(names.map((n) => [n, { visibility: "PRIVATE", boards: BOARD }]));
const io = () => {
  const out = [];
  const err = [];
  return { out, err, log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
};
const state = () => mkdtempSync(path.join(os.tmpdir(), "bc-state-"));

const violation = (subject, reason = "Ready item is missing Goal, Model") => ({ clause: "item-fields", subject, reason });
const goalsCheck = (violations) => async () => ({ code: violations.length ? 1 : 0, stdout: JSON.stringify({ violations }), stderr: "" });

// ── grouping ───────────────────────────────────────────────────────────────

test("grouping: 3 repos with violations give 3 children, a clean repo gets none, each carries its Done when", async () => {
  const gh = fakeGithub({ repos: repoSet(HUB, "o/a", "o/b", "o/c", "o/clean") });
  const sink = io();
  const code = await broadcastCmd(["new", "--title", "Groom the boards", "--goal", "G3", "--from", "goals-check", "--json"], {
    io: sink, gh: gh.gh, hub: HUB, stateDirPath: state(),
    goalsCheck: goalsCheck([
      violation("o/a#1"), violation("o/a#2"), violation("o/b#9"), violation("o/c#4"),
      { clause: "appetite", subject: "G3", reason: "not an item violation" },
    ]),
  });
  assert.equal(code, 0, sink.err.join("\n"));
  const plan = JSON.parse(sink.out.join("\n"));
  assert.deepEqual(plan.children.map((c) => c.repo).sort(), ["o/a", "o/b", "o/c"]);
  assert.ok(!plan.children.some((c) => c.repo === "o/clean"));
  for (const c of plan.children) {
    assert.match(c.body, new RegExp(`Done when: \`propagate goals check\` reports no item-fields violation for ${c.repo}\\.`));
    assert.equal(c.title, `Groom the boards · ${c.repo.split("/")[1]}`);
    assert.equal(keyOfBody(c.body), `groom-the-boards:${c.repo}`);
  }
  assert.match(plan.children.find((c) => c.repo === "o/a").body, /#1: .*\n- #2: /);
});

test("0 violations is an error and creates no parent", async () => {
  const gh = fakeGithub({ repos: repoSet(HUB) });
  const sink = io();
  const code = await broadcastCmd(["new", "--title", "T", "--goal", "G3", "--from", "goals-check", "--apply"], { io: sink, gh: gh.gh, hub: HUB, stateDirPath: state(), goalsCheck: goalsCheck([]) });
  assert.equal(code, 2);
  assert.match(sink.err.join("\n"), /nothing to broadcast/);
  assert.equal(gh.calls.filter((c) => isMutating(c)).length, 0);
  assert.equal(gh.calls.length, 0, "no parent is even looked up");
});

test("groupItemFields names a subject it cannot parse instead of dropping it", () => {
  const { groups, unparsed } = groupItemFields([violation("not-a-ref"), violation("o/a#1")]);
  assert.equal(groups.size, 1);
  assert.deepEqual(unparsed, ["not-a-ref"]);
});

test("the Model rule: Opus for Feature or no Done when, Haiku for XS with one, else Sonnet", () => {
  assert.equal(defaultModel("Feature", "S", "Done when: x"), "Opus");
  assert.equal(defaultModel(null, "S", "no condition here"), "Opus");
  assert.equal(defaultModel(null, "XS", "Done when: x"), "Haiku");
  assert.equal(defaultModel("Task", "M", "Done when: x"), "Sonnet");
});

// ── idempotency ────────────────────────────────────────────────────────────

test("an existing key is reused: no `issue create` for it, and the parent is reused too", () => {
  const key = (k) => keyComment(k);
  const gh = fakeGithub({
    repos: repoSet(HUB, "o/a"),
    seed: {
      "o/a": [{ number: 7, id: 11, url: "https://github.com/o/a/issues/7", title: "t", body: `x\n${key("t:o/a")}` }],
      [HUB]: [{ number: 3, id: 12, url: `https://github.com/${HUB}/issues/3`, title: "t", body: `x\n${key("t:parent")}` }],
    },
  });
  const plan = planBroadcast({ title: "T", goal: "G3", hub: HUB, children: [{ repo: "o/a", title: "T · a", body: "b\n\nDone when: x" }], gh: gh.gh });
  assert.equal(plan.ok, true);
  assert.equal(plan.children[0].existing.number, 7);
  assert.equal(plan.parent.existing.number, 3);
  const res = applyBroadcast(plan, { gh: gh.gh });
  assert.equal(gh.calls.filter((c) => c[0] === "issue" && c[1] === "create").length, 0, "nothing is created for a key that already exists");
  assert.equal(res.children[0].created, false);
  assert.equal(res.parent.created, false);
  assert.equal(res.ok, true, res.problems.join("; "));
});

// ── public gate ────────────────────────────────────────────────────────────

test("a public target with a forbidden literal is held, named, and never created", () => {
  const dir = state();
  writeFileSync(path.join(dir, "identity-map.json"), JSON.stringify({ names: { "Some Client": "client" } }));
  const repos = { ...repoSet(HUB, "o/priv"), "o/pub": { visibility: "PUBLIC", boards: [] } };
  const gh = fakeGithub({ repos });
  const body = `see /srv/${FORBIDDEN_LITERAL}/notes\n\nDone when: x`;
  const plan = planBroadcast({
    title: "T", goal: "G3", hub: HUB, stateDirPath: dir, gh: gh.gh,
    children: [{ repo: "o/pub", title: "T · pub", body }, { repo: "o/priv", title: "T · priv", body }],
  });
  assert.equal(plan.ok, true);
  const pub = plan.children.find((c) => c.repo === "o/pub");
  assert.match(pub.held, /^forbidden: .*home-dir username/);
  assert.equal(plan.children.find((c) => c.repo === "o/priv").held, null, "a private repo is not scrubbed or held");
  assert.ok(!plan.parent.body.includes("o/pub"), "a held child is not listed in the parent");
  const res = applyBroadcast(plan, { gh: gh.gh });
  const created = gh.calls.filter((c) => c[0] === "issue" && c[1] === "create").map((c) => c[c.indexOf("-R") + 1]);
  assert.deepEqual(created.sort(), [HUB, "o/priv"].sort(), "the public child is not created");
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.startsWith("o/pub: HELD forbidden")));
});

test("a public target with no identity map is held, not published unscrubbed", () => {
  const gh = fakeGithub({ repos: { [HUB]: { visibility: "PRIVATE" }, "o/pub": { visibility: "PUBLIC" } } });
  const plan = planBroadcast({ title: "T", goal: "G3", hub: HUB, stateDirPath: state(), gh: gh.gh, children: [{ repo: "o/pub", title: "x", body: "clean\n\nDone when: x" }] });
  assert.match(plan.children[0].held, /^no-identity-map/);
});

// ── apply: order, board, read-back ─────────────────────────────────────────

test("apply order: parent, children, sub-issue links, board, then the read-back", () => {
  const gh = fakeGithub({ repos: repoSet(HUB, "o/a", "o/b") });
  const plan = planBroadcast({ title: "T", goal: "G3", hub: HUB, gh: gh.gh, children: ["o/a", "o/b"].map((repo) => ({ repo, title: `T · ${repo}`, body: "b\n\nDone when: x" })) });
  const res = applyBroadcast(plan, { gh: gh.gh });
  assert.equal(res.ok, true, res.problems.join("; "));
  const seq = gh.calls.filter((c) => isMutating(c) || (c[0] === "api" && /sub_issues/.test(c.join(" ")))).map((c) => {
    if (c[0] === "issue") return `create:${c[c.indexOf("-R") + 1]}`;
    if (c[0] === "api" && c.includes("POST")) return "link";
    if (c[0] === "api") return "readback";
    return c.slice(0, 2).join(" ");
  });
  const firstLink = seq.indexOf("link");
  assert.deepEqual(seq.slice(0, 3), ["label create", "label create", `create:${HUB}`]);
  assert.ok(seq.indexOf("create:o/a") < firstLink && seq.indexOf("create:o/b") < firstLink, "children exist before they are linked");
  assert.ok(seq.indexOf("project item-add") > seq.lastIndexOf("link"), "board placement follows linking");
  assert.equal(seq[seq.length - 1], "readback");
  const edits = gh.calls.filter((c) => c[1] === "item-edit").map((c) => c[c.indexOf("--field-id") + 1]);
  assert.deepEqual(edits.slice(0, 3), ["F-goal", "F-pri", "F-mod"]);
  const sub = gh.calls.find((c) => c.includes("POST"));
  assert.ok(sub.includes(`repos/${HUB}/issues/100/sub_issues`) && sub.some((x) => /^sub_issue_id=\d+$/.test(x)), "links by the child's numeric id");
});

test("a child missing from the read-back gives exit 1 and names it", async () => {
  const gh = fakeGithub({ repos: repoSet(HUB, "o/a", "o/b"), dropLink: 5002 });
  const sink = io();
  const bodyFile = path.join(state(), "body.md");
  writeFileSync(bodyFile, "do the thing\n\nDone when: it is done");
  const code = await broadcastCmd(["new", "--title", "T", "--goal", "G3", "--to", "o/a,o/b", "--body-file", bodyFile, "--apply"], { io: sink, gh: gh.gh, hub: HUB, stateDirPath: state() });
  assert.equal(code, 1);
  assert.match(sink.err.join("\n"), /read-back: o\/b#\d+ is not in hubowner\/hub#\d+'s sub_issues/);
});

test("a failed link POST is re-read, not assumed: already linked is fine, absent is a problem", () => {
  const gh = fakeGithub({ repos: repoSet(HUB, "o/a"), failPost: true });
  const plan = planBroadcast({ title: "T", goal: "G3", hub: HUB, gh: gh.gh, children: [{ repo: "o/a", title: "x", body: "b\n\nDone when: x" }] });
  const res = applyBroadcast(plan, { gh: gh.gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.startsWith("link o/a#")));
});

test("zero or several open boards: named and skipped, never guessed", () => {
  const repos = { [HUB]: { visibility: "PRIVATE" }, "o/none": { visibility: "PRIVATE", boards: [] }, "o/two": { visibility: "PRIVATE", boards: [BOARD[0], { ...BOARD[0], number: 8 }] } };
  const gh = fakeGithub({ repos });
  const plan = planBroadcast({ title: "T", goal: "G3", hub: HUB, gh: gh.gh, children: ["o/none", "o/two"].map((repo) => ({ repo, title: "x", body: "b\n\nDone when: x" })) });
  const res = applyBroadcast(plan, { gh: gh.gh });
  assert.ok(res.children.every((c) => c.board.status === "skipped"));
  assert.match(res.children[1].board.note, /2 open board\(s\)/);
  assert.equal(gh.calls.filter((c) => c[0] === "project").length, 0);
});

// ── dry run writes nothing (measured on the calls) ─────────────────────────

for (const [label, argv, extra] of [
  ["--from goals-check", ["--from", "goals-check"], { goalsCheck: goalsCheck([violation("o/a#1"), violation("o/b#2")]) }],
  ["--to", ["--to", "o/a,o/b", "--body-file", "BODYFILE"], {}],
]) {
  test(`dry run (${label}) makes ZERO mutating gh calls`, async () => {
    const gh = fakeGithub({ repos: repoSet(HUB, "o/a", "o/b") });
    const bodyFile = path.join(state(), "body.md");
    writeFileSync(bodyFile, "b\n\nDone when: x");
    const sink = io();
    const code = await broadcastCmd(["new", "--title", "T", "--goal", "G3", ...argv.map((a) => (a === "BODYFILE" ? bodyFile : a))], { io: sink, gh: gh.gh, hub: HUB, stateDirPath: state(), ...extra });
    assert.equal(code, 0, sink.err.join("\n"));
    assert.ok(gh.calls.length > 0, "the dry run did read (a run that read nothing proves nothing)");
    const writes = gh.calls.filter((c) => isMutating(c));
    assert.deepEqual(writes, [], `mutating calls in a dry run: ${JSON.stringify(writes)}`);
    assert.match(sink.out.join("\n"), /DRY RUN/);
  });
}

test("isMutating itself can fail: it flags each write shape the apply path uses", () => {
  assert.equal(isMutating(["issue", "create", "-R", "o/a"]), true);
  assert.equal(isMutating(["label", "create", "x"]), true);
  assert.equal(isMutating(["project", "item-add", "7"]), true);
  assert.equal(isMutating(["project", "item-edit", "--id", "x"]), true);
  assert.equal(isMutating(["api", "-X", "POST", "repos/o/a/issues/1/sub_issues"]), true);
  assert.equal(isMutating(["issue", "list", "-R", "o/a"]), false);
  assert.equal(isMutating(["api", "repos/o/a/issues/1"]), false);
});

// ── status ─────────────────────────────────────────────────────────────────

function statusWorld({ closeChildren = [], missingChild = false } = {}) {
  const gh = fakeGithub({ repos: repoSet(HUB, "o/a", "o/b", "o/c", "o/d", "o/e") });
  const repos = ["o/a", "o/b", "o/c", "o/d", "o/e"];
  const plan = planBroadcast({ title: "Groom", goal: "G3", hub: HUB, gh: gh.gh, children: repos.map((repo) => ({ repo, title: `Groom · ${repo}`, body: "b\n\nDone when: x" })) });
  applyBroadcast(plan, { gh: gh.gh });
  for (const r of closeChildren) gh.issues[r][0].state = "closed";
  const parentNum = gh.issues[HUB][0].number;
  if (missingChild) {
    // GitHub moved or transferred o/e's child: it is still named in the parent body, and no longer a sub-issue.
    const id = gh.issues["o/e"][0].id;
    gh.subs[`${HUB}#${parentNum}`] = gh.subs[`${HUB}#${parentNum}`].filter((x) => x !== id);
  }
  gh.issues[HUB][0].labels = ["broadcast", "kind:handover"];
  return { gh, parentNum };
}

test("status: 2/5 closed, with one line per child and its age", async () => {
  const { gh } = statusWorld({ closeChildren: ["o/a", "o/b"] });
  const sink = io();
  const code = await broadcastCmd(["status", "--hub", HUB], { io: sink, gh: gh.gh, now: NOW });
  assert.equal(code, 0, sink.err.join("\n"));
  const text = sink.out.join("\n");
  assert.match(text, /^Groom: 2\/5 closed$/m);
  assert.match(text, /o\/a#\d+  closed  status not read  4d/);
  assert.match(text, /o\/c#\d+  open  status not read  4d/);
});

test("status: a missing child is named and NOT counted, and a closed one is counted", () => {
  const { gh, parentNum } = statusWorld({ closeChildren: ["o/a"], missingChild: true });
  const res = readStatus({ hub: HUB, number: parentNum, gh: gh.gh, now: NOW });
  assert.equal(res.ok, true);
  const b = res.broadcasts[0];
  assert.equal(b.completed, 1, "only the closed child counts");
  assert.equal(b.total, 4, "the missing child is not in the total");
  assert.deepEqual(b.missing, ["o/e"]);
  assert.equal(b.children.length, 4);
});

test("status: a gh failure is exit 2, never 0", async () => {
  const sink = io();
  const code = await broadcastCmd(["status", "--hub", HUB], { io: sink, gh: fakeGithub({ repos: repoSet(HUB), failStatus: true }).gh });
  assert.equal(code, 2);
  assert.match(sink.err.join("\n"), /could not read GitHub/);
});

test("status with no broadcast reads as a result, not an error", async () => {
  const sink = io();
  const code = await broadcastCmd(["status", "--hub", HUB], { io: sink, gh: fakeGithub({ repos: repoSet(HUB) }).gh });
  assert.equal(code, 0);
  assert.match(sink.out.join("\n"), /no open broadcast/);
});

test("usage errors exit 2 before any gh call", async () => {
  const gh = fakeGithub({ repos: repoSet(HUB) });
  for (const argv of [["new", "--goal", "G3", "--from", "goals-check"], ["new", "--title", "T", "--goal", "G3"], ["new", "--title", "T", "--goal", "G3", "--to", "o/a"], ["new", "--title", "T", "--goal", "G3", "--from", "goals-check", "--to", "o/a", "--body-file", "f"], ["new", "--title", "T", "--goal", "x", "--from", "goals-check"], ["new", "--bogus"], ["nope"]]) {
    const sink = io();
    assert.equal(await broadcastCmd(argv, { io: sink, gh: gh.gh, hub: HUB, stateDirPath: state(), goalsCheck: goalsCheck([violation("o/a#1")]) }), 2, argv.join(" "));
  }
  assert.equal(gh.calls.length, 0);
});

test("childGoal: each child serves the goal its items carry; --goal only as a fallback (first live dry run, 2026-11-14)", async () => {
  const { childGoal } = await import("../../lib/broadcast/model.mjs");
  // Literals: the snapshot shape day open writes.
  const snap = { "o/a#1": { goal: "G2" }, "o/a#2": { goal: "G2" }, "o/a#3": { goal: "G1" }, "o/b#9": { goal: "Parked" }, "o/c#4": { goal: "G3" }, "o/c#5": { goal: "G1" } };
  assert.equal(childGoal("o/a", [{ n: 1 }, { n: 2 }, { n: 3 }], snap, "G1"), "G2", "the majority goal, not the --goal stamped on everything");
  assert.equal(childGoal("o/b", [{ n: 9 }], snap, "G1"), "G1", "parked or goal-less items fall back to --goal");
  assert.equal(childGoal("o/z", [{ n: 1 }], {}, "G1"), "G1", "no snapshot falls back");
  assert.equal(childGoal("o/c", [{ n: 4 }, { n: 5 }], snap, "G1"), "G1", "a tie that includes the fallback keeps it");
  assert.equal(childGoal("o/c", [{ n: 4 }, { n: 5 }], snap, "G9"), "G1", "a tie without it is decided by the lowest id, never by map order");
});
