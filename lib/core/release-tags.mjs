/**
 * release-tags.mjs — the tag side of rule:release-versioning for propagate (#238): which version tags exist, whether
 * each is annotated, and the annotated `propagate-vX.Y.Z` alias each legacy `v*` tag is owed.
 *
 * READS are plain git. The ONE write is `applyAliases`, which only ever runs `git tag -a <new name> <commit>`: it
 * never moves, deletes or force-replaces a tag, and nothing here pushes. Pushing a tag is outward-facing and belongs
 * to the person (rule:release-versioning: "Never move or delete a pushed tag").
 *
 * The rule: "Legacy tags are allowed if declared. Tags that predate the convention and already have links out keep
 * their names, are listed under `legacy_tags`, and get an annotated alias in the new form."
 */
import { spawnSync } from "node:child_process";
import { readOnlyGitEnv } from "./git-env.mjs";

/** `v0.17.0`, `propagate-v0.17.0`, `propagate-v0.18.0-rc.1`. Group 1 is the prefix, group 2 the version. */
export const VERSION_TAG_RE = /^(propagate-v|v)(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/;
export const LEGACY_PREFIX = "v";
export const ALIAS_PREFIX = "propagate-v";

function git(cwd, args, { write = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: write ? process.env : readOnlyGitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr ?? "").trim() };
}

/**
 * Every tag that is a version tag in either form.
 * `annotated` is the OBJECT type (`tag`), never the name: a lightweight tag points straight at a commit.
 * @returns {{ok: boolean, reason?: string, tags: Array<{name: string, prefix: string, version: string, annotated: boolean, commit: string}>}}
 */
export function listVersionTags(cwd) {
  const r = git(cwd, ["for-each-ref", "refs/tags", "--format=%(refname:short)\t%(objecttype)\t%(objectname)\t%(*objectname)"]);
  if (!r.ok) return { ok: false, reason: r.err || "git for-each-ref failed", tags: [] };
  const tags = [];
  for (const line of r.out.split("\n")) {
    if (!line) continue;
    const [name, type, obj, peeled] = line.split("\t");
    const m = VERSION_TAG_RE.exec(name);
    if (!m) continue;
    const annotated = type === "tag";
    tags.push({ name, prefix: m[1], version: m[2], annotated, commit: annotated ? peeled : obj });
  }
  return { ok: true, tags };
}

/**
 * What the alias script would do, per legacy tag. Derived from `git for-each-ref`, never from a typed list.
 * action: `create` (no alias yet) | `exists` (alias present on the same commit) | `conflict` (alias present on a
 * DIFFERENT commit: reported, never touched).
 */
export function planAliases(cwd) {
  const all = listVersionTags(cwd);
  if (!all.ok) return { ok: false, reason: all.reason, plan: [] };
  const byName = new Map(all.tags.map((t) => [t.name, t]));
  const plan = [];
  for (const t of all.tags) {
    if (t.prefix !== LEGACY_PREFIX) continue;
    const aliasName = `${ALIAS_PREFIX}${t.version}`;
    const have = byName.get(aliasName);
    let action = "create";
    let note = "";
    if (have) {
      if (have.commit === t.commit) action = have.annotated ? "exists" : "conflict";
      else action = "conflict";
      if (action === "conflict") note = have.commit !== t.commit
        ? `${aliasName} already points at ${have.commit.slice(0, 7)}, not ${t.commit.slice(0, 7)}`
        : `${aliasName} exists but is lightweight`;
    }
    plan.push({ legacy: t.name, alias: aliasName, commit: t.commit, legacyAnnotated: t.annotated, action, note });
  }
  plan.sort((a, b) => cmpVersion(a.legacy.slice(1), b.legacy.slice(1)));
  return { ok: true, plan };
}

/** Creates the `create` rows as local annotated tags. Returns one result per row; a row it did not create says why. */
export function applyAliases(cwd, plan) {
  const results = [];
  for (const row of plan) {
    if (row.action !== "create") { results.push({ ...row, applied: false }); continue; }
    const version = row.alias.slice(ALIAS_PREFIX.length);
    // `git tag -a <name> <commit>` with no -f: git itself refuses an existing name, so this cannot move a tag.
    const r = git(cwd, ["tag", "-a", row.alias, row.commit, "-m", `propagate ${version} (alias of ${row.legacy})`], { write: true });
    results.push({ ...row, applied: r.ok, error: r.ok ? undefined : r.err });
  }
  return results;
}

/** The `legacy_tags` block for the sidecar, derived from git. Entries follow the shape claude-usage-widget's sidecar uses. */
export function legacyTagsYaml(cwd, repo) {
  const all = listVersionTags(cwd);
  if (!all.ok) return { ok: false, reason: all.reason, yaml: "" };
  const legacy = all.tags.filter((t) => t.prefix === LEGACY_PREFIX).sort((a, b) => cmpVersion(a.version, b.version));
  if (legacy.length === 0) return { ok: false, reason: "no v* tags found; refusing to print an empty legacy_tags", yaml: "" };
  const lines = ["legacy_tags:"];
  for (const t of legacy) {
    lines.push(`  - repo: ${repo}`, `    tag: ${t.name}`, `    commit: ${t.commit.slice(0, 7)}`);
  }
  return { ok: true, yaml: lines.join("\n") + "\n", count: legacy.length };
}

export function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (x === undefined) return -1; // a shorter version sorts first; rc ordering is not needed for the tags listed here
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * The gate behind `release --check`: the commit being released must not carry a lightweight version tag, and a
 * `v*`-only tag with no `propagate-v*` alias is refused.
 *
 * Pre-tag (the normal moment `release --check` runs) HEAD carries no version tag, so the gate says exactly that:
 * it is "nothing to check yet", which is a pass that names what it could not see, not a claim about the future tag.
 * `git describe --tags --exact-match HEAD` in RELEASE.md is the post-tag check, and re-running `release --check`
 * after tagging is this gate with something to look at.
 *
 * @returns {{status: "passed"|"failed"|"could-not-run", detail?: string, reason?: string, atHead?: string[], unaliasedLegacy?: string[]}}
 */
export function checkTagsAtHead(cwd) {
  const all = listVersionTags(cwd);
  if (!all.ok) return { status: "could-not-run", reason: `could not read tags: ${all.reason}` };
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok) return { status: "could-not-run", reason: `could not resolve HEAD: ${head.err}` };
  const atHead = all.tags.filter((t) => t.commit === head.out);
  const byName = new Map(all.tags.map((t) => [t.name, t]));
  const owed = all.tags.filter((t) => t.prefix === LEGACY_PREFIX && !byName.has(`${ALIAS_PREFIX}${t.version}`)).map((t) => t.name);
  const owedNote = owed.length
    ? ` ${owed.length} legacy v* tag(s) still have no propagate-v* alias (node scripts/release-tag-aliases.mjs lists them; --apply creates them locally).`
    : "";

  const problems = [];
  for (const t of atHead) {
    if (t.prefix === ALIAS_PREFIX && !t.annotated) {
      problems.push(`${t.name} is a LIGHTWEIGHT tag on HEAD; the release tag must be annotated (git tag -a ${t.name})`);
    } else if (t.prefix === LEGACY_PREFIX && !byName.has(`${ALIAS_PREFIX}${t.version}`)) {
      problems.push(`${t.name} is on HEAD with no ${ALIAS_PREFIX}${t.version} alias; tag the release as an annotated propagate-v${t.version}`);
    }
  }
  if (problems.length) {
    return { status: "failed", detail: problems.join("; ") + ".", atHead: atHead.map((t) => t.name), unaliasedLegacy: owed };
  }
  if (atHead.length === 0) {
    return {
      status: "passed",
      detail: `no version tag on HEAD yet, so there is nothing to refuse; tag the release commit with git tag -a propagate-vX.Y.Z (annotated) after the release PR merges.${owedNote}`,
      atHead: [],
      unaliasedLegacy: owed,
    };
  }
  return {
    status: "passed",
    detail: `HEAD carries ${atHead.map((t) => `${t.name} (${t.annotated ? "annotated" : "lightweight, legacy form with an annotated alias"})`).join(", ")}.${owedNote}`,
    atHead: atHead.map((t) => t.name),
    unaliasedLegacy: owed,
  };
}
