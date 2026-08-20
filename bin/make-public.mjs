#!/usr/bin/env node
/**
 * make-public.mjs — build the publishable tree from this private working copy.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-TIME EDIT. The public repo is a fresh, scrubbed copy
 * with no git history. That decision is only safe if regenerating it is mechanical: a
 * hand-scrub done once drifts the moment the private repo moves, and the drift is
 * invisible because the two repos share no history to diff. This is the coupling between
 * them, made executable.
 *
 * WHAT IT REFUSES TO DO. It never writes into the public repo and never commits. It
 * produces a directory and tells you what it found. Publishing is a human action on
 * an irreversible thing (git history is permanent), and the tool's whole premise is that
 * it reports rather than acts.
 *
 * THE MAPPING IS THE SENSITIVE PART. `identity-map.json` lives OUTSIDE the tree it
 * scrubs — in $PROPAGATE_STATE_DIR — precisely so it cannot be published by the process
 * that reads it. Shipping the key alongside the ciphertext is the classic version of this
 * mistake.
 *
 * Usage:
 *   node bin/make-public.mjs --out /tmp/propagate-public          # build + verify
 *   node bin/make-public.mjs --out /tmp/propagate-public --check  # verify only, no write
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { SEARCH_ROOTS } from "../lib/core/config.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.PROPAGATE_STATE_DIR || path.join(os.homedir(), ".propagate");
const MAP_PATH = path.join(STATE, "identity-map.json");

/**
 * Paths never published. Each excluded for a stated reason — a silent exclusion list is
 * how something important goes missing without anyone noticing.
 */
const EXCLUDE = [
  { prefix: "docs/archive/", why: "retired logs: evidence for the author, noise for a stranger, 938KB of it gzipped" },
  { prefix: "node_modules/", why: "vendored for plugin installs; rebuilt by npm ci in the public repo's CI" },
  { prefix: "docs/deferred/", why: "scratch work, not shipped behaviour" },
  { prefix: "docs/plans/", why: "internal planning, references private paths and people" },
  { prefix: "docs/AUDIT-", why: "point-in-time audit of a private tree" },
];

/** Patterns that must not survive into the public tree, checked after scrubbing. */
const FORBIDDEN = [
  { re: /rupali\.b/gi, label: "home-dir username" },
  { re: /\/Users\/[a-z]/gi, label: "absolute macOS home path" },
];

function sh(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });
}

/**
 * The map has two shapes on disk:
 *   - flat legacy:  { "Some Client": "alias", ... }
 *   - current:      { "names": { "Some Client": "alias", ... }, "allow": [...] }
 *
 * A flat object has no "names" key, so that alone distinguishes it — every real
 * client name is a legitimate object key, "names" is not one anyone has chosen.
 * Treating flat-as-{names: flat, allow: []} keeps every map on disk today valid
 * without a migration step.
 */
function normalizeMap(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "names")) {
    const names = raw.names && typeof raw.names === "object" ? raw.names : {};
    const allow = Array.isArray(raw.allow) ? raw.allow : [];
    return { names, allow };
  }
  return { names: raw && typeof raw === "object" ? raw : {}, allow: [] };
}

function loadMap() {
  if (!existsSync(MAP_PATH)) {
    console.error(`no identity map at ${MAP_PATH}`);
    console.error(`Create it (it is deliberately OUTSIDE the repo so it cannot be published):`);
    console.error(`  {"Vipin Kaushik": "workspace-a", "Keerti": "workspace-b", ...}`);
    console.error(`Every value must be a stable pseudonym: the incidents stay readable only if`);
    console.error(`the same workspace keeps the same name across every doc that mentions it.`);
    process.exit(2);
  }
  const { names, allow } = normalizeMap(JSON.parse(readFileSync(MAP_PATH, "utf8")));
  const entries = Object.entries(names).sort((a, b) => b[0].length - a[0].length); // longest first
  if (!entries.length) {
    console.error("identity map is empty — nothing would be scrubbed");
    process.exit(2);
  }
  return { entries, names, allow };
}

/**
 * WATCHLIST COMPLETENESS. The map being non-empty proves nothing about it being
 * *complete* — a new client directory appearing later is scrubbed by nothing and
 * leaks silently. The watchlist is depth-1 directory names under SEARCH_ROOTS,
 * not discovered workspaces: discovery only sees directories carrying a
 * `.propagates.yml` marker, and real client names (Tathya, Khushboo, Tushar in
 * the production tree) leak into docs with no marker of their own. Every
 * depth-1 name must appear as a `names` key or be listed in `allow`, or the
 * build refuses and names exactly which directory is unaccounted for.
 */
function watchlist() {
  const seen = new Set();
  const out = [];
  for (const root of SEARCH_ROOTS) {
    let children;
    try {
      children = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of children) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith(".")) continue;
      if (seen.has(dirent.name)) continue;
      seen.add(dirent.name);
      out.push(dirent.name);
    }
  }
  return out;
}

function checkWatchlistCoverage({ names, allow }) {
  const nameKeys = new Set(Object.keys(names));
  const allowed = new Set(allow);
  const unmapped = watchlist().filter((dir) => !nameKeys.has(dir) && !allowed.has(dir));
  if (unmapped.length) {
    console.error(`\n  ${unmapped.length} WATCHLIST DIRECTOR${unmapped.length === 1 ? "Y IS" : "IES ARE"} UNMAPPED:`);
    for (const dir of unmapped) {
      console.error(`     ${dir}`);
    }
    console.error(`\n  Every directory at depth 1 under SEARCH_ROOTS must be a key in the identity`);
    console.error(`  map's "names", or listed in its "allow" array. Add it to one of them at`);
    console.error(`  ${MAP_PATH}`);
    process.exit(2);
  }
}

function excludedBy(rel) {
  return EXCLUDE.find((e) => rel.startsWith(e.prefix)) || null;
}

function scrub(text, entries) {
  let out = text;
  for (const [real, alias] of entries) {
    out = out.split(real).join(alias);
  }
  out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, "$HOME");
  return out;
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
if (!OUT) {
  console.error("usage: node bin/make-public.mjs --out <dir> [--check]");
  process.exit(2);
}

const { entries, names, allow } = loadMap();
checkWatchlistCoverage({ names, allow });
const tracked = sh(["ls-files"]).trim().split("\n").filter(Boolean);

const skipped = new Map();
const copied = [];
const violations = [];

for (const rel of tracked) {
  const ex = excludedBy(rel);
  if (ex) {
    skipped.set(ex.prefix, (skipped.get(ex.prefix) || 0) + 1);
    continue;
  }
  const src = path.join(REPO, rel);
  let buf;
  try {
    if (statSync(src).isDirectory()) continue;
    buf = readFileSync(src);
  } catch {
    continue;
  }

  // Binary files are copied through untouched. Scrubbing a decoded string would
  // normalise unrelated bytes — the same reason the NUL fix operated on bytes.
  const isText = !buf.includes(0);
  const outText = isText ? scrub(buf.toString("utf8"), entries) : null;

  if (isText) {
    for (const { re, label } of FORBIDDEN) {
      re.lastIndex = 0;
      const hits = outText.match(re);
      if (hits) violations.push({ rel, label, count: hits.length });
    }
  }

  copied.push(rel);
  if (!checkOnly) {
    const dst = path.join(OUT, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, isText ? outText : buf);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n  source        ${REPO}`);
console.log(`  identity map  ${MAP_PATH}  (${entries.length} names, never published)`);
console.log(`  ${checkOnly ? "would copy" : "copied"}     ${copied.length} files`);
for (const e of EXCLUDE) {
  const n = skipped.get(e.prefix) || 0;
  if (n) console.log(`  excluded      ${String(n).padStart(3)}  ${e.prefix.padEnd(18)} ${e.why}`);
}

if (violations.length) {
  console.log(`\n  ${violations.length} FILE(S) STILL CARRY PRIVATE CONTENT:`);
  for (const v of violations.slice(0, 20)) {
    console.log(`     ${v.rel}  (${v.count}x ${v.label})`);
  }
  console.log(`\n  Not publishable. Extend the identity map, or exclude the path.`);
  process.exit(1);
}

console.log(`\n  clean — no forbidden pattern survives`);
if (checkOnly) {
  console.log(`  (--check: nothing written)`);
} else {
  console.log(`  tree at ${OUT}`);
  console.log(`\n  Review it, then publish by hand. This script never commits and never`);
  console.log(`  pushes: git history is permanent, so that stays a human decision.`);
}
