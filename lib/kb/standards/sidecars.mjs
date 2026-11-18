/**
 * lib/kb/standards/sidecars.mjs — the inputs `standards` and doctor's `# Knowledge base` both read: each project's sidecar
 * `kb:` block (or the legacy `standards:`), and the services.yml detect rules that a standard may reuse.
 *
 * Lives in lib/ so doctor does not import from cli/. Import prefix is `../…` from here (G60).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readSidecar } from "../../report/manifest.mjs";
import { bothKeysError } from "./adopt.mjs";
import { loadServices } from "../../report/services.mjs";

/** Each workspace's `propagation/state/<project>/.sidecar.yml` `kb:` block, or the legacy `standards:` one, read leniently.
 * `standards` is the block from whichever key held it; `key` says which (`"kb"`, `"standards"`, or null when there is none), so
 * doctor can name a legacy key. A sidecar with both keys is an `error`, never merged. */
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
      else if (sidecar?.kb !== undefined && sidecar?.standards !== undefined) out.push({ workspace: wsName, project: sidecar?.project ?? name, file, error: bothKeysError(file) });
      else {
        const key = sidecar?.kb !== undefined ? "kb" : sidecar?.standards !== undefined ? "standards" : null;
        out.push({ workspace: wsName, project: sidecar?.project ?? name, file, standards: key ? sidecar[key] : undefined, key });
      }
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
