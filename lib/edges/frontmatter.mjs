/**
 * Sidecar loader: .propagates.yml → validated object.
 *
 * Schema enforced via ajv. Malformed YAML / schema violations throw with
 * a useful message so /propagate doctor surfaces them.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import Ajv from "ajv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// TWO levels up, not one: this module moved from lib/ to lib/edges/ on 2026-08-20.
//
// Deliberately not imported from config.mjs, which would be the tidier source of this
// path: config.mjs runs workspace discovery at module load, and making the schema
// loader depend on it adds a load-order edge for a constant. Counting ".." keeps the
// dependency graph flat.
//
// The hazard that costs is that a wrong depth fails at RUNTIME with ENOENT — `node
// --check` parses it happily. Verified by loading every entry point, not by parsing.
const SCHEMA_PATH = path.join(__dirname, "..", "..", "propagates.schema.json");

const ajv = new Ajv({ allErrors: true });
const schemaRaw = JSON.parse(
  await readFile(SCHEMA_PATH, "utf8"),
);
const validate = ajv.compile(schemaRaw);

export class SidecarError extends Error {
  constructor(message, file, cause) {
    super(`[${file}] ${message}`);
    this.name = "SidecarError";
    this.file = file;
    if (cause) this.cause = cause;
  }
}

// RFC 6901 JSON-pointer segment unescape (~1 -> "/", ~0 -> "~"), in that
// order — ajv encodes instancePath segments this way, so a source key that
// itself contains a "/" round-trips correctly.
function unescapePointerSegment(seg) {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Partition ajv errors into per-entry (prunable) and structural (fatal).
 *
 * Prunable: instancePath points INSIDE a downstream entry —
 * /sources/<key>/propagates_to/<i> or deeper (e.g. .../<i>/path). One bad
 * `path` or `kind` costs that one edge, not the file.
 *
 * Fatal: everything else — malformed top-level shape, `sources` not an
 * object, a source missing `propagates_to` entirely, etc. These cannot be
 * partially recovered by dropping one downstream entry.
 */
function partitionErrors(errors) {
  const prunable = [];
  const fatal = [];
  for (const e of errors) {
    const segments = (e.instancePath || "").split("/");
    // ["", "sources", "<key>", "propagates_to", "<i>", ...rest]
    if (
      segments.length >= 5 &&
      segments[1] === "sources" &&
      segments[3] === "propagates_to" &&
      /^\d+$/.test(segments[4])
    ) {
      prunable.push({
        sourceKey: unescapePointerSegment(segments[2]),
        index: Number(segments[4]),
        message: e.message,
        pointer: e.instancePath,
      });
    } else {
      fatal.push(e);
    }
  }
  return { prunable, fatal };
}

function formatErrors(errors) {
  return errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
}

/**
 * Load and validate a .propagates.yml file.
 *
 * Structural problems (malformed YAML, `sources` not an object, a top-level
 * shape violation) are fatal — throws SidecarError, same as before.
 *
 * A schema violation confined to one downstream entry
 * (`/sources/<key>/propagates_to/<i>/...`) is pruned from a copy of the
 * parsed object instead of failing the whole file, and reported via
 * `problems`. The pruned object is re-validated before being returned — if
 * pruning didn't make it valid, this still throws rather than returning
 * unproven data.
 *
 * @param {string} sidecarPath absolute path to sidecar
 * @returns {Promise<{sources: Record<string, {propagates_to: Array, concepts?: object}>, problems: Array<{pointer: string, sourceKey: string, index: number, message: string, path: string|undefined}>}>}
 */
export async function loadSidecar(sidecarPath) {
  if (!existsSync(sidecarPath)) {
    return { sources: {}, problems: [] };
  }
  let raw;
  try {
    raw = await readFile(sidecarPath, "utf8");
  } catch (err) {
    throw new SidecarError(`unreadable: ${err.message}`, sidecarPath, err);
  }
  let parsed;
  try {
    parsed = yaml.parse(raw);
  } catch (err) {
    throw new SidecarError(`malformed YAML: ${err.message}`, sidecarPath, err);
  }
  if (parsed === null || parsed === undefined) {
    return { sources: {}, problems: [] };
  }
  if (validate(parsed)) {
    return { ...parsed, problems: [] };
  }

  const { prunable, fatal } = partitionErrors(validate.errors);
  if (fatal.length > 0 || prunable.length === 0) {
    throw new SidecarError(`schema violation: ${formatErrors(validate.errors)}`, sidecarPath);
  }

  // Group prunable errors by (sourceKey, index) — ajv's allErrors can emit
  // more than one error for the same offending entry.
  const grouped = new Map();
  for (const p of prunable) {
    const key = `${p.sourceKey}\u0000${p.index}`;
    if (!grouped.has(key)) {
      grouped.set(key, { sourceKey: p.sourceKey, index: p.index, pointer: p.pointer, messages: [] });
    }
    grouped.get(key).messages.push(p.message);
  }

  const bySource = new Map();
  for (const { sourceKey, index } of grouped.values()) {
    if (!bySource.has(sourceKey)) bySource.set(sourceKey, new Set());
    bySource.get(sourceKey).add(index);
  }

  const pruned = structuredClone(parsed);
  const problems = [];
  for (const [sourceKey, indices] of bySource) {
    const origEntry = parsed.sources?.[sourceKey];
    const prunedEntry = pruned.sources?.[sourceKey];
    if (!prunedEntry || !Array.isArray(prunedEntry.propagates_to)) continue;
    // Descending so earlier indices stay valid while splicing.
    const sorted = Array.from(indices).sort((a, b) => b - a);
    for (const idx of sorted) {
      const offending = origEntry?.propagates_to?.[idx];
      const offendingPath = offending && typeof offending === "object" ? offending.path : undefined;
      const g = grouped.get(`${sourceKey}\u0000${idx}`);
      problems.push({
        pointer: g.pointer,
        sourceKey,
        index: idx,
        message: g.messages.join("; "),
        path: offendingPath,
      });
      prunedEntry.propagates_to.splice(idx, 1);
    }
  }
  problems.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.index - b.index);

  // Never return something we have not proven valid.
  if (!validate(pruned)) {
    throw new SidecarError(
      `schema violation (unrecoverable after pruning ${problems.length} entr${problems.length === 1 ? "y" : "ies"}): ${formatErrors(validate.errors)}`,
      sidecarPath,
    );
  }

  return { ...pruned, problems };
}

/**
 * Find the .propagates.yml that covers a given source file.
 * Looks in the file's own directory, then walks up to the workspace root.
 * @param {string} sourceFilePath absolute path to a changed file
 * @param {string} workspaceRoot absolute path; do not walk past this
 * @returns {string | null} absolute path to the sidecar, or null
 */
export function findSidecarFor(sourceFilePath, workspaceRoot) {
  let dir = path.dirname(sourceFilePath);
  const root = path.resolve(workspaceRoot);
  while (dir.startsWith(root)) {
    const candidate = path.join(dir, ".propagates.yml");
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Given a sidecar + a source basename, return the downstream entries.
 * Returns [] if the source isn't declared (silent — declare is opt-in).
 */
export function downstreamsFor(sidecar, sourceBasename) {
  const entry = sidecar.sources?.[sourceBasename];
  if (!entry) return [];
  return entry.propagates_to || [];
}
