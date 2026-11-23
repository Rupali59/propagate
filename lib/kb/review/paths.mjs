/**
 * lib/kb/review/paths.mjs — where reviews live, and what a review directory is called.
 *
 * A null result reads as "kb reviews not configured", never as a guessed path (rule:discernment-checks §2).
 */
import path from "node:path";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SLUG_MAX = 60;

function usage(message) {
  const e = new Error(message);
  e.code = "KB_REVIEW_USAGE";
  return e;
}

/** @returns {{ok: true, dir: string} | {ok: false, reason: string}} */
export function reviewsDir(integrations) {
  const i = integrations ?? {};
  if (i.kbReviewsDir) return { ok: true, dir: i.kbReviewsDir };
  if (i.kbStandardsDir) return { ok: true, dir: path.join(path.dirname(i.kbStandardsDir), "reviews") };
  return { ok: false, reason: "kb reviews not configured" };
}

/** `YYYY-MM-DD-<slug>`. Throws KB_REVIEW_USAGE on a bad date or slug. */
export function reviewDirName(date, slug) {
  if (typeof date !== "string" || !DATE.test(date)) throw usage(`review date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  if (typeof slug !== "string" || slug.length > SLUG_MAX || !SLUG.test(slug)) {
    throw usage(`review slug must be lower-case kebab-case, at most ${SLUG_MAX} characters, got ${JSON.stringify(slug)}`);
  }
  return `${date}-${slug}`;
}
