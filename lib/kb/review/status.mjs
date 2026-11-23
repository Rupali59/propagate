/**
 * lib/kb/review/status.mjs — a review's live status, kept in `status.json` beside its protocol.
 *
 * An approved protocol.md is never edited, because its hash is what the brief was written against. The protocol's
 * front-matter `status` is therefore the status AT APPROVAL only; this file is the live one. No file means `current`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATUS_FILE = "status.json";
const STATUSES = ["current", "superseded", "retired"];

/** @returns {{ok: true, status: object} | {ok: false, problem: string}} never throws */
export function readStatus(dir) {
  const file = path.join(dir, STATUS_FILE);
  if (!existsSync(file)) return { ok: true, status: { schema_version: 1, status: "current", by: null, date: null } };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j) || j.schema_version !== 1 || !STATUSES.includes(j.status)) throw new Error("not a schema_version 1 status record");
    return { ok: true, status: { schema_version: 1, status: j.status, by: j.by ?? null, date: j.date ?? null } };
  } catch (e) {
    return { ok: false, problem: `${STATUS_FILE} is not readable (${e.message})` };
  }
}

/** Write through a temp file and a rename. @returns {string} the path written */
export function writeStatus(dir, { status, by = null, date }) {
  const file = path.join(dir, STATUS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema_version: 1, status, by, date }, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
