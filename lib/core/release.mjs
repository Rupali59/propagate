/**
 * release.mjs — the gates a release must clear before a human publishes.
 *
 * WHY THIS EXISTS. docs/RELEASE.md defines a five-step release procedure. Steps
 * 1-4 are things a machine can check; step 5 ("a human publishes") is deliberately
 * NOT one of them — this module has no write path and never will. See
 * ~/.claude/plans/status-temporal-plum.md §3 for the procedure this implements,
 * and §4 for why the cross-repo coupling (step 3's real target) cannot yet be
 * declared as a propagate edge: the public repo does not exist and
 * cross-allow.yml's partner_roots is empty by design. Until it does, step 3 is a
 * documented procedure this module runs, not a coupling propagate watches.
 *
 * THE CONTRACT EVERY GATE FOLLOWS (rule:discernment-checks §2, "absence must be
 * attributable"): a gate reports exactly one of three states, and a caller must
 * never be able to confuse them —
 *
 *   "passed"         — ran, and the thing it checks is true right now.
 *   "failed"         — ran, and the thing it checks is false right now.
 *   "could-not-run"  — did not produce an answer, for a named reason.
 *
 * "could-not-run" is not a synonym for failure and must never be summarized
 * alongside "passed" as though it were one. Gate 3 (make-public --check) exits 2
 * with no identity map, which is the NORMAL case in CI (the map lives outside the
 * repo on purpose, so it cannot be published) — that is a legitimate
 * could-not-run, not a defect in the release.
 *
 * D7 (this skill's own decomposition plan): new commands land as a thin dispatch
 * arm in cli.mjs plus a lib module that holds the logic. This file is the
 * module; cli.mjs's `release` arm only parses argv and prints/exits.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTEGRATIONS } from "./config.mjs";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Gate 1 — VERSION bumped: check names all FIVE manifests. VERSION ->
// package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json
// is declared in .propagates.yml; this gate asserts the fact that declaration
// exists to protect: those four in-repo files name the same version.
//
// PR-011 (propagation/state/workspace/TODOS.md), filed 2026-09-24: a FIFTH
// manifest exists and was never read — the HUB marketplace's own
// `marketplace.json` (`skills-marketplace/.claude-plugin/marketplace.json`),
// which lists `propagate` as one entry among several rather than being about
// this plugin alone. It sat pinned at 0.5.0 for weeks while the four in-repo
// manifests moved to 0.6.2+, and nothing here noticed. Verified genuinely
// distinct before this fix: `skills-marketplace/propagate` is a symlink to
// `../propagate`, but `.claude-plugin/marketplace.json` under it is an
// ordinary file, not reached through that link.
//
// THE FIFTH DEGRADES ALONE. The first version of this fix made the WHOLE
// gate `could-not-run` whenever the hub file was unreachable — and on any
// machine without the marketplace integration configured (every machine but
// this author's, `INTEGRATIONS.marketplaceDir` is `null` by design, see
// `defaultHubMarketplacePath` below), that is EVERY run. `could-not-run`
// does not block a release (see the contract above), so the fix made the
// four-manifest check — which has caught real drift since before PR-011 —
// go dark non-blockingly on exactly the machines PR-011 cares about, which
// includes the one carrying a live divergence. Caught only because the four
// were re-verified against the real tree after landing, not by any test:
// every test built the whole time supplied all five files, so none of them
// could see a gate that answers nothing when only the fifth is missing.
// `rule:enforcement-watches-itself`'s own recorded form applies verbatim —
// "the tool that exists to make absence attributable rendered 'I looked at
// nothing' identically to 'everything is fine'." So: the four in-repo
// manifests are ALWAYS checked and ALWAYS produce a real passed/failed
// verdict; an unlocatable, missing, unparseable, or `propagate`-less hub
// file degrades only itself, and `detail` says so explicitly so "four agree,
// fifth unchecked" cannot read the same as "all five agree." `could-not-run`
// for the WHOLE gate is reserved for what it meant before this change: the
// four cannot be checked (one is missing, unparseable, or version-less).
// ---------------------------------------------------------------------------

/**
 * Where the fifth manifest lives, by default. Cross-repo — it is NOT under
 * `skillDir`, so it cannot be joined the way the other four are.
 *
 * Reuses `INTEGRATIONS.marketplaceDir` (lib/core/config.mjs:304-357) rather
 * than deriving a second hub path here: that value already resolves the hub's
 * `skills-marketplace/` directory (env override, config file, or the
 * pre-integration-layer legacy default under `HUB_ROOT`), and a second lookup
 * would be the exact "second reporting mechanism duplicates the first" shape
 * `propagation/state/workspace/GOTCHAS.md` G20 warns against.
 *
 * Returns null when the integration is unconfigured — which, per
 * `lib/skills/skills-lifecycle.mjs:43-61`, is every machine but this author's
 * by design. The caller must turn that into a named `could-not-run` reason,
 * never silently drop the fifth manifest from the check (a gate whose scan
 * root falls back to "nothing found" the moment it is not this author's
 * machine reports success on every other checkout — the exact failure
 * `rule:enforcement-watches-itself` names).
 */
function defaultHubMarketplacePath() {
  return INTEGRATIONS.marketplaceDir
    ? path.join(INTEGRATIONS.marketplaceDir, ".claude-plugin", "marketplace.json")
    : null;
}

/**
 * The fifth manifest, read in ISOLATION from the four in-repo ones — nothing
 * here can turn a four-manifest verdict into a whole-gate could-not-run.
 * Never throws; every failure mode returns `{ ok: false, reason }`, and the
 * caller decides how that reason folds into `detail` alongside the real
 * four-manifest verdict.
 *
 * @returns {{ok: true, version: string, path: string}|{ok: false, reason: string}}
 */
function readHubManifest(hubMarketplacePath) {
  if (!hubMarketplacePath) {
    return {
      ok: false,
      reason:
        "location unknown — INTEGRATIONS.marketplaceDir is not configured " +
        "(set PROPAGATE_MARKETPLACE_DIR, or marketplaceDir in config.yml) — a NORMAL state on " +
        "every machine but this author's (lib/skills/skills-lifecycle.mjs:43-61), not a defect",
    };
  }
  if (!existsSync(hubMarketplacePath)) {
    return { ok: false, reason: `not found at ${hubMarketplacePath}` };
  }
  let hubJson;
  try {
    hubJson = JSON.parse(readFileSync(hubMarketplacePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `${hubMarketplacePath} unparseable: ${err.message}` };
  }
  // Shaped differently from the other four: it lists SEVERAL plugins, and
  // `propagate` is whichever array entry names it — never `.plugins[0]`,
  // which on this hub is `quarantine`. A `find()` that comes back empty (the
  // entry renamed, or removed) is its own named reason, never a bare
  // `undefined` read as "no version" — absence has to be attributable
  // (rule:discernment-checks §2).
  const hubEntry = Array.isArray(hubJson?.plugins) ? hubJson.plugins.find((p) => p?.name === "propagate") : undefined;
  if (!hubEntry || hubEntry.version == null || hubEntry.version === "") {
    return { ok: false, reason: `${hubMarketplacePath} has no "propagate" entry in its plugins[] array` };
  }
  return { ok: true, version: hubEntry.version, path: hubMarketplacePath };
}

export function gateVersionManifests({ skillDir = SKILL_DIR, hubMarketplacePath = defaultHubMarketplacePath() } = {}) {
  const name = "version-manifests";

  // The four in-repo manifests — checked exactly as before PR-011, and this
  // block alone decides could-not-run for the whole gate. The fifth (below)
  // can never widen a could-not-run into this block, nor shrink one.
  const files = {
    VERSION: path.join(skillDir, "VERSION"),
    "package.json": path.join(skillDir, "package.json"),
    ".claude-plugin/plugin.json": path.join(skillDir, ".claude-plugin", "plugin.json"),
    ".claude-plugin/marketplace.json": path.join(skillDir, ".claude-plugin", "marketplace.json"),
  };
  const missing = Object.entries(files)
    .filter(([, p]) => !existsSync(p))
    .map(([k]) => k);
  if (missing.length) {
    return {
      name,
      status: "could-not-run",
      reason: `missing manifest(s): ${missing.join(", ")}`,
      versions: {},
    };
  }

  let versions;
  try {
    versions = {
      VERSION: readFileSync(files.VERSION, "utf8").trim(),
      "package.json": JSON.parse(readFileSync(files["package.json"], "utf8")).version,
      ".claude-plugin/plugin.json": JSON.parse(readFileSync(files[".claude-plugin/plugin.json"], "utf8")).version,
      ".claude-plugin/marketplace.json": JSON.parse(readFileSync(files[".claude-plugin/marketplace.json"], "utf8"))
        ?.plugins?.[0]?.version,
    };
  } catch (err) {
    return { name, status: "could-not-run", reason: `manifest unparseable: ${err.message}`, versions: {} };
  }

  const values = Object.values(versions);
  const allPresent = values.every((v) => v != null && v !== "");
  if (!allPresent) {
    return {
      name,
      status: "could-not-run",
      reason: `one or more manifests carry no version: ${JSON.stringify(versions)}`,
      versions,
    };
  }
  const fourAgree = values.every((v) => v === values[0]);

  // The fifth. Read in isolation (readHubManifest never throws) and folded
  // in ONLY as a passed/failed distinction, never as could-not-run for the
  // whole gate — see the header note above this function for why.
  const hub = readHubManifest(hubMarketplacePath);

  if (!hub.ok) {
    // "Four agree, fifth unchecked" must never render the same as "all five
    // agree" — the whole point of this fix. Said explicitly in `detail`,
    // since that is the only field the CLI prints (cli.mjs:1563).
    return {
      name,
      status: fourAgree ? "passed" : "failed",
      detail: fourAgree
        ? `the four in-repo manifests agree at ${values[0]} — hub marketplace.json UNCHECKED: ${hub.reason}`
        : `disagreement among the four in-repo manifests — ${Object.entries(versions)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")} — hub marketplace.json UNCHECKED: ${hub.reason}`,
      versions,
    };
  }

  versions["hub marketplace.json"] = hub.version;
  const allSame = fourAgree && hub.version === values[0];

  return {
    name,
    status: allSame ? "passed" : "failed",
    detail: allSame
      ? `all five manifests agree at ${values[0]}`
      : `disagreement — ${Object.entries(versions)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
    versions,
  };
}

// ---------------------------------------------------------------------------
// Gate 2 — suite green on the floor. Runs `npm test` (this repo's own script
// wraps `node --test`) in skillDir and parses node:test's own summary lines.
// The full CI matrix (node 20/22/24, 20 expected to fail as the below-floor
// probe — .github/workflows/test.yml) is NOT reproduced here: this gate is a
// single-version local signal, and says so in its detail line rather than
// implying it is the floor measurement.
// ---------------------------------------------------------------------------

export function gateSuite({ skillDir = SKILL_DIR, env = process.env, timeoutMs = 10 * 60 * 1000 } = {}) {
  const name = "suite";
  let r;
  try {
    r = spawnSync("npm", ["test"], {
      cwd: skillDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
  } catch (err) {
    return { name, status: "could-not-run", reason: `could not spawn npm test: ${err.message}` };
  }
  if (r.error) {
    return { name, status: "could-not-run", reason: `could not spawn npm test: ${r.error.message}` };
  }

  // node:test's summary line is prefixed differently by reporter: the TAP
  // reporter (piped, non-TTY in some node versions) writes "# pass N"; the
  // default "spec" reporter writes "ℹ pass N". Both are the same summary —
  // match either glyph rather than assuming one. Measured against a real
  // `npm test` run on this machine: it emits "ℹ", not "#" (this gate's first
  // real run misreported could-not-run over exactly this, npm test having
  // actually passed 762/0 — see docs/DECISIONS.md / this file's own history).
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const passMatch = out.match(/(?:#|ℹ)\s*pass\s+(\d+)/);
  const failMatch = out.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
  const testsMatch = out.match(/(?:#|ℹ)\s*tests\s+(\d+)/);
  if (!passMatch || !failMatch) {
    return {
      name,
      status: "could-not-run",
      reason: "suite output did not contain a parseable node:test summary (pass / fail counts)",
      nodeVersion: process.version,
      raw: out.slice(-2000),
    };
  }

  const passed = Number(passMatch[1]);
  const failed = Number(failMatch[1]);
  const total = testsMatch ? Number(testsMatch[1]) : passed + failed;
  const ok = r.status === 0 && failed === 0;

  return {
    name,
    status: ok ? "passed" : "failed",
    detail:
      `${passed} pass / ${failed} fail / ${total} tests (node ${process.version}) — ` +
      `single-version local run, not the CI floor matrix; see .github/workflows/test.yml for node 20/22/24`,
    passed,
    failed,
    total,
    nodeVersion: process.version,
  };
}

// ---------------------------------------------------------------------------
// Gate 3 — make-public --check: scrub complete, watchlist satisfied, else
// refuse. Runs the REAL bin/make-public.mjs (never reimplemented here — the
// scrub living in two places is exactly how the two repos would drift). exit 2
// (no map / empty map / unmapped watchlist directory) is could-not-run, never a
// failure: that is the designed refusal, and it is the expected state in CI.
// ---------------------------------------------------------------------------

export function gateMakePublicCheck({ skillDir = SKILL_DIR, env = process.env } = {}) {
  const name = "make-public-check";
  const outDir = mkdtempSync(path.join(tmpdir(), "propagate-release-check-"));
  try {
    const r = spawnSync(process.execPath, [path.join(skillDir, "bin", "make-public.mjs"), "--out", outDir, "--check"], {
      cwd: skillDir,
      encoding: "utf8",
      env,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    if (r.error) {
      return { name, status: "could-not-run", reason: `could not spawn make-public.mjs: ${r.error.message}`, raw: out };
    }
    if (r.status === 2) {
      const firstLine =
        out
          .split("\n")
          .map((l) => l.trim())
          .find(Boolean) || "make-public.mjs refused (exit 2)";
      return { name, status: "could-not-run", reason: firstLine, raw: out };
    }
    if (r.status === 0) {
      const summary = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-2)
        .join(" / ");
      return { name, status: "passed", detail: summary || "clean — no forbidden pattern survives", raw: out };
    }
    return { name, status: "failed", detail: `make-public --check exited ${r.status} — private content survived the scrub`, raw: out };
  } finally {
    // `force` covers ENOENT, NOT ENOTEMPTY — a concurrent writer inside the tree
    // makes the unlink race. Third instance of this flake; see the two in
    // tests/. maxRetries is what actually fixes it.
    rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------
// Gate 4 — stranger install: HOME=$(mktemp -d): setup -> bootstrap -> doctor
// clean. Builds a throwaway demo workspace (git repo, one real declared edge
// so bootstrap has something to baseline) under an isolated HOME, then runs
// the REAL cli.mjs through the documented setup sequence (SKILL.md § Setup).
// Reports whatever doctor's actual exit code says — this gate does not force
// a pass; if a fresh install cannot reach doctor-clean today that is real
// information about the rest of the tool, not something to paper over here.
// ---------------------------------------------------------------------------

export function gateStrangerInstall({ skillDir = SKILL_DIR } = {}) {
  const name = "stranger-install";
  const cliPath = path.join(skillDir, "cli.mjs");
  if (!existsSync(cliPath)) {
    return { name, status: "could-not-run", reason: `no cli.mjs under ${skillDir}` };
  }

  const home = mkdtempSync(path.join(tmpdir(), "propagate-release-stranger-"));
  try {
    const codeRoot = path.join(home, "code");
    const demo = path.join(codeRoot, "demo");
    mkdirSync(demo, { recursive: true });

    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: demo });
      execFileSync("git", ["config", "user.email", "stranger@example.com"], { cwd: demo });
      execFileSync("git", ["config", "user.name", "stranger"], { cwd: demo });
    } catch (err) {
      return { name, status: "could-not-run", reason: `could not set up the demo git repo: ${err.message}` };
    }

    writeFileSync(
      path.join(demo, ".propagates.yml"),
      "workspace: true\nsources:\n  spec.md:\n    propagates_to:\n      - path: impl.md\n" +
        "        why: release --check stranger-install fixture — a real edge so bootstrap has something to baseline\n" +
        "        kind: prose\n",
    );
    writeFileSync(path.join(demo, "spec.md"), "spec v1\n");
    writeFileSync(path.join(demo, "impl.md"), "impl v1\n");
    execFileSync("git", ["add", "-A"], { cwd: demo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: demo });

    const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: path.join(home, ".propagate") };
    const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });

    const setup = run(["setup", "--roots", codeRoot]);
    if (setup.error) {
      return { name, status: "could-not-run", reason: `could not spawn setup: ${setup.error.message}` };
    }
    if (setup.status !== 0) {
      return {
        name,
        status: "failed",
        detail: `setup exited ${setup.status}`,
        stages: { setup: setup.status, bootstrap: null, doctor: null },
        raw: `${setup.stdout ?? ""}${setup.stderr ?? ""}`,
      };
    }

    const bootstrap = run(["bootstrap", "--baseline-from-git", "--apply"]);
    const doctor = run(["doctor"]);
    if (doctor.error) {
      return {
        name,
        status: "could-not-run",
        reason: `could not spawn doctor: ${doctor.error.message}`,
        stages: { setup: setup.status, bootstrap: bootstrap.status ?? null, doctor: null },
      };
    }

    const doctorOut = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
    const summaryLine = (doctorOut.match(/doctor:.*$/m) || [""])[0].trim();
    const ok = doctor.status === 0;

    return {
      name,
      status: ok ? "passed" : "failed",
      detail: ok
        ? "setup -> bootstrap --apply -> doctor: clean"
        : `doctor exited ${doctor.status} after setup + bootstrap --apply${summaryLine ? ` — ${summaryLine}` : ""}`,
      stages: { setup: setup.status, bootstrap: bootstrap.status, doctor: doctor.status },
      raw: doctorOut,
    };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------
// The aggregate. A could-not-run gate must never let the run read as "ready" —
// it makes the run "incomplete", distinct from "blocked" (an actual failure).
// ---------------------------------------------------------------------------

export function runReleaseCheck({
  skillDir = SKILL_DIR,
  manifestsDir = skillDir,
  hubMarketplacePath, // undefined -> gateVersionManifests' own default (defaultHubMarketplacePath())
  suiteDir = skillDir,
  suiteEnv = process.env,
  makePublicEnv = process.env,
} = {}) {
  const gates = [
    gateVersionManifests({ skillDir: manifestsDir, hubMarketplacePath }),
    gateSuite({ skillDir: suiteDir, env: suiteEnv }),
    gateMakePublicCheck({ skillDir, env: makePublicEnv }),
    gateStrangerInstall({ skillDir }),
  ];

  const failed = gates.filter((g) => g.status === "failed");
  const couldNotRun = gates.filter((g) => g.status === "could-not-run");

  const overall = failed.length ? "blocked" : couldNotRun.length ? "incomplete" : "ready";
  const exitCode = failed.length ? 1 : couldNotRun.length ? 2 : 0;

  return { generatedAt: new Date().toISOString(), gates, overall, exitCode };
}
