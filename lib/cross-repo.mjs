/**
 * Cross-repo propagation loader + validator + realpath allowlist.
 * Mirrors lib/code-canonical.mjs shape; parses <repo>/.propagates-cross.yml.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import Ajv from "ajv";
import { CROSS_SCHEMA_PATH } from "./config.mjs";

const FILE_NAME = ".propagates-cross.yml";

let _validate = null;
function validator() {
  if (_validate) return _validate;
  const schema = JSON.parse(readFileSync(CROSS_SCHEMA_PATH, "utf8"));
  _validate = new Ajv({ allErrors: true }).compile(schema);
  return _validate;
}

/**
 * @param {string} repoRoot absolute repo root
 * @returns {{pushEdges: Array, pullEdges: Array}}
 */
export function loadCrossRepoSync(repoRoot) {
  const filePath = path.join(repoRoot, FILE_NAME);
  if (!existsSync(filePath)) return { pushEdges: [], pullEdges: [] };

  const parsed = yaml.parse(readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return { pushEdges: [], pullEdges: [] };

  const validate = validator();
  if (!validate(parsed)) {
    const errs = validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`${FILE_NAME} schema violation in ${repoRoot}: ${errs}`);
  }

  const pushEdges = [];
  const pullEdges = [];
  for (const entry of parsed.platform_contracts ?? []) {
    if (entry.source && Array.isArray(entry.affects)) {
      pushEdges.push({ source: String(entry.source), affects: entry.affects, why: String(entry.why ?? ""), kind: entry.kind ?? "contract" });
    } else if (entry.watch) {
      pullEdges.push({ watch: String(entry.watch), for: String(entry.for ?? ""), why: String(entry.why ?? ""), flow: "platform_contract" });
    }
  }
  for (const entry of parsed.shared_conventions ?? []) {
    pullEdges.push({ watch: String(entry.watch), for: String(entry.for ?? ""), why: String(entry.why ?? ""), flow: "shared_convention" });
  }
  return { pushEdges, pullEdges };
}
