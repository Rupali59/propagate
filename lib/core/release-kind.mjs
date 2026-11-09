/**
 * release-kind.mjs — which KIND of release a set of commits makes, and whether the VERSION bump matches (#234).
 *
 * PURE: no I/O, no git, no clock unless a date is passed in. The callers do the I/O: `.githooks/commit-msg`
 * (the blocking enforcement point, via cli/release-kind.mjs), the `release-kind` gate in lib/core/release.mjs, and
 * `propagate release notes`.
 *
 * THREE STANDARDS, chosen in-repo rather than adopting release-please (docs/RELEASE.md names them, so a later
 * move to release-please is a configuration change):
 *   - Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/): `fix` is PATCH, `feat` is
 *     MINOR, and `!` or a `BREAKING CHANGE:` footer is MAJOR whatever the type. Other types do not change the
 *     version on their own.
 *   - SemVer 2.0.0 (https://semver.org/), item 4: "Major version zero (0.y.z) is for initial development.
 *     Anything MAY change at any time." So BEFORE 1.0 a breaking change bumps the MINOR number and is flagged
 *     in a Breaking section (release-please's `bump-minor-pre-major`).
 *   - Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/): "Changelogs are for humans, not machines",
 *     with an `Unreleased` section at the top.
 *
 * rule:discernment-checks §2: a subject with a prefix this module does not know is LISTED BY NAME in `unknown`,
 * never silently counted as a fix.
 */

/** Types that mean a feature (MINOR). */
const FEATURE = new Set(["feat"]);
/** Types that are PATCH on their own. `style` and `revert` are Conventional Commits types the plan did not list; they are patch. */
const PATCH_TYPES = new Set(["fix", "docs", "chore", "test", "refactor", "perf", "build", "ci", "style", "revert"]);

const SUBJECT_RE = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s+(\S.*)$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * @param {string[]} messages commit messages. A string with a newline is a FULL message: its first line is the
 *   subject and the rest is scanned for a `BREAKING CHANGE:` footer. A one-line string is just a subject.
 * @returns {{required: "minor"|"patch"|"none", breaking: boolean, byType: Record<string, number>,
 *   unknown: string[], items: Array<{type: string, scope: string|null, desc: string, breaking: boolean, subject: string}>}}
 *   `required` is the pre-1.0 requirement (`minor` for a feat or a breaking change). `items` holds the recognised
 *   subjects in input order, for the notes builder.
 */
export function classify(messages) {
  const byType = {};
  const unknown = [];
  const items = [];
  let breaking = false;
  let sawFeature = false;
  let sawPatch = false;
  for (const raw of messages ?? []) {
    const text = String(raw ?? "").replace(/\r/g, "");
    const nl = text.indexOf("\n");
    const subject = (nl === -1 ? text : text.slice(0, nl)).trim();
    if (!subject) continue;
    const body = nl === -1 ? "" : text.slice(nl + 1);
    const m = SUBJECT_RE.exec(subject);
    const type = m ? m[1].toLowerCase() : null;
    if (!m || !(FEATURE.has(type) || PATCH_TYPES.has(type))) {
      unknown.push(subject);
      // A breaking footer is a fact about the change even when its prefix is unrecognised.
      if (BREAKING_FOOTER_RE.test(body)) breaking = true;
      continue;
    }
    const isBreaking = Boolean(m[3]) || BREAKING_FOOTER_RE.test(body);
    byType[type] = (byType[type] ?? 0) + 1;
    items.push({ type, scope: m[2] || null, desc: m[4].trim(), breaking: isBreaking, subject });
    if (isBreaking) breaking = true;
    if (FEATURE.has(type)) sawFeature = true; else sawPatch = true;
  }
  const required = breaking || sawFeature ? "minor" : sawPatch ? "patch" : "none";
  return { required, breaking, byType, unknown, items };
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "major" | "minor" | "patch" | "none" (equal) | "invalid" (unparseable, or next is lower than prev). */
export function bumpKind(prev, next) {
  const a = parseVersion(prev);
  const b = parseVersion(next);
  if (!a || !b) return "invalid";
  if (b[0] !== a[0]) return b[0] > a[0] ? "major" : "invalid";
  if (b[1] !== a[1]) return b[1] > a[1] ? "minor" : "invalid";
  if (b[2] !== a[2]) return b[2] > a[2] ? "patch" : "invalid";
  return "none";
}

/** The smallest version of the given kind above prev, or null when prev does not parse. */
export function nextVersion(prev, kind) {
  const a = parseVersion(prev);
  if (!a) return null;
  if (kind === "major") return `${a[0] + 1}.0.0`;
  if (kind === "minor") return `${a[0]}.${a[1] + 1}.0`;
  if (kind === "patch") return `${a[0]}.${a[1]}.${a[2] + 1}`;
  return `${a[0]}.${a[1]}.${a[2]}`;
}

/** The bump the classified commits need, given the version they sit on. Pre-1.0 a breaking change is minor; from 1.0 it is major. */
export function requiredBump(prev, cls) {
  if (cls.required === "none") return "none";
  const a = parseVersion(prev);
  if (cls.breaking && a && a[0] >= 1) return "major";
  return cls.required;
}

/**
 * Does the bump prev -> next cover what the commits require?
 * An actual bump ABOVE the requirement is allowed (`above: true`); below it, or an invalid/equal version when
 * commits require a bump, fails.
 *
 * @param {string} prev  the version the commits sit on
 * @param {string} next  the VERSION being released
 * @param {string[]} messages commits since the last tag (and, in the hook, this commit's own message)
 * @param {{since?: string}} [opts] the tag name, for the message
 * @returns {{ok: boolean, required: string, requiredVersion: string|null, actual: string, above: boolean,
 *   breaking: boolean, unknown: string[], why: string}}
 */
export function checkBump(prev, next, messages, opts = {}) {
  const cls = classify(messages);
  const required = requiredBump(prev, cls);
  const actual = bumpKind(prev, next);
  const requiredVersion = required === "none" ? null : nextVersion(prev, required);
  const since = opts.since ?? "the last tag";
  const trigger = cls.breaking ? "a breaking change" : cls.byType.feat ? "a `feat:`" : "a `fix:`-class commit";
  const unk = cls.unknown.length ? ` Unprefixed (not counted): ${cls.unknown.map((s) => `"${s}"`).join("; ")}.` : "";
  const base = { required, requiredVersion, actual, breaking: cls.breaking, unknown: cls.unknown };

  if (actual === "invalid") {
    return { ...base, ok: false, above: false, why: `VERSION ${JSON.stringify(next)} is not a valid version at or above ${prev}.${unk}` };
  }
  if (RANK[actual] < RANK[required]) {
    const state = actual === "none" ? `is still ${next}` : `was bumped to ${next}`;
    return { ...base, ok: false, above: false, why: `${trigger} since ${since} needs a ${required} bump (${requiredVersion}); VERSION ${state}.${unk}` };
  }
  const above = RANK[actual] > RANK[required];
  const note = above ? ` (above the ${required} the commits require, which is allowed)` : "";
  return { ...base, ok: true, above, why: `${actual} bump ${prev} -> ${next} covers the ${required} the commits since ${since} require${note}.${unk}` };
}

const GROUPS = [
  ["Breaking", "Breaking"],
  ["Added", "Added"],
  ["Fixed", "Fixed"],
  ["Changed", "Changed"],
];

/** Group classified items by Keep a Changelog heading. Unprefixed subjects land in Changed with their raw text. */
export function groupNotes(messages) {
  const cls = classify(messages);
  const groups = { Breaking: [], Added: [], Fixed: [], Changed: [] };
  const bullet = (it) => (it.scope ? `${it.scope}: ${it.desc}` : it.desc);
  for (const it of cls.items) {
    if (it.breaking) groups.Breaking.push(bullet(it));
    if (it.type === "feat") groups.Added.push(bullet(it));
    else if (it.type === "fix") groups.Fixed.push(bullet(it));
    else if (!it.breaking) groups.Changed.push(bullet(it));
  }
  for (const s of cls.unknown) groups.Changed.push(`${s} (unprefixed)`);
  return { groups, cls };
}

/** The body of a changelog section (no heading): `### Group` blocks with one bullet per commit, empty groups omitted. */
export function renderBody(messages) {
  const { groups } = groupNotes(messages);
  const blocks = [];
  for (const [key, title] of GROUPS) {
    if (!groups[key].length) continue;
    blocks.push(`### ${title}\n\n${groups[key].map((b) => `- ${b}`).join("\n")}`);
  }
  return blocks.join("\n\n");
}

const UNRELEASED_RE = /^## \[Unreleased\][^\n]*$/m;
const SECTION_RE = /^## \[/m;

/** Index of the next `## [` heading at or after `from`, or text.length. */
function nextSection(text, from) {
  const re = /^## \[/gm;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/** The current body of `## [Unreleased]` ("" when empty or absent). */
export function unreleasedBody(text) {
  const m = UNRELEASED_RE.exec(text);
  if (!m) return "";
  const start = m.index + m[0].length;
  return text.slice(start, nextSection(text, start)).trim();
}

/** Does `## [X]` already exist? */
export function hasVersion(text, version) {
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${esc}\\]`, "m").test(text);
}

const HEADER = "# Changelog\n\nAll notable changes to propagate are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/) (before 1.0 a feature or a breaking change bumps the minor number), and commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). `propagate release notes --write` drafts each section from the commits; a person edits it.\n";

/**
 * Apply a notes draft to CHANGELOG text.
 *   - no `version`: fill/refresh `## [Unreleased]` with `body` (created at the top when absent).
 *   - `version` X: rename `## [Unreleased]` to `## [X] — date` and open an empty `## [Unreleased]` above it. The
 *     Unreleased text is KEPT when it has any (a person may have edited it); only an empty one is filled from `body`.
 *     Refuses when `## [X]` already exists.
 *
 * @returns {{ok: true, text: string, action: string} | {ok: false, reason: string}}
 */
export function applyToChangelog(text, { body, version = null, date }) {
  const src = text && text.trim() ? text : HEADER;
  const m = UNRELEASED_RE.exec(src);
  const head = m ? src.slice(0, m.index) : src.slice(0, SECTION_RE.exec(src)?.index ?? src.length);
  const tail = m ? src.slice(nextSection(src, m.index + m[0].length)) : src.slice(SECTION_RE.exec(src)?.index ?? src.length);
  const current = m ? unreleasedBody(src) : "";
  const join = (h, sections, t) => `${h.trimEnd()}\n\n${sections.join("\n\n")}${t ? `\n\n${t.trimStart()}` : "\n"}`.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");

  if (version == null) {
    const section = `## [Unreleased]${body ? `\n\n${body}` : ""}`;
    return { ok: true, text: join(head, [section], tail), action: m ? "refreshed [Unreleased]" : "created [Unreleased]" };
  }
  if (hasVersion(src, version)) return { ok: false, reason: `CHANGELOG.md already has a "## [${version}]" section; refusing to write a duplicate` };
  const content = current || body;
  if (!content) return { ok: false, reason: `no notes to release: [Unreleased] is empty and there are no commits to draft from` };
  const released = `## [${version}] — ${date}\n\n${content}`;
  return { ok: true, text: join(head, ["## [Unreleased]", released], tail), action: `released [Unreleased] as [${version}]` };
}

export { HEADER as CHANGELOG_HEADER };
