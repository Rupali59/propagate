/**
 * Creation-pipeline tests.
 *
 * The gate is what matters here: everything downstream writes a live,
 * autonomously-invocable skill into the model's namespace, so the tests are
 * mostly about proving creation REFUSES under each guard.
 *
 * draftSkillMd() is not tested — it spawns `claude -p` and costs tens of
 * seconds. The pipeline is split precisely so the untestable half is one
 * function and everything else can be driven with a literal string.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  takenNames,
  creationAllowed,
  createdToday,
  landInQuarantine,
  MAX_CREATES_PER_DAY,
  MAX_QUARANTINED,
} from "../../lib/skills/skills-create.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "screate-"));
  const quarantineDir = path.join(root, "quarantine", "skills");
  mkdirSync(quarantineDir, { recursive: true });
  const promotedDir = path.join(root, "tathya", "skills");
  mkdirSync(promotedDir, { recursive: true });
  return { root, quarantineDir, promotedDir, logPath: path.join(root, "log.jsonl"), disarmFile: path.join(root, "OFF") };
}

const noSkills = { skills: [], orphanUsageKeys: [] };

test("takenNames covers live skills, marketplace tiers, and HISTORICAL usage keys", () => {
  // The usage counter is never pruned, so a deleted skill's name is still
  // dangerous: reusing it would silently inherit its usage count and corrupt
  // the promotion decision for the new skill.
  const taken = takenNames({
    usage: { "propagate": { usageCount: 70 }, "quarantine:ghost": { usageCount: 4 } },
    skills: { skills: [{ id: "gstack-ship" }], orphanUsageKeys: [] },
  });
  assert.ok(taken.has("gstack-ship"), "live skill");
  assert.ok(taken.has("propagate"), "bare usage key");
  assert.ok(taken.has("ghost"), "namespaced usage key must be reduced to its bare name");
});

test("creation refuses on name collision", async () => {
  const f = fixture();
  try {
    const r = await creationAllowed({
      name: "propagate", ...f,
      usage: { propagate: { usageCount: 70 } }, skills: noSkills,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /name collision/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creation refuses malformed names", async () => {
  const f = fixture();
  try {
    for (const bad of ["", "X", "Has Spaces", "UPPER", "-leading", "a".repeat(60), "9starts-with-digit"]) {
      const r = await creationAllowed({ name: bad, ...f, usage: {}, skills: noSkills });
      assert.equal(r.ok, false, `"${bad}" should be rejected`);
    }
    const good = await creationAllowed({ name: "changelog-entry", ...f, usage: {}, skills: noSkills });
    assert.equal(good.ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the kill switch blocks creation before anything else is evaluated", async () => {
  const f = fixture();
  try {
    writeFileSync(f.disarmFile, "");
    // Deliberately also malformed: disarm must win, proving it is checked first.
    const r = await creationAllowed({ name: "!!!", ...f, usage: {}, skills: noSkills });
    assert.equal(r.reason, "disarmed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine has a hard ceiling", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < MAX_QUARANTINED; i++) mkdirSync(path.join(f.quarantineDir, `filler-${i}`));
    const r = await creationAllowed({ name: "one-more", ...f, usage: {}, skills: noSkills });
    assert.equal(r.ok, false);
    assert.match(r.reason, /quarantine full/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the daily rate limit counts only today's `created` events", async () => {
  const f = fixture();
  try {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(f.logPath,
      `{"id":"001","type":"created","skill":"a","timestamp":"2020-01-01T00:00:00.000Z"}\n` +   // old
      `{"id":"002","type":"promoted","skill":"b","timestamp":"${today}T01:00:00.000Z"}\n` +     // not a creation
      `{"id":"003","type":"created","skill":"c","timestamp":"${today}T02:00:00.000Z"}\n`);
    assert.equal(await createdToday(f.logPath, today), 1);

    const r = await creationAllowed({ name: "another", ...f, usage: {}, skills: noSkills });
    assert.equal(r.ok, MAX_CREATES_PER_DAY > 1);
    if (MAX_CREATES_PER_DAY === 1) assert.match(r.reason, /rate limit/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("createdToday survives a corrupt log rather than under-counting", async () => {
  // Under-counting would silently defeat the rate limit, so a parse failure
  // must not read as "nothing created today".
  const f = fixture();
  try {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(f.logPath,
      `{"id":"001","type":"created","skill":"a","timestamp":"${today}T01:00:00.000Z"}\n` +
      `{ this line is not json\n`);
    assert.equal(await createdToday(f.logPath, today), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("landInQuarantine writes the skill and logs a created event with evidence", async () => {
  const f = fixture();
  try {
    const md = `---\nname: demo-skill\ndescription: demo\n---\n\nbody`;
    const res = await landInQuarantine("demo-skill", md, {
      quarantineDir: f.quarantineDir, logPath: f.logPath,
      evidence: [{ sessionId: "abc", note: "seen 3 times" }], createdBy: "test",
    });
    assert.equal(res.ok, true);
    assert.equal(res.id, "quarantine:demo-skill");
    const written = readFileSync(path.join(f.quarantineDir, "demo-skill", "SKILL.md"), "utf8");
    assert.ok(written.endsWith("\n"), "must be newline-terminated");
    assert.match(written, /name: demo-skill/);

    const ev = JSON.parse(readFileSync(f.logPath, "utf8").trim().split("\n").pop());
    assert.equal(ev.type, "created");
    assert.equal(ev.id_name, "quarantine:demo-skill");
    assert.deepEqual(ev.evidence, [{ sessionId: "abc", note: "seen 3 times" }]);
    // A missing auditor must be recorded as "did not run", never as "passed".
    assert.ok(ev.audit.passed === true || ev.audit.passed === false || ev.audit.passed === null);
    if (!ev.audit.ran) assert.equal(ev.audit.passed, null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
