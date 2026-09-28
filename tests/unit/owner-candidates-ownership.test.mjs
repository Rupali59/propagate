/**
 * owner-candidates-ownership.test.mjs — a third party's repo is not a candidate.
 *
 * `ownerCandidates` deliberately uses VERSION CONTROL as its predicate rather
 * than a propagate marker, and its own note says why: the check for "did you
 * adopt the v3 layout" must never be gated on having adopted it, or a workspace
 * that never began is not reported as failing — it is not reported at all.
 *
 * That reasoning is sound and this filter does not weaken it. It answers a
 * different question: not "has it adopted the layout" but **"is it ours to
 * migrate at all"**.
 *
 * Measured 2026-09-28: doctor reported `2 not begun — Motion-Graphics, firstmate`
 * and thereby advised that propagate's propagation layout be adopted inside
 * `github.com/kunchenguid/firstmate` — someone else's repository, 597 commits,
 * cloned into this tree. `Motion-Graphics` is Rupali's and remains in the
 * population, correctly reported as not begun; `firstmate` never belonged there.
 *
 * DERIVED, NOT LISTED. An exemption list would have to be remembered for every
 * future third-party clone, and the ones nobody remembered would read as gaps —
 * G70. The owner comes from the hub's own `origin`, so it follows the install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ownerCandidates } from "../../lib/core/discovery.mjs";

/** A repo-shaped directory whose `.git/config` names `origin` at `owner/name`. */
function repo(root, owner) {
  mkdirSync(path.join(root, ".git"), { recursive: true });
  if (owner !== null) {
    writeFileSync(
      path.join(root, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/${owner}/${path.basename(root)}.git\n`,
    );
  }
  return root;
}

function tree(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "owner-cand-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a repo owned by someone else is EXCLUDED from the census", () => {
  tree((dir) => {
    repo(dir, "rupali59"); // the hub itself — this is what makes "ours" rupali59
    repo(path.join(dir, "mine"), "rupali59");
    repo(path.join(dir, "theirs"), "kunchenguid");

    const names = ownerCandidates([dir], []).map((c) => c.name);
    assert.ok(names.includes("mine"), "our own repo must stay in the population");
    assert.ok(
      !names.includes("theirs"),
      "a third party's repo must not be asked whether it adopted our layout",
    );
  });
});

test("owner comparison is case-insensitive — a host is not case-sensitive about it", () => {
  tree((dir) => {
    repo(dir, "Rupali59");
    repo(path.join(dir, "mine"), "rupali59");
    const names = ownerCandidates([dir], []).map((c) => c.name);
    assert.ok(names.includes("mine"), "RUPALI59 and rupali59 are the same owner");
  });
});

test("a repo with NO remote is INCLUDED — unknown ownership must not shrink the census", () => {
  // The whole purpose of this census is that it cannot be gated on the property
  // being measured. Silently dropping a repo because its git config was
  // unreadable would reintroduce that failure through a different door, and the
  // dropped repo would read as conformant by absence.
  tree((dir) => {
    repo(dir, "rupali59");
    repo(path.join(dir, "local-only"), null);
    const names = ownerCandidates([dir], []).map((c) => c.name);
    assert.ok(names.includes("local-only"), "no remote means unknown, and unknown is included");
  });
});

test("when the HUB has no origin, the filter is skipped entirely", () => {
  // `ours` cannot be derived, so nothing is excluded. A census that shrank
  // because it could not identify its own owner would be worse than one that
  // includes a stranger.
  tree((dir) => {
    repo(dir, null);
    repo(path.join(dir, "mine"), "rupali59");
    repo(path.join(dir, "theirs"), "somebody-else");
    const names = ownerCandidates([dir], []).map((c) => c.name);
    assert.ok(names.includes("mine"));
    assert.ok(
      names.includes("theirs"),
      "with no derivable owner the filter must not fire — it cannot know who is a stranger",
    );
  });
});

test("an SSH remote form is parsed too", () => {
  tree((dir) => {
    repo(dir, "rupali59");
    const theirs = path.join(dir, "theirs");
    mkdirSync(path.join(theirs, ".git"), { recursive: true });
    writeFileSync(
      path.join(theirs, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:kunchenguid/theirs.git\n',
    );
    const names = ownerCandidates([dir], []).map((c) => c.name);
    assert.ok(!names.includes("theirs"), "git@github.com:owner/name must resolve its owner too");
  });
});

test("a DECLARED workspace is never dropped, whoever owns it", () => {
  // The marker-based set is passed in and the docstring promises the result is a
  // SUPERSET of it. An ownership filter that could remove a declared workspace
  // would break that contract, and a workspace declares itself ours.
  tree((dir) => {
    repo(dir, "rupali59");
    const theirs = repo(path.join(dir, "declared"), "somebody-else");
    const names = ownerCandidates([dir], [{ root: theirs, name: "declared" }]).map((c) => c.name);
    assert.ok(
      names.includes("declared"),
      "ownerCandidates must remain a superset of the declared set",
    );
  });
});
