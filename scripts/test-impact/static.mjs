/**
 * Static import closure per test file.
 *
 * Follows static imports, re-exports, `import("literal")` and `require("literal")`,
 * resolving relative specifiers and recursing inside the repo. Bare specifiers
 * (packages) and node: builtins are not followed: node_modules is committed and
 * excluded from the map on purpose (a change there is "unknown", so it runs everything).
 *
 * A computed specifier (`import(expr)`) cannot be resolved by reading text. It is
 * REPORTED as unresolved rather than skipped, so a reader can tell "no dynamic
 * imports" from "dynamic imports I could not see" (rule:discernment-checks §2). The
 * recorder covers those at run time.
 *
 * Regex, not a parser, and deliberately over-approximating: an import inside a
 * comment or string adds a dep that does not exist, and a spurious dep only ever
 * selects an extra test. Missing a real one would be the unsafe direction.
 *
 * Usage: node scripts/test-impact/static.mjs [test-file ...]   (default: all)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, listTestFiles, rel } from "./lib.mjs";

const FROM_RE = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
const DYN_LITERAL_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const DYN_ANY_RE = /\bimport\(\s*([^)]*?)\s*\)/g;

const EXTS = ["", ".mjs", ".js", ".cjs", ".json"];

function resolveRelative(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const idx of ["index.mjs", "index.js"]) {
    const p = path.join(base, idx);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Specifiers in one file's text: {specs: string[], computed: string[]}. */
export function scanSource(source) {
  const specs = new Set();
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYN_LITERAL_RE, REQUIRE_RE]) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  const computed = [];
  for (const m of source.matchAll(DYN_ANY_RE)) {
    const arg = m[1].trim();
    if (arg && !/^["'][^"']*["']$/.test(arg)) computed.push(arg.slice(0, 60));
  }
  return { specs: [...specs], computed };
}

/**
 * Closure of `entryRel` (repo-relative). Returns { deps: string[] (repo-relative,
 * includes the entry), unresolved: [{file, spec}] , external: number }.
 * `unresolved` holds computed specifiers AND relative ones that resolve to nothing.
 */
export function closure(entryRel, repo = REPO) {
  const seen = new Set();
  const unresolved = [];
  let external = 0;
  const stack = [path.join(repo, entryRel)];
  while (stack.length) {
    const abs = stack.pop();
    const r = path.relative(repo, abs).split(path.sep).join("/");
    if (seen.has(r)) continue;
    seen.add(r);
    if (!/\.(mjs|js|cjs)$/.test(abs)) continue; // json etc: a leaf
    let src;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const { specs, computed } = scanSource(src);
    for (const c of computed) unresolved.push({ file: r, spec: `computed: ${c}` });
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        external++;
        continue;
      }
      const target = resolveRelative(abs, spec);
      if (!target) {
        unresolved.push({ file: r, spec: `unresolvable: ${spec}` });
        continue;
      }
      if (target.includes(`${path.sep}node_modules${path.sep}`)) continue;
      stack.push(target);
    }
  }
  return { deps: [...seen].sort(), unresolved, external };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => rel(path.resolve(f))) : listTestFiles();
  let withDeps = 0;
  let unresolvedTotal = 0;
  for (const f of files) {
    const c = closure(f);
    if (c.deps.length > 1) withDeps++;
    unresolvedTotal += c.unresolved.length;
    if (files.length <= 5) {
      console.log(`${f}: ${c.deps.length} deps, ${c.unresolved.length} unresolved`);
      for (const u of c.unresolved) console.log(`  ${u.file}: ${u.spec}`);
    }
  }
  console.log(`${files.length} test files · ${withDeps} import repo code · ${unresolvedTotal} unresolved specifiers`);
}
