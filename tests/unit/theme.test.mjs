/**
 * One wheel, three surfaces, two themes — asserted on RESOLVED colour.
 *
 * WHY THIS FILE KEEPS GROWING, IN ORDER. Each block below was added after a
 * defect shipped through the blocks above it:
 *
 *   structure   every token defined in both themes, no hex shared across the
 *               two families. Shipped: SIX unreadable light values, because
 *               structure is not legibility.
 *   contrast    every token >= 4.5:1 on its declared ground. Shipped: DRIFTED
 *               and DIVERGED indistinguishable to a deuteranope at separation
 *               17, because contrast is between a colour and its BACKGROUND
 *               and this failure is between two FOREGROUNDS.
 *   cvd + hue   the current floor. Five of seven tokens had sat inside a
 *               43-degree arc with two of them 2 degrees apart.
 *
 * The palette is now authored in OKLCH with relative derivation, so a token's
 * value is no longer a hex a regex can read. Everything here resolves through
 * lib/report/color.mjs — which is itself pinned, in tests/unit/color.test.mjs,
 * to numbers measured before it existed. That matters: a resolver returning
 * plausible-but-wrong colours would make every assertion below pass over a
 * palette nobody checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
// The stylesheet AS SERVED: commands/ui/css/*.css joined in cascade order (2026-10-08 split).
// Reading one fragment would let every check below pass over a fraction of the rules.
import { stylesheet } from "../../commands/ui.mjs";

import {
  contrast, deuteranope, rgbDistance, resolveColor, rgbToOklch,
  declarations, alphaOf, MIN_CVD_SEPARATION,
} from "../../lib/report/color.mjs";

const read = (rel) => readFileSync(path.join(import.meta.dirname, "../..", rel), "utf8");
const used = (css) => new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

/**
 * Set per-element by the CLIENT, never declared in CSS.
 *
 * A third category, distinct from "declared once and not themed": these have
 * no declaration to find, so the both-themes check would report them missing
 * forever. --len is each chart path's measured length, which only the browser
 * can know; the draw-in animation reads it as its dash offset.
 *
 * THE OBLIGATION THIS CREATES: a token in here that the client does not
 * actually set is a reference to nothing, and the animation silently does not
 * run. commands/ui.client.js is asserted to supply every one of these, below.
 */
const RUNTIME_SET = new Set(["--len"]);

/** Geometry and timing, declared once and never themed. */
const NOT_THEMED = new Set([
  "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--r1", "--r2", "--r3",
  "--r-shell", "--r-core", "--ease",
  "--t-fast", "--t-base", "--t-row", "--t-slow", "--t-draw", "--t-undo",
  "--h-ok", "--h-caution", "--h-warn", "--h-accent", "--h-drift", "--h-reverse", "--h-diverge",
]);

/**
 * Split a source into its light base and EVERY dark block.
 *
 * ui.css has TWO on purpose — the media query for automatic dark, and
 * [data-theme="dark"] so an explicit toggle wins. A token in only one is broken
 * in exactly one path, silently. An earlier version lumped them together, so
 * deleting a token from the media block still passed; the mutation gate caught
 * it because gates 2 and 3 went red and gate 1 did not.
 */
function themes(css, darkStarts) {
  const first = Math.min(...darkStarts.map((d) => {
    const i = css.indexOf(d);
    assert.notEqual(i, -1, `no dark block matching ${JSON.stringify(d)} — this check has gone blind`);
    return i;
  }));
  const light = declarations(css.slice(0, first));
  const darks = darkStarts.map((d) => {
    const i = css.indexOf(d);
    let depth = 0, k = css.indexOf("{", i);
    for (; k < css.length; k += 1) {
      if (css[k] === "{") depth += 1;
      else if (css[k] === "}") { depth -= 1; if (depth === 0) break; }
    }
    // A dark block redefines only what changes; the rest cascades from light,
    // which is how a browser resolves it.
    return { name: d, map: new Map([...light, ...declarations(css.slice(i, k + 1))]), own: declarations(css.slice(i, k + 1)) };
  });
  return { light, darks };
}

const SURFACES = [
  {
    name: "commands/ui/css (joined)",
    css: stylesheet(),
    darkStarts: ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]'],
    ground: { light: "--bg", dark: "--bg" },
    onFill: "--on-fill",
  },
  {
    name: "widget/propagate-queue.jsx",
    css: (() => {
      const s = read("widget/propagate-queue.jsx");
      const i = s.indexOf("export const className = `") + "export const className = `".length;
      const j = s.indexOf("`", i);
      assert.ok(j > i, "className literal not found or truncated");
      return s.slice(i, j);
    })(),
    darkStarts: ["@media (prefers-color-scheme: dark)"],
    // Ubersicht window material: a translucent gradient over the wallpaper, so
    // there is no --bg token to read. These are that composite at its least
    // opaque stop over an appearance-matched desktop — the realistic worst
    // case, not the flattering one. An earlier version read --bg, found
    // nothing, and said so rather than passing; that is how the widget's own
    // --st-accent failure was found.
    ground: { light: "#fdfbfa", dark: "#151517" },
    // The widget's state indicators are 7x7px swatches, never text on a fill.
    // A claim, asserted below, not an omission.
    onFill: null,
  },
];

const SEMANTIC = ["--st-ok", "--st-caution", "--st-warn", "--st-accent",
  "--edge-drift", "--edge-reverse", "--edge-diverge"];

/** Resolve, or report WHY not. Never returns a plausible default. */
function tryResolve(value, vars) {
  try { return { hex: resolveColor(value, vars), alpha: alphaOf(value) }; }
  catch (err) { return { hex: null, why: String(err.message) }; }
}

for (const s of SURFACES) {
  const view = () => themes(s.css, s.darkStarts);

  test(`${s.name}: every token used is defined in BOTH themes`, () => {
    const { light, darks } = view();
    const missing = [];
    for (const tok of used(s.css)) {
      if (NOT_THEMED.has(tok) || RUNTIME_SET.has(tok)) continue;
      if (!light.has(tok)) { missing.push(`${tok} — used but NOT defined in light`); continue; }
      // Inheritance is legitimate: a dark block that does not redefine a token
      // gets the light one, and requiring a copy would invite the two to
      // disagree. What must hold is that it RESOLVES under every theme.
      for (const d of darks) {
        if (!d.map.has(tok)) missing.push(`${tok} — unresolvable under ${d.name}`);
      }
    }
    assert.deepEqual(missing, [], `${s.name}\n  ${missing.join("\n  ")}`);
  });

  test(`${s.name}: geometry and timing are declared once, never themed`, () => {
    const { darks } = view();
    const themed = [...NOT_THEMED].filter((t) => darks.some((d) => d.own.has(t)));
    assert.deepEqual(themed, [], `these are not colour and must not be redefined per theme: ${themed.join(", ")}`);
  });

  test(`${s.name}: every semantic token clears 4.5:1 on its declared ground`, () => {
    const { light, darks } = view();
    const fails = [];
    for (const [key, theme, map] of [["light", "light", light], ...darks.map((d) => ["dark", d.name, d.map])]) {
      const decl = s.ground[key];
      const bg = decl.startsWith("--") ? tryResolve(map.get(decl), map).hex : decl;
      assert.ok(bg, `${theme}: ground ${decl} did not resolve — this check has gone blind`);
      for (const tok of SEMANTIC) {
        const r = tryResolve(map.get(tok), map);
        assert.ok(r.hex, `${theme}: ${tok} did not resolve — ${r.why}`);
        // A translucent colour has no contrast of its own; the answer depends
        // on the backdrop. Excluded rather than measured wrongly.
        if (r.alpha < 1) continue;
        const v = contrast(r.hex, bg);
        if (v < 4.5) fails.push(`${theme}: ${tok} ${r.hex} on ${bg} is ${v.toFixed(2)}`);
      }
    }
    assert.deepEqual(fails, [], `unreadable:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: ink on a saturated fill clears 4.5:1, or the surface declares it has none`, () => {
    if (s.onFill === null) {
      assert.doesNotMatch(s.css, /\.badge\b/,
        "the widget grew a filled text badge — it now needs an --on-fill and a ratio");
      return;
    }
    const { light, darks } = view();
    const fails = [];
    for (const [theme, map] of [["light", light], ...darks.map((d) => [d.name, d.map])]) {
      const ink = tryResolve(map.get(s.onFill), map).hex;
      assert.ok(ink, `${theme}: ${s.onFill} did not resolve — this check has gone blind`);
      for (const tok of SEMANTIC) {
        const r = tryResolve(map.get(tok), map);
        if (!r.hex || r.alpha < 1) continue;
        const v = contrast(ink, r.hex);
        if (v < 4.5) fails.push(`${theme}: ${s.onFill} ${ink} on ${tok} ${r.hex} is ${v.toFixed(2)}`);
      }
    }
    assert.deepEqual(fails, [], `unreadable badges:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: the three edge states stay distinct under deuteranopia`, () => {
    // They render as small swatches with no text, so colour is the ONLY channel
    // carrying the distinction. The pair that shipped scored 17.
    const { light, darks } = view();
    const toks = ["--edge-drift", "--edge-reverse", "--edge-diverge"];
    const fails = [];
    for (const [theme, map] of [["light", light], ...darks.map((d) => [d.name, d.map])]) {
      for (let i = 0; i < toks.length; i += 1) {
        for (let j = i + 1; j < toks.length; j += 1) {
          const a = tryResolve(map.get(toks[i]), map).hex;
          const b = tryResolve(map.get(toks[j]), map).hex;
          if (!a || !b) continue;
          const d = rgbDistance(deuteranope(a), deuteranope(b));
          if (d < MIN_CVD_SEPARATION) {
            fails.push(`${theme}: ${toks[i]} ${a} and ${toks[j]} ${b} are ${d.toFixed(0)} apart, need ${MIN_CVD_SEPARATION}`);
          }
        }
      }
    }
    assert.deepEqual(fails, [], `a deuteranope cannot tell these apart:\n  ${fails.join("\n  ")}`);
  });

  test(`${s.name}: no two semantic hues collide`, () => {
    // --st-accent and --edge-drift were 2 degrees apart while the structural
    // tests asserted the two families never share a hex. Sharing a HUE is the
    // same defect one step out, and nothing was watching for it.
    const { light } = view();
    const hues = SEMANTIC
      .map((t) => [t, rgbToOklch(tryResolve(light.get(t), light).hex).H])
      .filter(([, h]) => h !== null)
      .sort((a, b) => a[1] - b[1]);
    assert.equal(hues.length, SEMANTIC.length, "every semantic token must carry a real hue");
    const tight = [];
    for (let i = 0; i < hues.length; i += 1) {
      const next = hues[(i + 1) % hues.length];
      let gap = next[1] - hues[i][1];
      if (gap < 0) gap += 360;
      if (gap < 25) tight.push(`${hues[i][0]} (${hues[i][1].toFixed(0)}deg) and ${next[0]} (${next[1].toFixed(0)}deg) are ${gap.toFixed(0)}deg apart`);
    }
    assert.deepEqual(tight, [], `hues too close to tell apart:\n  ${tight.join("\n  ")}`);
  });
}

// ── one wheel, not three ───────────────────────────────────────────────────

test("all three surfaces resolve the wheel to the SAME colours", () => {
  // They render the same data side by side and the widget links to the graph
  // page. Two near-identical palettes generated against two slightly different
  // grounds is exactly the bug this caught once already.
  const ui = themes(stylesheet(), ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);
  const wi = themes(SURFACES[1].css, ["@media (prefers-color-scheme: dark)"]);
  const graph = read("lib/graph/graph-html.mjs");
  const graphName = { "--edge-drift": "--drift", "--edge-reverse": "--reverse", "--edge-diverge": "--diverge" };

  for (const [theme, a, b, idx] of [["light", ui.light, wi.light, 0], ["dark", ui.darks[0].map, wi.darks[0].map, 1]]) {
    for (const tok of SEMANTIC) {
      const x = resolveColor(a.get(tok), a);
      const y = resolveColor(b.get(tok), b);
      assert.equal(x, y, `${tok} differs between the web UI and the widget in ${theme}`);
      const g = graphName[tok];
      if (!g) continue;
      const hits = [...graph.matchAll(new RegExp(`\\${g}:\\s*(#[0-9a-f]{6})`, "g"))].map((m) => m[1]);
      assert.ok(hits.length >= 2, `graph-html.mjs should define ${g} in both themes, found ${hits.length}`);
      assert.equal(hits[idx], x, `${tok} differs between the web UI and graph-html.mjs in ${theme}`);
    }
  }
});

// ── motion ─────────────────────────────────────────────────────────────────

test("ui.css honours prefers-reduced-motion, and the rule is not toothless", () => {
  const css = stylesheet();
  const i = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.notEqual(i, -1, "no reduced-motion block — animation without one is an accessibility defect");
  const block = css.slice(i, css.indexOf("}", css.indexOf("}", i) + 1) + 1);
  assert.match(block, /animation-duration:\s*\.01ms\s*!important/);
  assert.match(block, /transition-duration:\s*\.01ms\s*!important/);
  assert.match(block, /\*,\s*\*::before,\s*\*::after/, "must apply to everything, not a hand-listed set that rots");
});

test("every animation and transition uses a declared duration token", () => {
  // A hardcoded 300ms cannot be turned off by the reduced-motion block's
  // override of a token, and it is invisible in the system.
  const css = stylesheet();
  const body = css.slice(css.indexOf("* { box-sizing"));
  const hard = [...body.matchAll(/(?:animation|transition)(?:-duration)?:\s*[^;]*?(\d+m?s)/g)]
    .map((m) => m[0].trim())
    .filter((d) => !/var\(--t-/.test(d) && !/\b1200ms\b/.test(d));
  assert.deepEqual(hard, [], `hardcoded durations outside the token set:\n  ${hard.join("\n  ")}`);
});

test("the undo ring degrades to something that still tells the time", () => {
  // The ring IS the clock. Hiding it under reduced motion without a fallback
  // removes the information, not just the animation — the client renders a
  // numeric countdown, and .secs is where it lands.
  const css = stylesheet();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ring \{ display: none/);
  assert.match(css, /\.undo \.secs/, "a numeric fallback must exist for the ring to degrade to");
});

test("a runtime-set token is supplied by whatever uses it, or has a fallback", () => {
  // A CSS token nothing sets resolves to nothing and the animation reading it
  // silently does not run — no error, no warning, and it looks deliberate.
  // Same class of failure as G65's dead page.
  //
  // TWO WAYS TO SATISFY THIS, and the distinction is the point. Either the
  // client sets the token, or the CSS declares a fallback so the rule still
  // means something without it. What is forbidden is a bare var(--x) that
  // nothing supplies.
  const client = read("commands/ui.client.js");
  const css = stylesheet();
  const bare = [];
  for (const tok of RUNTIME_SET) {
    if (client.includes(tok)) continue;                       // supplied
    const uses = [...css.matchAll(new RegExp(`var\\(${tok}([^)]*)\\)`, "g"))];
    for (const u of uses) {
      if (!u[1].includes(",")) bare.push(`${tok} in "${u[0]}" — no setter and no fallback`);
    }
  }
  assert.deepEqual(bare, [], bare.join("\n  "));
});

test("if the client draws chart series, it MUST measure and set --len", () => {
  // The fallback above keeps the CSS honest while no charts exist. Once they
  // do, a series drawn without a measured length has no draw-in at all, which
  // is the animation silently not happening rather than being turned off.
  const client = read("commands/ui.client.js");
  if (!/class="series"|className="series"|\bseries\b.*<path/.test(client)) return;   // no charts yet
  assert.match(client, /getTotalLength\(\)/, "a series path must measure itself");
  assert.match(client, /--len/, "and hand that length to the CSS");
});

test("ui.css styles every edge state the graph can emit", () => {
  // THE THIRD INSTANCE OF ONE SHAPE, all found on 2026-09-21: a value the code
  // can produce that the stylesheet has no rule for. The widget's toneFor
  // emitted five tones and it styled four; the chart CSS read a --len nothing
  // set; and ACTIONABLE holds four states while ui.css styled three.
  //
  // None of them errors. The element renders with no background, or the
  // animation silently does not run. That is what makes this class worth a
  // test rather than a careful eye.
  const graph = read("lib/graph/graph.mjs");
  const m = /const ACTIONABLE = new Set\(\[([^\]]*)\]\)/.exec(graph);
  assert.ok(m, "could not find ACTIONABLE in graph.mjs — this check has gone blind");
  const states = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
  assert.ok(states.length >= 4, `expected the actionable states, found ${states.length}`);

  const css = stylesheet();
  const unstyled = states.filter((st) => !new RegExp(`\\.badge\\.${st}\\s*\\{`).test(css));
  assert.deepEqual(unstyled, [],
    `the graph can emit these states and ui.css gives their badge no background: ${unstyled.join(", ")}`);
});

// ── the population, derived rather than curated ─────────────────────────────

/**
 * N97 / G70. Every colour assertion above iterates SEMANTIC — seven tokens.
 * `commands/ui.css` uses forty-six. The thirty-nine outside that list carry the
 * actual text of the interface and were checked by nothing, which is how four
 * rules shipped putting --dim on --field at 4.40 and .badge.none at 3.60, in a
 * repo whose DESIGN.md sets the floor at 4.5 and whose suite was green.
 *
 * So this check does not name tokens. It reads the stylesheet, finds every rule
 * that declares BOTH a colour and a background, and asserts that pair in both
 * themes. Adding a rule adds coverage; there is no list to remember to extend.
 */
/**
 * T4 / D-T4 guard 1. The FOURTH instance of the shape the test above records,
 * and the first one caught BEFORE it shipped: `.sitem.quiet` had no rule when
 * the component that uses it was written, so the row that must read as muted
 * would have rendered identically to a failure.
 *
 * The population is derived from the two modules that can put a disposition on
 * the wire, never listed here. `reconcile.mjs` emits ROUTING dispositions and
 * `sync.mjs` emits INSERT refusals; the panel renders rows from both, so a
 * guard reading one of them would be blind to half the vocabulary — which is
 * G70's defect exactly, a curated population reporting a clean sweep.
 */
test("ui.css styles every held disposition the reminders lane can emit", () => {
  const sources = [
    ["lib/reminders/sync.mjs", /export const REFUSAL_DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
    ["lib/reminders/reconcile.mjs", /export const DISPOSITIONS = Object\.freeze\(\[([^\]]*)\]\)/],
  ];

  const dispositions = [];
  for (const [rel, re] of sources) {
    const m = re.exec(read(rel));
    assert.ok(m, `could not find the disposition list in ${rel} — this check has gone blind`);
    const found = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    assert.ok(found.length >= 6, `${rel}: parsed only ${found.length} dispositions — the extraction has gone blind`);
    // Only the ones the CONFLICTS panel renders as a badge. `new`, `no-change`,
    // `completed` and `reopened` are outcomes, not conflicts, and never reach it.
    dispositions.push(...found.filter((d) => d.startsWith("held-") || d === "already-inserted"));
  }

  assert.ok(dispositions.length >= 8,
    `expected at least 8 held dispositions across both modules, found ${dispositions.length}: ${dispositions.join(", ")}`);

  const css = stylesheet();
  const unstyled = dispositions.filter((d) => !new RegExp(`\\.badge\\.${d}\\b`).test(css));
  assert.deepEqual(unstyled, [],
    `the reminders lane can emit these and ui.css gives their badge no background: ${unstyled.join(", ")}`);

  // The muted row is a rule too, and it is the one that had none.
  // (`.sitem.quiet` until the DataTable unification, 2026-10-16: the Reminders rows are DataTable rows now.)
  assert.match(css, /\.dt-row\.quiet td\s*\{/,
    "`already-inserted` is rendered in a `.dt-row.quiet` row and the stylesheet has no rule for it");
});

test("every colour/background pair ui.css DECLARES clears 4.5:1, both themes", () => {
  const css = stylesheet();
  const t = themes(css, ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);

  const pairs = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().split("\n").pop().trim();
    const fg = m[2].match(/(?:^|[;\s])color:\s*var\((--[a-z0-9-]+)\)/);
    const bg = m[2].match(/background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/);
    if (fg && bg) pairs.push({ sel, fg: fg[1], bg: bg[1] });
  }

  // Absence must be attributable: a regex that stops matching would otherwise
  // report a clean sweep of nothing. This is the same guard the edge-state
  // check carries, and the reason it is here is that this test's whole subject
  // is a population that was smaller than anyone thought.
  assert.ok(pairs.length >= 12,
    `only ${pairs.length} colour/background pairs found — the extraction has gone blind`);

  const fails = [];
  for (const [name, vars] of [["light", t.light], ["dark", t.darks[0].map]]) {
    for (const p of pairs) {
      let ink, ground;
      try { ink = resolveColor(vars.get(p.fg), vars); ground = resolveColor(vars.get(p.bg), vars); }
      catch (err) { fails.push(`${name}: ${p.sel} — cannot resolve ${p.fg}/${p.bg}: ${err.message}`); continue; }
      const v = contrast(ink, ground);
      if (v < 4.5) fails.push(`${name}: ${p.sel} — ${p.fg} on ${p.bg} is ${v.toFixed(2)}`);
    }
  }
  assert.deepEqual(fails, [],
    `${pairs.length} pairs checked in 2 themes; under 4.5:1:\n  ${fails.join("\n  ")}`);
});

test("the responsive overrides load AFTER the base rules they override (cascade order of commands/ui/css)", () => {
  // stylesheet() joins commands/ui/css/*.css in NAME order. If the responsive file sorted
  // first, every `@media (max-width …) { .rail { … } }` would be overridden by the base
  // `.rail` rule that follows it, and the narrow layout would silently stop applying. A
  // rename (90- -> 05-) went green against every other test on 2026-10-08; this is the one
  // that notices.
  const css = stylesheet();
  const base = css.indexOf("\n.rail {");
  const narrow = css.indexOf("@media (max-width: 1100px)");
  assert.ok(base > -1 && narrow > -1, "control: both the base .rail rule and the 1100px override exist");
  assert.ok(narrow > base, "the max-width overrides must come after the base .rail rule, or they never win");
});

// ── the 2026-10-15 redesign: F1-F4, each as a property rather than a promise ──

/** CSS with its comments removed, so a rule can EXPLAIN a banned construct without tripping the ban. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("F1: no colour-mix anywhere in the stylesheet -- tints are RELATIVE derivations", () => {
  // The mock's quiet bar segment was an in-oklch colour-mix of the accent and the
  // field, and the light render came out SAGE GREEN: that interpolation runs the hue
  // the short way round the wheel, 250 toward 85, through green. A relative
  // derivation keeps the hue fixed and moves only lightness and chroma, which is what
  // "the same colour, quieter" means. 10-tokens.css already did it for --accent-quiet.
  const css = stripComments(stylesheet());
  assert.doesNotMatch(css, /color-mix\(/, "a colour-mix is back: derive the tint with oklch(from var(--token) …) instead");
  // The floor, and the reason it matters: a stylesheet that was emptied, or a strip
  // that ate everything, would also contain no colour-mix.
  const derived = (css.match(/oklch\(from /g) || []).length;
  assert.ok(derived >= 8, `only ${derived} relative derivations found -- the scan has gone blind, it has not found nothing`);
  // And the negative control: the pattern does fire on the construct it bans.
  assert.match("background: color-mix(in oklch, var(--a) 40%, var(--b));", /color-mix\(/);
});

test("F1: every lightness-RAISING derivation is redefined in each dark block", () => {
  // `calc(l + .44)` makes a pale tint of a LIGHT-theme colour. Inherited into dark,
  // where the base is already L .78, it clips to white. So a token derived upward in
  // light must be derived DOWNWARD in dark, in both dark blocks, or it is wrong in
  // exactly one theme and fine in the other. The both-themes test above cannot see
  // this: an inherited token "resolves", it just resolves to the wrong colour.
  const { light, darks } = themes(stylesheet(), ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);
  const up = [...light].filter(([, v]) => /^oklch\(from [^)]*\)\s*$/.test(String(v).trim()) || String(v).includes("oklch(from"))
    .filter(([, v]) => /calc\(l \+/.test(v)).map(([k]) => k);
  assert.ok(up.length >= 4, `only ${up.length} upward derivations found (${up.join(", ")}) -- the scan has gone blind`);
  assert.ok(up.includes("--seg-quiet"), "the new quiet-segment tint is not among the upward derivations");
  const missing = [];
  for (const d of darks) for (const t of up) if (!d.own.has(t)) missing.push(`${t} is not redefined in ${d.name}`);
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("F2: FAIL, ACCEPTED and NEVER-VERIFIED are .badge modifiers, and no second pill component exists", () => {
  const css = stripComments(stylesheet());
  for (const m of ["fail", "accepted", "NEVER_VERIFIED"]) {
    assert.match(css, new RegExp(`\\.badge\\.${m}\\s*\\{`), `.badge.${m} has no rule: the badge renders as ink on no background`);
  }
  assert.doesNotMatch(css, /\.pill\b/, "a .pill component appeared; the plan says reuse .badge");
  assert.doesNotMatch(css, /\.stat\b/, "a .stat component appeared; the stat row is .kpi");
  // Phase 1 (2026-10-16) deleted the div-bar chart: EVERY chart is Observable Plot. A `.bar` rule
  // coming back is a fifth chart implementation arriving, which is the thing that was removed.
  assert.equal((css.match(/(^|\n)\.bar\s*\{/g) || []).length, 0, "a .bar rule came back: the div-bar chart was deleted, every chart is PlotChart");
});

test("F3: a focus ring is 2px --st-accent with a 2px offset, on every control", () => {
  const css = stripComments(stylesheet());
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--st-accent\);\s*outline-offset:\s*2px/);
  assert.doesNotMatch(css, /outline:\s*(?:none|0)\b/, "a rule removes the focus ring");
});

test("F4: below 1100px the two diffs stack, and the wide views span the whole row", () => {
  const css = stripComments(stylesheet());
  const i = css.indexOf("@media (max-width: 1100px)");
  assert.notEqual(i, -1, "no 1100px breakpoint");
  const block = css.slice(i, css.indexOf("@media (max-width: 860px)"));
  assert.match(block, /\.evgrid\s*\{\s*grid-template-columns:\s*1fr\s*;?\s*\}/, "the evidence grid is still two columns on a narrow screen");
  assert.match(block, /\.detail\.wide\s*\{\s*grid-column:\s*1 \/ -1/, "a wide view would sit in a column that no longer exists");
});

test("the tooltip is token-only, never takes the pointer, and animates on a duration token", () => {
  // Plain-user pass 2026-10-16. The tooltip replaced every native title=. Three ways it can
  // quietly be wrong, each asserted: a literal colour (one theme's value is unreadable in the
  // other), pointer-events other than none (the box under the pointer steals the hover that
  // placed it and the whole thing flickers), and a hardcoded duration (reduced motion cannot
  // reach it). Its ink-on-ground pair is covered by the 4.5:1 sweep above only because it
  // declares var() for both, which the first assertion holds in place.
  const css = stylesheet();
  const m = /(^|\n)\.tip \{([^}]*)\}/.exec(css);
  assert.ok(m, "no .tip rule: the tooltip has no styling and would render as bare text");
  const body = m[2];
  assert.match(body, /pointer-events:\s*none/);
  assert.match(body, /background:\s*var\(--card\)/);
  assert.match(body, /color:\s*var\(--fg\)/);
  assert.match(body, /animation:[^;]*var\(--t-fast\)/);
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|oklch\(|rgba?\(|hsla?\(/i, "a literal colour inside the tooltip");
  // An inert DataTable row must not light up on hover: a ground that answers the pointer says "click me".
  assert.match(css, /\.dt-row\.inert:hover td \{ background: transparent; \}/, "an inert row would hover like a live one");
});

test("Overview 2026-10-16: the 'no change needed' fill is READABLE in dark, and still quieter than the changed fill", () => {
  // --seg-quiet is a FILL the eye has to find, not a ground that text sits on, so the 4.5:1 text
  // sweep never covered it. In dark it was `l - .34` => #2e557d, 2.11:1 on --card: a dark-blue
  // slab that disappeared into the card. It paints the quiet half of the Activity bars AND the
  // Overview's verdict chart, so the floor is the 3:1 non-text minimum (WCAG 1.4.11) on --card,
  // and it must stay clearly separable from --st-accent (the changed half), or the two-part bar
  // stops being two-part.
  const { darks } = themes(stylesheet(), ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']);
  assert.equal(darks.length, 2, "both dark blocks must be checked, or a token can be right in one path only");
  const fails = [];
  for (const d of darks) {
    const seg = resolveColor(d.map.get("--seg-quiet"), d.map);
    const card = resolveColor(d.map.get("--card"), d.map);
    const acc = resolveColor(d.map.get("--st-accent"), d.map);
    const onCard = contrast(seg, card), fromAcc = contrast(seg, acc);
    if (onCard < 3) fails.push(`${d.name}: --seg-quiet is ${onCard.toFixed(2)}:1 on --card (needs 3)`);
    if (fromAcc < 2) fails.push(`${d.name}: --seg-quiet is only ${fromAcc.toFixed(2)}:1 from --st-accent (needs 2 to read as a second series)`);
  }
  assert.deepEqual(fails, [], fails.join("\n"));
});

test("Overview 2026-10-16: the new rules declare no colour of their own", () => {
  // Every fill on the dashboard is a token (CSS) or a token resolved at render (the chart).
  // A hex or oklch literal in these rules would be one theme's value in both.
  const css = stripComments(stylesheet());
  const i = css.indexOf(".kpis.ov");
  assert.notEqual(i, -1, "the Overview rules are missing, so this check has gone blind");
  const block = css.slice(i);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\((?!from)/i, "a literal colour in the Overview rules");
  for (const s of ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]) {
    assert.match(css, new RegExp("\\.mix i\\." + s + "\\s*\\{\\s*background:\\s*var\\(--"), `the mini bar has no token colour for ${s}`);
  }
});
