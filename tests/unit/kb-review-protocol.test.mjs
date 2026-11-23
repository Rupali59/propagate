import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderProtocolTemplate, parseProtocol, newReview } from "../../lib/kb/review/protocol.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kb-rev-"));
const opts = { slug: "llm-screening", date: "2026-11-23", decision: "adopt a screening method", decider: "the owner" };

const snapshot = (dir) =>
  readdirSync(dir, { recursive: true }).sort().map((f) => {
    const p = path.join(dir, f);
    return f + "\0" + (existsSync(p) && !readdirOrNull(p) ? readFileSync(p, "utf8") : "<dir>");
  }).join("\n");
const readdirOrNull = (p) => { try { return readdirSync(p); } catch { return null; } };

test("a rendered template parses ok, with approved.by null", () => {
  const r = parseProtocol(renderProtocolTemplate(opts));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.fields.approved.by, null);
  assert.equal(r.fields.review, "llm-screening");
  assert.equal(r.fields.type, "rapid-multivocal");
  assert.equal(r.fields.status, "current");
  assert.equal(r.fields.decision, "adopt a screening method");
  assert.equal(r.fields.decider, "the owner");
});

test("the body carries Kitchenham's section headings", () => {
  const t = renderProtocolTemplate(opts);
  for (const h of ["Background", "Research questions", "Search strategy", "Selection", "Quality", "Extraction", "Synthesis"]) {
    assert.match(t, new RegExp(`^## ${h}$`, "m"), h);
  }
});

test("type outside the enum is a problem naming type", () => {
  const t = renderProtocolTemplate(opts).replace("type: rapid-multivocal", "type: casual");
  const r = parseProtocol(t);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("type")), r.problems.join("|"));
});

test("status outside the enum is a problem naming status", () => {
  const r = parseProtocol(renderProtocolTemplate(opts).replace("status: current", "status: maybe"));
  assert.ok(r.problems.some((p) => p.includes("status")));
});

test("cadence outside none | <N>d | on-trigger is a problem; the three forms pass", () => {
  const t = renderProtocolTemplate(opts);
  assert.ok(parseProtocol(t.replace("cadence: none", "cadence: weekly")).problems.some((p) => p.includes("cadence")));
  for (const ok of ["none", "90d", "on-trigger"]) {
    assert.deepEqual(parseProtocol(t.replace("cadence: none", `cadence: ${ok}`)).problems, [], ok);
  }
});

test("a missing key is a problem naming it", () => {
  const t = renderProtocolTemplate(opts).replace(/^decider:.*\n/m, "");
  const r = parseProtocol(t);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("decider")), r.problems.join("|"));
});

test("text that is not a front-matter document is a problem, not zero problems", () => {
  for (const bad of ["", "just prose", "---\n- a\n- b\n---\n"]) {
    const r = parseProtocol(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.problems.length > 0);
  }
  assert.equal(parseProtocol(undefined).ok, false);
});

test("newReview on a fresh dir writes exactly protocol.md", () => {
  const dir = path.join(tmp(), "2026-11-23-llm-screening");
  const r = newReview(dir, opts, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.wrote, [path.join(dir, "protocol.md")]);
  assert.deepEqual(readdirSync(dir), ["protocol.md"]);
  assert.equal(parseProtocol(readFileSync(r.wrote[0], "utf8")).ok, true);
});

test("newReview on an existing dir refuses with KB_REVIEW_EXISTS and leaves every byte unchanged", () => {
  const dir = path.join(tmp(), "2026-11-23-llm-screening");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "protocol.md"), "approved by hand\n");
  writeFileSync(path.join(dir, "brief.json"), "{}");
  const before = snapshot(dir);
  const r = newReview(dir, opts, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "KB_REVIEW_EXISTS");
  assert.ok(r.what && r.next);
  assert.equal(snapshot(dir), before);
});
