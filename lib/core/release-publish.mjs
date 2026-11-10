/**
 * release-publish.mjs — the GitHub release lifecycle for propagate (#238), as ONE script a person runs.
 *
 * rule:release-versioning: "draft (building) -> pre-release (testing) -> release (a person approves) -> replaced (the
 * release stays, with 'Replaced by <version>' at the top of its body)". Publishing is outward-facing, so this is never
 * run by the tool or by CI: `release --check` has no path to it.
 *
 * Each step READS the state first and acts only when the state asks for it, so a re-run after a half-finished run
 * continues where it stopped and a re-run after a finished one writes nothing:
 *
 *   draft        no release for the tag        -> POST a DRAFT
 *   pre-release  the release is a draft        -> PATCH draft=false prerelease=true, then check its assets
 *   release      the release is a pre-release  -> PATCH prerelease=false (marked Latest unless told otherwise)
 *   replaced     the previous release's body does not start with "Replaced by" -> PATCH the line onto the top
 *
 * The body is the CHANGELOG section for the version, extracted: "a generated CHANGELOG is the single source of each
 * release body" and the body is never written separately. The step order is enforced: `release` on a draft refuses.
 *
 * Dry run is the default. It still READS (GET only, so the plan reflects the real state) and prints every call it
 * would make; it sends no write. `gh` is injected so the tests run against a stub and never reach GitHub.
 *
 * The push of the tag is NOT here and not done here. A tag missing from the remote REFUSES the apply, because GitHub
 * creates a missing tag from a branch head as a lightweight tag, which is exactly what #238 exists to stop.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { VERSION_TAG_RE } from "./release-tags.mjs";
import { tagVersion } from "./release-git.mjs";

export const STEPS = ["draft", "pre-release", "release", "replaced"];
export const REPLACED_RE = /^Replaced by /;

/** The body of `## [X]` in a Keep a Changelog file: everything under the heading, up to the next `## [`. null when absent. */
export function extractChangelogSection(text, version) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^## \\[${esc}\\](\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body === "" ? null : body;
}

function cmpSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The release this one replaces: the highest-version full release (not draft, not pre-release) below `version`. */
export function previousRelease(releases, version) {
  const cands = releases
    .filter((r) => !r.draft && !r.prerelease && VERSION_TAG_RE.test(r.tag_name))
    .map((r) => ({ r, v: tagVersion(r.tag_name) }))
    .filter((x) => cmpSemver(x.v, version) < 0)
    .sort((a, b) => cmpSemver(b.v, a.v));
  return cands.length ? cands[0].r : null;
}

export function defaultGh(bin = process.env.PROPAGATE_GH_BIN || "gh") {
  return (args, { input } = {}) => {
    const r = spawnSync(bin, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : "") };
  };
}

function gitIn(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/**
 * @param {object} o
 * @param {string} o.root repo with CHANGELOG.md and the tag
 * @param {string} o.version X.Y.Z
 * @param {string} [o.tag] default propagate-v<version>
 * @param {string} [o.repo] owner/name
 * @param {boolean} [o.apply] false (default) = dry run
 * @param {string} [o.only] one of STEPS, or omitted for all four in order
 * @param {boolean} [o.latest] mark the release Latest (default true: propagate is a customer product)
 * @param {string} [o.remote] git remote that must hold the tag
 * @param {string[]} [o.expectAssets] asset names the pre-release must carry before it may become a release
 * @param {(args: string[], opts?: {input?: string}) => {status: number, stdout: string, stderr: string}} [o.gh]
 * @param {(line: string) => void} [o.out]
 * @returns {{exitCode: number, writes: number, steps: Array<{step: string, action: string, detail: string}>}}
 */
export function publishRelease(o) {
  const {
    root, version, repo = "Rupali59/propagate", apply = false, only = null, latest = true, remote = "origin",
    expectAssets = [], gh = defaultGh(), out = console.log,
  } = o;
  const tag = o.tag ?? `propagate-v${version}`;
  const steps = [];
  let writes = 0;
  const say = (step, action, detail) => { steps.push({ step, action, detail }); out(`[${step}] ${action}${detail ? ` — ${detail}` : ""}`); };
  const fail = (msg) => { out(`refused: ${msg}`); return { exitCode: 1, writes, steps }; };
  const mode = apply ? "APPLY" : "DRY RUN (reads only; every write below is printed, none is sent)";
  out(`# release-publish ${tag} -> ${repo}   ${mode}`);

  if (only && !STEPS.includes(only)) return { exitCode: 2, writes, steps: [{ step: "args", action: "usage", detail: `--step must be one of ${STEPS.join(", ")}` }] };
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) return { exitCode: 2, writes, steps: [{ step: "args", action: "usage", detail: `${JSON.stringify(version)} is not a version` }] };

  // --- the body: the CHANGELOG section, extracted, never written separately -------------------------------------
  const changelog = path.join(root, "CHANGELOG.md");
  if (!existsSync(changelog)) return fail(`no CHANGELOG.md under ${root}; the release body comes from it`);
  const body = extractChangelogSection(readFileSync(changelog, "utf8"), version);
  if (body == null) return fail(`CHANGELOG.md has no non-empty "## [${version}]" section; the release body is extracted from it and is not written separately`);
  out(`body: ${body.split("\n").length} line(s) from CHANGELOG.md ## [${version}]`);

  // --- preconditions: fatal on apply; on a dry run they are reported and the plan continues --------------------
  const problems = [];
  const objType = gitIn(root, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (!objType.ok) problems.push(`tag ${tag} does not exist locally`);
  else {
    const legacy = /^v\d/.test(tag);
    if (objType.out !== "tag" && !legacy) problems.push(`tag ${tag} is lightweight; the release tag must be annotated (git tag -a)`);
    const v = gitIn(root, ["show", `refs/tags/${tag}:VERSION`]);
    if (v.ok && v.out !== version) problems.push(`tag ${tag} holds VERSION ${v.out}, not ${version}`);
    if (!v.ok) problems.push(`could not read VERSION at ${tag}: ${v.err}`);
  }
  const onRemote = gitIn(root, ["ls-remote", "--tags", remote, `refs/tags/${tag}`]);
  if (!onRemote.ok) problems.push(`could not ask remote ${remote} for ${tag}: ${onRemote.err}`);
  else if (!onRemote.out) problems.push(`tag ${tag} is not on remote ${remote}; push it first (GitHub would otherwise create a lightweight tag from a branch head)`);
  for (const p of problems) out(`precondition ${apply ? "FAILED" : "would fail on --apply"}: ${p}`);
  if (apply && problems.length) return fail("preconditions above; nothing was sent");
  if (problems.length === 0) out(`preconditions: ${tag} is ${objType.out === "tag" ? "annotated" : "a legacy lightweight tag"}, holds VERSION ${version}, and is on ${remote}`);

  // --- GitHub: reads always, writes only on --apply -------------------------------------------------------------
  const readAll = () => {
    const all = [];
    for (let page = 1; page < 50; page++) {
      const args = ["api", `repos/${repo}/releases?per_page=100&page=${page}`];
      out(`  gh ${args.join(" ")}   [read]`);
      const r = gh(args);
      if (r.status !== 0) throw new Error(`gh api releases failed (exit ${r.status}): ${r.stderr.trim()}`);
      let arr;
      try { arr = JSON.parse(r.stdout || "[]"); } catch (e) { throw new Error(`gh api releases returned unparseable JSON: ${e.message}`); }
      if (!Array.isArray(arr)) throw new Error("gh api releases did not return a list; refusing to treat that as 'no releases'");
      all.push(...arr);
      if (arr.length < 100) break;
    }
    return all;
  };
  const write = (method, endpoint, payload, apply2) => {
    const args = ["api", "-X", method, endpoint, "--input", "-"];
    out(`  gh ${args.join(" ")}   [${apply2 ? "WRITE" : "dry run: not sent"}]`);
    out(`    ${JSON.stringify(payload)}`);
    if (!apply2) return { ok: true, json: null };
    const r = gh(args, { input: JSON.stringify(payload) });
    writes++;
    if (r.status !== 0) return { ok: false, err: `gh api ${method} ${endpoint} failed (exit ${r.status}): ${r.stderr.trim()}` };
    try { return { ok: true, json: JSON.parse(r.stdout) }; } catch { return { ok: true, json: null }; }
  };

  let releases;
  try { releases = readAll(); } catch (e) { return fail(e.message); }
  let cur = releases.find((r) => r.tag_name === tag) ?? null;
  const refresh = () => { releases = readAll(); cur = releases.find((r) => r.tag_name === tag) ?? null; };
  // After a write, take the release object that write RETURNED. GitHub's list is eventually consistent: on the first
  // real run (propagate-v0.18.0) the list re-read right after the POST did not show the new draft, and the run refused.
  // Re-read only when the response carried no release.
  const adopt = (w) => {
    if (w.json && w.json.id != null && w.json.tag_name === tag) {
      cur = w.json;
      releases = [cur, ...releases.filter((r) => r.id !== cur.id)];
    } else refresh();
  };
  const stateOf = (r) => (!r ? "absent" : r.draft ? "draft" : r.prerelease ? "pre-release" : "release");
  const want = (s) => !only || only === s;
  const endpointFor = (r) => `repos/${repo}/releases/${r.id}`;

  // 1. draft
  if (want("draft")) {
    if (cur) say("draft", "skip", `a ${stateOf(cur)} already exists for ${tag}`);
    else {
      const payload = { tag_name: tag, name: `propagate ${version}`, body, draft: true, prerelease: false };
      const w = write("POST", `repos/${repo}/releases`, payload, apply);
      if (!w.ok) return fail(w.err);
      say("draft", apply ? "created" : "would create", "a DRAFT; a workflow cannot read a draft, so asset checks run at the pre-release");
      if (apply) adopt(w); else cur = { id: "<id>", tag_name: tag, name: payload.name, body, draft: true, prerelease: false, assets: [] };
    }
  }

  // 2. pre-release (+ asset check)
  if (want("pre-release")) {
    if (!cur) return fail(`no release for ${tag}; run the draft step first`);
    if (cur.draft) {
      const w = write("PATCH", endpointFor(cur), { draft: false, prerelease: true, body }, apply);
      if (!w.ok) return fail(w.err);
      say("pre-release", apply ? "promoted" : "would promote", "draft -> pre-release (visible to collaborators)");
      if (apply) adopt(w); else cur = { ...cur, draft: false, prerelease: true };
    } else say("pre-release", "skip", `already a ${stateOf(cur)}`);

    const have = (cur.assets ?? []).map((a) => a.name);
    const missing = expectAssets.filter((a) => !have.includes(a));
    if (expectAssets.length === 0) say("pre-release", "assets", `none expected (propagate ships as a git tree); the release carries ${have.length}`);
    else if (missing.length) {
      if (apply) return fail(`pre-release ${tag} is missing expected asset(s): ${missing.join(", ")}; it was not promoted to a release`);
      say("pre-release", "assets", `WOULD BLOCK on --apply: missing ${missing.join(", ")} (carries ${have.join(", ") || "none"}); a dry-run draft has no assets yet`);
    } else say("pre-release", "assets", `all ${expectAssets.length} expected asset(s) present`);
  }

  // 3. release
  if (want("release")) {
    if (!cur) return fail(`no release for ${tag}; run the earlier steps first`);
    if (cur.draft) return fail(`${tag} is still a draft; promote it to a pre-release first (the order is draft, pre-release, release)`);
    if (cur.prerelease) {
      const w = write("PATCH", endpointFor(cur), { prerelease: false, make_latest: latest ? "true" : "false", body }, apply);
      if (!w.ok) return fail(w.err);
      say("release", apply ? "promoted" : "would promote", `pre-release -> release${latest ? ", marked Latest" : ", NOT marked Latest (--no-latest)"}`);
      if (apply) adopt(w); else cur = { ...cur, prerelease: false };
    } else {
      const same = (cur.body ?? "").replace(/\r/g, "").replace(/^Replaced by [^\n]*\n+/, "").trim() === body;
      say("release", "skip", `already a release${same ? "" : "; its body DIFFERS from CHANGELOG ## [" + version + "] and a published release body is not edited here"}`);
    }
  }

  // 4. replaced
  if (want("replaced")) {
    if (!cur || cur.draft || cur.prerelease) {
      if (only === "replaced") return fail(`${tag} is not a published release (${stateOf(cur)}); the previous release is marked replaced only once this one is out`);
      say("replaced", "skip", `${tag} is a ${stateOf(cur)}, so nothing is replaced yet`);
    } else {
      const prev = previousRelease(releases, version);
      if (!prev) say("replaced", "skip", `no earlier full release below ${version}; nothing to mark`);
      else if (REPLACED_RE.test(prev.body ?? "")) say("replaced", "skip", `${prev.tag_name} already begins "${(prev.body ?? "").split("\n")[0]}"`);
      else {
        const line = `Replaced by ${tag}`;
        const newBody = `${line}\n\n${prev.body ?? ""}`.trimEnd();
        const w = write("PATCH", endpointFor(prev), { body: newBody }, apply);
        if (!w.ok) return fail(w.err);
        say("replaced", apply ? "marked" : "would mark", `${prev.tag_name} now begins "${line}"`);
      }
    }
  }

  out(apply ? `# done: ${writes} write(s) sent` : "# dry run done: 0 writes sent; pass --apply to send the writes printed above");
  return { exitCode: 0, writes, steps };
}
