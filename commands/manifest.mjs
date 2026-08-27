/**
 * manifest.mjs — `propagate manifest <workspace>`.
 *
 * Renders what `lib/report/manifest.mjs` derives: how to stand this workspace up
 * on another machine. Report only — it never clones, writes, or reaches the
 * network.
 *
 * WHY THE OUTPUT IS PHASED. This command reads `.sidecar.yml` files that live
 * INSIDE the workspace repo, so on a bare machine it cannot be the first thing
 * you run — the repo it reads is not there yet. Pretending otherwise would hand
 * someone a runbook whose step 1 is impossible. Phase 0 is therefore by hand,
 * and phase 2 is where this command starts being able to describe the rest.
 *
 * Import prefix is `../lib/…` from here. G60: a specifier copied out of cli.mjs
 * is relative to the REPO ROOT, resolves to a different (non-existent) file from
 * this directory, and fails only at runtime.
 */

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

/** Quote a path for a shell command only when it needs it. */
const q = (s) => (/[\s'"]/.test(s) ? JSON.stringify(s) : s);

const GAP_LABEL = {
  "arrives-with-parent": `${DIM}arrives with parent${RESET}`,
  "cannot-clone": `${RED}cannot clone${RESET}`,
  "shared-remote": `${RED}shared remote${RESET}`,
  "remote-undeclared": `${YELLOW}remote undeclared${RESET}`,
  "would-be-missed": `${RED}would be missed${RESET}`,
  "not-cloned-here": `${DIM}not cloned here${RESET}`,
  "sidecar-unreadable": `${RED}sidecar unreadable${RESET}`,
  "state-dir-undeclared": `${RED}state dir undeclared${RESET}`,
};

export async function manifestCmd() {
  const args = process.argv.slice(3);
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error(`${RED}error:${RESET} a workspace is required — e.g. ${BOLD}propagate manifest "Vipin Kaushik"${RESET}`);
    console.error(`  ${DIM}one workspace per invocation; the argument is not optional${RESET}`);
    process.exit(2);
  }

  const { WORKSPACES } = await import("../lib/core/config.mjs");
  const ws = WORKSPACES.find((w) => w.name === target || w.root === target || w.root.endsWith(`/${target}`));
  if (!ws) {
    // Absence attributable: name what WAS found, so "no such workspace" and
    // "discovery found nothing at all" are distinguishable.
    console.error(`${RED}error:${RESET} no workspace named ${JSON.stringify(target)}`);
    console.error(`  ${DIM}${WORKSPACES.length} known: ${WORKSPACES.map((w) => w.name).join(", ") || "(none — discovery found no workspaces)"}${RESET}`);
    process.exit(2);
  }

  const { workspaceManifest } = await import("../lib/report/manifest.mjs");
  const result = workspaceManifest(ws.root);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ORDER IS LOAD-BEARING: the workspace repo clones FIRST. Every project path
  // is INSIDE the workspace directory, so cloning a project first creates that
  // directory and `git clone` then refuses the workspace repo into a non-empty
  // target. The first draft emitted it last and the runbook would have failed
  // at step 2 for anyone who followed it literally.
  const clonable = result.projects
    .filter((p) => p.remote)
    .sort((a, b) => Number(b.isWorkspaceItself) - Number(a.isWorkspaceItself));
  // Informational kinds are NOT blockers. `not-cloned-here` is the normal state
  // of a fresh machine, and `arrives-with-parent` says the thing is already
  // covered by another clone. Counting either as blocking makes a healthy
  // workspace report failures, which trains people to ignore the number.
  const INFORMATIONAL = new Set(["not-cloned-here", "arrives-with-parent"]);
  const blocking = result.gaps.filter((g) => !INFORMATIONAL.has(g.kind));

  console.log(
    `${BOLD}${result.workspace}${RESET} ${DIM}— ${result.projects.length} project(s), ` +
      `${blocking.length} blocking gap(s)${RESET}`,
  );

  // ── phase 0 ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}# 0 · Before this command can run there${RESET} ${DIM}(by hand)${RESET}`);
  console.log(`  ${DIM}This reads .sidecar.yml files inside the workspace repo, so it cannot be`);
  console.log(`  the first step on a bare machine — the repo is not there yet.${RESET}`);
  console.log(`    git clone <hub-remote> ~/Documents/GitHub`);
  console.log(`    ${DIM}install the propagate plugin, then:${RESET}`);
  console.log(`    propagate setup --hub ~/Documents/GitHub`);

  // ── phase 1 ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}# 1 · Clone${RESET} ${DIM}(${clonable.length} of ${result.projects.length})${RESET}`);
  for (const p of clonable) {
    const dest = p.isWorkspaceItself ? result.workspace : `${result.workspace}/${p.repo_root}`;
    console.log(`  git clone ${p.remote} ${q(dest)}`);
    if (p.active_line && p.active_line !== "main") {
      console.log(`  git -C ${q(dest)} checkout ${p.active_line}   ${DIM}# not main${RESET}`);
    }
  }

  // ── phase 2 ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}# 2 · Per unit${RESET}`);
  const w = Math.max(12, ...result.projects.flatMap((p) => p.units.map((u) => u.rel.length)));
  for (const p of result.projects) {
    for (const u of p.units) {
      if (p.isWorkspaceItself && u.toolchain === "none") continue;
      // Pad the PLAIN string and colour afterwards. padEnd counts ANSI escape
      // bytes as width, so colouring first silently destroys the alignment of
      // exactly the rows that are coloured — i.e. the ones worth reading.
      const dim = u.toolchain === "none" || u.toolchain === "unknown";
      const toolPad = u.toolchain.padEnd(8);
      const portTxt = (u.port ? `port ${u.port}` : `port ${u.portStatus}`).padEnd(18);
      const envTxt = u.env.source === "doppler" ? `doppler ${u.env.project}` : u.env.source === "env-example" ? ".env.example" : "env: NO SOURCE";
      const tool = dim ? `${DIM}${toolPad}${RESET}` : toolPad;
      const port = u.port ? portTxt : `${DIM}${portTxt}${RESET}`;
      const env =
        u.env.source === "doppler" ? envTxt : u.env.source === "env-example" ? `${DIM}${envTxt}${RESET}` : `${YELLOW}${envTxt}${RESET}`;
      console.log(`  ${u.rel.padEnd(w)}  ${tool} ${port} ${env}${u.compose ? `  ${DIM}compose${RESET}` : ""}`);
    }
  }
  if (result.workspaceCompose) {
    console.log(`  ${DIM}workspace docker-compose.yml present — local infra for the whole workspace${RESET}`);
  }

  // ── phase 3 ────────────────────────────────────────────────────────────────
  const externals = result.projects.flatMap((p) => p.external.map((e) => ({ ...e, project: p.project })));
  if (externals.length) {
    console.log(`\n${BOLD}# 3 · Out of band${RESET} ${DIM}(not in git — no clone produces these)${RESET}`);
    for (const e of externals) {
      const size = e.bytes_approx ? ` ${DIM}(~${Math.round(e.bytes_approx / 1e6)} MB)${RESET}` : "";
      console.log(`  ${YELLOW}${e.path}${RESET}${size}  ${DIM}${e.project}${RESET}`);
      if (e.why) console.log(`      ${DIM}${e.why}${RESET}`);
      if (e.transfer) console.log(`      ${DIM}${e.transfer}${RESET}`);
    }
  }

  // ── gaps ───────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}# Gaps${RESET}`);
  if (result.gaps.length === 0) {
    console.log(`  ${GREEN}none${RESET}`);
  } else {
    for (const g of result.gaps) {
      console.log(`  ${GAP_LABEL[g.kind] ?? g.kind}  ${g.project}`);
      console.log(`      ${DIM}${g.detail}${RESET}`);
    }
  }

  // Registry health last, so a malformed registry is visible without burying
  // the runbook. "ok" is printed too — silence about a source you read is how a
  // stale registry passes for a healthy one.
  console.log(`\n${DIM}registries: ports ${result.sources.ports} · deploy ${result.sources.deploy} · mongo ${result.sources.mongo}${RESET}`);
  console.log(
    `${DIM}This gets you cloned, on the right branches, with toolchains and ports known.` +
      ` Env VALUES come from Doppler; out-of-band payloads move by hand.${RESET}`,
  );
}
