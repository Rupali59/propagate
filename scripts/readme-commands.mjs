#!/usr/bin/env node
// Rewrite the README's command section from COMMANDS (#292).
//   npm run readme:commands            rewrite
//   npm run readme:commands -- --check exit 1 when the README is stale, write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReadmeCommands } from "../lib/core/commands.mjs";

export const START = "<!-- commands:start -->";
export const END = "<!-- commands:end -->";

/** Replace the text between the markers; throws when a marker is missing. */
export function spliceCommands(readme, body) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md needs ${START} then ${END}`);
  return `${readme.slice(0, a + START.length)}\n\n${body}\n${readme.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
  const cur = readFileSync(file, "utf8");
  const next = spliceCommands(cur, renderReadmeCommands());
  if (process.argv.includes("--check")) {
    if (next !== cur) { console.error("README.md command section is stale: run npm run readme:commands"); process.exit(1); }
  } else if (next !== cur) writeFileSync(file, next);
}
