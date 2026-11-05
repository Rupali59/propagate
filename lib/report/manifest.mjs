/**
 * manifest.mjs — what it takes to stand a workspace up on another machine.
 *
 * WHAT THIS ANSWERS. "To put Vipin's work on a client machine, which repos do I
 * need, on which branches, where, and what is not in git at all?" Today that is
 * spread across five files and one person's memory, and nothing says when it is
 * incomplete.
 *
 * REPORT ONLY. Never clones, never writes, never touches the network. That is
 * the posture everywhere else here — the tool does not edit a downstream, it
 * tells a human — and it means this is safe to run on a machine mid-setup.
 *
 * SOURCE OF TRUTH IS `.sidecar.yml`, NOT `refs/snapshot.json`, and the choice is
 * deliberate because the snapshot looks like the obvious source:
 *   - it stores `repo_root` as an ABSOLUTE path from the capturing machine, and
 *     records `upstream` ("origin/main") but no URL — you cannot clone a ref
 *     name;
 *   - it carries G26: two writers emit different schemas that both claim
 *     `schema_version: 1`, and guessing wrong once turned 36 existing refs into
 *     "there was nothing here".
 * The sidecar has a RELATIVE `repo_root`, the URL and the branch.
 *
 * TOOLCHAIN COMES FROM THE LOCKFILE, NOT `package.json.packageManager`.
 * Measured 2026-08-26 across Vipin's seven units: the lockfile resolves 6, the
 * `packageManager` field resolves 1. Worse, the field's absence is not "npm" —
 * `Astroclarity` and `marketing-intel` have a package.json and no field, and
 * rendering those as npm reproduces the exact break `Vipin Kaushik/CLAUDE.md`
 * records: "Running `npm install` in a pnpm project breaks CI silently —
 * happened on VipinKaushik#26." Unknown must stay unknown.
 *
 * A PROJECT MAY HAVE SEVERAL UNITS. `VipinKaushik-mb` has no root package.json;
 * it is `server` (3152) and `ui` (3153). The lockfile walk finds that for free,
 * and the registries already key on `<Workspace>/<unit-path>`, so they join.
 *
 * THREE GAP KINDS, NEVER COLLAPSED — each sends you somewhere different:
 *   cannot-clone     no `remote:`; must be copied out of band
 *   would-be-missed  a repo on disk that no sidecar declares — a new machine
 *                    silently would not get it
 *   not-cloned-here  declared, absent locally. Informational: a fresh machine
 *                    is entirely this, so it must not read as an error
 */

import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "yaml";

import { INTEGRATIONS } from "../core/config.mjs";

/** Lockfile -> toolchain. Order matters: pnpm and npm can both leave a lockfile. */
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
];

/** How deep below a project root to look for units. `mb/server` is depth 1. */
const UNIT_DEPTH = 1;

/**
 * Read a registry. LENIENT ON DUPLICATE KEYS, and loud about it.
 *
 * Measured 2026-08-26: `scripts/execution/ports.yml` has TWO `notes:` keys in one
 * project's map (the second opens at :294), which makes the whole file invalid
 * YAML under a strict parser — every port in the tree became unreadable at once.
 *
 * A reader whose job is to report should not be the thing that fails on someone
 * else's registry defect, but it must not hide it either: `uniqueKeys: false`
 * takes the last value, and `duplicateKeys` carries the fact upward so the
 * renderer can say the registry is malformed while still showing the ports.
 * Silently accepting would be the same class of failure as silently rejecting.
 */
function readYamlSafe(file) {
  if (!file) return { data: null, error: "not configured", duplicateKeys: false };
  if (!existsSync(file)) return { data: null, error: "not found", duplicateKeys: false };
  const raw = readFileSync(file, "utf8");
  let strictFailed = false;
  try {
    yaml.parse(raw);
  } catch {
    strictFailed = true;
  }
  try {
    return { data: yaml.parse(raw, { uniqueKeys: false }) ?? {}, error: null, duplicateKeys: strictFailed };
  } catch (err) {
    return { data: null, error: `unparseable: ${err.message}`, duplicateKeys: strictFailed };
  }
}

/**
 * Read one `.sidecar.yml`. No reader existed — `lib/migrate/workspace.mjs` only
 * WRITES them — so this is new, and uses the `yaml` package already imported by
 * lib/edges/frontmatter.mjs rather than hand-rolling a parser.
 */
export function readSidecar(file) {
  const { data, error } = readYamlSafe(file);
  if (error) return { error, sidecar: null };
  return { error: null, sidecar: data };
}

/** Directories under `root` that look like a runnable unit, by lockfile. */
function discoverUnits(projectAbs, rel) {
  const found = [];
  const probe = (dir, relPath) => {
    for (const [lock, tool] of LOCKFILES) {
      if (existsSync(path.join(dir, lock))) return { rel: relPath, toolchain: tool, evidence: lock };
    }
    // A Python project may declare no lockfile but still be a unit.
    if (existsSync(path.join(dir, "pyproject.toml"))) {
      return { rel: relPath, toolchain: "python", evidence: "pyproject.toml" };
    }
    return null;
  };

  const top = probe(projectAbs, rel);
  if (top) found.push(top);

  if (found.length === 0 || UNIT_DEPTH > 0) {
    let entries = [];
    try {
      entries = readdirSync(projectAbs, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const sub = probe(path.join(projectAbs, e.name), path.posix.join(rel, e.name));
      if (sub) found.push(sub);
    }
  }

  // No lockfile anywhere is a real answer for this tree — `sanskrit-texts` has
  // no package manager at all, which its CLAUDE.md states. Report the project
  // as one unit with toolchain `none` rather than dropping it.
  if (found.length === 0) found.push({ rel, toolchain: "none", evidence: null });
  return found;
}


/**
 * FRAMEWORK, derived from the unit's own manifest files. The population is the
 * set of units discovery already found (rule:derive-dont-curate); only the
 * recognised NAMES are a list, and an unrecognised dependency simply is not
 * reported. `[]` means "none of the known ones", never "no framework".
 * package.json and go.mod are source manifests, not secret stores.
 */
const JS_FRAMEWORKS = [
  ["next", (d) => "next" in d],
  ["react", (d) => "react" in d],
  ["next-auth", (d) => "next-auth" in d],
  ["@clerk/*", (d) => Object.keys(d).some((k) => k.startsWith("@clerk/"))],
  ["@auth0/*", (d) => Object.keys(d).some((k) => k.startsWith("@auth0/"))],
  ["mongoose", (d) => "mongoose" in d],
  ["pg", (d) => "pg" in d],
  ["prisma", (d) => "prisma" in d || "@prisma/client" in d],
  ["express", (d) => "express" in d],
];

function deriveFrameworks(unitAbs) {
  const found = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(unitAbs, "package.json"), "utf8"));
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    for (const [name, test] of JS_FRAMEWORKS) if (test(deps)) found.push(name);
  } catch {
    // no package.json, or unparseable: nothing derivable from it
  }
  try {
    const mod = readFileSync(path.join(unitAbs, "go.mod"), "utf8");
    if (/github\.com\/gin-gonic\/gin\b/.test(mod)) found.push("gin");
  } catch {
    // no go.mod
  }
  return found;
}

/**
 * `.env*` files in a unit directory, by NAME only. The directory is listed and
 * nothing is opened: a credential file's contents must never reach this
 * process. Templates are not stores. Non-recursive on purpose; nested app
 * directories are separate units and are scanned as such.
 */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
function envFilesByName(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && (e.name === ".env" || e.name.startsWith(".env.")) && !ENV_TEMPLATES.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}


/**
 * Every non-template `.env*` file under a project root, by NAME only (readdir;
 * nothing is opened). The population is DERIVED by walking, not taken from the
 * units a registry happens to know (rule:derive-dont-curate) — a unit-only scan
 * saw 1 of Motherboard's 24 files. Returns paths relative to `root`, posix.
 */
const WALK_SKIP = new Set(["node_modules", ".git", ".next", "dist", "vendor", ".worktrees"]);
const ENV_WALK_DEPTH = 6;
function walkEnvFiles(root, maxDepth = ENV_WALK_DEPTH, skipRel = new Set()) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (depth < maxDepth && !WALK_SKIP.has(e.name) && !skipRel.has(childRel)) walk(path.join(dir, e.name), childRel, depth + 1);
      } else if ((e.name === ".env" || e.name.startsWith(".env.")) && !ENV_TEMPLATES.has(e.name)) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, "", 0);
  return out.sort();
}

const asStoreList = (v) =>
  (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && typeof x.store === "string");

/** `~` is shell syntax, not a path: expand it before stat. */
function expandHome(p, home) {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/**
 * Normalise the lenient `credentials:` key. Locations only; a `see:` pointer is
 * kept as written, never resolved to a value.
 */
function readCredentials(sidecar) {
  const c = sidecar?.credentials && typeof sidecar.credentials === "object" ? sidecar.credentials : {};
  const see = (v) => (v && typeof v === "object" && typeof v.see === "string" ? v.see : null);
  return {
    declared: Boolean(sidecar?.credentials),
    deployed: see(c.deployed),
    database: see(c.database),
    analytics: see(c.analytics),
    local: asStoreList(c.local),
    out_of_tree: asStoreList(c.out_of_tree),
  };
}

/** Mode bits beyond owner read/write (0600). stat only, never open. */
const looseBits = (mode) => (mode & 0o777) & ~0o600;

/**
 * The origin URL a repo declares, or null. Callers MUST confirm the directory
 * has its own `.git` first — this walks up otherwise.
 */
/**
 * The repo that CONTAINS `dir`, or null. Deliberately walks UP — the same
 * behaviour `gitRemote` must guard against is the signal here.
 *
 * A monorepo subdirectory (Motherboard/motherboard-web) has no `.git` and no
 * remote of its own, which is indistinguishable from "unclonable" if you only
 * look at the directory itself. It is not unclonable: it arrives with its
 * parent. Asking git which repo owns the path is the difference, and it is
 * derivable — no new sidecar field required.
 */
function containingRepo(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null; // not in a repo, or git unavailable
  }
}

function gitRemote(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null; // no origin, or git unavailable — both mean "cannot tell from here"
  }
}

/** Git repos physically present under the workspace, for the coverage diff. */
function reposOnDisk(workspaceRoot) {
  const out = new Set();
  const walk = (dir, relBase, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules") continue;
      if (e.name === ".git") {
        if (relBase) out.add(relBase);
        continue;
      }
      if (e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), relBase ? path.posix.join(relBase, e.name) : e.name, depth + 1);
    }
  };
  walk(workspaceRoot, "", 0);
  return out;
}

/**
 * @param {string} workspaceRoot absolute path to the workspace
 * @param {{integrations?: object}} [opts] injectable for tests
 */
export function workspaceManifest(workspaceRoot, opts = {}) {
  const integrations = opts.integrations ?? INTEGRATIONS;
  const home = opts.home ?? os.homedir();
  const wsName = path.basename(workspaceRoot);

  const ports = readYamlSafe(integrations.portsFile);
  const deploy = readYamlSafe(integrations.deployFile);
  const mongo = readYamlSafe(integrations.mongoFile);
  const access = readYamlSafe(integrations.accessFile);
  const note = (r) => (r.error ? r.error : r.duplicateKeys ? "ok (registry has duplicate keys — last wins)" : "ok");
  const sources = { ports: note(ports), deploy: note(deploy), mongo: note(mongo), access: note(access) };
  // The top-level keys were READ, not guessed — an earlier version assumed
  // `ports:` and `projects:` and silently fell through to the whole document,
  // so every unit reported `NO SOURCE` while deploy.yml plainly bound three of
  // them. Measured 2026-08-26: ports.yml -> `services:`, deploy.yml ->
  // `deployments:`, mongo.yml -> `databases:`.
  const portRows = ports.data?.services ?? {};
  const deployRows = deploy.data?.deployments ?? {};
  // access.yml is shaped differently: its rows sit under `properties:` (measured
  // 2026-11-05; `conventions:` and `robots:` are siblings, not rows), keyed
  // `<Workspace>/<repo>` like the others.
  const accessRows = access.data?.properties ?? {};

  const stateDir = path.join(workspaceRoot, "propagation", "state");
  const projects = [];
  const gaps = [];
  let sidecarDirs = [];
  try {
    sidecarDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    sidecarDirs = [];
  }

  const declaredPaths = new Set();

  // PRE-PASS: which remote URL does each sidecar already claim?
  //
  // Needed because two projects can sit on ONE remote. `Tushar/Youvan-legacy`
  // has no `.git` remote of its own name — its origin IS `Youvan.git`, shared
  // with `Tushar/Youvan`. Recommending "add `remote: .../Youvan.git`" there
  // produces a manifest that clones Youvan into TWO directories and silently
  // drops the 29-file unpushed overhaul that exists only on the original disk.
  // The advice has to know the URL is already spoken for.
  const remoteOwners = new Map();
  // Every declared project root, so the workspace repo's own walk can step over
  // other projects (their files are attributed to them, not counted twice).
  const declaredRoots = new Set();
  for (const name of sidecarDirs) {
    const f = path.join(stateDir, name, ".sidecar.yml");
    if (!existsSync(f)) continue;
    const { sidecar: sc } = readSidecar(f);
    if (sc?.remote) remoteOwners.set(sc.remote, sc.project ?? name);
    if (sc?.repo_root && sc.repo_root !== "." && name !== "workspace") declaredRoots.add(sc.repo_root);
  }

  for (const name of sidecarDirs) {
    const file = path.join(stateDir, name, ".sidecar.yml");
    if (!existsSync(file)) {
      // A state directory with no sidecar was `continue`d silently until
      // 2026-08-26, and the cost is specific: `Anushka` and `Rupali` both have
      // a `state/workspace/` holding STATE.md with no `.sidecar.yml`, so their
      // WORKSPACE REPO — the one you must clone first, before anything else
      // works — appeared nowhere in the manifest, and the workspace reported
      // "clean". Silence about a directory you looked at is not a pass
      // (rule:discernment-checks §2).
      gaps.push({
        kind: "state-dir-undeclared",
        project: name,
        detail: `propagation/state/${name}/ exists but has no .sidecar.yml — nothing here can say what repo it belongs to, or where to clone it from`,
      });
      continue;
    }
    const { sidecar, error } = readSidecar(file);
    if (error) {
      gaps.push({ kind: "sidecar-unreadable", project: name, detail: error });
      continue;
    }
    const rel = sidecar.repo_root ?? name;
    // The workspace's own state dir describes the workspace repo, not a project
    // inside it; it still needs cloning, so keep it and mark it.
    const isWorkspaceItself = name === "workspace" || rel === "." || rel === "";
    if (!isWorkspaceItself) declaredPaths.add(rel);

    const abs = isWorkspaceItself ? workspaceRoot : path.join(workspaceRoot, rel);
    const onDisk = existsSync(abs);

    if (!sidecar.remote) {
      // TWO DIFFERENT FACTS, and they send you to different places.
      //
      // The sidecar records a VALUE, so it goes stale: three workspaces were
      // given remotes on 2026-08-26 and their sidecars still said none. That is
      // a fixable declaration, not an unclonable repo.
      //
      // `git -C <dir> remote` WALKS UP to a parent repo, so it cannot be used
      // alone — measured the same day, `Keerti/Keerti-mb` reported
      // `keerti-workspace.git` because it has no `.git` of its own and the
      // lookup found the workspace's. Require an OWN `.git` before believing it.
      const ownGit = onDisk && existsSync(path.join(abs, ".git"));
      const actual = ownGit ? gitRemote(abs) : null;
      gaps.push(
        actual
          ? (() => {
              const owner = remoteOwners.get(actual);
              const me = sidecar.project ?? name;
              // Same URL, different project => a SHARED origin, not a missing
              // declaration. Declaring it would clone one repo twice.
              if (owner && owner !== me) {
                return {
                  kind: "shared-remote",
                  project: me,
                  detail: `its on-disk origin ${actual} is ALREADY claimed by \`${owner}\` — this is a shared remote, not a missing declaration. Do NOT add it: the manifest would clone one repo into two directories, and work that exists only in this copy would be lost. It needs its own repo first`,
                };
              }
              return {
                kind: "remote-undeclared",
                project: me,
                detail: `on disk with remote ${actual}, but its .sidecar.yml records none — a new machine has no way to learn this URL. Add \`remote: ${actual}\` to the sidecar`,
              };
            })()
          : (() => {
              // Before calling it unclonable, ask whether it is INSIDE a repo we
              // already clone. Motherboard/motherboard-web is a directory in the
              // monorepo: no .git, no remote, and nothing to clone separately —
              // it arrives with the parent. Reporting that as `cannot-clone` is a
              // false blocker, and a false blocker in a setup runbook is worse
              // than a missing one: it sends someone hunting for a repo that
              // does not exist.
              // realpath, NOT path.resolve. On macOS the tmpdir is a symlink
              // (/var -> /private/var), so a repo compared against ITSELF looks
              // like a parent and every unclonable dir would be excused. Caught
              // by the two existing tests going red.
              const same = (a, b) => {
                try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
              };
              const parent = onDisk ? containingRepo(abs) : null;
              if (parent && !same(parent, abs)) {
                // Names the parent DIRECTORY, never its remote URL. The URL is
                // one copy-paste away from being pasted into this project's
                // sidecar, which is the exact mis-attribution the sibling test
                // ("`git -C` walks UP") exists to prevent.
                return {
                  kind: "arrives-with-parent",
                  project: sidecar.project ?? name,
                  detail: `not a repo of its own — it is a directory inside the \`${path.basename(parent)}\` repo, so it arrives with that clone. Nothing to clone separately, and no \`remote:\` of its own is needed`,
                };
              }
              return {
              kind: "cannot-clone",
              project: sidecar.project ?? name,
              // THREE causes, not two. `Tushar/texts` IS a git repo of its
              // own and simply has no remote configured; reporting that as
              // "not a git repo" sends you to fix the wrong thing
              // (rule:discernment-checks §6 — a reader that cannot report
              // failure invents an answer).
              detail: !onDisk
                ? "no `remote:` in its .sidecar.yml and not present here — nothing can reconstruct it"
                : ownGit
                  ? "a git repo of its own but with NO REMOTE configured, so there is nothing to clone from — it exists on this disk only, and must be given a remote or copied out of band"
                  : "no `remote:` in its .sidecar.yml, and not a git repo of its own on this machine — it must be copied out of band",
              };
            })(),
      );
    }
    if (!onDisk) {
      gaps.push({
        kind: "not-cloned-here",
        project: sidecar.project ?? name,
        detail: `declared at ${rel} but not present on this machine — informational, a fresh machine is entirely this`,
      });
    }

    const creds = readCredentials(sidecar);
    const projectName = sidecar.project ?? name;
    // Declared stores are only STATted, never opened. A project absent from this
    // machine cannot have its local stores judged (that would restate
    // not-cloned-here as N missing files), but an out-of-tree store is
    // machine-level and is always judged.
    for (const s of creds.local) {
      if (!onDisk) continue;
      if (!existsSync(path.resolve(abs, s.store))) {
        gaps.push({ kind: "store-missing", project: projectName, detail: `credentials.local declares \`${s.store}\` but nothing is at ${path.resolve(abs, s.store)} (stat only, never opened)` });
      }
    }
    for (const s of creds.out_of_tree) {
      const full = expandHome(s.store, home);
      let st = null;
      try {
        st = statSync(full);
      } catch {
        gaps.push({ kind: "store-missing", project: projectName, detail: `credentials.out_of_tree declares \`${s.store}\` but nothing is at ${full} (stat only, never opened)` });
        continue;
      }
      if (looseBits(st.mode) !== 0) {
        gaps.push({ kind: "store-loose", project: projectName, detail: `\`${s.store}\` has mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}, wider than 0600 — a credential store other users can read` });
      }
    }

    const units = onDisk && !isWorkspaceItself ? discoverUnits(abs, rel) : [{ rel, toolchain: onDisk ? "none" : "unknown", evidence: null }];

    // credential-undeclared: derive the files by walking the PROJECT root, then
    // attribute each to its nearest unit (longest rel prefix) or, with none, to
    // the project. The workspace repo itself is walked too, stepping over the
    // directories of other declared projects so nothing is counted twice.
    if (onDisk) {
      const unitRels = units.map((u) => u.rel).filter((r) => r !== rel && r !== ".");
      for (const file of walkEnvFiles(abs, ENV_WALK_DEPTH, isWorkspaceItself ? declaredRoots : new Set())) {
        const fileAbs = path.join(abs, file);
        const fileRel = isWorkspaceItself ? file : path.posix.join(rel, file);
        const owner = unitRels.filter((r) => fileRel.startsWith(r + "/")).sort((x, y) => y.length - x.length)[0];
        const bound = deployRows?.[`${wsName}/${owner ?? rel}`]?.doppler;
        const named = creds.local.some((st) => path.resolve(abs, st.store) === fileAbs);
        if (bound || named) continue;
        gaps.push({
          kind: "credential-undeclared",
          project: projectName,
          detail: `${fileRel} is on disk (found by name, never read) with no deploy.yml Doppler binding for ${owner ?? "the project"} and no \`credentials.local\` entry naming it — add one to the sidecar, or delete the file`,
        });
      }
    }

    projects.push({
      project: sidecar.project ?? name,
      repo_root: rel,
      remote: sidecar.remote ?? null,
      active_line: sidecar.active_line ?? null,
      isWorkspaceItself,
      onDisk,
      external: Array.isArray(sidecar.external) ? sidecar.external : [],
      credentials: creds,
      units: units.map((u) => {
        const key = `${wsName}/${u.rel}`;
        const portRow = portRows?.[key];
        const deployRow = deployRows?.[key];
        const unitAbs = path.join(workspaceRoot, u.rel);
        const hasExample =
          existsSync(path.join(unitAbs, ".env.example")) || existsSync(path.join(unitAbs, ".env.sample"));
        // TRI-STATE, and the third value is the finding. A unit with no Doppler
        // binding AND no .env.example gives a new machine no way to learn what
        // env it needs — that is worth naming, not leaving blank.
        const env = deployRow?.doppler
          ? { source: "doppler", project: deployRow.doppler, binding: deployRow.binding ?? null }
          : hasExample
            ? { source: "env-example", project: null, binding: null }
            : { source: "NO SOURCE", project: null, binding: null };
        const accessRow = accessRows?.[key];
        const envFiles = onDisk ? envFilesByName(unitAbs) : [];
        return {
          rel: u.rel,
          toolchain: u.toolchain,
          framework: onDisk ? deriveFrameworks(unitAbs) : [],
          analytics: accessRow
            ? { property: accessRow.property ?? null, robot: accessRow.robot ?? null, role: accessRow.role ?? null }
            : null,
          envFiles,
          toolchainEvidence: u.evidence,
          port: sources.ports.startsWith("ok") ? (portRow?.port ?? null) : null,
          portStatus: sources.ports.startsWith("ok") ? (portRow?.port ? "ok" : "unassigned") : sources.ports,
          env,
          compose: existsSync(path.join(unitAbs, "docker-compose.yml")),
        };
      }),
    });
  }

  for (const rel of reposOnDisk(workspaceRoot)) {
    if (declaredPaths.has(rel)) continue;
    gaps.push({
      kind: "would-be-missed",
      project: rel,
      detail: "a git repo on disk that no .sidecar.yml declares — a new machine would silently not get it",
    });
  }

  // FLOOR (rule:derive-dont-curate). Zero units scanned is a scan that looked at
  // nothing, which reads identically to "nothing is wrong" unless it is named.
  const unitsScanned = projects.reduce((n, p) => n + p.units.length, 0);

  return {
    workspace: wsName,
    workspaceRoot,
    unitsScanned,
    blind: unitsScanned === 0,
    projects,
    gaps,
    sources,
    workspaceCompose: existsSync(path.join(workspaceRoot, "docker-compose.yml")),
  };
}
