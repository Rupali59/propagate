/**
 * verdict.mjs — the glance's daily failure rule (propagate#295, design §2). PURE: no imports, no filesystem.
 *
 * A series is failures per UTC day over the DATA days that exist. A day with no data (a sleeping laptop, no monitor
 * run) is absent, never 0: a zero there would drag the median down and make an ordinary day read as a spike.
 *
 *   learning  fewer than 3 prior data days; never broken, whatever the counts
 *   broken    today > 2 x the median of up to 7 prior data days AND today >= 3,
 *             or (chronic) failures on each of the last 3 data days, today included, whatever the median
 *   working   otherwise
 */

export const DAY_MS = 86400000;
export const LEARNING_DAYS = 3;
export const MEDIAN_WINDOW = 7;
export const MIN_TODAY = 3;

/** The UTC day of a ms epoch or ISO string, as YYYY-MM-DD. */
export function utcDay(t) {
  return new Date(typeof t === "number" ? t : Date.parse(t)).toISOString().slice(0, 10);
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {{counts: Map<string, number>, dataDays: string[], today: string}} series dataDays need not be sorted
 * @param {{chronic?: boolean}} [opts] chronic:false for a level rather than an event count (doctor.problems)
 * @returns {{state: "learning"|"working"|"broken", have: number, need: number, median: number|null, today: number, reason: string}}
 */
export function dailyVerdict({ counts, dataDays, today }, { chronic = true } = {}) {
  const days = [...new Set([...dataDays, today])].filter((d) => d <= today).sort();
  const prior = days.filter((d) => d < today).slice(-MEDIAN_WINDOW);
  const at = (d) => counts.get(d) ?? 0;
  const t = at(today);
  const base = { have: Math.min(prior.length, LEARNING_DAYS), need: LEARNING_DAYS, today: t };
  if (prior.length < LEARNING_DAYS) return { ...base, state: "learning", median: null, reason: `baseline not yet set (${prior.length} of ${LEARNING_DAYS} days)` };
  const med = median(prior.map(at));
  if (t > 2 * med && t >= MIN_TODAY) return { ...base, state: "broken", median: med, reason: `${t} today against a median of ${med}` };
  if (chronic) {
    const last3 = days.slice(-3);
    if (last3.length === 3 && last3.every((d) => at(d) > 0)) return { ...base, state: "broken", median: med, reason: `failures on each of the last 3 days (${last3.map(at).join(", ")})` };
  }
  return { ...base, state: "working", median: med, reason: `${t} today, median ${med}` };
}
