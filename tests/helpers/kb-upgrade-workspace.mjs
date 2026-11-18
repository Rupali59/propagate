/**
 * A search root holding one generic workspace of 12 projects (the standards scan's blind-scan floor is 10), for the
 * kb-rename upgrade tests (#322). Project p00 carries `example.yaml`, which the fixture registry detects.
 * Everything is generic and built under a caller-supplied directory, so nothing here names a real workspace.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function makeKbUpgradeWorkspace(searchRoot) {
  const ws = path.join(searchRoot, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\n");
  for (let i = 0; i < 12; i++) {
    const p = `p${String(i).padStart(2, "0")}`;
    mkdirSync(path.join(ws, p), { recursive: true });
    mkdirSync(path.join(ws, "propagation", "state", p), { recursive: true });
    writeFileSync(path.join(ws, p, "package.json"), `{"name":"${p}"}\n`);
    writeFileSync(path.join(ws, p, "package-lock.json"), "{}\n");
    writeFileSync(path.join(ws, "propagation", "state", p, ".sidecar.yml"), `project: ${p}\nrepo_root: ${p}\n`);
  }
  writeFileSync(path.join(ws, "p00", "example.yaml"), "x: 1\n");
  return ws;
}
