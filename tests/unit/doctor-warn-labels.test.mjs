/**
 * doctor-warn-labels.test.mjs — N87 slice 3.
 *
 * A WARNING'S LABEL IS ITS KIND. The detail is the instance.
 *
 * N87 counts 354 warnings across "299 distinct kinds" and reads that as a
 * 299-item classification problem. It is not. Measured 2026-09-23: those come
 * from nine static `reporter.warn` sites, seven of which built their LABEL by
 * interpolating the row — so every row was its own kind, by construction, and no
 * two rows could ever fold. The label carried the identity and the detail
 * carried the explanation: backwards.
 *
 * Swap them and folding needs no classifier, no severity table and no per-kind
 * judgement. This test stops them drifting back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../../lib/report/doctor/", import.meta.url);

/** Every `reporter.warn(` call's FIRST argument, as source text. */
function warnLabels() {
  const out = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".mjs")).sort()) {
    const src = readFileSync(new URL(f, DIR), "utf8");
    // Scan forward from each call, tracking depth, and stop at the top-level comma.
    let i = 0;
    while ((i = src.indexOf("reporter.warn(", i)) !== -1) {
      let j = i + "reporter.warn(".length;
      let depth = 0;
      let arg = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if ("([{`".includes(c)) depth++;
        else if (")]}".includes(c)) {
          if (c === ")" && depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
        arg += c;
      }
      out.push({ file: f, line: src.slice(0, i).split("\n").length, arg: arg.trim() });
      i = j;
    }
  }
  return out;
}

test("the corpus is not empty — a scanner that parses nothing reports perfect compliance", () => {
  const labels = warnLabels();
  assert.ok(labels.length >= 8, `only ${labels.length} reporter.warn calls parsed — if doctor's shape changed, this scanner must change too`);
});

test("no warning builds its LABEL by interpolating the row — the label is the kind", () => {
  const interpolated = warnLabels().filter((w) => w.arg.includes("${"));
  assert.deepEqual(
    interpolated.map((w) => `${w.file}:${w.line} ${w.arg.slice(0, 52)}`),
    [],
    "these warnings interpolate their label, so each row is its own kind and nothing can fold:\n  " +
      interpolated.map((w) => `${w.file}:${w.line}  ${w.arg.slice(0, 60)}`).join("\n  "),
  );
});

test("no warning takes its label from a VARIABLE either — interpolation is not the only way to hide a row", () => {
  // The interpolation check above cannot see `const label = \`${t.marketplace}/x\``
  // followed by `warn(label, ...)`: the argument holds no \`${\`. delivery.mjs did
  // exactly that, so the guard would have passed a file with two row-derived
  // labels. The rule is therefore stricter and simpler — a label is a LITERAL, or
  // a ternary of literals.
  // SIMPLE ON PURPOSE. The first version tried to recognise "a ternary of string
  // literals" with a regex and rejected two valid ones, because `[^"]*` cannot
  // span quotes and the greedy `.*` never backtracked into a match. Clever
  // pattern, wrong answer, and it accused working code. The rule that actually
  // matters is narrow: a label must not be a BARE IDENTIFIER (which hides
  // whatever was assigned to it) and must not interpolate. Anything built from
  // literals — one, or a ternary of them — is a kind.
  const bad = warnLabels().filter((w) => {
    const a = w.arg.replace(/\s+/g, " ").trim();
    if (a.includes("${")) return true;                 // interpolates the row
    if (/^[A-Za-z_$][\w$]*$/.test(a)) return true;      // a variable: contents unknown here
    return false;
  });
  assert.deepEqual(
    bad.map((w) => `${w.file}:${w.line} ${w.arg.slice(0, 44)}`),
    [],
    "a warning label must be a literal (or a ternary of literals), so it names a KIND:\n  " +
      bad.map((w) => `${w.file}:${w.line}  ${w.arg.slice(0, 60)}`).join("\n  "),
  );
});
