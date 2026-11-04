/**
 * plugin-validate.mjs — read `claude plugin validate --json` and say whether propagate's plugin is acceptable (#98, #115).
 *
 * Two readers share this file: the release gate (`gatePluginValidate` in release.mjs) and
 * tests/portability/plugin-validate.test.mjs. Before 2026-11-04 `classify` lived in the test, so a release could be cut
 * without anyone running Claude's own validator. It is Claude's validator doing the validating; this module only decides
 * which of its findings propagate knowingly carries.
 *
 * READ `--json`, NEVER THE PROSE. Claude Code 2.1.311 appended a plugin-directory section to the human report and both
 * live tests went red with the validator's verdict unchanged. The JSON keeps the validator's warnings (`manifest`,
 * `contents[]`), the plugin directory's findings (`directory.findings[]`, each with a stable `code`) and advice apart.
 *
 * An allowlist of one fails loudly on anything new (rule:derive-dont-curate): a warning that is not pinned below is
 * unexpected, and so is a report whose shape this reader does not recognise (rule:discernment-checks §6).
 */
import { spawnSync } from "node:child_process";

/** The validator warnings propagate knowingly carries, matched against `<path>: <message>`. */
export const KNOWN_WARNINGS = [
  {
    re: /^directory: 1 component here was not read/,
    label: "skills/propagate/SKILL.md symlink, #98",
    why: "skills/propagate/SKILL.md is a symlink to the root SKILL.md (#98)",
  },
];

/** Plugin-directory finding codes propagate knowingly carries. */
export const KNOWN_DIRECTORY = [
  { code: "ICON_MISSING", why: "propagate ships from its own marketplace, not the plugin directory; no listing icon exists yet" },
];

/**
 * `{passed, unexpected, directoryUnexpected, pinnedWarnings, pinnedDirectory, untrackedOsFiles}` from the validator's `--json` report.
 * `isTracked(file)` answers whether a repo-relative path is committed; untracked OS metadata is not submitted.
 * A report whose shape is not recognised is a failure that says so, never an empty result (rule:discernment-checks §6).
 */
export function classify(report, { isTracked = () => true } = {}) {
  if (!report || typeof report !== "object" || !Array.isArray(report.contents) || !report.manifest) {
    return {
      passed: false,
      unexpected: ["unrecognised validator report shape — the reader cannot say what it found"],
      directoryUnexpected: [],
      pinnedWarnings: [],
      pinnedDirectory: [],
      untrackedOsFiles: 0,
    };
  }
  const parts = [report.manifest, ...report.contents];
  const errors = parts.flatMap((p) => p.errors ?? []);
  const warnings = parts.flatMap((p) => p.warnings ?? []).map((w) => `${w.path}: ${w.message}`);
  const pinnedWarnings = warnings.flatMap((l) => KNOWN_WARNINGS.filter((k) => k.re.test(l)).map((k) => k.label));
  const unexpected = [...errors.map((e) => `error ${e.path}: ${e.message}`), ...warnings.filter((l) => !KNOWN_WARNINGS.some((k) => k.re.test(l)))];
  const findings = report.directory?.findings ?? [];
  const directoryUnexpected = findings
    .filter((f) => {
      if (f.blocking) return true;
      if (f.code === "ARCHIVE_OS_METADATA_FILE") return isTracked(f.file);
      return !KNOWN_DIRECTORY.some((k) => k.code === f.code);
    })
    .map((f) => `${f.code} ${f.file}${f.blocking ? " (blocking)" : ""}`);
  const pinnedDirectory = [...new Set(findings.filter((f) => !f.blocking && KNOWN_DIRECTORY.some((k) => k.code === f.code)).map((f) => f.code))];
  const untrackedOsFiles = findings.filter((f) => f.code === "ARCHIVE_OS_METADATA_FILE" && !f.blocking && !isTracked(f.file)).length;
  return { passed: report.success === true && errors.length === 0, unexpected, directoryUnexpected, pinnedWarnings, pinnedDirectory, untrackedOsFiles };
}

/** The installed `claude` version string ("2.1.311"), or null when the CLI is not installed or does not answer. */
export function claudeVersion({ bin = "claude" } = {}) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout.match(/\d+\.\d+\.\d+\S*/) || [String(r.stdout).trim() || "unknown"])[0];
}

/** Run `claude plugin validate <dir> --json`. Returns the parsed report, or `{ unparsed }` with whatever it printed. */
export function validatePlugin(dir, { bin = "claude", timeout = 60000 } = {}) {
  const r = spawnSync(bin, ["plugin", "validate", dir, "--json"], { encoding: "utf8", timeout });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { unparsed: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }
}

/** Whether a repo-relative file is tracked by git in `repo`. */
export function isTrackedIn(repo) {
  return (file) => spawnSync("git", ["-C", repo, "ls-files", "--error-unmatch", "--", file], { stdio: "ignore" }).status === 0;
}
