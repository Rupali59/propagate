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
const SCHEMA_PATH = path.join(__dirname, "..", "propagates.schema.json");

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

/**
 * Load and validate a .propagates.yml file.
 * @param {string} sidecarPath absolute path to sidecar
 * @returns {Promise<{sources: Record<string, {propagates_to: Array, concepts?: object}>}>}
 */
export async function loadSidecar(sidecarPath) {
  if (!existsSync(sidecarPath)) {
    return { sources: {} };
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
    return { sources: {} };
  }
  if (!validate(parsed)) {
    const errs = validate.errors
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    throw new SidecarError(`schema violation: ${errs}`, sidecarPath);
  }
  return parsed;
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
