/**
 * gh.mjs — the one gh seam for `propagate broadcast`. A `gh` is a function `(args, {input}) -> {status, stdout, stderr}`;
 * the default shells out to $PROPAGATE_GH_BIN or `gh`, so a test injects either a script or a function.
 */
import { spawnSync } from "node:child_process";

export function makeGh(gh = process.env.PROPAGATE_GH_BIN || "gh") {
  if (typeof gh === "function") return gh;
  return (args, { input } = {}) => {
    const r = spawnSync(gh, args, { encoding: "utf8", timeout: 60000, input, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { status: 127, stdout: "", stderr: `${gh}: ${r.error.code || r.error.message}` };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

/** `{ok:true, json}` or `{ok:false, error}`. Never throws: the caller owns the exit code. */
export function readJson(gh, args, what) {
  const r = gh(args);
  if (r.status !== 0) return { ok: false, error: `${what}: ${firstLine(r.stderr || r.stdout) || `gh exited ${r.status}`}` };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: `${what}: output was not JSON` };
  }
}
