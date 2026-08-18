import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
const ROOT = "/Users/rupali.b/Documents/GitHub";
const SKIP = new Set(["node_modules",".git",".next","dist","build",".venv","__pycache__",".worktrees",".gstack","_archive",".vercel",".turbo"]);

// A "project" = a directory containing a package.json OR a CLAUDE.md OR a .git,
// at depth 1 or 2 under the hub. Deliberately generous: a candidate list that is
// too small would make adoption look better than it is.
const projects = [];
function walk(dir, depth) {
  if (depth > 2) return;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    const isProject = existsSync(path.join(p,"package.json")) || existsSync(path.join(p,"CLAUDE.md")) || existsSync(path.join(p,".git"));
    if (isProject) projects.push(p);
    walk(p, depth + 1);
  }
}
walk(ROOT, 1);

let hasGotchasFile = 0, hasSection = 0, hasNeither = 0;
const withFile = [], withSectionOnly = [], without = [];
for (const p of projects) {
  const f = existsSync(path.join(p,"docs","GOTCHAS.md")) || existsSync(path.join(p,"GOTCHAS.md"));
  const cm = path.join(p,"CLAUDE.md");
  let section = false;
  if (existsSync(cm)) {
    const t = readFileSync(cm,"utf8").toLowerCase();
    section = /bite you|gotcha|will burn|foot-?gun|things that will/.test(t);
  }
  const rel = p.replace(ROOT + "/","");
  if (f) { hasGotchasFile++; withFile.push(rel); }
  else if (section) { hasSection++; withSectionOnly.push(rel); }
  else { hasNeither++; without.push(rel); }
}
console.log(`project candidates: ${projects.length}`);
console.log(`  docs/GOTCHAS.md present : ${hasGotchasFile}  ${withFile.join(", ")}`);
console.log(`  CLAUDE.md section only  : ${hasSection}  ${withSectionOnly.join(", ")}`);
console.log(`  neither                 : ${hasNeither}`);
console.log(`\nprojects with a CLAUDE.md but no gotchas of any kind:`);
without.filter(p=>existsSync(path.join(ROOT,p,"CLAUDE.md"))).forEach(p=>console.log("   "+p));
