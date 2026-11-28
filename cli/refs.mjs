/**
 * `propagate refs record-pruned` (propagate#448): the one door for an outside tool to record a branch
 * it prunes. All decisions live in lib/refs/record-pruned.mjs; this file parses, resolves the
 * workspace, prints, and maps the result to an exit code.
 *
 * EXIT CODES. 0 recorded, or a dry run that would be accepted; 1 refused, with a REFS_PRUNE_* code;
 * 2 could not run (usage, no or unreadable snapshot or lifecycle, an unknown snapshot shape, a lock
 * held elsewhere). A caller that deletes after this MUST treat anything but 0 as "do not delete".
 * Without --apply nothing is written, whatever the result.
 */
import { applyRecord } from "../lib/refs/record-pruned.mjs";

const USAGE =
  "usage: propagate refs record-pruned --workspace <dir|name> --branch <name> --head <sha> --evidence <json> --detected-by cleaner [--project <p>] [--apply] [--json]";

function valueOf(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}

export async function refsCmd(argv = []) {
  if (argv[0] !== "record-pruned") {
    console.error(`error: ${USAGE}`);
    return 2;
  }
  const rest = argv.slice(1);
  const asJson = rest.includes("--json");
  const apply = rest.includes("--apply");
  const workspace = valueOf(rest, "--workspace");
  const branch = valueOf(rest, "--branch");
  const head = valueOf(rest, "--head");
  const evidence = valueOf(rest, "--evidence");
  const detectedBy = valueOf(rest, "--detected-by");
  const project = valueOf(rest, "--project");
  const missing = [["--workspace", workspace], ["--branch", branch], ["--head", head], ["--evidence", evidence], ["--detected-by", detectedBy]]
    .filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    console.error(`error: missing ${missing.join(", ")}\n${USAGE}`);
    return 2;
  }

  const { WORKSPACES } = await import("../lib/core/config.mjs");
  const { resolveWorkspace } = await import("../lib/core/discovery.mjs");
  const resolved = resolveWorkspace(workspace, WORKSPACES);
  if (!resolved.ok) {
    console.error(`error: ${resolved.reason}`);
    return 2;
  }

  const r = await applyRecord({ workspace: resolved.workspace.root, branch, head, evidence, detectedBy, project, apply });
  const exit = r.ok ? 0 : r.exit;
  if (asJson) {
    console.log(JSON.stringify({ ...r, exit }, null, 2));
    return exit;
  }
  if (!r.ok) {
    console.error(`${r.exit === 1 ? "refused" : "could not run"} ${r.code}: ${r.reason}`);
    return exit;
  }
  console.log(`${r.applied ? "recorded" : "would record"}: ${JSON.stringify(r.event)}`);
  if (!r.applied) console.log("dry run: nothing was written; pass --apply to append it");
  return exit;
}
