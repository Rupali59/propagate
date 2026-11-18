/**
 * lib/kb/migrate.mjs — `propagate kb migrate`: rename a sidecar's legacy `standards:` key to `kb:` (#322).
 *
 * `planMigrate` is PURE: it reads sidecars and writes nothing, so a run without --apply cannot touch a byte.
 * `applyMigrate` is the only writer.
 *
 * BYTE SAFETY. Only the key's own source range (`standards`) is replaced by `kb`; the block under it, every comment
 * and every other key keep the bytes they had. A sidecar carrying BOTH keys is a conflict, never rewritten.
 */
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "yaml";
import { bothKeysError } from "./standards/adopt.mjs";

const topLevelPair = (doc, key) => doc.contents?.items?.find((p) => p.key?.value === key);

/**
 * @param {string[]} sidecarFiles resolved by the caller through discovery
 * @returns {{changes:{file:string,from:"standards",to:"kb"}[], conflicts:string[]}}
 */
export function planMigrate(sidecarFiles) {
  const changes = [];
  const conflicts = [];
  for (const file of sidecarFiles) {
    let doc;
    try {
      doc = yaml.parseDocument(readFileSync(file, "utf8"));
    } catch (e) {
      conflicts.push(`${file}: unreadable sidecar: ${e.message}`);
      continue;
    }
    if (doc.errors.length) {
      conflicts.push(`${file}: unreadable sidecar: ${doc.errors[0].message}`);
      continue;
    }
    const legacy = topLevelPair(doc, "standards");
    if (!legacy) continue;
    if (topLevelPair(doc, "kb")) conflicts.push(bothKeysError(file));
    else changes.push({ file, from: "standards", to: "kb" });
  }
  return { changes, conflicts };
}

/** Rewrite exactly the planned sidecars. Re-reads each one: a file that no longer fits the plan is skipped and named, never guessed at. */
export function applyMigrate(plan) {
  const written = [];
  const skipped = [];
  for (const { file } of plan.changes) {
    const before = readFileSync(file, "utf8");
    const doc = yaml.parseDocument(before);
    const pair = topLevelPair(doc, "standards");
    if (!pair || topLevelPair(doc, "kb")) {
      skipped.push(`${file}: changed since the plan was made; re-run`);
      continue;
    }
    const [start, end] = pair.key.range;
    writeFileSync(file, `${before.slice(0, start)}kb${before.slice(end)}`);
    written.push(file);
  }
  return { written, skipped };
}
