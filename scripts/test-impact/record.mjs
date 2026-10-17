/**
 * Recorder preload: run the suite with NODE_OPTIONS="--import <this file>" and every
 * node process it starts, children included, logs which repo files it depended on.
 * This is the "recorded file dependencies" half of the test map (Ekstazi, Hammant's
 * TIA). map.mjs merges it with the static import graph (static.mjs).
 *
 * WHY a preload and not NODE_V8_COVERAGE: coverage sees only JS it executed, so a test
 * that reads ui.client.js or a CSS file as TEXT would look independent of it. This
 * logs those reads too.
 *
 * CONTRACT, each clause is asserted by tests/unit/test-impact.test.mjs:
 *  - a no-op unless TESTIMPACT_DIR is set (it is imported by nothing else, but a stray
 *    NODE_OPTIONS must not turn it on by accident);
 *  - writes ONLY to $TESTIMPACT_DIR/<pid>-<nonce>.jsonl, once, in the process 'exit' handler. The nonce
 *    is there because a pid is not unique across a run: a process that execs into node keeps its pid, and
 *    1,199 processes in one suite reused three. Keyed by pid alone, the second process APPENDED to the
 *    first one's file and map.mjs read its header as a data row (crash, 2026-10-17 release gate);
 *  - never writes to stdout or stderr (a test asserting empty stderr must not see us);
 *  - never throws (every hook body is guarded; a recorder fault loses data, not the run).
 *
 * HOW modules are seen, chosen for Node 22 AND 25:
 *   module.registerHooks (sync, in-thread; added 22.15, no warning on 25.9) when it
 *   exists, else module.register with a hooks module on a data: URL (works from 20.6;
 *   deprecated on newer lines, which is why it is only the fallback and never the
 *   first choice — its deprecation warning would land on stderr). The fallback's hook
 *   thread appends to its own file because it cannot share this thread's Set.
 *
 * ATTRIBUTION: a node:test file process (NODE_TEST_CONTEXT set by the runner) sets
 * process.env.TESTIMPACT_OWNER to its own test file, so every process it spawns with
 * an inherited env records under that owner. A child spawned with a CLEAN env loses
 * both the owner and NODE_OPTIONS; the child_process wrapper below sees that at the
 * spawn site and logs a "c" row for the owner, which map.mjs turns into `partial`.
 */
import fsMod from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import moduleMod from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.TESTIMPACT_DIR;

if (DIR) {
  try {
    install();
  } catch {
    // A recorder fault loses data; it must never fail the process it is observing.
  }
}

function install() {
  const SELF = fileURLToPath(import.meta.url);
  const REPO = path.resolve(path.dirname(SELF), "..", "..");
  const REPO_PREFIX = REPO + path.sep;
  const NM = `${path.sep}node_modules${path.sep}`;
  const DIR_ABS = path.resolve(DIR);
  const UID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // The runner (`node --test`) is not a test; the files it starts are.
  if (process.execArgv.includes("--test")) return;

  const origAppend = fsMod.appendFileSync;
  const origMkdir = fsMod.mkdirSync;

  // Owner: inherited from the parent test process, else this process IS the test file.
  if (!process.env.TESTIMPACT_OWNER && process.env.NODE_TEST_CONTEXT && process.argv[1]) {
    const entry = path.resolve(process.argv[1]);
    if (entry.startsWith(REPO_PREFIX)) process.env.TESTIMPACT_OWNER = entry.slice(REPO_PREFIX.length).split(path.sep).join("/");
  }
  const owner = process.env.TESTIMPACT_OWNER || null;
  // npm itself is harness, like the runner above: `npm test` runs `npm run test:propagate` and
  // `npm run test:curate-docs`, each an npm process that reads package.json and .npmrc and owns no test.
  // Recorded, they counted as 4 "unattributed" processes and turned the floors test red on the very map
  // release --check had just written (2026-10-17). Only an UNOWNED npm is skipped: an npm a test starts
  // inherits the owner and is still recorded against that test.
  if (!owner && /(?:^|[\\/])npm(?:-cli(?:\.js)?)?$/.test(process.argv[1] || "")) return;
  const isTestProcess = !!process.env.NODE_TEST_CONTEXT && owner && path.resolve(process.argv[1] || "") === path.join(REPO, owner);

  /** @type {Set<string>} "k\tpath" */
  const rows = new Set();

  function note(kind, abs) {
    abs = path.resolve(abs); // a file: URL for a directory keeps its trailing slash; the key must not
    // The repo root itself is recorded as ".": a test that lists it depends on every
    // top-level entry, and skipping it would make that test look narrower than it is.
    if (abs !== REPO && !abs.startsWith(REPO_PREFIX)) return;
    if (abs.includes(NM) || abs === SELF) return;
    if (abs === DIR_ABS || abs.startsWith(DIR_ABS + path.sep)) return;
    rows.add(`${kind}\t${abs === REPO ? "." : abs.slice(REPO_PREFIX.length).split(path.sep).join("/")}`);
  }

  function toAbs(p) {
    if (typeof p === "string") return path.resolve(p);
    if (p instanceof URL) return p.protocol === "file:" ? fileURLToPath(p) : null;
    if (Buffer.isBuffer(p)) return path.resolve(p.toString());
    return null; // a file descriptor or something else: nothing to attribute
  }

  // --- modules ---------------------------------------------------------------
  const noteUrl = (url) => {
    try {
      if (typeof url === "string" && url.startsWith("file:")) note("m", fileURLToPath(url));
    } catch {}
  };
  if (typeof moduleMod.registerHooks === "function") {
    moduleMod.registerHooks({
      load(url, context, nextLoad) {
        noteUrl(url);
        return nextLoad(url, context);
      },
    });
  } else if (typeof moduleMod.register === "function") {
    const hooksSrc = `
      import { appendFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      import path from "node:path";
      let out, repo, self;
      export function initialize(d) { out = d.out; repo = d.repo; self = d.self; }
      export async function load(url, ctx, next) {
        try {
          if (url.startsWith("file:")) {
            const abs = fileURLToPath(url);
            if (abs.startsWith(repo + path.sep) && !abs.includes(path.sep + "node_modules" + path.sep) && abs !== self)
              appendFileSync(out, "m\\t" + abs.slice(repo.length + 1).split(path.sep).join("/") + "\\n");
          }
        } catch {}
        return next(url, ctx);
      }`;
    origMkdir(DIR_ABS, { recursive: true });
    moduleMod.register("data:text/javascript," + encodeURIComponent(hooksSrc), {
      data: { out: path.join(DIR_ABS, `${UID}.hooks.txt`), repo: REPO, self: SELF },
    });
  }

  // --- file reads --------------------------------------------------------------
  // Patch the CJS exports object and re-sync the ESM named exports, so both
  // `fs.readFileSync(...)` and `import { readFileSync } from "node:fs"` are seen.
  const wrap = (obj, name, fn) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    const wrapped = function (...args) {
      try {
        fn(args);
      } catch {}
      return orig.apply(this, args);
    };
    try {
      Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
    } catch {}
    obj[name] = wrapped;
  };
  const reader = (kind) => (args) => {
    const abs = toAbs(args[0]);
    if (abs) note(kind, abs);
  };
  const dirReader = (args) => {
    const abs = toAbs(args[0]);
    if (!abs) return;
    const recursive = args[1] && typeof args[1] === "object" && args[1].recursive;
    note(recursive ? "R" : "d", abs); // d = listing of one dir, R = recursive listing
  };
  for (const n of ["readFileSync", "readFile", "existsSync", "statSync", "lstatSync", "stat", "accessSync", "openSync", "createReadStream"]) {
    wrap(fsMod, n, reader("r"));
  }
  for (const n of ["readdirSync", "readdir"]) wrap(fsMod, n, dirReader);
  for (const n of ["readFile", "stat", "access", "open"]) wrap(fsp, n, reader("r"));
  wrap(fsp, "readdir", dirReader);
  try {
    moduleMod.syncBuiltinESMExports();
  } catch {}

  // --- spawns ------------------------------------------------------------------
  // A spawn is worth flagging when it can reach repo code: it runs node, or it is a
  // shell/other command whose words name node, cli.mjs or a path inside the repo
  // (the widget tests run `bash <repo>/widget/open-ui.sh` under a clean env, and that
  // script starts node). `git ls-files`/`ls-tree` is the whole-tree signal instead.
  const spawnCheck = (name) => (args) => {
    if (!owner) return;
    const cmd = args[0];
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const words = [cmd, ...argv].filter((w) => typeof w === "string");
    if (path.basename(String(cmd)) === "git" && argv.some((a) => a === "ls-files" || a === "ls-tree")) rows.add("g\t");
    // A script or file named on the command line is itself a dependency of this test.
    for (const w of words) if (path.isAbsolute(w)) note("r", w);
    const opts = args.find((a, i) => i > 0 && a && typeof a === "object" && !Array.isArray(a));
    const reaches =
      name === "fork" || cmd === process.execPath || words.some((w) => /\bnode\b|cli\.mjs/.test(w) || w.startsWith(REPO_PREFIX));
    if (!reaches) return;
    const env = opts && opts.env;
    if (env && (!env.TESTIMPACT_OWNER || !String(env.NODE_OPTIONS || "").includes("test-impact/record.mjs"))) rows.add("c\t");
  };
  for (const n of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(cp, n, spawnCheck(n));
  try {
    moduleMod.syncBuiltinESMExports();
  } catch {}

  // --- flush -------------------------------------------------------------------
  process.on("exit", () => {
    try {
      origMkdir(DIR_ABS, { recursive: true });
      const lines = [];
      lines.push(JSON.stringify({ o: owner, pid: process.pid, test: !!isTestProcess, ms: isTestProcess ? Math.round(process.uptime() * 1000) : undefined }));
      for (const r of rows) {
        const [k, p] = r.split("\t");
        lines.push(JSON.stringify({ k, p }));
      }
      origAppend(path.join(DIR_ABS, `${UID}.jsonl`), lines.join("\n") + "\n");
    } catch {}
  });
}
