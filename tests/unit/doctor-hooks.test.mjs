/**
 * doctor-hooks.test.mjs — presence is not liveness, and the probe must be able to
 * say so.
 *
 * Built for issue #22's third ask: an installed hook needs a liveness probe,
 * because a warn-only gate whose command does not exist is indistinguishable from
 * one that ran and found nothing.
 *
 * THE LIVE TREE CANNOT TEST THIS, and that is exactly the trap this repo spent
 * 2026-09-28 naming. Measured that day: every propagate hook in the tree resolves
 * — the six in `Vipin Kaushik` were hardened on 2026-08-20 to try a candidate list
 * ending in the legacy path, propagate's own uses `$(git rev-parse --show-toplevel)`,
 * and the one genuinely dead hook #22 found has since been repaired. So a probe
 * validated only against reality would report `0 dead` and never once have
 * exercised the branch it exists for — `rule:mutate-behind-the-fixture-builder`,
 * with the live filesystem as the fixture that cannot express the violation.
 *
 * Every hook below is therefore written by hand, as a literal. Do not refactor
 * them onto a shared builder that emits "valid" hooks.
 *
 * EVERY FIXTURE CARRIES A `# propagate` BANNER, as the real hooks do. Four of
 * these failed on first run without it: `probeRepo` skips any hook that does not
 * mention propagate — someone else's `npm run lint` is not its business — so the
 * fixtures returned zero rows and the assertions read `undefined`. The probe was
 * right and the fixtures could not express the case, which is the same shape as
 * the live-tree problem described above, one level in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkHooks,
  hooksDirFor,
  invokedPaths,
  probeRepo,
  probeTree,
} from "../../lib/report/doctor/hooks.mjs";

/** A bare repo-shaped directory. `config` body is the caller's business. */
function repo(root, { config = "", hooksSubdir = ".git/hooks", hooks = {}, gitFile = null } = {}) {
  mkdirSync(root, { recursive: true });
  if (gitFile !== null) {
    writeFileSync(path.join(root, ".git"), gitFile);
  } else {
    mkdirSync(path.join(root, ".git"), { recursive: true });
    if (config) writeFileSync(path.join(root, ".git", "config"), config);
  }
  const hd = path.join(root, hooksSubdir);
  mkdirSync(hd, { recursive: true });
  for (const [name, body] of Object.entries(hooks)) writeFileSync(path.join(hd, name), body);
  return root;
}

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir: d, clean: () => rmSync(d, { recursive: true, force: true }) };
}

/* ── the branch the whole check exists for ───────────────────────────────── */

test("a hook whose command does not exist is DEAD — the assertion this probe is for", () => {
  const { dir, clean } = tmp("hooks-dead-");
  try {
    const r = repo(path.join(dir, "proj"), {
      hooks: {
        "pre-commit": '#!/bin/sh\nnode "/nowhere/propagate/cli.mjs" check --staged || true\nexit 0\n',
      },
    });
    const [row] = probeRepo(r);
    assert.equal(row.state, "dead", "an unresolvable literal path must be reported dead");
    assert.match(row.detail, /unresolvable/);
    assert.match(row.detail, /\/nowhere\/propagate\/cli\.mjs/, "the message must name the path that does not resolve");
  } finally {
    clean();
  }
});

test("the same hook pointed at a file that EXISTS is live — the negative control", () => {
  // Without this, "dead" could just mean "this probe reports dead for everything".
  const { dir, clean } = tmp("hooks-live-");
  try {
    const real = path.join(dir, "cli.mjs");
    writeFileSync(real, "// a real file\n");
    const r = repo(path.join(dir, "proj"), {
      hooks: { "pre-commit": `#!/bin/sh\n# propagate: declared-coupling check\nnode "${real}" check --staged || true\nexit 0\n` },
    });
    const [row] = probeRepo(r);
    assert.equal(row.state, "live");
    assert.equal(row.checked, 1, "one real path resolved on disk IS coverage, and must be counted");
  } finally {
    clean();
  }
});

test("$HOME is expanded before the file is looked for", () => {
  const { dir, clean } = tmp("hooks-home-");
  try {
    writeFileSync(path.join(dir, "cli.mjs"), "//\n");
    const r = repo(path.join(dir, "proj"), {
      hooks: { "pre-commit": '#!/bin/sh\n# propagate gate\nnode "$HOME/cli.mjs" check --staged\n' },
    });
    assert.equal(probeRepo(r, { home: dir })[0].state, "live", "an unexpanded $HOME would read as dead");
    assert.equal(probeRepo(r, { home: "/nowhere" })[0].state, "dead", "…and must still be dead when it genuinely is");
  } finally {
    clean();
  }
});

/* ── the false positive that shipped first, asserted absent ──────────────── */

test("a command SUBSTITUTION is not a dead path — propagate's own hook", () => {
  // The first version of this probe reported `node "$(git rev-parse --show-toplevel)/cli.mjs"`
  // as dead, because it treated the literal string as a filename. That gate
  // demonstrably works, and the natural response to the report would have been to
  // "fix" a correct hook. A dynamic target is UNCHECKED, never dead.
  const { dir, clean } = tmp("hooks-subst-");
  try {
    const r = repo(path.join(dir, "proj"), {
      hooks: {
        "pre-commit": '#!/bin/sh\n# propagate gate\nnode "$(git rev-parse --show-toplevel)/cli.mjs" check --staged || true\n',
      },
    });
    const [row] = probeRepo(r);
    assert.equal(row.state, "live", "a run-time-resolved path must not be called dead");
    assert.match(row.detail, /resolved at run time/, "and the report must say it was not checked, not that it passed");
    assert.deepEqual(row.dynamic, ["$(git rev-parse --show-toplevel)/cli.mjs"]);
    assert.equal(row.checked, 0, "nothing was statically resolved, so it must not count as coverage");
  } finally {
    clean();
  }
});

test("a mixed hook reports the dead literal AND notes the unchecked dynamic one", () => {
  const { dir, clean } = tmp("hooks-mixed-");
  try {
    const r = repo(path.join(dir, "proj"), {
      hooks: {
        "pre-commit":
          '#!/bin/sh\n# propagate gate\nnode "$CLAUDE_PLUGIN_ROOT/cli.mjs" a\nnode "/nowhere/cli.mjs" b\n',
      },
    });
    const [row] = probeRepo(r);
    assert.equal(row.state, "dead", "one unresolvable literal is enough to fail");
    assert.match(row.detail, /resolved at run time, unchecked/, "the dynamic one must be disclosed, not dropped");
  } finally {
    clean();
  }
});

/* ── absence, which must not read as failure OR as health ────────────────── */

test("a repo with no hooks directory yields NO rows, not an `unreadable` alarm", () => {
  // The first version returned `{state: "unreadable", hook: null}` for two
  // worktree checkouts whose hooks dir simply did not exist — an alarm about
  // nothing, inside the check whose subject is telling absence from failure.
  const { dir, clean } = tmp("hooks-none-");
  try {
    const r = path.join(dir, "proj");
    mkdirSync(path.join(r, ".git"), { recursive: true });
    assert.deepEqual(probeRepo(r), []);
  } finally {
    clean();
  }
});

test("a hook that never mentions propagate is not reported at all", () => {
  const { dir, clean } = tmp("hooks-other-");
  try {
    const r = repo(path.join(dir, "proj"), {
      hooks: { "pre-commit": "#!/bin/sh\nnpm run lint\n" },
    });
    assert.deepEqual(probeRepo(r), [], "someone else's hook is not this check's business");
  } finally {
    clean();
  }
});

/* ── the reason #22's own census was wrong ───────────────────────────────── */

test("core.hooksPath is honoured, and is resolved against the WORK TREE", () => {
  // This is the defect that made the original census report 1 installation where
  // there were 7: it swept `.git/hooks` while every real one sets
  // `core.hooksPath = .githooks`, a TRACKED directory a `.git/hooks` sweep cannot
  // see. Getting this wrong hides every installation rather than some of them.
  const { dir, clean } = tmp("hooks-path-");
  try {
    const r = repo(path.join(dir, "proj"), {
      config: "[core]\n\thooksPath = .githooks\n",
      hooksSubdir: ".githooks",
      hooks: { "pre-commit": '#!/bin/sh\nnode "/nowhere/propagate/cli.mjs"\n' },
    });
    assert.equal(hooksDirFor(r), path.join(r, ".githooks"));
    const rows = probeRepo(r);
    assert.equal(rows.length, 1, "the hook in .githooks must be found");
    assert.equal(rows[0].state, "dead");
  } finally {
    clean();
  }
});

test("a `.git` FILE (worktree/submodule) is followed to its real gitdir", () => {
  const { dir, clean } = tmp("hooks-wt-");
  try {
    const gitdir = path.join(dir, "real-gitdir");
    mkdirSync(path.join(gitdir, "hooks"), { recursive: true });
    writeFileSync(path.join(gitdir, "hooks", "pre-commit"), '#!/bin/sh\nnode "/nowhere/cli.mjs" propagate\n');
    const wt = path.join(dir, "wt");
    repo(wt, { gitFile: `gitdir: ${gitdir}\n`, hooksSubdir: "unused" });
    assert.equal(hooksDirFor(wt), path.join(gitdir, "hooks"));
    assert.equal(probeRepo(wt)[0].state, "dead", "a worktree's hooks must be probed, not skipped");
  } finally {
    clean();
  }
});

/* ── the walk, and its floor ─────────────────────────────────────────────── */

test("probeTree finds nested repos and counts what it scanned", () => {
  const { dir, clean } = tmp("hooks-tree-");
  try {
    repo(path.join(dir, "ws"), { hooks: { "pre-commit": '#!/bin/sh\nnode "/nowhere/a.mjs" propagate\n' } });
    repo(path.join(dir, "ws", "proj"), { hooks: { "pre-commit": '#!/bin/sh\nnode "/nowhere/b.mjs" propagate\n' } });
    const r = probeTree([dir]);
    assert.equal(r.reposScanned, 2, "a nested project repo must be found, not shadowed by its parent");
    assert.equal(r.dead, 2);
    assert.equal(r.live, 0);
  } finally {
    clean();
  }
});

test("a tree with no repos reports reposScanned 0 — the floor the caller keys on", () => {
  // doctor turns this into a FAILED check reading "the probe has gone blind, it
  // has not found nothing". A derived population can silently empty; the count is
  // what makes that distinguishable.
  const { dir, clean } = tmp("hooks-empty-");
  try {
    const r = probeTree([dir]);
    assert.equal(r.reposScanned, 0);
    assert.deepEqual(r.rows, []);
  } finally {
    clean();
  }
});

/* ── the parser, directly ────────────────────────────────────────────────── */

test("invokedPaths reads quoted, single-quoted and bare .mjs forms", () => {
  assert.deepEqual(invokedPaths('node "/a/b.mjs" x'), ["/a/b.mjs"]);
  assert.deepEqual(invokedPaths("node '/a/c.mjs'"), ["/a/c.mjs"]);
  assert.deepEqual(invokedPaths("node /a/d.mjs --flag"), ["/a/d.mjs"]);
  assert.deepEqual(invokedPaths("node -e 'console.log(1)'"), [], "an inline -e script names no file");
  assert.deepEqual(invokedPaths("npm run build"), []);
});

/* ── the doctor section itself, and the check that must be able to fail ───── */

/**
 * A tiny stand-in for doctor's Reporter. Only the surface `checkHooks` touches,
 * written by hand rather than imported: the real one carries rendering concerns
 * this test has no opinion about, and importing it would couple this file to
 * changes in how doctor PRINTS rather than what it DECIDES.
 */
function reporterStub() {
  const entries = [];
  return {
    entries,
    problems: 0,
    header(t) { entries.push(["header", t]); },
    note(t) { entries.push(["note", t]); },
    info(l, d) { entries.push(["info", l, d]); },
    check(l, ok, d) { entries.push(["check", l, ok, d]); if (!ok) this.problems += 1; },
  };
}

test("`hook probe ran` FAILS when a search root cannot be read — the failing case", () => {
  // Required by tests/cli/doctor-check-coverage.test.mjs: a check nobody has seen
  // fail is not known to work (G1). This is also the floor from
  // rule:mutate-behind-the-fixture-builder — a derived population can silently
  // empty, and "scanned 0 repos" must not render as a clean tree.
  const r = reporterStub();
  checkHooks({ reporter: r, roots: ["/nonexistent-search-root"] });
  const row = r.entries.find((e) => e[0] === "check" && e[1] === "hook probe ran");
  assert.ok(row, "the floor must be a CHECK, not a note — a note costs no exit code");
  assert.equal(row[2], false, "an unreadable root must FAIL");
  assert.match(row[3], /could not look, which is not the same as finding nothing/);
  assert.equal(r.problems, 1, "and it must count toward doctor's problem tally");
});

test("an EMPTY but readable tree is an honest zero, not a failure", () => {
  // The floor's negative control, and the reason it moved off the count. The first
  // version failed on `reposScanned === 0`, which made doctor exit non-zero in any
  // tree with no git repos — it broke two existing fixtures that legitimately have
  // none. A tree with no repos is a fact about the tree; an unreadable root is a
  // fact about the probe. Only the second is a problem.
  const { dir, clean } = tmp("hooks-empty-ok-");
  try {
    const r = reporterStub();
    checkHooks({ reporter: r, roots: [dir] });
    assert.equal(r.problems, 0, "an empty readable tree must not cost an exit code");
    const info = r.entries.find((e) => e[0] === "info" && e[1] === "repositories found");
    assert.ok(info, "…and must still be stated rather than rendering as silence");
    assert.match(info[2], /honest zero/);
  } finally {
    clean();
  }
});

test("a tree with repos but no propagate hooks says so, and does NOT fail", () => {
  // The negative control for the floor: "nothing installed" is a supported
  // configuration, so it must be an info rather than a problem. Without this, the
  // check above would be satisfied by failing on every tree.
  const { dir, clean } = tmp("hooks-noinstall-");
  try {
    repo(path.join(dir, "proj"), { hooks: { "pre-commit": "#!/bin/sh\nnpm run lint\n" } });
    const r = reporterStub();
    checkHooks({ reporter: r, roots: [dir] });
    assert.equal(r.problems, 0, "no installation is not a defect");
    const info = r.entries.find((e) => e[0] === "info" && e[1] === "propagate hooks installed");
    assert.ok(info, "and it must be stated rather than rendering as an empty section");
    assert.match(info[2], /none/);
  } finally {
    clean();
  }
});

test("a DEAD hook reaches doctor as a failed check, not an info row", () => {
  const { dir, clean } = tmp("hooks-doctor-dead-");
  try {
    repo(path.join(dir, "proj"), {
      hooks: { "pre-commit": '#!/bin/sh\n# propagate gate\nnode "/nowhere/cli.mjs" check --staged || true\n' },
    });
    const r = reporterStub();
    checkHooks({ reporter: r, roots: [dir] });
    assert.equal(r.problems, 1, "a gate that cannot fire must cost an exit code somewhere");
    const row = r.entries.find((e) => e[0] === "check" && String(e[1]).endsWith("/pre-commit"));
    assert.ok(row && row[2] === false);
    assert.match(row[3], /warn-only, so this fails silently at commit time/);
  } finally {
    clean();
  }
});

test("static coverage is stated when nothing could be checked", () => {
  const { dir, clean } = tmp("hooks-cov-");
  try {
    repo(path.join(dir, "proj"), {
      hooks: { "pre-commit": '#!/bin/sh\n# propagate gate\nnode "$(git rev-parse --show-toplevel)/cli.mjs" x\n' },
    });
    const r = reporterStub();
    checkHooks({ reporter: r, roots: [dir] });
    assert.equal(r.problems, 0, "a run-time-resolved hook is not a fault");
    const note = r.entries.find((e) => e[0] === "note");
    assert.match(note[1], /0 of 1 statically verified/,
      "the denominator is what stops one `resolves:` row reading as one confirmation");
    assert.ok(r.entries.some((e) => e[0] === "info" && e[1] === "static coverage"));
  } finally {
    clean();
  }
});
