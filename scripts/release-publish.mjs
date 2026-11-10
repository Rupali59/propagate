#!/usr/bin/env node
/**
 * release-publish.mjs — the one script a person runs to publish a propagate release (#238).
 *
 *   node scripts/release-publish.mjs                       dry run for the version in VERSION (the default)
 *   node scripts/release-publish.mjs --apply               send the writes
 *   node scripts/release-publish.mjs --version 0.18.0 --step pre-release
 *
 * Options: --version X.Y.Z (default: VERSION) · --tag <name> (default propagate-vX.Y.Z) · --repo owner/name ·
 * --step draft|pre-release|release|replaced (default: all four, in order) · --remote <name> (default origin) ·
 * --expect-asset <name> (repeatable) · --no-latest · --gh <binary> (default $PROPAGATE_GH_BIN or gh).
 *
 * The lifecycle, the idempotency and the refusals are in lib/core/release-publish.mjs. Exit: 0 ok, 1 refused or a
 * write failed, 2 usage. This is the ONLY place in the repo that writes a GitHub release, and no gate reaches it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishRelease, defaultGh } from "../lib/core/release-publish.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function main(argv, { out = console.log, err = console.error, root = ROOT } = {}) {
  const valued = new Set(["--version", "--tag", "--repo", "--step", "--remote", "--expect-asset", "--gh", "--root"]);
  const flags = new Set(["--apply", "--no-latest"]);
  const opts = { expectAssets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { opts[a.slice(2)] = true; continue; }
    if (valued.has(a)) {
      const v = argv[++i];
      if (!v || v.startsWith("--")) { err(`release-publish: ${a} needs a value`); return 2; }
      if (a === "--expect-asset") opts.expectAssets.push(v); else opts[a.slice(2)] = v;
      continue;
    }
    err(`release-publish: unknown argument ${a}`);
    return 2;
  }
  const repoRoot = opts.root ? path.resolve(opts.root) : root;
  let version = opts.version;
  if (!version) {
    const f = path.join(repoRoot, "VERSION");
    if (!existsSync(f)) { err(`release-publish: no --version and no VERSION file under ${repoRoot}`); return 2; }
    version = readFileSync(f, "utf8").trim();
  }
  const res = publishRelease({
    root: repoRoot, version, tag: opts.tag, repo: opts.repo, apply: Boolean(opts.apply), only: opts.step ?? null,
    latest: !opts["no-latest"], remote: opts.remote, expectAssets: opts.expectAssets,
    gh: defaultGh(opts.gh), out,
  });
  return res.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
