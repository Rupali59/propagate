/**
 * `--help` / `-h` / `help [cmd]`, answered from COMMANDS above the flag check.
 *
 * Before this, `propagate --help` printed `unknown mode: --help` plus a 3 KB
 * one-line usage, and `verify --help` was refused as an unknown flag. The
 * population below is DERIVED from COMMANDS, with a floor -- a hand-listed set
 * would pass while a newly-added command answered nothing
 * (`rule:derive-dont-curate`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { COMMANDS, renderHelp, helpRequest } from "../../lib/core/commands.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const run = (argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });

test("EVERY COMMANDS entry answers `<cmd> --help` with exit 0 and its own name — derived, with a floor", () => {
  const names = Object.keys(COMMANDS);
  assert.ok(names.length >= 40, `only ${names.length} commands — the derivation has gone blind, not found nothing`);
  const failures = [];
  for (const name of names) {
    const r = run([...name.split(" "), "--help"]);
    if (r.status !== 0 || !r.stdout.includes(`propagate ${name}`)) {
      failures.push(`${name}: exit ${r.status}, stdout head ${JSON.stringify(r.stdout.slice(0, 60))}, stderr ${JSON.stringify(r.stderr.slice(0, 80))}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the seven args:null commands get a DEFINED answer that says their flags are not enumerated", () => {
  const nulls = Object.entries(COMMANDS).filter(([, c]) => c.args === null).map(([n]) => n);
  assert.ok(nulls.length >= 7, `expected the seven handled-but-undocumented commands, found ${nulls.length}`);
  for (const n of nulls) {
    const r = run([n, "--help"]);
    assert.equal(r.status, 0, n);
    assert.match(r.stdout, /not yet enumerated/, `${n} must say why it lists no flags`);
  }
});

test("global help lists every command once, grouped, one line each", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  for (const name of Object.keys(COMMANDS)) {
    // Rows are `  <name padded to 18> <summary>`; padding keeps `reminders` from matching `reminders sync`.
    const lines = r.stdout.split("\n").filter((l) => l.startsWith(`  ${name.padEnd(18)} `));
    assert.equal(lines.length, 1, `${name} must appear exactly once in the global list`);
  }
  assert.match(r.stdout, /Settle drift/);
  assert.deepEqual(run(["-h"]).stdout, r.stdout);
  assert.deepEqual(run(["help"]).stdout, r.stdout);
});

test("`help verify` and `verify --help` agree, and list every declared flag", () => {
  const a = run(["help", "verify"]);
  const b = run(["verify", "--help"]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  for (const flag of Object.keys(COMMANDS.verify.flags)) assert.match(a.stdout, new RegExp(flag.replace(/-/g, "\\-")));
});

test("two-word commands resolve: `help claims check`", () => {
  const r = run(["help", "claims", "check"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /propagate claims check/);
});

test("help for a command that does not exist is a named refusal, exit 2", () => {
  const r = run(["help", "nosuchcmd"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command: nosuchcmd/);
});

test("an unknown mode is still reported by the unknown-mode path, unchanged", () => {
  const r = run(["not-a-real-mode"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown mode: not-a-real-mode/);
});

test("a --help that is the VALUE of a value flag is text, not a request", () => {
  assert.equal(helpRequest(["verify", "--reason", "--help"]), null);
  assert.deepEqual(helpRequest(["verify", "--help"]), { name: "verify" });
  assert.equal(renderHelp("nosuchcmd"), null);
});
