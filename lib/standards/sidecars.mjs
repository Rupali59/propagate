/**
 * lib/standards/sidecars.mjs — the inputs `standards` and doctor's `# Standards` both read: each project's sidecar
 * `standards:` block, and the services.yml detect rules that a standard may reuse.
 *
 * Lives in lib/ so doctor does not import from cli/. Import prefix is `../…` from here (G60).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readSidecar } from "../report/manifest.mjs";
import { loadServices } from "../report/services.mjs";

/** Each workspace's `propagation/state/<project>/.sidecar.yml` `standards:` block, read leniently. */
export function readSidecars(workspaces) {
  const out = [];
  for (const ws of workspaces ?? []) {
    const dir = path.join(ws.root, "propagation", "state");
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name, ".sidecar.yml");
      if (!existsSync(file)) continue;
      const { sidecar, error } = readSidecar(file);
      const wsName = ws.name ?? path.basename(ws.root);
      if (error) out.push({ workspace: wsName, project: name, file, error: `unreadable sidecar: ${error}` });
      else out.push({ workspace: wsName, project: sidecar?.project ?? name, file, standards: sidecar?.standards });
    }
  }
  return out;
}

/**
 * services.yml detect rules by service id, when some standard reuses one. A services.yml that cannot be read is
 * pushed onto `loaded.problems` (the caller reports it), never silently an empty map.
 * @returns {Record<string, object>|null}
 */
export function serviceDetectsFor(loaded, integrations) {
  if (!loaded.standards.some((s) => s.service && !s.detect) || !integrations.servicesFile) return null;
  const sv = loadServices(integrations.servicesFile);
  if (sv.ok) return Object.fromEntries(sv.services.map((s) => [s.id, s.detect]));
  loaded.problems.push(`services.yml could not be read, so standards that reuse a service's detect read nothing: ${sv.reason}`);
  return null;
}
