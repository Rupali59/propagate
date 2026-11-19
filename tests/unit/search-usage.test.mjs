/**
 * `propagate search-usage` — external-search use, derived from session transcripts (propagate #255, plan #133 Stage 0).
 *
 * Every transcript is SYNTHETIC and built literally, one JSONL line per record, so the cases that matter
 * reach the counter exactly as written: a successful result whose TEXT says 429 (must not count), an
 * `is_error` result, a fetch that "succeeds" with a 404 body (the tool's own phrasing), a subagent file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchUsage, MIN_TRANSCRIPTS } from "../../lib/report/search-usage.mjs";
import { searchUsageCmd } from "../../cli/search-usage.mjs";
import { COMMANDS } from "../../lib/core/commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let seq = 0;
const uid = () => `toolu_${++seq}`;

const use = (name, input, ts = "2026-10-15T10:00:00.000Z") => {
  const id = uid();
  return { id, rec: { type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } } };
};
const result = (id, content, { is_error = false, ts = "2026-10-15T10:00:01.000Z" } = {}) => ({
  type: "user", timestamp: ts,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] },
});
/** A call and its result as two records. */
const call = (name, input, content = "ok", opts = {}) => {
  const u = use(name, input, opts.ts);
  return [u.rec, result(u.id, content, opts)];
};

function tree(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "su-test-"));
  for (const [rel, records] of Object.entries(files)) {
    const f = path.join(dir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return dir;
}
/** Pad with empty-but-valid transcripts so the floor is met without adding any search. */
function pad(files, n = MIN_TRANSCRIPTS) {
  const out = { ...files };
  for (let i = 0; Object.keys(out).length < n; i++) {
    out[`p-pad/pad-${i}.jsonl`] = [{ type: "user", timestamp: "2026-10-15T09:00:00.000Z", message: { role: "user", content: "hi" } }];
  }
  return out;
}
const snapshot = (dir) => {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out.push(f + "\0" + statSync(f).mtimeMs + "\0" + readFileSync(f, "utf8"));
    }
  })(dir);
  return out.sort().join("\n");
};
const run = (files, opts = {}) => {
  const dir = tree(pad(files));
  try { return searchUsage({ projectsDir: dir, ...opts }); } finally { rmSync(dir, { recursive: true, force: true }); }
};
async function withProjectsDir(dir, fn) {
  const prev = process.env.PROPAGATE_PROJECTS_DIR;
  process.env.PROPAGATE_PROJECTS_DIR = dir;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.PROPAGATE_PROJECTS_DIR; else process.env.PROPAGATE_PROJECTS_DIR = prev;
  }
}

test("counts calls per source, WebSearch split by mode", () => {
  const r = run({
    "p-a/s1.jsonl": [
      ...call("WebSearch", { query: "alpha", mode: "standard" }),
      ...call("WebSearch", { query: "beta" }), // no mode: standard
      ...call("WebSearch", { query: "gamma", mode: "extended" }),
      ...call("WebFetch", { url: "https://example.com/a", prompt: "x" }),
      ...call("Bash", { command: "gh search code foo --limit 5" }),
      ...call("Bash", { command: "echo 'gh search is mentioned here only'" }), // not a call
      ...call("mcp__github__search_code", { q: "x" }),
      ...call("mcp__github__create_pull_request", {}), // a write, not a search
      ...call("mcp__plugin_context7_context7__query-docs", { q: "x" }),
      ...call("mcp__claude_ai_Vercel__search_vercel_documentation", { q: "x" }),
      ...call("mcp__claude_ai_Vercel__list_deployments", {}), // not docs search
      ...call("mcp__claude_ai_Semrush__keyword_research", {}),
      ...call("mcp__claude_ai_Ahrefs__serp-overview", {}),
      ...call("mcp__claude_ai_Scholar_Gateway__semanticSearch", {}),
    ],
  });
  const c = (id) => r.sources[id].calls;
  assert.equal(c("websearch_standard"), 2);
  assert.equal(c("websearch_extended"), 1);
  assert.equal(c("webfetch"), 1);
  assert.equal(c("gh_search"), 1);
  assert.equal(c("github_mcp"), 1);
  assert.equal(c("context7"), 1);
  assert.equal(c("vercel_docs"), 1);
  assert.equal(c("semrush"), 1);
  assert.equal(c("ahrefs"), 1);
  assert.equal(c("scholar"), 1);
});

test("subagent transcripts are read, and a tool_use id seen twice counts once", () => {
  const u = use("WebFetch", { url: "https://example.com/z" });
  const r = run({
    "p-a/s1/subagents/agent-1.jsonl": [u.rec, result(u.id, "page")],
    "p-a/s1.jsonl": [u.rec], // the same tool_use echoed in the parent transcript
  });
  assert.equal(r.sources.webfetch.calls, 1);
  assert.ok(r.transcripts.subagent >= 1);
});

test("is_error is counted separately from words in results: a 429 inside a Read or grep result is not a failure", () => {
  const r = run({
    "p-a/s1.jsonl": [
      ...call("Read", { file_path: "/x" }, "line says HTTP 429 Too Many Requests"),
      ...call("Bash", { command: "grep 429 log" }, "429 found"),
      ...call("WebFetch", { url: "https://example.com/ok" }, "The article explains the 429 status code and 404 Not Found pages."),
      ...call("WebFetch", { url: "https://example.com/err" }, "Request failed with status code 429", { is_error: true }),
      ...call("WebFetch", { url: "https://example.com/slow" }, "timeout of 60000ms exceeded", { is_error: true }),
      ...call("WebFetch", { url: "https://nope.invalid" }, "getaddrinfo ENOTFOUND nope.invalid", { is_error: true }),
      ...call("WebFetch", { url: "https://example.com/gone" }, "The server returned HTTP 404 Not Found. The response body was empty."),
      ...call("WebFetch", { url: "https://example.com/limited" }, "The server returned HTTP 429 Too Many Requests."),
    ],
  });
  assert.equal(r.sources.webfetch.calls, 6);
  assert.deepEqual(r.sources.webfetch.failures, { is_error: 3, not_found: 1, rate_limited: 2, timeout: 1, dns: 1 });
});

test("ToolSearch loads are attributed to the source they name", () => {
  const r = run({
    "p-a/s1.jsonl": [
      ...call("ToolSearch", { query: "select:WebSearch,WebFetch", max_results: 2 }),
      ...call("ToolSearch", { query: "select:mcp__plugin_context7_context7__query-docs" }),
      ...call("ToolSearch", { query: "+github search" }),
      ...call("ToolSearch", { query: "notebook jupyter" }), // no source
    ],
  });
  assert.equal(r.toolsearch.websearch, 1);
  assert.equal(r.toolsearch.webfetch, 1);
  assert.equal(r.toolsearch.context7, 1);
  assert.equal(r.toolsearch.github_mcp, 1);
  assert.equal(r.toolsearch.total, 4);
});

test("WebSearch topic buckets and the exact-repeat rate", () => {
  const r = run({
    "p-a/s1.jsonl": [
      ...call("WebSearch", { query: "Next.js app router docs api reference" }),
      ...call("WebSearch", { query: "next.js  App Router docs API reference" }), // same query, normalised
      ...call("WebSearch", { query: "claude code pricing limits 2026" }),
      ...call("WebSearch", { query: "github repo for a thing" }),
    ],
  });
  assert.equal(r.websearch.total, 4);
  assert.equal(r.websearch.distinct, 3);
  assert.equal(r.websearch.repeated_calls, 1);
  assert.equal(r.websearch.exact_repeat_rate, 0.25);
  assert.equal(r.websearch.one_off_rate, 0.5); // two queries asked exactly once, out of four calls
  const sum = Object.values(r.websearch.buckets).reduce((a, b) => a + b, 0);
  assert.equal(sum, 4, "every search lands in exactly one bucket");
});

test("--since / --until bound calls by their own timestamp; --project filters by directory", () => {
  const files = {
    "p-keep/s1.jsonl": [
      ...call("WebFetch", { url: "https://e.com/1" }, "ok", { ts: "2026-10-01T00:00:00.000Z" }),
      ...call("WebFetch", { url: "https://e.com/2" }, "ok", { ts: "2026-11-13T00:00:00.000Z" }),
    ],
    "p-other/s2.jsonl": [...call("WebFetch", { url: "https://e.com/3" }, "ok", { ts: "2026-10-02T00:00:00.000Z" })],
  };
  assert.equal(run(files).sources.webfetch.calls, 3);
  assert.equal(run(files, { since: "2026-10-01", until: "2026-11-13" }).sources.webfetch.calls, 2);
  assert.equal(run(files, { since: "2026-10-01", until: "2026-11-13", project: "keep" }).sources.webfetch.calls, 1);
});

test("floor: under the minimum transcripts, the scan has gone blind (exit 2), never a clean zero", async () => {
  const dir = tree({ "p-a/s1.jsonl": call("WebFetch", { url: "https://e.com/1" }) });
  try {
    await withProjectsDir(dir, async () => {
      const out = [], err = [];
      assert.equal(await searchUsageCmd([], { out: (s) => out.push(s), err: (s) => err.push(s) }), 2);
      assert.match(err.join("\n"), /the scan has gone blind/);
      assert.equal(out.join("").includes("webfetch"), false, "no counts printed from a blind scan");
      assert.equal(await searchUsageCmd(["--json"], { out() {}, err() {} }), 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing projects directory is blind too, not zero", async () => {
  await withProjectsDir(path.join(os.tmpdir(), "su-does-not-exist-" + process.pid), async () => {
    const err = [];
    assert.equal(await searchUsageCmd([], { out() {}, err: (s) => err.push(s) }), 2);
    assert.match(err.join(""), /the scan has gone blind/);
  });
});

test("read-only: the transcript tree is byte-identical before and after, across every flag", async () => {
  const dir = tree(pad({ "p-a/s1.jsonl": [...call("WebSearch", { query: "q" }), ...call("WebFetch", { url: "https://e.com" })] }));
  try {
    await withProjectsDir(dir, async () => {
      const before = snapshot(dir);
      for (const args of [[], ["--json"], ["--since", "2026-10-01"], ["--project", "a"], ["--since", "2026-10-01", "--until", "2026-12-01", "--json"]]) {
        assert.equal(await searchUsageCmd(args, { out() {}, err() {} }), 0, args.join(" "));
        assert.equal(snapshot(dir), before, `${args.join(" ")} must not touch the transcripts`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered: in the command table, and cli.mjs dispatches it end to end", () => {
  assert.ok(COMMANDS["search-usage"], "search-usage is missing from lib/core/commands.mjs");
  const dir = tree(pad({ "p-a/s1.jsonl": call("WebFetch", { url: "https://e.com" }) }));
  try {
    const env = { ...process.env, PROPAGATE_PROJECTS_DIR: dir };
    const r = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), "search-usage", "--json"], { env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).sources.webfetch.calls, 1);
    const bad = spawnSync(process.execPath, [path.join(ROOT, "cli.mjs"), "search-usage", "--nope"], { env, encoding: "utf8", timeout: 60000 });
    assert.notEqual(bad.status, 0, "an unknown flag is refused by the table");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
