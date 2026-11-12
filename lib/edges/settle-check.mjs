/**
 * settle-check.mjs — the deterministic gate on an agent's settle proposals (propagate#251).
 *
 * WHY IT EXISTS. The `propagate:edge-settler` subagent reads a file's drifted edges and the git log on both
 * sides, then proposes one disposition per edge. Its report comes back in the same confident register whether it
 * is right or wrong, so the parent never acts on the report: it acts on what THIS module accepts. Rupali,
 * 2026-11-12: "if we are replacing a functionality, it better have a deterministic check at the end".
 *
 * WHAT IT CHECKS, each clause a refusal the agent cannot argue with:
 *   1. shape      — proposals is an array of {edge_id, disposition, reason, shas[]}; reason is not the placeholder.
 *   2. coverage   — the edge-id SET equals the worklist's (missing, extra and duplicate ids are named). This is
 *                   the position-binding error of 2026-11-12, where ids were matched by worklist order.
 *   3. predicate  — the disposition is in the edge's `allowed` list, the SAME predicate verify enforces
 *                   (DIVERGED guard + ordering). A disposition only reachable via --out-of-order is refused: that
 *                   override is the parent's decision, never the agent's.
 *   4. evidence   — every SHA exists and touched one of the edge's two paths. An uncommitted change has no SHA,
 *                   so it is refused with that reason rather than accepted on faith.
 *
 * Pure: git is injected ({exists(sha, cwd), touched(sha, file)}). Nothing here writes. The caller (cli/settle.mjs
 * `--check`) then runs each accepted command through `verify` WITHOUT --apply, the second, independent gate.
 */

import { REASON_PLACEHOLDER, REASON_PLACEHOLDER_BOTH, verifyCommand } from "./disposition.mjs";

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * @param {{items: object[]}} worklist  settleWorklist(...) result (ok: true)
 * @param {unknown} proposals            the agent's JSON
 * @param {{exists: (sha: string, file: string) => boolean, touched: (sha: string, file: string) => boolean}} git
 * @returns {{ok: boolean, accepted: object[], rejected: {edge_id: string|null, reasons: string[]}[], missing: string[], extra: string[], duplicate: string[], error?: string}}
 */
export function checkProposals(worklist, proposals, git) {
  const result = { ok: false, accepted: [], rejected: [], missing: [], extra: [], duplicate: [] };
  const list = Array.isArray(proposals) ? proposals : Array.isArray(proposals?.proposals) ? proposals.proposals : null;
  if (!list) return { ...result, error: "proposals is not an array (nor {proposals: [...]})" };

  const items = new Map(worklist.items.map((i) => [i.edge_id, i]));
  const seen = new Set();

  for (const p of list) {
    const reasons = [];
    const id = typeof p?.edge_id === "string" ? p.edge_id : null;
    if (!id) {
      result.rejected.push({ edge_id: null, reasons: ["no edge_id"] });
      continue;
    }
    if (seen.has(id)) {
      result.duplicate.push(id);
      continue;
    }
    seen.add(id);
    const item = items.get(id);
    if (!item) {
      result.extra.push(id);
      continue;
    }

    const disp = p.disposition;
    if (typeof disp !== "string") reasons.push("no disposition");
    else if (!item.allowed.includes(disp)) {
      reasons.push(
        item.viaOutOfOrder?.includes(disp)
          ? `${disp} needs --out-of-order (blocked by ${item.blockedBy.map((b) => b.edge_id).join(", ")}); that override is the parent's call`
          : `${disp} is not allowed on this ${item.state} edge (allowed: ${item.allowed.join(", ") || "none"})`,
      );
    }

    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    if (!reason || reason === REASON_PLACEHOLDER || reason === REASON_PLACEHOLDER_BOTH) reasons.push("no reason (or the placeholder)");

    const shas = Array.isArray(p.shas) ? p.shas : [];
    if (!shas.length) reasons.push("no evidence SHA");
    const paths = [item.source, item.downstream].filter(Boolean);
    for (const s of shas) {
      if (typeof s !== "string" || !SHA.test(s)) {
        reasons.push(`${JSON.stringify(s)} is not a commit SHA (an uncommitted change has none: commit it, or settle by hand)`);
        continue;
      }
      if (!paths.some((f) => git.exists(s, f))) {
        reasons.push(`${s} does not exist in the repo of either side`);
        continue;
      }
      if (!paths.some((f) => git.touched(s, f))) reasons.push(`${s} touched neither ${paths.join(" nor ")}`);
    }

    if (reasons.length) result.rejected.push({ edge_id: id, reasons });
    else {
      result.accepted.push({
        edge_id: id,
        disposition: disp,
        reason,
        shas,
        dryRun: verifyCommand({ edge: id, disposition: disp, reason, apply: false }),
        apply: verifyCommand({ edge: id, disposition: disp, reason }),
      });
    }
  }

  for (const id of items.keys()) if (!seen.has(id)) result.missing.push(id);
  result.ok =
    result.rejected.length === 0 && !result.missing.length && !result.extra.length && !result.duplicate.length && result.accepted.length > 0;
  return result;
}

/** The real git reader. `touched` asks git which commits changed the file, so a renamed or wrong path answers no. */
export function realGit(spawnSync, path) {
  const run = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30000 });
  return {
    exists: (sha, file) => run(path.dirname(file), ["cat-file", "-e", `${sha}^{commit}`]).status === 0,
    touched: (sha, file) => {
      const r = run(path.dirname(file), ["log", "--format=%H", "--follow", "--", path.basename(file)]);
      return r.status === 0 && r.stdout.split("\n").some((h) => h && h.startsWith(sha));
    },
  };
}
