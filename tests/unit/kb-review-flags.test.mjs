/**
 * kb-review-flags.test.mjs: the CLI's allowlist (lib/core/commands.mjs) accepts every flag `kb review` reads (#384).
 *
 * `kb review` parses its own flags from REVIEW_FLAGS in lib/kb/review/cmd.mjs, but cli.mjs refuses any flag that
 * COMMANDS does not list before the handler ever runs. kb-review-cli.test.mjs calls kbCmd directly, so it never passed
 * through that allowlist, and cli-flag-parity.test.mjs scans only handlers in cli.mjs. That is how --rater and
 * --rater-kind shipped required in cmd.mjs and refused at the CLI. The population here is derived from REVIEW_FLAGS,
 * so a flag added there and forgotten in COMMANDS fails this test (rule:derive-dont-curate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../../lib/core/commands.mjs";
import { REVIEW_FLAGS } from "../../lib/kb/review/cmd.mjs";
import { drawSample } from "../../lib/kb/review/agree.mjs";
import { buildReview } from "../fixtures/kb-review/build.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

test("every kb review subcommand's flags, with their kind, are in the CLI allowlist", () => {
  const subs = Object.keys(REVIEW_FLAGS);
  assert.ok(subs.length >= 5, `only ${subs.length} kb review subcommands read from REVIEW_FLAGS: the scan has gone blind`);
  for (const sub of subs) {
    const reg = COMMANDS[`kb review ${sub}`];
    assert.ok(reg, `kb review ${sub} has no COMMANDS entry`);
    const [values, booleans] = REVIEW_FLAGS[sub];
    for (const f of values) assert.equal(reg.flags[f], "value", `kb review ${sub}: cmd.mjs reads ${f} as a value flag; COMMANDS has ${reg.flags[f] ?? "nothing"}`);
    for (const f of booleans) assert.equal(reg.flags[f], "boolean", `kb review ${sub}: cmd.mjs reads ${f} as a switch; COMMANDS has ${reg.flags[f] ?? "nothing"}`);
  }
});

test("#384: `kb review agree --record --rater --rater-kind --apply` through the real CLI writes agreement.json", () => {
  const fx = buildReview();
  const s = drawSample(fx.brief);
  const agent = new Map(fx.brief.screened.map((x) => [x.url, x.decision === "included" ? "include" : "exclude"]));
  const answers = {
    screening: Object.fromEntries(s.screening.map((x) => [x.url, agent.get(x.url)])),
    support: Object.fromEntries(s.support.map((x) => [x.claim_id, "supports"])),
  };
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "kb-flags-")), "answers.json");
  writeFileSync(f, JSON.stringify(answers));
  const r = spawnSync(process.execPath, [CLI, "kb", "review", "agree", fx.dir, "--record", f, "--rater", "second reviewer", "--rater-kind", "human", "--apply"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: fx.state },
    timeout: 60000,
  });
  assert.doesNotMatch(r.stderr, /unknown flag/, `the CLI refused a flag: ${r.stderr}`);
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const rec = path.join(fx.dir, "agreement.json");
  assert.ok(existsSync(rec), "agreement.json was not written");
  const a = JSON.parse(readFileSync(rec, "utf8"));
  assert.equal(a.rater, "second reviewer");
  assert.equal(a.rater_kind, "human");
});
