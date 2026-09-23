/**
 * color.mjs — OKLCH, contrast, and colour-vision deficiency.
 *
 * WHY THIS MODULE EXISTS. `commands/ui.css` defines its palette in `oklch()`
 * with relative-colour derivation, so a token's value is no longer a hex a
 * regex can read — `oklch(from var(--st-warn) calc(l - .06) c h)` has to be
 * RESOLVED before anything can ask whether it is legible. The test suite needs
 * that resolver; so would any generator. One implementation, shared, because
 * two readers of one fact are free to disagree and nothing compares them.
 *
 * WHY OKLCH AND NOT HEX. Scaling a hex toward black to fix contrast drops
 * chroma along with lightness, which is what turned this palette brown. In
 * OKLCH the two are separable: drop L for contrast, keep C for colour. The
 * whole hue wheel is legible in the source, so the defect that shipped — five
 * of seven tokens inside a 43-degree arc, two of them 2 degrees apart — would
 * have been visible while writing it rather than needing a script to find.
 *
 * THE RISK THIS MODULE CARRIES. A resolver that silently returns the wrong
 * colour makes every colour test pass vacuously, which is worse than having no
 * colour tests. `tests/unit/color.test.mjs` therefore pins it against values
 * measured before it existed: `#c26a1e` must still compute 3.75 against
 * `#fbfaf8`, and the shipped DRIFTED/DIVERGED pair must still score 17 under
 * deuteranopia. Those are the fixed points; if they move, the resolver broke.
 */

/* ── sRGB transfer ────────────────────────────────────────────────────────── */

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const byte = (v) => Math.round(clamp01(v) * 255);

/** "#rrggbb" -> [r,g,b] in 0..1 gamma space. Throws rather than guessing. */
export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${JSON.stringify(hex)}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
export const toHex = ([r, g, b]) =>
  "#" + [r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("");

/* ── OKLab / OKLCH ────────────────────────────────────────────────────────── */

/** OKLCH -> sRGB. `clipped` is reported, never silently clamped away: a colour
 *  outside the gamut is a design error, not a rendering detail. */
export function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  const rgb = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(toGamma);
  return { rgb: rgb.map(clamp01), hex: toHex(rgb), clipped: rgb.some((v) => v < -0.002 || v > 1.002) };
}

/** sRGB -> OKLCH. Hue is 0..360; for a neutral it is meaningless and reported
 *  as null rather than as an arbitrary angle that a gap check would believe. */
export function rgbToOklch(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H: C < 0.002 ? null : H };
}

/* ── contrast ─────────────────────────────────────────────────────────────── */

export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ── colour-vision deficiency ─────────────────────────────────────────────── */

/**
 * Viénot deuteranope simulation, in linear sRGB.
 *
 * Coarse on purpose — it answers "same or different", which is the only
 * question asked of it. Two plausible stronger claims were written here first
 * and BOTH were measured false: pure red and green do not collapse (they
 * separate by lightness, 169 apart), and this is not axis-selective (red-green
 * retains 68%, blue-yellow 65%). The narrow claim is the true one.
 */
export function deuteranope(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return toHex([0.625 * r + 0.375 * g, 0.7 * r + 0.3 * g, 0.3 * g + 0.7 * b].map(toGamma));
}
export const rgbDistance = (a, b) => {
  const [x, y] = [parseHex(a), parseHex(b)].map((p) => p.map((v) => v * 255));
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/**
 * Below this, two swatches read as one colour.
 *
 * EMPIRICAL, and said so. 40 sits between the pair that shipped (17) and its
 * replacement (112). RGB distance after a Viénot matrix is a crude perceptual
 * metric; it is used because it separates those two by more than 6x, not
 * because anyone derived 40.
 */
export const MIN_CVD_SEPARATION = 40;

/* ── the CSS the palette is actually written in ───────────────────────────── */

const NUM = String.raw`[-+]?(?:\d*\.\d+|\d+)%?`;

/** `calc(l - .06)` / `calc(c * .18)` / a bare number / a channel name. */
function evalChannel(expr, base, key) {
  const t = String(expr).trim();
  if (t === key) return base[key];
  if (t === "none") return 0;
  const calc = /^calc\(\s*([a-z]|[-+]?[\d.]+)\s*([-+*/])\s*([-+]?[\d.]+%?)\s*\)$/i.exec(t);
  if (calc) {
    const left = /^[a-z]$/i.test(calc[1]) ? base[calc[1].toLowerCase()] : Number(calc[1]);
    let right = Number(String(calc[3]).replace("%", ""));
    if (String(calc[3]).endsWith("%")) right /= 100;
    switch (calc[2]) {
      case "-": return left - right;
      case "+": return left + right;
      case "*": return left * right;
      case "/": return left / right;
      default: break;
    }
  }
  if (/^[a-z]$/i.test(t)) return base[t.toLowerCase()];
  const n = Number(t.replace("%", ""));
  if (!Number.isFinite(n)) throw new Error(`cannot evaluate colour channel ${JSON.stringify(expr)}`);
  return t.endsWith("%") ? n / 100 : n;
}

/**
 * Resolve one CSS colour value to a hex, following `var()` through `vars`.
 *
 * Handles: `#rrggbb`, `oklch(L C H)`, `oklch(from <colour> <l> <c> <h>)` and
 * `var(--x)`. Anything else THROWS with the value in the message — a resolver
 * that returns a plausible default for a form it does not understand is the
 * reader-that-cannot-report-failure from `rule:discernment-checks` §6, and it
 * would make the contrast suite pass over colours nobody checked.
 */
export function alphaOf(value) {
  const m = /\/\s*([\d.]+%?)\s*\)\s*$/.exec(String(value ?? "").trim());
  if (!m) return 1;
  const raw = m[1];
  return raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
}

export function resolveColor(value, vars = new Map(), depth = 0) {
  if (depth > 12) throw new Error(`var() cycle resolving ${JSON.stringify(value)}`);
  let v = String(value ?? "").trim();

  // ALPHA IS STRIPPED AND RETURNED OPAQUE, and callers must know it.
  // A translucent colour has no contrast ratio of its own — the answer depends
  // on the backdrop, which CSS knows and this module does not. Returning the
  // opaque base lets hue and family checks work; `alphaOf` is exported so a
  // contrast check can EXCLUDE it rather than quietly measure the wrong thing.
  v = v.replace(/\s*\/\s*[\d.]+%?\s*\)\s*$/, ")");

  const varRef = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i.exec(v);
  if (varRef) {
    if (!vars.has(varRef[1])) throw new Error(`undefined custom property ${varRef[1]}`);
    return resolveColor(vars.get(varRef[1]), vars, depth + 1);
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();

  // Inline var() inside an oklch(...) — substitute then re-parse.
  if (/var\(/.test(v)) {
    v = v.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/gi, (_m, name) => {
      if (!vars.has(name)) throw new Error(`undefined custom property ${name}`);
      return String(vars.get(name)).trim();
    });
  }

  const rel = new RegExp(String.raw`^oklch\(\s*from\s+(.+?)\s+(\S+|calc\([^)]*\))\s+(\S+|calc\([^)]*\))\s+(\S+|calc\([^)]*\))\s*\)$`, "i").exec(v);
  if (rel) {
    const base = rgbToOklch(resolveColor(rel[1], vars, depth + 1));
    const b = { l: base.L, c: base.C, h: base.H ?? 0 };
    return oklchToRgb(evalChannel(rel[2], b, "l"), evalChannel(rel[3], b, "c"), evalChannel(rel[4], b, "h")).hex;
  }

  const abs = new RegExp(String.raw`^oklch\(\s*(${NUM})\s+(${NUM})\s+(${NUM})\s*\)$`, "i").exec(v);
  if (abs) {
    const L = abs[1].endsWith("%") ? parseFloat(abs[1]) / 100 : parseFloat(abs[1]);
    return oklchToRgb(L, parseFloat(abs[2]), parseFloat(abs[3])).hex;
  }

  throw new Error(`unresolvable colour value: ${JSON.stringify(value)}`);
}

/** `--name: value;` pairs, comments stripped first.
 *
 *  STRIPPING IS NOT TIDINESS. A comment reading "S3 takes --dim: least severe
 *  gets no hue" parses as a DECLARATION whose value runs to the next
 *  semicolon, swallowing the real declaration that follows it. That produced a
 *  false "undefined token" report that looked exactly like a CSS defect. */
export const stripComments = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, "");
export function declarations(css) {
  const out = new Map();
  for (const m of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}
