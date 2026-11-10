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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTEGRATIONS } from "./config.mjs";
import { classify, claudeVersion, validatePlugin, isTrackedIn } from "./plugin-validate.mjs";
import { CLAUDE_KNOWN_MARKETPLACES, CLAUDE_INSTALLED_PLUGINS } from "./paths.mjs";
import { checkBump, classify as classifyCommits, requiredBump, nextVersion } from "./release-kind.mjs";
import { readKnownMarketplaces, readInstalledPlugins, inPlaceMarketplace } from "../report/doctor/delivery.mjs";
import { lastTag, messagesSince, tagVersion, previousReleaseTag, isGitRepo } from "./release-git.mjs";
import { checkTagsAtHead } from "./release-tags.mjs";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 2026-10-17: propagate now loads in place (`propagate@propagate`), so the hub
// marketplace no longer lists it and the fifth manifest below is optional on
// purpose; the delivery step after a release is `/reload-plugins`, not
// `claude plugin update`.
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
    return { ok: false, notListed: true, reason: `${hubMarketplacePath} has no "propagate" entry in its plugins[] array` };
  }
  return { ok: true, version: hubEntry.version, path: hubMarketplacePath };
}

export function gateVersionManifests({
  skillDir = SKILL_DIR,
  hubMarketplacePath = defaultHubMarketplacePath(),
  knownMarketplacesPath = CLAUDE_KNOWN_MARKETPLACES,
  installedPluginsPath = CLAUDE_INSTALLED_PLUGINS,
} = {}) {
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

  // A hub that does not list propagate is NOT always a lapse. Since 2026-10-17 propagate is its own
  // directory marketplace and loads in place, so the hub file is no longer a delivery path at all, and
  // "UNCHECKED" on every release would train people to read past the one time the entry vanished by
  // accident. So absence is accepted ONLY when doctor's own in-place test (known_marketplaces.json: a
  // directory source whose realpath is THIS skillDir, with propagate@<it> installed) says so. A fixture
  // skillDir never matches, which keeps the renamed-entry test meaning what it meant.
  if (!hub.ok && hub.notListed && fourAgree) {
    const known = readKnownMarketplaces(knownMarketplacesPath);
    const served = known.data
      ? inPlaceMarketplace({ knownMarketplaces: known.data, installedPlugins: readInstalledPlugins(installedPluginsPath), repoRoot: skillDir })
      : null;
    if (served) {
      return {
        name,
        status: "passed",
        detail: `the four in-repo manifests agree at ${values[0]} — the hub marketplace.json is not a delivery path: propagate loads in place from marketplace "${served}"`,
        versions,
      };
    }
  }

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

/** The XML entities node's junit reporter writes into attribute values. */
function xmlDecode(v) {
  return String(v).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** npm's own `> pkg@ver test:<name>` header lines, with their offsets. A nested `npm test --prefix` prints a plain `test` header, which names nothing. */
function npmSuiteHeaders(out) {
  return [...out.matchAll(/^> (?:\S+ )?test:(\S+)[ \t]*$/gm)].map((m) => ({ name: m[1], at: m.index }));
}

/**
 * Per-suite results from node:test's built-in junit reporter (`--test-reporter=junit`), one `<testsuites>` document per
 * `node --test` run. Totals are the reporter's own counters (`<!-- tests N -->` ...), the same numbers the spec summary
 * prints; failing tests are the `<testcase>` elements carrying a `<failure>` or `<error>`. A suite is named by the last
 * npm `test:<name>` header before its document.
 */
function parseJunitSuites(out, headers) {
  const suites = [];
  for (const doc of out.matchAll(/<testsuites>[\s\S]*?<\/testsuites>/g)) {
    const xml = doc[0];
    const counter = (k) => {
      const m = xml.match(new RegExp(`<!--\\s*${k}\\s+(\\d+)\\s*-->`));
      return m ? Number(m[1]) : null;
    };
    // The attribute scan skips quoted values whole: node escapes `<` and `&` in a test name but leaves `>` bare.
    const cases = [...xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
    const failing = cases
      .filter((c) => /<(failure|error)\b/.test(c[2] ?? ""))
      .map((c) => xmlDecode((c[1].match(/\bname="([^"]*)"/) || [, "(unnamed test)"])[1]));
    const fail = counter("fail") ?? failing.length;
    const tests = counter("tests") ?? cases.length;
    const pass = counter("pass") ?? tests - fail;
    const header = headers.filter((h) => h.at < doc.index).pop();
    suites.push({ name: header?.name ?? null, pass, fail, total: tests, failing });
  }
  return suites;
}

/**
 * The fallback, for output that is not junit (a fixture's own printed summary, or a node that ignores the reporter flag):
 * every `pass` / `fail` / `tests` summary line, matched in order and ONLY at the start of a line (npm echoes a script's own command, so
 * a fixture printing "# pass 3" appears twice; first-match hid that, `matchAll` does not). node:test's summary is prefixed differently by
 * reporter: TAP writes "# pass N", the "spec" reporter writes "ℹ pass N". Both are the same summary, so match either
 * glyph (this gate's first real run misreported could-not-run over exactly that, npm test having passed 762/0).
 */
function parseTextSuites(out, headers) {
  const all = (k) => [...out.matchAll(new RegExp(`^(?:#|ℹ)[ \\t]*${k}[ \\t]+(\\d+)`, "gm"))];
  const P = all("pass");
  const F = all("fail");
  const T = all("tests");
  const n = Math.min(P.length, F.length);
  const suites = [];
  for (let i = 0; i < n; i++) {
    const pass = Number(P[i][1]);
    const fail = Number(F[i][1]);
    const header = headers.filter((h) => h.at < P[i].index).pop();
    suites.push({ name: header?.name ?? null, pass, fail, total: T.length === n ? Number(T[i][1]) : pass + fail, failing: [] });
  }
  // The names node prints after "✖ failing tests:", each given to the nearest failing suite whose summary line precedes
  // it, or to the first failing suite when the block comes first.
  const failedIdx = suites.map((s, i) => (s.fail > 0 ? i : -1)).filter((i) => i >= 0);
  if (failedIdx.length) {
    for (const marker of out.matchAll(/^✖ failing tests:/gm)) {
      // The block ends where npm announces the next script, so one suite's inline ✖ lines are not read as another's.
      const rest = out.slice(marker.index + marker[0].length).split(/^> /m)[0];
      for (const m of rest.matchAll(/^✖ (.+?)(?: \([\d.]+m?s\))?$/gm)) {
        const at = marker.index + marker[0].length + m.index;
        const owner = failedIdx.filter((i) => F[i].index < at).pop() ?? failedIdx[0];
        if (!suites[owner].failing.includes(m[1])) suites[owner].failing.push(m[1]);
      }
    }
  }
  return suites;
}

const FAILING_SHOWN = 5;

// The title of the map's own membership test. tests/unit/test-impact.test.mjs uses this constant as its
// test() title, so renaming that test cannot silently switch off the self-heal below (#235).
export const MAP_MEMBERSHIP_TEST = "every test file is in the map, and the map names no test that is gone";

export function gateSuite({ skillDir = SKILL_DIR, env = process.env, timeoutMs = 10 * 60 * 1000 } = {}) {
  const name = "suite";
  // The full run here is also the test-impact map's refresh (DECISIONS 2026-10-17: the recorded map
  // is committed and refreshed by the run release already does, Hammant's practice). The recorder is a
  // preload that writes only under TESTIMPACT_DIR; measured overhead was within run-to-run noise. It is
  // switched on only where the repo carries the map builder, so a fixture skillDir (the release tests)
  // runs exactly as before, and never when the caller is already recording.
  const mapScript = path.join(skillDir, "scripts", "test-impact", "map.mjs");
  const recorder = path.join(skillDir, "scripts", "test-impact", "record.mjs");
  const record = existsSync(mapScript) && existsSync(recorder) && !env.TESTIMPACT_DIR;
  const recordDir = record ? mkdtempSync(path.join(tmpdir(), "propagate-impact-")) : null;
  // node:test's own junit reporter, switched on through NODE_OPTIONS so neither npm script is edited: it reaches both
  // `node --test` runs (propagate's, and curate-docs' through `npm test --prefix`). Proven by a two-suite probe, #115.
  // It writes the XML to stdout, where npm's own `> pkg test:<name>` headers already say which suite each document is.
  // Added once: this gate also runs inside a suite that an outer gate already switched to junit (the release tests do),
  // and a doubled reporter prints every document twice.
  const hasJunit = /--test-reporter[= ]junit\b/.test(env.NODE_OPTIONS ?? "");
  const nodeOptions = [env.NODE_OPTIONS, hasJunit ? null : "--test-reporter=junit", record ? `--import ${recorder}` : null].filter(Boolean).join(" ");
  const runEnv = { ...env, NODE_OPTIONS: nodeOptions, ...(record ? { TESTIMPACT_DIR: recordDir } : {}) };
  let r;
  try {
    r = spawnSync("npm", ["test"], {
      cwd: skillDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: runEnv,
    });
  } catch (err) {
    return { name, status: "could-not-run", reason: `could not spawn npm test: ${err.message}` };
  }
  if (r.error) {
    return { name, status: "could-not-run", reason: `could not spawn npm test: ${r.error.message}` };
  }

  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const headers = npmSuiteHeaders(out);
  let source = "junit";
  let suites = parseJunitSuites(out, headers);
  if (!suites.length) {
    source = "text";
    suites = parseTextSuites(out, headers);
  }
  if (!suites.length) {
    return {
      name,
      status: "could-not-run",
      reason: "suite output did not contain a parseable node:test summary (pass / fail counts)",
      nodeVersion: process.version,
      raw: out.slice(-2000),
    };
  }

  // Name each suite: npm's header when there was one, "suite N" otherwise. A suite npm announced and that printed no
  // summary (it crashed before reporting) is reported, and the gate fails: never summed as if the run were complete.
  suites.forEach((s, i) => { s.name = s.name ?? `suite ${i + 1}`; });
  const announced = [...new Set(headers.map((h) => h.name))];
  const silent = announced.filter((n) => !suites.some((s) => s.name === n));
  const expected = announced.length || suites.length;
  const incomplete = silent.length > 0;

  const passed = suites.reduce((a, s) => a + s.pass, 0);
  const failed = suites.reduce((a, s) => a + s.fail, 0);
  const total = suites.reduce((a, s) => a + s.total, 0);
  const ok = r.status === 0 && failed === 0 && !incomplete;
  const failing = suites.flatMap((s) => s.failing.map((t) => (suites.length > 1 && !s.name.startsWith("suite ") ? `${s.name} › ${t}` : t)));

  // The map is written only from a green run: a red run lacks the deps of whatever aborted. Its
  // outcome rides in the detail line either way, so "not refreshed" is never silent (discernment §2).
  // A map failure does not fail the gate: the suite's verdict is the gate, the map is a by-product.
  //
  // ONE exception (#235): a run whose only red test is the map's own membership assertion. That run
  // completed every test, so its recording is whole; the red is the stale map, not the code. Without
  // this, every release adding a test file deadlocked (no green run, so no map, so no green run) and
  // needed a hand rebuild. The map is rebuilt with --allow-red and the gate passes ONLY if the map test
  // then passes against the map just written. Any other red test keeps the refusal.
  const mapTest = path.join(skillDir, "tests", "unit", "test-impact.test.mjs");
  const onlyMembership = record && !ok && !incomplete && failed > 0 && failing.length === failed &&
    failing.every((t) => t === MAP_MEMBERSHIP_TEST || t.endsWith(` › ${MAP_MEMBERSHIP_TEST}`)) && existsSync(mapTest);
  let mapNote = "";
  let mapFailure = null;
  let healed = false;
  if (record) {
    if (!ok && !onlyMembership) mapNote = " · test-impact map NOT refreshed (suite not green)";
    else {
      const mapArgs = onlyMembership ? ["--reuse", "--allow-red", "--dir", recordDir] : ["--reuse", "--dir", recordDir];
      const m = spawnSync(process.execPath, [mapScript, ...mapArgs], { cwd: skillDir, encoding: "utf8", env });
      // The reason is the first line naming an error, not the last line: a crash's last stderr line is
      // node's "Node.js v25.9.0" trailer, which is what the first real run reported (2026-10-17).
      const lines = `${m.stderr || ""}\n${m.stdout || ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
      const why = lines.find((l) => /\b\w*Error\b|refus|not green|missing/i.test(l)) || lines.find((l) => !/^Node\.js v/.test(l)) || `exit ${m.status}`;
      mapNote = m.status !== 0
        ? ` · test-impact map NOT refreshed: ${why}`
        : onlyMembership
          ? ` · test-impact map rebuilt: the only red test was its own membership assertion (${failed} fail healed)`
          : " · test-impact map refreshed (tests/impact-map.json)";
      // CHECK THE MAP THIS RUN WROTE, not the one it started with. The suite above ran against the map
      // on disk BEFORE this rewrite, so a bad recording (v0.15.28's: 4 unowned npm processes) passed
      // its own gate and turned main red one release later. The map's own test file is re-run against
      // the fresh map; it takes seconds. A red here fails the gate: the map is a committed artifact.
      if (m.status === 0 && existsSync(mapTest)) {
        const c = spawnSync(process.execPath, ["--test", mapTest], {
          cwd: skillDir,
          encoding: "utf8",
          timeout: 5 * 60 * 1000,
          // NODE_TEST_CONTEXT is dropped: inherited from an enclosing node --test run, it makes this run a
          // child of THAT runner, which reports results upward and exits 0 on failure (measured in the test).
          env: { ...env, NODE_TEST_CONTEXT: undefined, PROPAGATE_STATE_DIR: env.PROPAGATE_STATE_DIR || path.join(tmpdir(), "propagate-test-state") },
        });
        if (c.status !== 0) {
          const first = `${c.stdout || ""}\n${c.stderr || ""}`.split("\n").map((l) => l.trim()).find((l) => /Error|✖|not ok/.test(l)) || `exit ${c.status}`;
          mapFailure = `the test-impact map this run wrote fails its own check (tests/unit/test-impact.test.mjs): ${first}`;
        } else if (onlyMembership) {
          healed = true;
        }
      }
    }
    try { rmSync(recordDir, { recursive: true, force: true }); } catch { /* temp dir; the OS reaps it */ }
  }

  const across = suites.length > 1 ? ` across ${suites.length} suites (${suites.map((s) => `${s.name} ${s.pass}/${s.fail}`).join(" · ")})` : "";
  const readNote = incomplete ? ` — read ${suites.length} of ${expected} suite summaries — ${silent.join(", ")} printed none` : "";
  const failingNote = failing.length
    ? `\n${" ".repeat(25)}failing: ${failing.slice(0, FAILING_SHOWN).join("; ")}` +
      (failing.length > FAILING_SHOWN ? ` … and ${failing.length - FAILING_SHOWN} more (npm test for the full list)` : "")
    : "";

  return {
    name,
    status: (ok || healed) && !mapFailure ? "passed" : "failed",
    detail:
      (mapFailure ? `${mapFailure} — ` : "") +
      `${passed} pass / ${failed} fail / ${total} tests${across} (node ${process.version})${readNote} — ` +
      `single-version local run, not the CI floor matrix; see .github/workflows/test.yml for node 20/22/24` + mapNote + failingNote,
    passed,
    failed,
    total,
    suites: suites.map(({ name: n, pass, fail, total: t }) => ({ name: n, pass, fail, total: t })),
    failing,
    source,
    nodeVersion: process.version,
  };
}

// ---------------------------------------------------------------------------
// Gate — plugin-validate: Claude's own `claude plugin validate --json` on this plugin (#115). Before this the release
// gates never ran Claude's validator, so a release could ship a plugin Claude itself would warn about. The reading of
// its report (`classify`, the pinned warnings) is lib/core/plugin-validate.mjs, shared with the test. The `claude` CLI
// is not on CI runners: the gate is then "skipped", stated and non-blocking, never a silent pass.
// ---------------------------------------------------------------------------

export function gatePluginValidate({ skillDir = SKILL_DIR, claudeBin = "claude" } = {}) {
  const name = "plugin-validate";
  const version = claudeVersion({ bin: claudeBin });
  if (version === null) {
    return { name, status: "skipped", reason: "skipped — the claude CLI is not installed here" };
  }
  const report = validatePlugin(skillDir, { bin: claudeBin });
  const r = classify(report, { isTracked: isTrackedIn(skillDir) });
  const label = `claude plugin validate (${version})`;
  if (r.unexpected[0]?.startsWith("unrecognised validator report shape")) {
    const seen = report?.unparsed ? ` — it printed: ${String(report.unparsed).trim().slice(0, 200)}` : "";
    return { name, status: "failed", detail: `${label}: ${r.unexpected[0]}${seen}`, ...r };
  }
  const problems = [];
  if (r.unexpected.length) problems.push(`new validator warning: ${r.unexpected.join("; ")} — fix it or pin it in KNOWN_WARNINGS`);
  if (r.directoryUnexpected.length) problems.push(`new plugin-directory finding: ${r.directoryUnexpected.join("; ")} — fix it or pin its code in KNOWN_DIRECTORY`);
  if (!r.passed && !problems.length) problems.push("the validator did not pass");
  if (problems.length) return { name, status: "failed", detail: `${label}: ${problems.join(" · ")}`, ...r };
  const pinned = r.pinnedWarnings.length ? `${r.pinnedWarnings.length} pinned warning${r.pinnedWarnings.length === 1 ? "" : "s"} (${r.pinnedWarnings.join("; ")})` : "0 warnings";
  const dir = `directory: ${r.pinnedDirectory.length ? `${r.pinnedDirectory.join(", ")} pinned` : "no findings"}, 0 tracked OS files${r.untrackedOsFiles ? ` (${r.untrackedOsFiles} untracked ignored)` : ""}`;
  return { name, status: "passed", detail: `${label}: passed · ${pinned} · ${dir}`, ...r };
}

// ---------------------------------------------------------------------------
// Gate 3 — make-public --check: scrub complete, watchlist satisfied, else
// refuse. Runs the REAL scripts/make-public.mjs (never reimplemented here — the
// scrub living in two places is exactly how the two repos would drift). exit 2
// (no map / empty map / unmapped watchlist directory) is could-not-run, never a
// failure: that is the designed refusal, and it is the expected state in CI.
// ---------------------------------------------------------------------------

export function gateMakePublicCheck({ skillDir = SKILL_DIR, env = process.env } = {}) {
  const name = "make-public-check";
  const outDir = mkdtempSync(path.join(tmpdir(), "propagate-release-check-"));
  try {
    const r = spawnSync(process.execPath, [path.join(skillDir, "scripts", "make-public.mjs"), "--out", outDir, "--check"], {
      cwd: skillDir,
      encoding: "utf8",
      env,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    if (r.error) {
      return { name, status: "could-not-run", reason: `could not spawn make-public.mjs: ${r.error.message}`, raw: out };
    }
    if (r.status === 2) {
      // The first PARAGRAPH, not the first line: the refusal is "1 WATCHLIST DIRECTORY IS UNMAPPED:" with the
      // directory on the next line, and the first line alone named nothing (discernment §2; seen 2026-11-04).
      const lines = out.split("\n").map((l) => l.trim());
      const start = lines.findIndex(Boolean);
      const end = start < 0 ? -1 : lines.indexOf("", start);
      const firstLine =
        (start < 0 ? "" : lines.slice(start, end < 0 ? undefined : end).join(" ")) ||
        "make-public.mjs refused (exit 2)";
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

/**
 * The throwaway machine the stranger-install gate runs on, and the upgrade-path gate reuses (#236, which must not copy
 * it): an isolated HOME and state dir, and a git-initialized demo workspace with one real declared edge so
 * `bootstrap` has something to baseline.
 * @returns {{ok: true, home: string, codeRoot: string, demo: string, env: object, cleanup: () => void}
 *   | {ok: false, reason: string}}
 */
export function buildStrangerFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "propagate-release-stranger-"));
  const cleanup = () => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const codeRoot = path.join(home, "code");
  const demo = path.join(codeRoot, "demo");
  mkdirSync(demo, { recursive: true });

  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: demo });
    execFileSync("git", ["config", "user.email", "stranger@example.com"], { cwd: demo });
    execFileSync("git", ["config", "user.name", "stranger"], { cwd: demo });
  } catch (err) {
    cleanup();
    return { ok: false, reason: `could not set up the demo git repo: ${err.message}` };
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
  return { ok: true, home, codeRoot, demo, env, cleanup };
}

export function gateStrangerInstall({ skillDir = SKILL_DIR } = {}) {
  const name = "stranger-install";
  const cliPath = path.join(skillDir, "cli.mjs");
  if (!existsSync(cliPath)) {
    return { name, status: "could-not-run", reason: `no cli.mjs under ${skillDir}` };
  }

  const fx = buildStrangerFixture();
  if (!fx.ok) return { name, status: "could-not-run", reason: fx.reason };
  const { home, codeRoot, env } = fx;
  try {
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
// Gate — release-kind (#234): the version bump must match the KIND of the commits.
//
// What it can see: the COMMITTED range (commits since the last v* tag) and the working-tree VERSION against that tag.
// What it cannot: the pending release commit's own type, which does not exist yet when this runs. That is checked by
// .githooks/commit-msg when the commit is written, and this gate SAYS so in every result (never silent on the
// missing input, rule:discernment-checks §2).
// Fails on: VERSION equal to the tag while commits exist since it; a bump below what the committed subjects need.
// ---------------------------------------------------------------------------

const HOOK_NOTE = "the pending commit's own type is checked by .githooks/commit-msg when it is written, not here";

export function gateReleaseKind({ skillDir = SKILL_DIR } = {}) {
  const name = "release-kind";
  const versionFile = path.join(skillDir, "VERSION");
  if (!existsSync(versionFile)) return { name, status: "could-not-run", reason: "no VERSION file" };
  const version = readFileSync(versionFile, "utf8").trim();

  const t = lastTag(skillDir);
  if (!t.tag) return { name, status: "could-not-run", reason: `no v* tag reachable from HEAD (${t.reason}); the commit range is unknown` };
  const log = messagesSince(skillDir, t.tag);
  if (!log.ok) return { name, status: "could-not-run", reason: `could not read commits since ${t.tag}: ${log.reason}` };

  const prevVersion = tagVersion(t.tag);
  const cls = classifyCommits(log.messages);
  const unknownNote = cls.unknown.length ? ` Unprefixed, not counted: ${cls.unknown.map((s) => JSON.stringify(s)).join("; ")}.` : "";

  if (log.messages.length === 0) {
    // Nothing committed since the tag: any VERSION at or above the tag is consistent; below it is not.
    const r = checkBump(prevVersion, version, [], { since: t.tag });
    return r.ok
      ? { name, status: "passed", detail: `no commits since ${t.tag}; VERSION ${version}${version === prevVersion ? " == the tag" : ` is above ${prevVersion}`}. ${HOOK_NOTE}.`, required: "none", actual: r.actual }
      : { name, status: "failed", detail: r.why, required: r.required, actual: r.actual };
  }

  const r = checkBump(prevVersion, version, log.messages, { since: t.tag });
  const req = requiredBump(prevVersion, cls);
  const range = `${log.messages.length} commit(s) since ${t.tag} need a ${req} bump (${nextVersion(prevVersion, req)})`;
  return r.ok
    ? { name, status: "passed", detail: `${range}; VERSION ${version} is a ${r.actual} bump${r.above ? " (above the requirement)" : ""}.${unknownNote} ${HOOK_NOTE}.`, required: r.required, actual: r.actual }
    : { name, status: "failed", detail: `${r.why} ${HOOK_NOTE}.`, required: r.required, actual: r.actual };
}

// ---------------------------------------------------------------------------
// Gate — release-tag (#238): the release tag is an annotated propagate-vX.Y.Z (rule:release-versioning).
//
// Refuses when HEAD carries a LIGHTWEIGHT propagate-v* tag, or a v*-only tag with no propagate-v* alias. When HEAD
// carries no version tag (the normal moment this runs: the tag is made after the release PR merges) it passes and SAYS
// there was nothing to look at, rather than implying the future tag was checked (rule:discernment-checks §2).
// ---------------------------------------------------------------------------

export function gateReleaseTag({ skillDir = SKILL_DIR } = {}) {
  const name = "release-tag";
  if (!isGitRepo(skillDir)) return { name, status: "could-not-run", reason: `${skillDir} is not a git work tree; the tags are unknown` };
  return { name, ...checkTagsAtHead(skillDir) };
}

// ---------------------------------------------------------------------------
// Gate — upgrade-path (#236): an EXISTING install moving from the previous release must work, not only a fresh one.
//
// The previous version tag is extracted with `git archive | tar -x` into a temp dir. The OLD cli runs setup +
// bootstrap --apply on the stranger fixture (buildStrangerFixture, shared with stranger-install), then the NEW cli
// runs doctor + status over the SAME HOME and state dir. A failure there is a release that breaks the people who
// already have it. Then the OLD doctor runs once more over what the new version left: a downgrade check, REPORTED and
// never blocking (the convention does not promise downgrades).
//
// THE BLIND SPOT, stated in every passing result: this exercises what the fixture's one workspace persists. A shape
// only a long-lived install holds (a ledger many versions old, a user's hand-edited settings) is not built here. The
// "persisted-shape diff" from #236 (lib/ files that read or write state, changed since the tag, against a CHANGELOG
// `### Upgrading` section) is deferred. If the archived tree has no node_modules, the CURRENT one is symlinked in, so
// a dependency change between the two releases is not exercised either; the detail says which happened.
//
// No previous tag => `skipped`, stated: there is no install to upgrade from. It never reads as a pass.
// PROPAGATE_UPGRADE_PATH_SKIP=<reason> skips it knowingly, and the reason is printed.
// ---------------------------------------------------------------------------

const UPGRADE_STAGE_TIMEOUT_MS = 120_000;
const doctorSummary = (text) => (String(text).match(/doctor:.*$/m) || [""])[0].trim();

export function gateUpgradePath({ skillDir = SKILL_DIR, env = process.env, previousRef = null } = {}) {
  const name = "upgrade-path";
  if (env.PROPAGATE_UPGRADE_PATH_SKIP) {
    return { name, status: "skipped", reason: `skipped on purpose: PROPAGATE_UPGRADE_PATH_SKIP=${env.PROPAGATE_UPGRADE_PATH_SKIP}` };
  }
  const newCli = path.join(skillDir, "cli.mjs");
  if (!existsSync(newCli)) return { name, status: "could-not-run", reason: `no cli.mjs under ${skillDir}` };
  if (!isGitRepo(skillDir)) return { name, status: "could-not-run", reason: `${skillDir} is not a git work tree; the previous release is unknown` };

  const prev = previousRef ? { tag: previousRef } : previousReleaseTag(skillDir);
  if (!prev.tag) {
    return { name, status: "skipped", reason: `skipped — no previous release tag reachable from HEAD (${prev.reason}); there is no install to upgrade from` };
  }

  const work = mkdtempSync(path.join(tmpdir(), "propagate-release-upgrade-"));
  const oldTree = path.join(work, "old");
  let fx = null;
  try {
    mkdirSync(oldTree, { recursive: true });
    const tarFile = path.join(work, "old.tar");
    const arch = spawnSync("git", ["archive", "--format=tar", "-o", tarFile, prev.tag], { cwd: skillDir, encoding: "utf8" });
    if (arch.status !== 0) return { name, status: "could-not-run", reason: `git archive ${prev.tag} failed: ${(arch.stderr ?? "").trim() || `exit ${arch.status}`}` };
    const untar = spawnSync("tar", ["-xf", tarFile, "-C", oldTree], { encoding: "utf8" });
    if (untar.status !== 0) return { name, status: "could-not-run", reason: `could not extract ${prev.tag}: ${(untar.stderr ?? "").trim() || `exit ${untar.status}`}` };
    const oldCli = path.join(oldTree, "cli.mjs");
    if (!existsSync(oldCli)) return { name, status: "could-not-run", reason: `${prev.tag} has no cli.mjs at its root; nothing to run as the old version` };

    let deps = "the tag's own committed node_modules";
    if (!existsSync(path.join(oldTree, "node_modules"))) {
      const cur = path.join(skillDir, "node_modules");
      if (!existsSync(cur)) return { name, status: "could-not-run", reason: `${prev.tag} has no node_modules and neither does ${skillDir}; the old cli cannot load` };
      symlinkSync(cur, path.join(oldTree, "node_modules"));
      deps = "the CURRENT node_modules symlinked in (the tag has none), so a dependency change between the releases is a blind spot";
    }

    fx = buildStrangerFixture();
    if (!fx.ok) return { name, status: "could-not-run", reason: fx.reason };
    const run = (cli, args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: fx.env, timeout: UPGRADE_STAGE_TIMEOUT_MS });
    const out = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

    // 1. the OLD version installs and bootstraps, as a user of that release did.
    const oldSetup = run(oldCli, ["setup", "--roots", fx.codeRoot]);
    if (oldSetup.error || oldSetup.status !== 0) {
      return {
        name, status: "could-not-run",
        reason: `${prev.tag}'s own setup did not complete on the fixture (${oldSetup.error ? oldSetup.error.message : `exit ${oldSetup.status}`}); that is the previous release failing a fresh install, not an upgrade finding`,
        raw: out(oldSetup),
      };
    }
    const oldBootstrap = run(oldCli, ["bootstrap", "--baseline-from-git", "--apply"]);
    const oldDoctor = run(oldCli, ["doctor"]);

    // 2. the NEW version, over the SAME HOME and state dir.
    const newDoctor = run(newCli, ["doctor"]);
    const newStatus = run(newCli, ["status"]);
    for (const [label, r] of [["doctor", newDoctor], ["status", newStatus]]) {
      if (r.error) return { name, status: "could-not-run", reason: `could not run this version's ${label}: ${r.error.message}` };
    }

    // 3. the downgrade: the OLD doctor over what the new version left. Reported, never blocking.
    const downDoctor = run(oldCli, ["doctor"]);
    const stages = {
      oldSetup: oldSetup.status, oldBootstrap: oldBootstrap.status, oldDoctor: oldDoctor.status,
      newDoctor: newDoctor.status, newStatus: newStatus.status, downgradeDoctor: downDoctor.status ?? null,
    };
    const downNote = downDoctor.error
      ? `downgrade (${prev.tag} doctor after this version): could not run (${downDoctor.error.message}); reported, not blocking`
      : downDoctor.status === 0
        ? `downgrade (${prev.tag} doctor after this version): still clean`
        : `downgrade (${prev.tag} doctor after this version): exit ${downDoctor.status}; reported, not blocking (downgrades are not promised)`;

    const bad = [];
    if (newDoctor.status !== 0) bad.push(`doctor exited ${newDoctor.status}${doctorSummary(out(newDoctor)) ? ` — ${doctorSummary(out(newDoctor))}` : ""}`);
    if (newStatus.status !== 0) bad.push(`status exited ${newStatus.status}`);
    if (bad.length) {
      return {
        name, status: "failed", stages,
        detail: `this version cannot work over the state ${prev.tag} wrote: ${bad.join("; ")}. ${prev.tag} doctor before the upgrade: exit ${oldDoctor.status}. ${downNote}.`,
        raw: out(newDoctor) + out(newStatus),
      };
    }
    return {
      name, status: "passed", stages,
      detail: `${prev.tag} setup + bootstrap --apply, then this version's doctor + status over the same state: clean. ${downNote}. Blind spot: only the fixture's one workspace is upgraded; old tree deps: ${deps}; the persisted-shape diff is deferred (#236).`,
    };
  } finally {
    fx?.cleanup();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  claudeBin = "claude",
  upgradeDir = skillDir, // where the tags are read from; tests point it at a fixture repo
  upgradeEnv = process.env,
} = {}) {
  const gates = [
    gateVersionManifests({ skillDir: manifestsDir, hubMarketplacePath }),
    gateReleaseKind({ skillDir }),
    gateReleaseTag({ skillDir: upgradeDir }),
    gateSuite({ skillDir: suiteDir, env: suiteEnv }),
    gatePluginValidate({ skillDir, claudeBin }),
    gateMakePublicCheck({ skillDir, env: makePublicEnv }),
    gateStrangerInstall({ skillDir }),
    gateUpgradePath({ skillDir: upgradeDir, env: upgradeEnv }),
  ];

  const failed = gates.filter((g) => g.status === "failed");
  const couldNotRun = gates.filter((g) => g.status === "could-not-run");

  const overall = failed.length ? "blocked" : couldNotRun.length ? "incomplete" : "ready";
  const exitCode = failed.length ? 1 : couldNotRun.length ? 2 : 0;

  return { generatedAt: new Date().toISOString(), gates, overall, exitCode };
}
