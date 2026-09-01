/**
 * lib/claims/store.mjs — the verdict store: one judgment per block, keyed by the
 * hash of that block's normalised text.
 *
 * WHY THIS IS NOT THE EVENT STORE. Measured before building: `lib/edges/events.mjs`
 * cannot carry a claim verdict, and not for want of a spare field.
 * `validateEvent` requires `edge_id` AND `node_id` unconditionally; it requires
 * `downstream_on_ref` BY KEY PRESENCE on every disposition including `deferred`
 * ("an edge has two ends and an event must name the ref each was observed at");
 * and every disposition except `deferred` requires BOTH `source_content` and
 * `downstream_content`, while `deferred` must pin no content at all. A claim has
 * ONE subject and ONE hash. Supplying a second, invented hash would put a
 * fabricated pair inside a store whose stated premise is "these two blobs are
 * consistent with each other". Beyond the schema, none of its eight dispositions
 * is a truth verdict — they are edge-lifecycle verbs, and `SUPPORTED` has no home
 * among them. So: a separate store, not a call-site trick.
 *
 * WHAT IS COPIED FROM IT, DELIBERATELY. Append-only. Month-sharded. Validate
 * BEFORE the lock and before touching disk, so an invalid record is never
 * written. Corrupt lines COUNTED as `malformed` on read, never silently skipped.
 * `BY_KINDS` imported rather than restated. Honours `PROPAGATE_STATE_DIR`, so a
 * test run cannot write into the real store — the failure G56 records, one store
 * over.
 *
 * CONTENT-ADDRESSED, WHICH IS THE WHOLE POINT. A verdict is pinned to
 * `block_sha`. Edit the block and the hash moves, so the old verdict no longer
 * applies to anything and the block reads as UNJUDGED — automatically, with no
 * staleness bookkeeping and no way to silently inherit a judgment about text that
 * no longer exists. It also means judging is done ONCE per distinct text, which
 * is what makes an expensive, non-deterministic step affordable at 42 KB.
 *
 * THE DECAY MODE IS ORPHANING, NOT ROTATION. Verdicts do not become "finished"
 * and this store is not a register — nobody opens it. What accumulates is
 * verdicts whose `block_sha` appears in no file any more. That is a different
 * fact from a resolved issue and takes a different remedy (re-judge or drop,
 * never archive), which is why claims are NOT a fifth `LIFECYCLE` kind in
 * `lib/report/registers.mjs`.
 */
import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { STATE_DIR } from "../core/config.mjs";
import { BY_KINDS } from "../edges/provenance.mjs";
import { mintEventId } from "../edges/events.mjs";
import { acquireLock } from "../core/lock.mjs";

const DEFAULT_ROOT = path.join(os.homedir(), ".propagate");

/** $STATE_DIR/claims (or ~/.propagate/claims when PROPAGATE_STATE_DIR is unset). */
export const CLAIMS_DIR = path.join(STATE_DIR || DEFAULT_ROOT, "claims");

/**
 * What KIND of assertion this block is. The segregation axis, and the reason the
 * whole layer exists: `VIPIN.md` mixes these five in one prose register and the
 * mechanical layer treated all of it as config, producing a 94% wontfix rate
 * across 165 rows. Closed and validated — adding a value is an edit here, never
 * a caller's choice.
 */
export const CLAIM_KINDS = Object.freeze(["fact", "policy", "quote", "impression", "aspiration"]);

/**
 * Whether the claim still holds. Optional: most blocks have a kind and no
 * standing. `wrong` and `superseded` require a reason — a claim retired without
 * one is indistinguishable from a claim nobody understood.
 */
export const CLAIM_STANDINGS = Object.freeze(["current", "expired", "superseded", "wrong"]);

/** Only meaningful with `against` — the contradiction axis. */
export const CLAIM_FINDINGS = Object.freeze(["consistent", "contradicts", "unrelated"]);

const KIND_SET = new Set(CLAIM_KINDS);
const STANDING_SET = new Set(CLAIM_STANDINGS);
const FINDING_SET = new Set(CLAIM_FINDINGS);
const BY_KIND_SET = new Set(BY_KINDS);

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Reject before the lock, before disk. Every message names the offending field
 * and the legal set, matching `validateEvent`'s posture: a caller that gets this
 * wrong must be told what "right" is, not merely that it failed.
 */
export function validateClaim(claim, claimId = "(unminted)") {
  const at = `claim ${claimId}`;
  if (!claim || typeof claim !== "object") throw new Error(`${at}: not an object`);

  if (!claim.file) throw new Error(`${at}: missing "file" — a verdict must name the document it is about`);

  if (!SHA256_RE.test(String(claim.block_sha ?? ""))) {
    throw new Error(`${at}: "block_sha" must be 64 lowercase hex (sha256 of the NORMALISED block text)`);
  }
  if (!KIND_SET.has(claim.kind)) {
    throw new Error(`${at}: unknown "kind" ${JSON.stringify(claim.kind)} — must be one of: ${CLAIM_KINDS.join(", ")}`);
  }
  if (claim.standing !== undefined && claim.standing !== null && !STANDING_SET.has(claim.standing)) {
    throw new Error(`${at}: unknown "standing" ${JSON.stringify(claim.standing)} — must be one of: ${CLAIM_STANDINGS.join(", ")}`);
  }
  // A retirement without a reason is the thing a future reader cannot act on.
  if ((claim.standing === "wrong" || claim.standing === "superseded") && !claim.reason) {
    throw new Error(`${at}: standing "${claim.standing}" requires a "reason" — say what is wrong, or what replaced it`);
  }
  // `against` and `finding` travel together in both directions. One without the
  // other is a half-recorded judgment, which reads as a whole one.
  if (claim.against !== undefined && claim.against !== null) {
    if (!SHA256_RE.test(String(claim.against))) {
      throw new Error(`${at}: "against" must be 64 lowercase hex (sha256 of the derived fact it was judged against)`);
    }
    if (!FINDING_SET.has(claim.finding)) {
      throw new Error(`${at}: "against" requires a "finding" — one of: ${CLAIM_FINDINGS.join(", ")}`);
    }
    if (claim.finding === "contradicts" && !claim.reason) {
      throw new Error(`${at}: finding "contradicts" requires a "reason" — name what disagrees with what`);
    }
  } else if (claim.finding !== undefined && claim.finding !== null) {
    throw new Error(`${at}: "finding" without "against" — a contradiction verdict must name what it was judged against`);
  }
  if (claim.by_kind !== undefined && claim.by_kind !== null && !BY_KIND_SET.has(claim.by_kind)) {
    throw new Error(`${at}: unknown "by_kind" ${JSON.stringify(claim.by_kind)} — must be one of: ${BY_KINDS.join(", ")}`);
  }
  return true;
}

/** Dry validation for a preview path: the message, or null. Same rules, no throw. */
export function dryValidateClaim(claim) {
  try { validateClaim(claim); return null; } catch (err) { return err.message; }
}

function shardFileForTs(ts) {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return `${iso.slice(0, 7)}.jsonl`;
}

export function shardPathForTs(ts) {
  return path.join(CLAIMS_DIR, shardFileForTs(ts));
}

/**
 * Append one verdict. Mints `claim_id` and `ts`; any the caller supplied are
 * overwritten, because minting is this function's job.
 *
 * @param {object} claim
 * @param {{now?: Date}} [opts]
 * @returns {Promise<object>} the stamped record as written
 */
export async function appendClaim(claim, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const claimId = mintEventId(); // same ULID minter — one id scheme in this repo, not two

  validateClaim(claim, claimId);

  const ts = now.toISOString();
  const stamped = {
    ...claim,
    claim_id: claimId,
    ts,
    hash_alg: claim.hash_alg || "sha256",
  };

  const shardPath = shardPathForTs(ts);
  await mkdir(CLAIMS_DIR, { recursive: true });
  if (!existsSync(shardPath)) await appendFile(shardPath, "");

  const release = await acquireLock(shardPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) throw new Error(`appendClaim: could not acquire lock on ${shardPath} after retries`);
  try {
    await appendFile(shardPath, JSON.stringify(stamped) + "\n");
  } finally {
    await release();
  }
  return stamped;
}

/**
 * Read verdicts across all shards.
 *
 * Never throws for an absent store — "no store yet" is a legitimate state on a
 * fresh machine, and it returns `{claims: [], malformed: 0, storeExists: false}`
 * so a caller can tell it apart from "a store with nothing in it". Those are
 * different facts and only one of them means judging has happened.
 *
 * @param {{file?: string, blockSha?: string, since?: string}} [filter]
 */
export async function readClaims(filter = {}) {
  const claims = [];
  let malformed = 0;
  if (!existsSync(CLAIMS_DIR)) return { claims, malformed, storeExists: false };

  const files = (await readdir(CLAIMS_DIR)).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    let raw;
    try { raw = await readFile(path.join(CLAIMS_DIR, file), "utf8"); } catch { malformed++; continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { malformed++; continue; }
      if (filter.file && rec.file !== filter.file) continue;
      if (filter.blockSha && rec.block_sha !== filter.blockSha) continue;
      if (filter.since && !(rec.ts >= filter.since)) continue;
      claims.push(rec);
    }
  }
  return { claims, malformed, storeExists: true };
}

/**
 * Latest verdict per `block_sha` — the store is append-only, so a re-judgment is
 * a new record rather than an edit, and "current" means "last written".
 *
 * Ordering is by `ts` then `claim_id`: ULIDs are lexicographically sortable by
 * mint time, which breaks ties within the same millisecond deterministically
 * rather than by whichever line happened to be read first.
 */
export function latestByBlock(claims) {
  const out = new Map();
  for (const c of [...claims].sort((a, b) => (a.ts === b.ts ? (a.claim_id < b.claim_id ? -1 : 1) : a.ts < b.ts ? -1 : 1))) {
    out.set(c.block_sha, c);
  }
  return out;
}
