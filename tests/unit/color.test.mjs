/**
 * The OKLCH resolver — pinned to numbers measured BEFORE it existed.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE PALETTE WORK. Once `ui.css`
 * expresses colour as `oklch(from var(--st-warn) calc(l - .06) c h)`, every
 * contrast, ink-on-fill, colour-blindness and hue-gap assertion runs on THIS
 * module's output. A resolver that quietly returns a wrong-but-plausible
 * colour makes all of them pass over a palette nobody checked — strictly worse
 * than having no colour tests, because the green is now evidence.
 *
 * So the fixed points below are values measured on 2026-09-19/21 with ad-hoc
 * scripts, against the palette as it then shipped. They are not regenerated
 * from this module. If the resolver breaks, these move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contrast, deuteranope, rgbDistance, resolveColor, rgbToOklch, oklchToRgb,
  declarations, parseHex, MIN_CVD_SEPARATION,
} from "../../lib/report/color.mjs";

// ── the fixed points ───────────────────────────────────────────────────────

test("contrast reproduces the six failures that shipped", () => {
  // Measured before this module existed. Every one of these passed the
  // structural palette test while being unreadable.
  const BG = "#fbfaf8";
  assert.equal(contrast("#a8700f", BG).toFixed(2), "4.03", "old --st-caution");
  assert.equal(contrast("#c26a1e", BG).toFixed(2), "3.75", "old --edge-drift");
  assert.equal(contrast("#8a6bb8", BG).toFixed(2), "4.13", "old --edge-reverse");
  assert.equal(contrast("#ffffff", "#a8700f").toFixed(2), "4.21", "white on old --sev-2");
  assert.equal(contrast("#ffffff", "#c26a1e").toFixed(2), "3.91", "white on old --edge-drift");
  assert.equal(contrast("#ffffff", "#8a6bb8").toFixed(2), "4.31", "white on old --edge-reverse");
});

test("contrast reproduces the anchors everyone agrees on", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
  assert.equal(contrast("#ffffff", "#ffffff").toFixed(0), "1");
});

test("deuteranope reproduces the 17 that shipped and the 112 that replaced it", () => {
  const shipped = rgbDistance(deuteranope("#ad5e1b"), deuteranope("#c0392b"));
  const now = rgbDistance(deuteranope("#0b7f7f"), deuteranope("#b64797"));
  assert.equal(shipped.toFixed(0), "17", "DRIFTED vs DIVERGED, as it shipped");
  assert.equal(now.toFixed(0), "112", "and after the hue wheel");
  assert.ok(shipped < MIN_CVD_SEPARATION && now >= MIN_CVD_SEPARATION);
});

test("a saturated colour round-trips exactly", () => {
  for (const hex of ["#0b7f7f", "#b64797", "#33803a", "#6f63ce", "#bf4c42"]) {
    const { L, C, H } = rgbToOklch(hex);
    assert.equal(oklchToRgb(L, C, H).hex, hex, `${hex} survives a round trip`);
  }
});

test("only a HUELESS colour loses anything in the round trip", () => {
  // Measured: of the palette's neutrals, only #1a1a19 (C=0.0019) and pure
  // white fall under the .002 chroma threshold. The cooled greys -- #6d7175
  // C=.0079, #d9dde0 C=.0060, #8d9195 C=.0076 -- carry real hue and survive
  // exactly. So the loss is confined to colours nobody perceives as coloured.
  //
  // This is the deliberate cost of reporting H = null for a neutral, and it is
  // pinned so nobody "fixes" it by inventing a hue for grey -- which would let
  // the hue-gap check believe a neutral collides with a real token.
  const drift = (hex) => {
    const { L, C, H } = rgbToOklch(hex);
    const back = oklchToRgb(L, C, H ?? 0).hex;
    return { back, H, max: Math.max(...[1, 3, 5].map((k) =>
      Math.abs(parseInt(back.slice(k, k + 2), 16) - parseInt(hex.slice(k, k + 2), 16)))) };
  };
  for (const hex of ["#6d7175", "#d9dde0", "#8d9195", "#16171a", "#fbfaf8"]) {
    const d = drift(hex);
    assert.ok(d.H !== null, hex + " carries a real hue");
    assert.equal(d.max, 0, hex + " -> " + d.back + " must be exact");
  }
  const grey = drift("#1a1a19");
  assert.equal(grey.H, null, "below .002 chroma there is no hue to report");
  assert.ok(grey.max <= 1, "and the cost is one byte: " + grey.back);
});

test("hue of a near-neutral is NULL, not an arbitrary angle", () => {
  // A grey has no meaningful hue. Returning one would make the hue-gap check
  // believe a neutral sits somewhere on the wheel and collides with a real
  // token — a confident number with nothing behind it.
  assert.equal(rgbToOklch("#808080").H, null);
  assert.ok(rgbToOklch("#b64797").H > 300, "a saturated colour still reports one");
});

test("out-of-gamut is REPORTED, never silently clamped", () => {
  // Clamping turns an impossible colour into a plausible one, which is how a
  // palette ends up with two tokens rendering identically.
  assert.equal(oklchToRgb(0.55, 0.13, 145).clipped, false);
  assert.equal(oklchToRgb(0.55, 0.40, 145).clipped, true, "chroma .40 is outside sRGB at this lightness");
});

// ── the resolver ───────────────────────────────────────────────────────────

const VARS = () => declarations(`
  :root {
    --h-warn: 28;
    --l-fg: .55;
    --bg: #fbfaf8;
    --st-warn: oklch(var(--l-fg) .15 var(--h-warn));
    --st-warn-hover: oklch(from var(--st-warn) calc(l - .06) c h);
    --st-warn-quiet: oklch(from var(--st-warn) l calc(c * .18) h);
    --alias: var(--st-warn);
  }
`);

test("resolves a plain hex, an absolute oklch, and a var chain", () => {
  const v = VARS();
  assert.equal(resolveColor("var(--bg)", v), "#fbfaf8");
  assert.equal(resolveColor("oklch(.55 .15 28)", v), oklchToRgb(0.55, 0.15, 28).hex);
  assert.equal(resolveColor("var(--alias)", v), resolveColor("var(--st-warn)", v));
});

test("var() inside oklch() is substituted before parsing", () => {
  const v = VARS();
  assert.equal(resolveColor("var(--st-warn)", v), oklchToRgb(0.55, 0.15, 28).hex);
});

test("relative colour actually changes the channel it names", () => {
  // The whole point of the notation: hover is DERIVED, so it cannot drift from
  // its base the way ~30 hand-picked hexes did.
  const v = VARS();
  const base = rgbToOklch(resolveColor("var(--st-warn)", v));
  const hover = rgbToOklch(resolveColor("var(--st-warn-hover)", v));
  assert.ok(Math.abs(hover.L - (base.L - 0.06)) < 0.01, "l - .06 lands where it says");
  assert.ok(Math.abs(hover.C - base.C) < 0.005, "chroma is carried through untouched");
  assert.ok(Math.abs(hover.H - base.H) < 1, "and so is hue");

  const quiet = rgbToOklch(resolveColor("var(--st-warn-quiet)", v));
  assert.ok(quiet.C < base.C * 0.3, "calc(c * .18) genuinely desaturates");
});

test("an unresolvable value THROWS with the value in the message", () => {
  // rule:discernment-checks §6 — a reader that cannot report failure invents an
  // answer. A default here would hand the contrast suite a colour nobody wrote.
  const v = VARS();
  assert.throws(() => resolveColor("color-mix(in srgb, red, blue)", v), /unresolvable colour value/);
  assert.throws(() => resolveColor("var(--never-defined)", v), /undefined custom property/);
  assert.throws(() => resolveColor("rebeccapurple", v), /unresolvable colour value/);
  assert.throws(() => parseHex("#fff"), /not a 6-digit hex/);
});

test("a var() cycle terminates instead of hanging", () => {
  const v = declarations(":root{ --a: var(--b); --b: var(--a); }");
  assert.throws(() => resolveColor("var(--a)", v), /cycle/);
});

test("comments are stripped before declarations are read", () => {
  // A comment naming a token parses as a declaration whose value runs to the
  // next semicolon, swallowing the real one after it. This exact shape once
  // reported a healthy --on-fill as undefined.
  const d = declarations(`:root{
    /* S3 takes --dim: least severe gets no hue */
    --on-fill: #ffffff;
  }`);
  assert.equal(d.get("--on-fill"), "#ffffff");
  assert.equal(d.has("--dim"), false, "the commented mention is not a declaration");
});
