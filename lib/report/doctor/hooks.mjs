/**
 * hooks.mjs — is an installed git hook's command actually resolvable?
 *
 * WHY THIS EXISTS. Issue #22: propagate's `pre-commit` drift gate called
 * `~/.claude/skills/propagate/cli.mjs`, a path the 2026-08-22 plugin cutover
 * deleted. It stayed broken for 33 days and could not have been noticed, because
 * the hook is warn-only by design — `|| true` and `exit 0`. That is correct for a
 * coupling warning, and it means **a hook whose command does not exist is
 * indistinguishable from a hook that ran and found nothing.** Both print nothing
 * and both exit 0.
 *
 * `rule:enforcement-watches-itself`: the gate that exists to catch drift was
 * itself drifted. Its corollary is the design here — have the thing check itself
 * as part of its own run, so the exemption cannot be silently reintroduced.
 *
 * THREE STATES, NEVER TWO. `absent`, `live`, `dead` — plus `unreadable` when the
 * probe itself cannot answer. Presence was true the whole time this was broken,
 * so presence is not the question; resolvability is. `rule:discernment-checks` §2.
 *
 * IT RESOLVES THE COMMAND RATHER THAN GREPPING FOR THE KNOWN-BAD STRING. #22
 * offered both. Grepping for `.claude/skills/propagate` finds the one dead path
 * anyone already knows about; resolving the invoked file finds every dead path,
 * including ones created after this was written. G70 — a derived population grows,
 * a curated list of known-bad strings does not.
 *
 * NO SUBPROCESSES. `core.hooksPath` is read out of `.git/config` directly. The
 * census this replaced spawned `git config` 55 times; doctor already carries
 * reconcile as its slowest operation and does not need another fleet of execs.
 * That also fixes the reason #22's own census was wrong — it looked in
 * `.git/hooks` while all seven installations set `core.hooksPath = .githooks`,
 * which a `.git/hooks` sweep cannot see. 1 reported, 7 real.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * **S2, and the argument against S1 is worth stating** because #22's whole
 * complaint is that this was invisible for 33 days, which sounds like the silent
 * class. It is not: a dead hook is *visible to anyone who opens the hook file and
 * resolves the path it names* — which is exactly what this probe automates. That
 * is `environment.mjs`'s S2 criterion verbatim, misleading rather than silent, and
 * this section is its neighbour for the same reason.
 *
 * Not S1, because a wrong answer here does not make doctor wrong about the tree.
 * It means one warn-only gate is not warning, and `reconcile` still derives the
 * same drift on demand in ~1.2s — `rule:delegation-criteria` §2's point that the
 * on-demand path is the one that cannot miss. The hook is an early notice, not the
 * mechanism.
 */
export const SEVERITY = "S2";

/** Hook files worth probing. Only the ones propagate installs or documents. */
export const PROBED_HOOKS = Object.freeze(["pre-commit", "post-merge", "pre-push"]);

/**
 * Where this repo's hooks actually live.
 *
 * `.git` is normally a directory, but is a FILE holding `gitdir: <path>` in a
 * worktree or submodule checkout. Both are present in this tree, so both are
 * followed — a probe that silently skipped worktrees would under-report in
 * exactly the repos most likely to be misconfigured.
 */
export function hooksDirFor(repoRoot) {
  const dotGit = path.join(repoRoot, ".git");
  if (!existsSync(dotGit)) return null;

  let gitDir = dotGit;
  try {
    if (!statSync(dotGit).isDirectory()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(repoRoot, m[1].trim());
    }
  } catch {
    return null;
  }

  // core.hooksPath wins when set, and is resolved against the WORK TREE, which
  // is what git does — not against the git dir. `.githooks` is a tracked
  // directory in this tree, so getting this wrong hides every real installation.
  try {
    const cfg = readFileSync(path.join(gitDir, "config"), "utf8");
    const m = /^\s*hooksPath\s*=\s*(.+)$/m.exec(cfg);
    if (m) {
      const p = m[1].trim();
      return path.isAbsolute(p) ? p : path.join(repoRoot, p);
    }
  } catch {
    /* no config, or unreadable — fall through to the default */
  }
  return path.join(gitDir, "hooks");
}

/**
 * The file paths a hook script invokes via `node <path>`.
 *
 * Deliberately narrow: only `node "<path>"` / `node <path>` forms, which is what
 * propagate installs. A hook doing something cleverer is reported as `live`
 * rather than guessed at — claiming a command is dead because this parser did not
 * understand it would be the false-negative twin of the bug being fixed.
 */
export function invokedPaths(script) {
  const out = [];
  const re = /\bnode\s+(?:"([^"]+)"|'([^']+)'|(\S+\.mjs))/g;
  let m;
  while ((m = re.exec(script))) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw) out.push(raw);
  }
  return out;
}

/** Expand `$HOME` / `${HOME}` / `~` so a declared path can be checked on disk. */
function expand(p, home) {
  return p
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home);
}

/**
 * Probe one repo's hooks.
 *
 * Returns one row per hook FILE that mentions propagate. A hook that exists and
 * does not mention propagate is not our business and is not reported — the
 * question is whether *propagate's* gate is alive, not whether the repo has
 * hooks.
 */
export function probeRepo(repoRoot, { home = process.env.HOME ?? "" } = {}) {
  const dir = hooksDirFor(repoRoot);
  if (!dir) return [];
  // A hooks directory that does not EXIST is not one that cannot be READ. The
  // first version conflated them and reported two worktree checkouts as
  // `unreadable` with `hook: null` — an alarm about nothing, in the check whose
  // whole subject is telling absence apart from failure. §2, in this file.
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return [{ repo: repoRoot, hook: null, state: "unreadable", detail: `cannot read ${dir}: ${err.message}` }];
  }

  const rows = [];
  for (const name of PROBED_HOOKS) {
    if (!names.includes(name)) continue;
    const file = path.join(dir, name);
    let script;
    try {
      script = readFileSync(file, "utf8");
    } catch (err) {
      rows.push({ repo: repoRoot, hook: name, state: "unreadable", detail: err.message, file });
      continue;
    }
    if (!/propagate/.test(script)) continue;

    const all = invokedPaths(script);
    // DYNAMIC TARGETS ARE NOT DEAD TARGETS, and getting this wrong was a false
    // positive on the one hook that provably works. propagate's own pre-commit
    // runs `node "$(git rev-parse --show-toplevel)/cli.mjs"` — a command
    // substitution that resolves at run time to whatever repo the hook fires in,
    // which is MORE robust than a literal path, not less. Treating the literal
    // string as a filename reported a live gate as broken, and the natural
    // response to that report is to "fix" a hook that was correct.
    //
    // So anything this parser cannot statically resolve — `$(…)`, backticks, or a
    // variable other than HOME — is excluded from the dead set and named as
    // unchecked. The docstring on invokedPaths said exactly this before the code
    // did it.
    const dynamic = all.filter((t) => /\$\(|`|\$(?!\{?HOME\b)[A-Za-z_]/.test(t));
    const targets = all.filter((t) => !dynamic.includes(t));
    if (all.length > 0 && targets.length === 0) {
      rows.push({
        repo: repoRoot, hook: name, state: "live", file, dynamic, checked: 0,
        detail: `invokes ${dynamic.length} path(s) resolved at run time (${dynamic.join(", ")}) — not statically checkable, and not evidence of a fault`,
      });
      continue;
    }
    if (targets.length === 0) {
      rows.push({
        repo: repoRoot, hook: name, state: "live", file, checked: 0,
        detail: "mentions propagate but invokes no `node <path>` — nothing to resolve",
      });
      continue;
    }
    const dead = targets.filter((t) => !existsSync(expand(t, home)));
    const note = dynamic.length ? ` (+${dynamic.length} resolved at run time, unchecked)` : "";
    rows.push(
      dead.length > 0
        ? { repo: repoRoot, hook: name, state: "dead", file, dead, dynamic, checked: targets.length,
            detail: `unresolvable: ${dead.join(", ")}${note}` }
        : { repo: repoRoot, hook: name, state: "live", file, dynamic, checked: targets.length,
            detail: `${targets.join(", ")}${note}` },
    );
  }
  return rows;
}

/**
 * Walk for repos, then probe each.
 *
 * `maxDepth` default 5 rather than 3: measured 2026-09-28, the dead
 * installations sit at depth 2 (`Vipin Kaushik/astroacharya`) and a shallower
 * bound would have found the workspace and missed its projects. G-L — a shallow
 * maxdepth is a claim about depth you have not checked.
 */
export function probeTree(roots, { maxDepth = 5, home = process.env.HOME ?? "" } = {}) {
  const seen = new Set();
  const repos = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git") && !seen.has(d)) {
      seen.add(d);
      repos.push(d);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".worktrees") continue;
      walk(path.join(d, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);

  const rows = repos.flatMap((r) => probeRepo(r, { home }));
  return {
    reposScanned: repos.length,
    rows,
    live: rows.filter((r) => r.state === "live").length,
    dead: rows.filter((r) => r.state === "dead").length,
    unreadable: rows.filter((r) => r.state === "unreadable").length,
  };
}

/**
 * doctor's section.
 *
 * `dead` is a `check` failure and not an `info`, which is a departure from the
 * neighbouring launchd rows and is deliberate: those describe a component that
 * was retired on purpose, where a stale reading is expected. A hook whose command
 * cannot resolve is a gate someone is relying on and which cannot fire. It is
 * warn-only at commit time by design — `doctor` is where it is allowed to be loud.
 */
export async function checkHooks({ reporter, roots, home = process.env.HOME ?? "" }) {
  reporter.header("# installed git hooks — presence is not liveness");

  const r = probeTree(roots, { home });

  // THE FLOOR, AND WHAT IT IS ACTUALLY A FLOOR ON.
  //
  // First version failed whenever `reposScanned === 0`, which made doctor exit
  // non-zero in any tree containing no git repositories — including two existing
  // fixtures. That is the same absence-vs-failure conflation this section reports
  // on, made for the third time inside the module that reports it. A tree with no
  // repos is a fact about the tree; a root that cannot be read is a fact about the
  // probe, and only the second is a problem.
  //
  // So the floor is on the ROOTS, not on the count. If every root resolves and is
  // readable, "0 repositories" is an honest answer and is reported as one.
  const unreadableRoots = roots.filter((root) => {
    try {
      return !statSync(root).isDirectory();
    } catch {
      return true;
    }
  });
  if (unreadableRoots.length > 0) {
    reporter.check(
      "hook probe ran",
      false,
      `${unreadableRoots.length} of ${roots.length} search root(s) unreadable (${unreadableRoots.join(", ")}) — ` +
        `the probe could not look, which is not the same as finding nothing`,
    );
    return { counts: r };
  }
  if (r.reposScanned === 0) {
    reporter.info(
      "repositories found",
      `none under ${roots.length} readable root(s) — an honest zero, not a blind walk`,
    );
    return { counts: r };
  }
  // COVERAGE, STATED. Every hook in this tree resolves its target at run time
  // (a `$_pg_cli` candidate list, or `$(git rev-parse --show-toplevel)`), so this
  // probe statically verifies NONE of them — and eight "resolves:" rows read as
  // eight confirmations unless the denominator is printed. Saying "0 of 8
  // statically verified" is the difference between "found nothing wrong" and
  // "could not look", which is the whole subject of this section.
  // `checked` counts rows where a STATIC path was actually resolved on disk. A
  // hook with nothing to resolve is not "verified" — it is "nothing to verify",
  // and counting it as coverage was the first version's own small instance of the
  // defect this section reports.
  const checked = r.rows.filter((x) => (x.checked ?? 0) > 0).length;
  reporter.note(
    `${r.reposScanned} repositories scanned; ${r.rows.length} carry a propagate hook; ` +
      `${checked} of ${r.rows.length} statically verified`,
  );
  if (r.rows.length > 0 && checked === 0) {
    reporter.info(
      "static coverage",
      "0 — every hook resolves its target at run time, so this probe confirmed nothing about them. " +
        "It would still catch a hook that hardcodes a path, which is the form that broke in #22",
    );
  }

  if (r.rows.length === 0) {
    reporter.info(
      "propagate hooks installed",
      "none — commit-time drift checking is not installed anywhere. Supported (`reconcile` derives drift on demand), but say so rather than reading as healthy",
    );
    return { counts: r };
  }

  for (const row of r.rows) {
    const label = `${path.basename(row.repo)}/${row.hook ?? "?"}`;
    if (row.state === "dead") {
      reporter.check(label, false, `${row.detail} — the hook is warn-only, so this fails silently at commit time and only shows up here`);
    } else if (row.state === "unreadable") {
      reporter.check(label, false, `${row.detail} — could not determine liveness, which is not the same as live`);
    } else {
      reporter.info(label, `resolves: ${row.detail}`);
    }
  }
  return { counts: r };
}
