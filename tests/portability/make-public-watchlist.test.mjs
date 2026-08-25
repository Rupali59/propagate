/**
 * make-public --check must refuse when a directory at depth 1 under SEARCH_ROOTS
 * is neither a key in the identity map's `names` nor listed in `allow`.
 *
 * WHY THIS SOURCE (see docs/plans — "Identity map: configurable, with a
 * self-maintaining watchlist"). Deriving the watchlist from *discovered
 * workspaces* was tried first and is wrong: it only catches directories that
 * carry a `.propagates.yml` marker, which misses real client names that leak
 * into docs with no marker of their own (Tathya, Khushboo, Tushar in the
 * production tree). Depth-1 directory names under SEARCH_ROOTS catch all of
 * them, so that is the watchlist source under test here — not workspace
 * discovery.
 *
 * SANDBOXED BY CONSTRUCTION: a throwaway root directory and a throwaway
 * PROPAGATE_STATE_DIR per test; nothing here touches the real identity map or
 * the real $HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAKE_PUBLIC = path.join(REPO_ROOT, "bin", "make-public.mjs");

/** Build a throwaway SEARCH_ROOTS dir with the given depth-1 subdirectory names,
 *  a throwaway PROPAGATE_STATE_DIR, and write `map` as identity-map.json there. */
function harness(dirNames, map) {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-mp-root-"));
  for (const name of dirNames) {
    mkdirSync(path.join(root, name), { recursive: true });
  }
  const stateDir = mkdtempSync(path.join(tmpdir(), "propagate-mp-state-"));
  writeFileSync(path.join(stateDir, "identity-map.json"), JSON.stringify(map));
  const outDir = mkdtempSync(path.join(tmpdir(), "propagate-mp-out-"));
  return { root, stateDir, outDir };
}

function runCheck({ stateDir, searchRoots }) {
  const env = {
    ...process.env,
    PROPAGATE_STATE_DIR: stateDir,
    PROPAGATE_SEARCH_ROOTS: searchRoots,
  };
  try {
    const stdout = execFileSync(process.execPath, [MAKE_PUBLIC, "--out", "/tmp/unused-mp-out", "--check"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
  }
}

function cleanup(h) {
  for (const dir of [h.root, h.stateDir, h.outDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("make-public --check refuses when a depth-1 directory is unmapped and unallowed", () => {
  const h = harness(["Some New Client", "Motherboard"], {
    names: { "Some New Client": "workspace-a" },
    // "Motherboard" deliberately left out of both names and allow.
    allow: [],
  });
  try {
    const r = runCheck({ stateDir: h.stateDir, searchRoots: h.root });
    assert.notEqual(r.code, 0, "must refuse with a nonzero exit when a directory is unmapped");
    const combined = r.stdout + r.stderr;
    assert.match(
      combined,
      /Motherboard/,
      "refusal must name the specific unmapped directory, not just say something is wrong"
    );
  } finally {
    cleanup(h);
  }
});

test("make-public --check passes once the previously-unmapped directory is added to allow", () => {
  const h = harness(["Some New Client", "Motherboard"], {
    names: { "Some New Client": "workspace-a" },
    allow: ["Motherboard"],
  });
  try {
    const r = runCheck({ stateDir: h.stateDir, searchRoots: h.root });
    assert.equal(r.code, 0, `expected --check to pass once Motherboard is allowed; got:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(h);
  }
});

test("make-public --check passes when the unmapped directory is added to names instead", () => {
  const h = harness(["Some New Client", "Motherboard"], {
    names: { "Some New Client": "workspace-a", Motherboard: "platform-core" },
    allow: [],
  });
  try {
    const r = runCheck({ stateDir: h.stateDir, searchRoots: h.root });
    assert.equal(r.code, 0, `expected --check to pass once Motherboard is named; got:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(h);
  }
});

test("backward compatibility: a flat {name: alias} map is treated as names with an empty allow", () => {
  // No "names"/"allow" keys at all -- the shape every existing identity-map.json uses today.
  const h = harness(["Vipin Kaushik"], {
    "Vipin Kaushik": "workspace-a",
  });
  try {
    const r = runCheck({ stateDir: h.stateDir, searchRoots: h.root });
    assert.equal(
      r.code,
      0,
      `flat legacy map covering the only watchlist directory must still pass; got:\n${r.stdout}\n${r.stderr}`
    );
  } finally {
    cleanup(h);
  }
});

test("backward compatibility: a flat legacy map still refuses on a directory it does not cover", () => {
  const h = harness(["Vipin Kaushik", "Unmapped Client"], {
    "Vipin Kaushik": "workspace-a",
  });
  try {
    const r = runCheck({ stateDir: h.stateDir, searchRoots: h.root });
    assert.notEqual(r.code, 0, "flat legacy map must still refuse on directories it doesn't cover");
    assert.match(r.stdout + r.stderr, /Unmapped Client/);
  } finally {
    cleanup(h);
  }
});
