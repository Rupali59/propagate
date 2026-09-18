/**
 * Both themes, and two colour families that never share a hex.
 *
 * WHY THIS FILE EXISTS. Both surfaces shipped dark-only, through a design review
 * that specifically scored accessibility 3 → 9. The review looked at a sketch,
 * and the sketch was the sibling widget's DARK branch over a fake dark desktop —
 * so a missing light theme was not visible in the artefact under review (G66).
 *
 * Meanwhile this repo's own `lib/graph/graph-html.mjs` already stated the rule —
 * *"No colour gets its only definition inside a media query"* — and the widget's
 * footer links to that page.
 *
 * The sibling widget enforces its palette with a test, and that is precisely why
 * its theming has not rotted while this one never existed (G67). This is that
 * test, ported, plus the family check for the defect that prompted it:
 *
 *   --caution  #e0a53a  bar fill      ordinal "needs attention"
 *   --DRIFTED  #e0a53a  grid cell     one edge state
 *
 * Two hexes each carrying two meanings on one card. Invisible in a rendering,
 * obvious in the token table — which is why it needs a test and not an eye.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel) => readFileSync(path.join(import.meta.dirname, "../..", rel), "utf8");

/** Geometry, never colour. These are declared ONCE and must not be themed. */
const THEME_INDEPENDENT = new Set(["--s1", "--s2", "--s3", "--s4", "--s5", "--r-shell", "--r-core"]);

/**
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness.
 *
 * The first version parsed raw text, and a comment reading "S3 takes --dim:
 * least severe gets no hue" matched as a DECLARATION named --dim whose value ran
 * to the next semicolon — swallowing the real `--on-fill: #ffffff;` that
 * followed it. The checker then reported --on-fill as undefined in light, which
 * was a defect in the checker and looked exactly like a defect in the CSS.
 *
 * Prose about tokens is the normal way to document a palette, so a parser that
 * cannot tell prose from code will keep being wrong here.
 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value;` pairs inside a chunk of CSS. */
function decls(css) {
  const out = new Map();
  for (const m of strip(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}
const used = (css) => new Set([...strip(css).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

/**
 * Split a source into its light base and EVERY dark block.
 *
 * ui.css has TWO dark blocks on purpose — the media query for automatic dark,
 * and `[data-theme="dark"]` so an explicit toggle can win. A token present in
 * only one of them is broken in exactly one of those two paths, silently.
 *
 * The first version of this helper lumped everything after the media query into
 * one "dark" map, so deleting a token from the media block still passed because
 * the attribute block below it still had one. The mutation gate caught that:
 * gates 2 and 3 went red and gate 1 did not, which is the only reason anyone
 * looked. A gate that only fires for some mutations is reporting on the
 * mutations it fires for, not on the check.
 */
function themes(css, { darkStarts }) {
  const first = Math.min(...darkStarts.map((d) => {
    const i = css.indexOf(d);
    assert.notEqual(i, -1, `no dark block matching ${JSON.stringify(d)} — this check has gone blind`);
    return i;
  }));
  const darks = darkStarts.map((d) => {
    const i = css.indexOf(d);
    // To the end of THIS block: the attribute form is one rule, the media form
    // wraps one, so a brace scan from the selector is the honest boundary.
    let depth = 0, j = css.indexOf("{", i), k = j;
    for (; k < css.length; k += 1) {
      if (css[k] === "{") depth += 1;
      else if (css[k] === "}") { depth -= 1; if (depth === 0) break; }
    }
    return { name: d, map: decls(css.slice(i, k + 1)) };
  });
  return { light: decls(css.slice(0, first)), darks, dark: darks[0].map };
}

const SURFACES = [
  {
    name: "widget/propagate-queue.jsx",
    // Only the className template literal is CSS.
    css: (() => {
      const s = read("widget/propagate-queue.jsx");
      const i = s.indexOf("export const className = `") + "export const className = `".length;
      const j = s.indexOf("`", i);
      assert.ok(j > i, "className literal not found or truncated");
      return s.slice(i, j);
    })(),
    darkStarts: ["@media (prefers-color-scheme: dark)"],
  },
  {
    name: "commands/ui.css",
    css: read("commands/ui.css"),
    // BOTH, and both must be complete.
    darkStarts: ["@media (prefers-color-scheme: dark)", ":root[data-theme=\"dark\"]"],
  },
];

for (const s of SURFACES) {
  test(`${s.name}: every token actually used is defined in BOTH themes`, () => {
    // The rule from graph-html.mjs, asserted: no colour gets its only definition
    // inside a media query. A token defined only in dark renders as nothing in
    // light — an invisible bar, an unstyled badge — with no error anywhere.
    const { light, darks } = themes(s.css, s);
    const missing = [];
    for (const tok of used(s.css)) {
      if (THEME_INDEPENDENT.has(tok)) continue;
      if (!light.has(tok)) { missing.push(`${tok} — used but NOT defined in light`); continue; }

      // AN ALIAS IS THEMED THROUGH ITS TARGET. `--sev-1: var(--st-warn)` needs
      // no dark redefinition: the var() resolves at use time, so it already
      // follows whatever --st-warn is under the active theme. Requiring a
      // second declaration would be asking for a copy that can then disagree.
      // The target must itself be themed, which is checked rather than assumed.
      const alias = /^var\((--[a-z0-9-]+)\)$/.exec(light.get(tok));
      if (alias) {
        const target = alias[1];
        const themedTarget = light.has(target) && darks.every((d) => d.map.has(target));
        if (!THEME_INDEPENDENT.has(target) && !themedTarget) {
          missing.push(`${tok} aliases ${target}, which is NOT themed — the alias inherits a light-only value`);
        }
        continue;
      }
      for (const d of darks) {
        if (!d.map.has(tok)) missing.push(`${tok} — defined in light but missing from ${d.name}`);
      }
    }
    assert.deepEqual(missing, [], `${s.name}\n  ${missing.join("\n  ")}`);
  });

  test(`${s.name}: geometry is declared once and never themed`, () => {
    const { darks } = themes(s.css, s);
    const themed = [...THEME_INDEPENDENT].filter((t) => darks.some((d) => d.map.has(t)));
    assert.deepEqual(themed, [], `these are geometry, not colour, and must not be redefined per theme: ${themed.join(", ")}`);
  });

  test(`${s.name}: no hex is shared between the STATUS and EDGE-STATE families`, () => {
    // THE DEFECT THIS WHOLE FILE IS FOR. Status is ordinal (how bad); edge state
    // says which side moved. Sharing a hex makes amber mean both, and a reader
    // cannot tell which question the colour is answering.
    const { light, dark } = themes(s.css, s);
    for (const [theme, d] of [["light", light], ["dark", dark]]) {
      const status = new Map();
      const edge = new Map();
      for (const [k, v] of d) {
        if (/^--st-/.test(k)) status.set(k, v.toLowerCase());
        if (/^--edge-(drift|reverse|diverge)$/.test(k)) edge.set(k, v.toLowerCase());
      }
      assert.ok(status.size >= 3, `${theme}: expected a status family, found ${status.size}`);
      assert.ok(edge.size >= 3, `${theme}: expected an edge-state family, found ${edge.size}`);
      const clashes = [];
      for (const [ek, ev] of edge) {
        for (const [sk, sv] of status) if (ev === sv) clashes.push(`${ek} and ${sk} are both ${ev} (${theme})`);
      }
      assert.deepEqual(clashes, [], `one hex, two meanings:\n  ${clashes.join("\n  ")}`);
    }
  });

  test(`${s.name}: no colour is hardcoded outside the palette blocks`, () => {
    // A literal in a rule cannot respond to the theme. Every one of these was a
    // real light-mode bug: `color: #06080b` on a badge is near-black ink on the
    // light palette's dark rust fill.
    const last = Math.max(...s.darkStarts.map((d) => s.css.lastIndexOf(d)));
    const afterPalette = s.css.slice(last);
    const body = afterPalette.slice(afterPalette.indexOf("}") + 1);
    const hard = [...body.matchAll(/(?:color|background(?:-color)?)\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1]);
    assert.deepEqual(hard, [], `hardcoded and therefore theme-blind: ${hard.join(", ")}`);
  });
}

test("the widget and the web UI agree on what each edge state looks like", () => {
  // They render the same data side by side, and the widget's footer links to the
  // graph page these values came from. Three surfaces, one meaning per colour.
  const w = themes(SURFACES[0].css, SURFACES[0]);
  const u = themes(SURFACES[1].css, SURFACES[1]);
  for (const theme of ["light", "dark"]) {
    for (const tok of ["--edge-drift", "--edge-reverse", "--edge-diverge"]) {
      assert.equal(w[theme].get(tok), u[theme].get(tok), `${tok} differs between the widget and the web UI in ${theme}`);
    }
  }
});

test("the edge values are the ones graph-html.mjs already shipped", () => {
  // "Inherit, do not invent" — applied to the palette that was already here. If
  // graph-html.mjs changes its state colours, this fails and the other two
  // surfaces get updated rather than silently diverging.
  const g = read("lib/graph/graph-html.mjs");
  const w = themes(SURFACES[0].css, SURFACES[0]);
  for (const [ours, theirs] of [["--edge-drift", "--drift"], ["--edge-reverse", "--reverse"], ["--edge-diverge", "--diverge"]]) {
    const hexes = [...g.matchAll(new RegExp(`\\${theirs}:\\s*(#[0-9a-f]{6})`, "g"))].map((m) => m[1]);
    assert.ok(hexes.length >= 2, `graph-html.mjs should define ${theirs} in both themes, found ${hexes.length}`);
    assert.equal(w.light.get(ours), hexes[0], `${ours} light must match graph-html's ${theirs}`);
    assert.equal(w.dark.get(ours), hexes[1], `${ours} dark must match graph-html's ${theirs}`);
  }
});
