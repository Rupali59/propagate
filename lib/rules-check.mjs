/**
 * rules-check.mjs — the canonical-rules duplication detector.
 *
 * Absorbed from `~/Documents/GitHub/rules/_check.mjs` (Phase 5,
 * docs/plans/2026-08-19-portability-and-rules.md). This is a coherent home rather
 * than an annexation: docs/LIFECYCLE.md already defines PROMOTE, and its destination
 * *is* a rule file carrying id/scope/status/fingerprint with a green selftest. The
 * concept lived here; only the code lived elsewhere.
 *
 * WHAT IT DETECTS. A `CLAUDE.md` that RESTATES a canonical rule instead of pointing
 * at it. Restating is the drift: measured 2026-08-14, the tool-priority rule had 9
 * inline copies making 4 mutually exclusive claims, while the 13 files that merely
 * pointed at a parent rule had zero conflicts between them. A file is clean if it
 * says nothing about the rule, or references it as `rule:<id>`. A third case,
 * `overrides: <id>`, declares a deliberate deviation — printed, never failed, because
 * the entire point of the escape hatch is that divergence stays VISIBLE. Skipping it
 * silently would make a declared deviation indistinguishable from a file that never
 * had an opinion.
 *
 * FOUR DEFECTS FIXED IN THE MOVE, in order of what they cost:
 *
 *   1. IT EXITED 0 ON AN EMPTY TREE. Zero files found gave zero findings gave exit 0
 *      gave "no drift" — when it meant "nothing was scanned". GOTCHAS G1 verbatim: a
 *      check that cannot fail reports success. On any machine but the author's the
 *      tree does not exist, so the detector has been reporting clean since it was
 *      written. `diagnostic` now distinguishes ok / roots-missing / no-files-scanned
 *      / no-rules, and anything but `ok` is a non-zero exit.
 *   2. The scan root was `~/Documents/GitHub`, hardcoded. Now SEARCH_ROOTS.
 *   3. The rules directory was `~/.claude/rules`, hardcoded. Now configurable, and
 *      still defaulting to that path so this machine is unaffected.
 *   4. It shelled out to `find`, so a missing root threw out of execFileSync instead
 *      of being reported. Now a plain walk — one less spawn (G6) and a failure mode
 *      that can be described.
 *
 * Read-only. Prints nothing; the CLI formats. Every function takes its inputs as
 * arguments rather than reading module state, so tests can drive it without env.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Directories never worth descending into when looking for CLAUDE.md. */
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel", "Library", "Trash"]);

/**
 * `overrides: <id>` may be wrapped in backticks and/or bold, because it is written
 * inside prose. Tolerate that; do not tolerate a bare mention of the id.
 *
 * The trailing guard is `(?![\w-])`, NOT `\b`: rule ids contain hyphens, and `\b`
 * matches between "truth" and "-extended", so `\b` would accept a longer id as this
 * one. That was a real bug, caught by the selftest case that is still below.
 */
export function overrideRe(id) {
  return new RegExp(
    "overrides:\\s*[`*_ ]*" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])",
    "i",
  );
}


/** Everything after the YAML frontmatter block. See selftest() for why this matters. */
export function stripFrontmatter(raw) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * Parse every active rule in `rulesDir`.
 *
 * A rule without `id` or `fingerprint` is ignored by construction rather than by a
 * denylist — that is what keeps the three legacy `paths:`-format files inert without
 * anyone maintaining a list of them. `status: obsolete` is excluded so a rule can be
 * retired without being deleted, which is the lifecycle the standalone version had
 * and nothing else did.
 */
export function loadRules(rulesDir) {
  let names;
  try {
    names = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    let raw;
    try {
      raw = readFileSync(path.join(rulesDir, f), "utf8");
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) continue;
    // A REAL YAML PARSE, not a line regex that strips quotes.
    //
    // The original did `/^(\w+):\s*(.*)$/` and removed surrounding quotes, which
    // does not UNESCAPE. So the valid YAML `fingerprint: "STATE\\.md"` — meaning the
    // regex `STATE\.md` — reached the regex engine as `STATE\\.md`, which matches a
    // literal backslash. THREE of the sixteen live rules are written that way
    // (nextjs-dev-server-port, plan-mode-3-files, state-and-decisions) and all three
    // detectors were dead: incapable of firing for any input, ever.
    //
    // The old selftest passed all three, because it tested the fingerprint against
    // the WHOLE FILE, whose frontmatter contains the fingerprint text verbatim. A
    // check whose subject includes its own expectation cannot fail — GOTCHAS G1, in
    // the one place built to prove the opposite.
    let parsed;
    try {
      parsed = parseYaml(m[1]);
    } catch {
      continue; // malformed frontmatter is inert by construction, same as before
    }
    if (!parsed || typeof parsed !== "object") continue;
    const meta = { ...parsed, __file: path.join(rulesDir, f) };
    if (meta.id && meta.fingerprint && meta.status !== "obsolete") out.push(meta);
  }
  return out;
}


/** How many CLAUDE.md files sit under a skipped subtree — so the skip can be reported. */
function countClaudeMds(dir, maxDepth) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(d, e.name), depth + 1);
      } else if (e.name === "CLAUDE.md") n++;
    }
  };
  walk(dir, 0);
  return n;
}

/**
 * Every `CLAUDE.md` beneath the given roots, plus which roots were missing.
 *
 * Returns `missing` rather than throwing or silently dropping: "the root is not
 * there" and "the root is there and empty" need different fixes, and the shell-out
 * this replaces could only express the second (by throwing for the first).
 */
export function findCandidateFiles(roots, { maxDepth = 6, extra = [] } = {}) {
  const files = [];
  const missing = [];
  const present = [];
  let excludedWorktrees = 0;

  for (const root of roots) {
    let ok = false;
    try {
      ok = statSync(root).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      missing.push(root);
      continue;
    }
    present.push(root);
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // an unreadable directory is not a reason to abandon the rest
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (SKIP.has(e.name)) continue;
          // A worktree's CLAUDE.md is the SAME file seen twice — its canonical path is
          // already in this walk — so counting it inflates findings with duplicate
          // work. And a DETACHED-HEAD worktree sits on no branch, so an edit there can
          // never merge: the finding would be real and unfixable. Counted, not silently
          // dropped, because a scan that quietly narrows its scope reads as "covered
          // everything".
          if (e.name === "worktrees" || e.name === ".worktrees") {
            excludedWorktrees += countClaudeMds(path.join(dir, e.name), maxDepth);
            continue;
          }
          walk(path.join(dir, e.name), depth + 1);
        } else if (e.name === "CLAUDE.md") {
          files.push(path.join(dir, e.name));
        }
      }
    };
    walk(root, 0);
  }

  for (const f of extra) if (existsSync(f) && !files.includes(f)) files.push(f);
  return { files, missing, present, excludedWorktrees };
}

/**
 * Run the detector.
 *
 * @returns {{rules: object[], filesScanned: number, findings: object[], overrides: object[],
 *            diagnostic: "ok"|"no-rules"|"roots-missing"|"no-files-scanned", missing: string[], exitCode: number}}
 */
export function checkRules({ rulesDir, roots, exclude = [], maxDepth = 6, extra = [] } = {}) {
  const rules = loadRules(rulesDir);
  const { files, missing, excludedWorktrees } = findCandidateFiles(roots, { maxDepth, extra });

  const base = { rules, filesScanned: files.length, findings: [], overrides: [], missing, excludedWorktrees };

  // Absence, attributed. Each of these is a real state with a different fix, and the
  // original expressed all of them as "0 restatements, exit 0".
  if (rules.length === 0) return { ...base, diagnostic: "no-rules", exitCode: 2 };
  if (files.length === 0) {
    return { ...base, diagnostic: missing.length ? "roots-missing" : "no-files-scanned", exitCode: 2 };
  }

  const findings = [];
  const overrides = [];
  for (const r of rules) {
    let re;
    try {
      re = new RegExp(r.fingerprint, "i");
    } catch {
      continue; // an unparseable fingerprint is a selftest failure, not a scan crash
    }
    const ov = overrideRe(r.id);
    for (const f of files) {
      if (exclude.includes(f)) continue;
      let raw;
      try {
        raw = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (!re.test(raw)) continue;
      if (ov.test(raw)) {
        const line = raw.split(/\r?\n/).findIndex((l) => ov.test(l)) + 1;
        overrides.push({ rule: r.id, file: f, line });
        continue;
      }
      if (raw.includes(`rule:${r.id}`)) continue; // references it — clean
      const lines = raw.split(/\r?\n/);
      const hits = lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
      findings.push({ rule: r.id, file: f, hits, lines });
    }
  }

  return {
    ...base,
    findings,
    overrides,
    diagnostic: "ok",
    exitCode: findings.length ? 1 : 0,
  };
}

/**
 * Prove the detector can fail.
 *
 * A check that cannot fire reports success forever, which is worse than no check
 * (GOTCHAS G1). Two halves, both load-bearing:
 *
 *  - every rule's fingerprint must match its OWN body. On first run this failed:
 *    `plan-mode-3-files` declared `3\+ *files` while its body said "3 or more files",
 *    so that rule's detector could never have fired for anything.
 *  - override detection must fire on a real declaration AND refuse the near-misses.
 *    Recognising too much is the worse failure here — it would let an undeclared copy
 *    pass by merely naming the rule.
 */
export function selftest({ rulesDir } = {}) {
  const failures = [];
  const checks = [];
  for (const r of loadRules(rulesDir)) {
    let hit = false;
    try {
      // THE BODY, not the whole file. The original tested the raw file, which
      // CONTAINS the frontmatter, which contains the fingerprint — so any plain-string
      // fingerprint matched itself and could never fail this check. It only ever
      // caught fingerprints carrying regex metacharacters, which is why
      // `plan-mode-3-files` (`3\+ *files`) was found and nothing else ever was.
      // A check that can only fail for one class of input is most of the way to a
      // check that cannot fail (GOTCHAS G1).
      hit = new RegExp(r.fingerprint, "i").test(stripFrontmatter(readFileSync(r.__file, "utf8")));
    } catch {
      hit = false;
    }
    checks.push({ kind: "fingerprint", id: r.id, pass: hit });
    if (!hit) failures.push(`${r.id}: fingerprint matches nothing in its own body`);
  }

  const id = "secrets-source-of-truth";
  const cases = [
    ["overrides: secrets-source-of-truth", true, "bare"],
    ["**`overrides: secrets-source-of-truth`** — reason", true, "bold + backticks, as written in prose"],
    ["see rule:secrets-source-of-truth", false, "a reference is not an override"],
    ["overrides: secrets-source-of-truth-extended", false, "must not match a longer id"],
    ["this overrides the secrets-source-of-truth rule", false, "prose mentioning both words"],
  ];
  for (const [sample, want, why] of cases) {
    const got = overrideRe(id).test(sample);
    checks.push({ kind: "override", why, want, pass: got === want });
    if (got !== want) failures.push(`override ${why}: expected ${want}`);
  }

  return { pass: failures.length === 0, failures, checks };
}
