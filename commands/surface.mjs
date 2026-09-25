/**
 * surface.mjs — the whole propagation picture as one payload, printed once.
 *
 * `propagate queue` answers "what is drifting". This answers the question the
 * design review actually asked: what does propagation LOOK like right now —
 * edges, registers and machinery health together, each linked to the control
 * that accepts a judgement about it.
 *
 * Same split as `queue`: `lib/report/surface.mjs` derives, this renders. The
 * widget shells out to it and renders nothing of its own, so the widget, the
 * web UI and this command cannot drift apart into three ideas of "actionable".
 *
 * The text form is a fallback, not the point — the surface is the widget. It
 * exists so the payload can be read by a person debugging the widget, which is
 * the situation where a JSON blob is least useful.
 */
import { surfacePayload } from "../lib/report/surface.mjs";
import path from "node:path";

const TONE_MARK = { ok: "✓", warn: "!", fail: "✗", unknown: "?" };

/** A 17-cell bar, or a row of dashes when there is no denominator to draw
 *  against. An empty track and an absent track must not look identical. */
function bar(ratio, width = 17) {
  if (ratio == null) return "-".repeat(width);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function age(ms) {
  if (ms == null) return "unknown";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The CHANGED line (PR-024). `--json` has carried `changed` since
 * `surfacePayload()` grew it; this renderer was never updated, so the number
 * was invisible to anyone not passing `--json`.
 *
 * `changed.value` can be `null` — {value: null, label: "no stream"|"stream
 * error", tone: "unknown"} — when `streamPayload()` could not run at all.
 * That is a DIFFERENT fact from "it ran and found nothing changed" (`value:
 * 0`, `tone: "ok"`), and rule:discernment-checks §2 is explicit that the two
 * must not collapse into the same rendered output. So a null value never
 * prints as `0` or as a blank line — it prints its own label with an explicit
 * "could not derive", exactly the same distinction `buildChangedSummary`
 * already encodes in the payload; this only has to not throw it away.
 *
 * One line, matching the tone-mark convention every other summary value on
 * this card already uses (`headline`, each row) — proportionate to a text
 * form this module's own docstring calls "a fallback, not the point."
 */
export function changedLine(changed) {
  if (!changed) return null;
  return changed.value == null
    ? `${TONE_MARK[changed.tone] ?? "?"} ${changed.label} — could not derive what changed since last look`
    : `${TONE_MARK[changed.tone] ?? "·"} ${changed.value} ${changed.label} since last look`;
}

export async function surfaceCmd(argv = [], io = console) {
  const asJson = argv.includes("--json");
  const root = path.join(process.env.HOME ?? "", "Documents/GitHub/");

  let s;
  try {
    s = await surfacePayload({ root });
  } catch (err) {
    // The shape a consumer expects, with the error IN it. An empty surface
    // would render as a calm, healthy card — which is the N87 failure wearing
    // this module's clothes (rule:discernment-checks §6).
    const msg = String(err?.message ?? err);
    if (asJson) { io.log(JSON.stringify({ error: msg, headline: null, groups: null, grid: null })); return 2; }
    io.log(`surface: could not derive — ${msg}`);
    return 2;
  }

  if (asJson) { io.log(JSON.stringify(s)); return 0; }

  const h = s.headline;
  io.log(
    h.tone === "unknown"
      ? `? ${h.label} — that is not a clean tree; check the config with \`propagate doctor\``
      : `${TONE_MARK[h.tone] ?? "·"} ${h.value} ${h.label} of ${s.edges.expanded} edges (from ${s.edges.declared} declared)`,
  );

  // Rides beside the headline, not inside a group — see the module doc on
  // `changed` in lib/report/surface.mjs: it is one number, closer in kind to
  // "here is THE number" than to a row in a backlog group.
  const changed = changedLine(s.changed);
  if (changed) io.log(changed);

  for (const g of s.groups) {
    io.log(`\n${g.label}`);
    for (const r of g.rows) {
      const val = r.value == null ? "" : `${r.value} ${r.unit}`.trim();
      io.log(`  ${(TONE_MARK[r.tone] ?? "·")} ${String(r.label).padEnd(12)} ${bar(r.ratio)} ${val.padEnd(14)} ${r.cta.route}`);
      for (const e of r.extra ?? []) io.log(`      ·· ${e}`);
      if (r.detail) io.log(`      ·· ${r.detail}`);
    }
  }

  if (s.grid.length) {
    io.log("");
    io.log(s.grid.map((g) => `${g.state.toLowerCase()} ${g.count}`).join("      "));
  }

  // The snapshot's age is stated on EVERY run, including the healthy one. A
  // staleness warning that only appears when something is wrong trains a reader
  // to assume freshness the rest of the time.
  io.log("");
  io.log(s.snapshot.ok ? `snapshot ${age(s.snapshot.ageMs)} old · ${s.snapshot.problems} problem(s)` : `snapshot: ${s.snapshot.reason}`);
  return 0;
}
