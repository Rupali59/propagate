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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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

function loadMap() {
  if (!existsSync(MAP_PATH)) {
    console.error(`no identity map at ${MAP_PATH}`);
    console.error(`Create it (it is deliberately OUTSIDE the repo so it cannot be published):`);
    console.error(`  {"Vipin Kaushik": "workspace-a", "Keerti": "workspace-b", ...}`);
    console.error(`Every value must be a stable pseudonym: the incidents stay readable only if`);
    console.error(`the same workspace keeps the same name across every doc that mentions it.`);
    process.exit(2);
  }
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length); // longest first
  if (!entries.length) {
    console.error("identity map is empty — nothing would be scrubbed");
    process.exit(2);
  }
  return entries;
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

const entries = loadMap();
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
