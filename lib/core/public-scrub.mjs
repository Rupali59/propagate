/**
 * The identity-map scrub `bin/make-public.mjs` applies to every published file, as
 * pure functions.
 *
 * Lives here rather than inside the script for the reason `public-forbidden.mjs` does:
 * the script runs on import, so nothing else could reuse or test it. Since 2026-10-12
 * a second publisher needs it — the live entries of propagate's ISSUES.md moved to the
 * PUBLIC GitHub tracker, scrubbed by this same function — and two scrubbers would
 * disagree about what is private the first time either one changed.
 *
 * Loading the map (and refusing when it is missing or empty) stays with each caller:
 * that is a process-level decision, and only the caller knows how to report it.
 */

/**
 * The map has two shapes on disk:
 *   - flat legacy:  { "Some Client": "alias", ... }
 *   - current:      { "names": { "Some Client": "alias", ... }, "allow": [...] }
 *
 * A flat object has no "names" key, so that alone distinguishes it — every real
 * client name is a legitimate object key, "names" is not one anyone has chosen.
 * Treating flat-as-{names: flat, allow: []} keeps every map on disk today valid
 * without a migration step.
 */
export function normalizeMap(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "names")) {
    const names = raw.names && typeof raw.names === "object" ? raw.names : {};
    const allow = Array.isArray(raw.allow) ? raw.allow : [];
    return { names, allow };
  }
  return { names: raw && typeof raw === "object" ? raw : {}, allow: [] };
}

/** [real, alias] pairs, longest real name first, so "Vipin Kaushik" wins over "Vipin". */
export function scrubEntries(names) {
  return Object.entries(names).sort((a, b) => b[0].length - a[0].length);
}

export function scrub(text, entries) {
  let out = text;
  for (const [real, alias] of entries) {
    out = out.split(real).join(alias);
  }
  out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, "$HOME");
  return out;
}
