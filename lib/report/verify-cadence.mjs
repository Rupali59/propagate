/**
 * verify-cadence.mjs — how long a settle walkthrough spends per edge, derived.
 *
 * THE QUESTION. Plan 3's premise is that settling drift stopped costing 10-20
 * minutes a pass. That is a claim about time per edge, and nothing recorded
 * time. The ledger records WHEN each verify landed (`ts`) and, since
 * 2026-10-02, WHICH session wrote it (`session_id`) -- so the gap between two
 * consecutive verifies in one session is the time spent on the edge between
 * them. No run log, no counter: derived from the events, per
 * `rule:derive-dont-curate`, so it cannot disagree with the ledger.
 *
 * WHAT IT EXCLUDES, AND WHY.
 *  - Gaps under `batchMs` (default 2 s): one `verify --node X` writes N events
 *    in a loop, milliseconds apart. Counting those would drag the median to ~0
 *    and read as "settling is instant" -- the gauge answering a narrower
 *    question than the one asked (`rule:measure-the-claim-not-a-proxy`).
 *  - Events with no `session_id`: every event before 2026-10-02, and any process
 *    outside Claude Code. ABSENT MEANS UNKNOWN, never "a different session" and
 *    never "no session": they are counted and reported, not guessed into a group.
 *
 * UNCALIBRATED, and printed as such. A median over a handful of gaps is a
 * reading, not a threshold; `doctor` prints it as info and asserts nothing.
 */

/**
 * @param {Array<{ts?: string, session_id?: string}>} events
 * @param {{batchMs?: number}} [opts]
 * @returns {{total: number, stamped: number, sessions: number, gaps: number, batchGapsExcluded: number, medianSec: number|null}}
 */
export function sessionGapMedian(events, { batchMs = 2000 } = {}) {
  const bySession = new Map();
  let stamped = 0;
  for (const e of events ?? []) {
    if (!e?.session_id || !e.ts) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    stamped += 1;
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id).push(t);
  }

  const gaps = [];
  let batchGapsExcluded = 0;
  for (const times of bySession.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap < batchMs) batchGapsExcluded += 1;
      else gaps.push(gap);
    }
  }

  gaps.sort((a, b) => a - b);
  let medianSec = null;
  if (gaps.length) {
    const mid = Math.floor(gaps.length / 2);
    const ms = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    medianSec = Math.round(ms / 100) / 10;
  }
  return {
    total: (events ?? []).length,
    stamped,
    sessions: bySession.size,
    gaps: gaps.length,
    batchGapsExcluded,
    medianSec,
  };
}

/** The one doctor line. Absence is attributed, never a bare zero. */
export function describeCadence(r) {
  if (r.stamped === 0) {
    return `no session-stamped verify events yet (0 of ${r.total}) — events before 2026-10-02 are unknown, not human`;
  }
  if (r.medianSec === null) {
    return `${r.stamped} session-stamped event(s) over ${r.sessions} session(s), but no gap of 2s or more between consecutive verifies — nothing to take a median of`;
  }
  return (
    `median ${r.medianSec}s between consecutive same-session verifies · ${r.gaps} gap(s) over ${r.sessions} session(s) · ` +
    `${r.batchGapsExcluded} batch-write gap(s) under 2s excluded · ${r.total - r.stamped} of ${r.total} events carry no session_id and are not counted`
  );
}
