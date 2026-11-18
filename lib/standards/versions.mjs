/**
 * lib/standards/versions.mjs — tool versions, probed only on request.
 *
 * `refreshVersions` is the ONLY place a tool is spawned, and only `standards versions --refresh` calls it: doctor
 * and hooks read `$STATE/standards/versions.json` and never probe (a `flutter --version` takes seconds). The
 * spawn is injectable (`run`), so tests never run a real tool. A probe that fails is recorded as
 * `{version: null, error}`, never left out: a missing key would read as "no probe configured".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION_RE = /\d+\.\d+(?:\.\d+)?/;
const PROBE_TIMEOUT_MS = 30_000;

const versionsFile = (stateDirPath) => path.join(stateDirPath, "standards", "versions.json");

/** @returns {{at:string, tools:Record<string,{version:string|null, at:string, error?:string}>}|null} null = never refreshed. */
export function readVersions(stateDirPath) {
  try {
    const v = JSON.parse(readFileSync(versionsFile(stateDirPath), "utf8"));
    return v && typeof v === "object" && v.tools && typeof v.tools === "object" ? v : null;
  } catch {
    return null;
  }
}

/** The cached version of `key`, or null when it is absent or is not a version (a cache written by an older parse). */
export function usableVersion(versions, key) {
  const v = versions?.tools?.[key]?.version;
  return typeof v === "string" && VERSION_RE.test(v) ? v : null;
}

/** "3h ago" for the cache's `at`; null when there is no cache or its time is unreadable. */
export function cacheAge(versions, now = Date.now()) {
  const t = Date.parse(versions?.at ?? "");
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function writeVersions(stateDirPath, versions) {
  const f = versionsFile(stateDirPath);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(versions, null, 2) + "\n");
}

/** The real spawn. Returns stdout; throws on a spawn error, a timeout or a non-zero exit. */
export function spawnRun(cmd, args = []) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split("\n")[0]}` : ""}`);
  return `${r.stdout ?? ""}`;
}

/**
 * @param {{probes: Record<string,{cmd:string,args?:string[],parse?:string}>, run?: (cmd:string,args:string[])=>string, now?: ()=>string}} o
 */
export function refreshVersions({ probes, run = spawnRun, now = () => new Date().toISOString() }) {
  const at = now();
  const tools = {};
  for (const [key, p] of Object.entries(probes ?? {})) {
    try {
      const out = String(run(p.cmd, p.args ?? []));
      const re = p.parse ? new RegExp(p.parse) : VERSION_RE;
      const m = re.exec(out);
      const captured = m ? (m[1] ?? m[0]) : null;
      if (m && !VERSION_RE.test(captured ?? "")) {
        tools[key] = { version: null, at, error: `probe output did not contain a version: ${String(captured).slice(0, 60)}` };
      } else tools[key] = captured ? { version: captured, at } : { version: null, at, error: `output did not match ${re}: ${out.trim().split("\n")[0].slice(0, 80)}` };
    } catch (e) {
      tools[key] = { version: null, at, error: String(e?.message ?? e).split("\n")[0] };
    }
  }
  return { at, tools };
}
