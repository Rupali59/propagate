#!/usr/bin/env node
/**
 * release-tag-aliases.mjs — give every legacy `vX.Y.Z` tag its annotated `propagate-vX.Y.Z` alias (#238).
 *
 * rule:release-versioning: "Legacy tags are allowed if declared ... and get an annotated alias in the new form."
 *
 *   node scripts/release-tag-aliases.mjs                  dry run (the default): prints what --apply would create
 *   node scripts/release-tag-aliases.mjs --apply          creates the missing aliases as LOCAL annotated tags
 *   node scripts/release-tag-aliases.mjs --print-sidecar  prints the `legacy_tags:` block for .sidecar.yml, from git
 *   node scripts/release-tag-aliases.mjs --repo <dir>     another git repo (default: this one)
 *
 * WHAT IT NEVER DOES. It never moves, deletes or replaces a tag (an alias that already exists is reported, and one on
 * a different commit is a `conflict` that is left alone), and it never pushes. The tags it creates are local until a
 * person runs `git push origin 'refs/tags/propagate-v*'`.
 *
 * Exit: 0 done / nothing to do, 1 a conflict or a failed create, 2 could not run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planAliases, applyAliases, legacyTagsYaml } from "../lib/core/release-tags.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function main(argv, { out = console.log, err = console.error } = {}) {
  const apply = argv.includes("--apply");
  const sidecar = argv.includes("--print-sidecar");
  const ri = argv.indexOf("--repo");
  if (ri !== -1 && !argv[ri + 1]) { err("release-tag-aliases: --repo needs a directory"); return 2; }
  const repoDir = ri === -1 ? path.resolve(HERE, "..") : path.resolve(argv[ri + 1]);
  const known = new Set(["--apply", "--print-sidecar", "--repo", ...(ri === -1 ? [] : [argv[ri + 1]])]);
  const stray = argv.filter((a) => !known.has(a));
  if (stray.length) { err(`release-tag-aliases: unknown argument(s): ${stray.join(" ")}`); return 2; }

  if (sidecar) {
    const y = legacyTagsYaml(repoDir, "Rupali59/propagate");
    if (!y.ok) { err(`release-tag-aliases: ${y.reason}`); return 2; }
    out(y.yaml.trimEnd());
    return 0;
  }

  const p = planAliases(repoDir);
  if (!p.ok) { err(`release-tag-aliases: could not read tags: ${p.reason}`); return 2; }
  if (p.plan.length === 0) { err("release-tag-aliases: no v* tags found in this repo; the scan found nothing to alias, which is not the same as being done"); return 2; }

  const results = apply ? applyAliases(repoDir, p.plan) : p.plan.map((r) => ({ ...r, applied: false }));
  out(apply ? "# release-tag-aliases --apply (local annotated tags; nothing is pushed)" : "# release-tag-aliases (dry run: nothing is created; pass --apply)");
  let bad = 0;
  for (const r of results) {
    const state =
      r.action === "create" ? (apply ? (r.applied ? "created" : `FAILED: ${r.error}`) : "would create")
      : r.action === "exists" ? "exists"
      : `CONFLICT: ${r.note}`;
    if (r.action === "conflict" || (apply && r.action === "create" && !r.applied)) bad++;
    out(`${r.legacy.padEnd(12)} -> ${r.alias.padEnd(20)} ${r.commit.slice(0, 7)}  ${r.legacyAnnotated ? "annotated" : "lightweight"} legacy  ${state}`);
  }
  const n = (a) => results.filter((r) => r.action === a).length;
  out(`# ${results.length} legacy tag(s): ${n("create")} to create, ${n("exists")} already aliased, ${n("conflict")} conflict(s)`);
  if (apply) out("# push is yours: git push origin 'refs/tags/propagate-v*'");
  return bad ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
