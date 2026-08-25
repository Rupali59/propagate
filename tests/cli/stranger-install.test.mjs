/**
 * Gate 4 of `release --check` ("stranger-install"): a freshly set-up workspace must
 * reach `doctor`-clean after the documented sequence — `setup` -> `bootstrap --apply`
 * -> `doctor`. It never did (docs/ISSUES.md N38-adjacent gap, recorded in STATE.md
 * 2026-08-20 "Lane C landed"): `init`/`setup` scaffold the sidecar, `bootstrap --apply`
 * writes only the v2 event store, and nothing in the install path ever created the v1
 * ledger JSONL/MD pair a workspace with no prior rows needs. `doctor`'s "ledger JSONL
 * exists" / "ledger MD exists" checks failed on every stranger machine, forever.
 *
 * Fixed in lib/core/discovery.mjs's `makeWorkspaceRecord`: the ledger pair is now
 * created, once, "on first use" — the first time a workspace is discovered with
 * NEITHER candidate ledger file present. The pinning rule (never relocate a live
 * ledger) still runs first, so this is a pure no-op for every already-ledgered
 * workspace — see tests/unit/discovery.test.mjs's LEDGER PINNING case, unchanged.
 *
 * This is the same sequence `.github/workflows/test.yml`'s "fresh-machine install
 * reaches doctor-clean" step runs, minus the `|| true` that hid the bug (removed in
 * the same change). The fixture declares one real edge (not `sources: {}`) because
 * `bootstrap --apply`'s baseline-from-git needs a co-committed source+downstream pair
 * to write even one event — doctor's "event store non-empty" check can never pass on
 * an empty sidecar, independent of the ledger-creation bug this test targets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`), code: r.status };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

/**
 * Builds a fresh "stranger machine": an isolated HOME, an isolated
 * PROPAGATE_STATE_DIR under it, and one real git repo with one declared edge —
 * the same shape as the CI fixture. Nothing here touches the real machine's
 * $HOME or ~/.propagate.
 */
function strangerMachine() {
  const home = mkdtempSync(path.join(tmpdir(), "propagate-stranger-"));
  const codeRoot = path.join(home, "code");
  const wsRoot = path.join(codeRoot, "demo");
  mkdirSync(wsRoot, { recursive: true });

  writeFileSync(path.join(wsRoot, "SOURCE.md"), "# source\n");
  writeFileSync(path.join(wsRoot, "DOWNSTREAM.md"), "# downstream\n");
  writeFileSync(
    path.join(wsRoot, ".propagates.yml"),
    [
      "workspace: true",
      "sources:",
      "  SOURCE.md:",
      "    propagates_to:",
      "      - path: DOWNSTREAM.md",
      "        why: stranger-install test fixture",
      "        kind: prose",
      "",
    ].join("\n"),
  );

  git(wsRoot, ["init", "-q"]);
  git(wsRoot, ["config", "user.email", "stranger@example.com"]);
  git(wsRoot, ["config", "user.name", "stranger"]);
  git(wsRoot, ["add", "-A"]);
  git(wsRoot, ["commit", "-q", "-m", "init"]);

  const env = {
    ...process.env,
    HOME: home,
    PROPAGATE_STATE_DIR: path.join(home, ".propagate"),
  };

  return {
    home,
    codeRoot,
    wsRoot,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

test("RED regression: a fresh workspace's ledger pair does not pre-exist before setup+bootstrap", () => {
  const m = strangerMachine();
  try {
    // Nothing has run `setup` yet — this just proves the fixture itself carries no
    // ledger, so the GREEN test below is actually exercising creation, not finding
    // files that were already there.
    assert.equal(existsSync(path.join(m.wsRoot, "propagation", "ledger.jsonl")), false);
    assert.equal(existsSync(path.join(m.wsRoot, ".propagation", "ledger.jsonl")), false);
    assert.equal(existsSync(path.join(m.wsRoot, "docs", "PROPAGATION_LEDGER.jsonl")), false);
  } finally {
    m.cleanup();
  }
});

test("stranger sequence (setup -> bootstrap --apply -> doctor) reaches doctor-clean", () => {
  const m = strangerMachine();
  try {
    const setup = run(["setup", "--roots", m.codeRoot], m.env);
    assert.equal(setup.code, 0, `setup must succeed:\n${setup.out}`);

    const bootstrap = run(["bootstrap", "--baseline-from-git", "--apply"], m.env);
    assert.equal(bootstrap.code, 0, `bootstrap --apply must succeed:\n${bootstrap.out}`);

    // The gate-4 fix, asserted directly: the ledger pair now exists.
    //
    // PATHS CHANGED 2026-08-22, claim unchanged. This used to assert
    // `.propagation/ledger.{jsonl,md}` with the rationale "docs/ exists
    // nowhere in this fixture, so the legacy convention applies" — which
    // describes the accident this test was inheriting, not a requirement.
    // A brand-new workspace now pins the CANONICAL layout
    // (docs/REFERENCE.md §"Ledger layout"), so a stranger install produces
    // the same shape as every existing workspace instead of a third one.
    //
    // The gate-4 subject — a workspace with NO prior ledger gets a pair,
    // rather than doctor failing its "ledger exists" checks forever on a
    // fresh machine — is untouched.
    assert.equal(
      existsSync(path.join(m.wsRoot, "propagation", "ledger.jsonl")),
      true,
      "ledger JSONL must be created for a workspace with no prior ledger",
    );
    assert.equal(
      existsSync(path.join(m.wsRoot, "propagation", "ledger.md")),
      true,
      "ledger MD must be created for a workspace with no prior ledger",
    );
    // And the superseded layouts must NOT also appear — a stranger install
    // that created two ledgers would trip doctor's "at most one live ledger
    // file per workspace" check, which is the failure this whole file exists
    // to keep out of fresh machines.
    assert.equal(existsSync(path.join(m.wsRoot, ".propagation", "ledger.jsonl")), false);
    assert.equal(existsSync(path.join(m.wsRoot, "docs", "PROPAGATION_LEDGER.jsonl")), false);

    const doctor = run(["doctor"], m.env);
    assert.equal(
      doctor.code,
      0,
      `doctor must exit 0 after setup + bootstrap --apply on a fresh workspace:\n${doctor.out}`,
    );
    assert.match(strip(doctor.out), /doctor: all green/);
  } finally {
    m.cleanup();
  }
});
