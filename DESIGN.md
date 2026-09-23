# DESIGN.md — propagate

The design system for `propagate ui`, the Übersicht widget, and the graph page.
**One system, three surfaces.** A test asserts they resolve to identical colour;
they have diverged before.

> **Do not restate a number from this file.** Derive it. Every count below names
> the command that produces it, because a count in a document rots faster than
> anything else in it (`rule:state-and-decisions`). G67 is this repo's record of
> a design spec whose two headline claims were both wrong and bound to nothing.

```sh
node -e 'import("./lib/report/color.mjs").then(async({declarations,resolveColor,contrast,rgbToOklch})=>{
  const c=require("fs").readFileSync("commands/ui.css","utf8");
  const l=declarations(c.slice(0,c.indexOf("@media (prefers-color-scheme: dark)")));
  for(const t of ["--st-ok","--st-caution","--st-warn","--st-accent","--edge-drift","--edge-reverse","--edge-diverge"])
    console.log(t, resolveColor(l.get(t),l), contrast(resolveColor(l.get(t),l),"#fbfaf8").toFixed(2));
})'
```

## What this surface is

**OPERATE.** A dense admin worklist someone works through for tens of minutes at
a stretch, by keyboard. Scanability and speed beat expression; the brand lives in
the details. It is not a landing page and must not acquire the manners of one.

---

## 1 · Colour

Authored in **OKLCH with relative derivation** (`commands/ui.css`). Lightness and
chroma are separable there, which is the entire reason: an earlier fix scaled hex
toward black to gain contrast and dragged chroma down with it, which is what made
these surfaces brown.

Requires Chrome 119 / Safari 16.4. Verified on this machine: Chrome 153, Safari 27.
`lib/report/color.mjs` resolves the notation for tests and any generator.

### The two families, and why they are separate

| family | question it answers | shape | hues |
|---|---|---|---|
| **Status** | *how bad* | ordinal | warm arc — 28° warn, 80° caution, 145° ok |
| **Edge state** | *which side moved* | categorical | cool arc — 195° drift, 285° reverse, 340° diverge |
| **Chrome** | neither | — | 250° accent |

**Green → amber → red is a ramp people already read**, so status keeps it.
Edge state is not severity: DIVERGED is not "worse" than DRIFTED, it is a
different fact about which end of the edge moved. Putting it on warning hues is a
semantic error before it is a visual one. That is why the two families sit on
opposite halves of the wheel and why nothing may bridge them.

### The wheel

One number per role, **identical in both themes** (measured delta 0). Only
lightness changes between light and dark — the whole point of the notation.

**Minimum gap between any two hues: 25°, asserted.** The palette that shipped on
2026-09-18 had five of seven inside a 43° arc, with `--st-accent` and
`--edge-drift` **2° apart** across the two families the tests were already
keeping structurally separate.

### Lightness is per token, deliberately

A uniform semantic lightness was tried and measured. At `L=.545` green falls to
**4.50** contrast with no headroom while caution and drift clip the sRGB gamut.
Solved per hue, all seven land **4.62–4.69** inside a 0.038 lightness spread —
already near-uniform perceptually, without paying for it.

### Derived, never hand-picked

`-hover` (−.06 L) · `-active` (−.10 L) · `-quiet` (a pale tint for backgrounds).
A hover that is its own hex is free to drift from its base; one built with
`calc()` cannot. Roughly thirty values collapse to seven definitions plus rules.

### Neutrals

Tinted toward `--h-accent` at chroma .008, not pure grey — dead grey beside a
full-spectrum palette is what reads as unfinished. `--bg` keeps its warm cast on
purpose: swapping the ground wholesale trades brown for blue.

### The three things a colour must survive

1. **Contrast ≥ 4.5:1** against its own declared ground, both themes. The ground
   is *declared per surface*, never guessed — the widget is translucent window
   material and has no `--bg` to read, and the check said so rather than passing.
2. **Ink on fill ≥ 4.5:1** wherever text sits on a saturated colour. The widget
   declares it has none (its indicators are 7×7px swatches), and that claim is
   asserted.
3. **Distinguishable under deuteranopia.** The three edge states carry no text,
   so colour is their only channel. The pair that shipped scored **17**; the
   floor is 40 and the current trio scores 71–112.

Contrast cannot see failure 3: it measures a colour against its *background*,
and this one is between two *foregrounds*.

---

## 2 · Space, radius, elevation

`--s1`…`--s6` (4–32px) and `--r1`…`--r3` (3/6/10px) in `commands/ui.css`.

**The widget keeps its own tighter 3/6/9/12/15 scale.** Its ground is a 300px
card on a desktop, not a three-column page; sharing one scale would be
over-unification. Recorded here as a deviation with a reason rather than left to
look like an accident.

Elevation is **offset plus soft blur, tinted to the ground**. A zero-offset
coloured halo is decoration, not depth.

---

## 3 · Motion

Seven moments. **Each answers a question a static frame cannot** — that is the
test for whether one earns its cost. This is a worklist used for long stretches,
and motion you have to wait through is the kind people reliably hate.

| moment | token | what it tells you |
|---|---|---|
| undo ring drain | `--t-undo` 5000ms | how long you have left |
| row collapse on judge | `--t-row` 180ms | **where** the row left from, so your place is obvious |
| division switch | `--t-base` 160ms | that the ground changed |
| count pulse | `--t-slow` 220ms | READY dropped, without re-reading it |
| batch expand | `--t-slow` | the group has members |
| evidence arrive | `--t-fast` 140ms | the pane filled rather than failed |
| chart draw-in | `--t-draw` 420ms | the series has a direction |

Skeleton shimmer is the one loop, at 1200ms: *waiting*, not *empty*.

**Every duration is a token**, asserted. A hardcoded `300ms` cannot be reached by
the reduced-motion override and is invisible in the system.

### Reduced motion is not optional

`@media (prefers-reduced-motion: reduce)` zeroes every duration, applied with
`*, *::before, *::after` rather than a hand-listed set that rots. Asserted.

**The undo ring degrades to a numeric countdown.** The ring *is* the clock, so
hiding it would remove the information rather than the animation. The
information survives; the movement does not.

---

## 4 · Interaction states

Every division specifies **loading · empty · error · success · partial**. Empty
states name what remains elsewhere — *"nothing to judge; 18 in BLOCKED are
waiting on edges you just settled"* — because an empty division is not an empty
system. `"Nothing matches this filter"` and `"Nothing in this division"` stay
distinct strings.

Keyboard: every shortcut has a visible control. Disposition keys are built from
`item.allowed`, so the UI cannot offer one the write path will refuse.

---

## 5 · Deliberately not in the system

- **A chart library.** The page is one self-contained response with no build
  step; charts are inline SVG that inherits the palette tokens.
- **A typeface.** The system font stack stays, chosen 2026-09-21 with the cost
  named: it is the "gave up on typography" signal, and a self-hosted face means
  a woff2 as a data URI in a single-response page.
- **44px touch targets.** Localhost desktop tool.
- **Uniform semantic lightness.** Measured; costs headroom and chroma for a
  spread already perceptually near-uniform.
- **A shared space scale with the widget.** Different ground, different scale.

---

## 6 · Where it is enforced

| property | asserted in |
|---|---|
| the resolver itself, pinned to pre-existing measurements | `tests/unit/color.test.mjs` |
| both themes complete, contrast, ink-on-fill, CVD, hue gaps | `tests/unit/theme.test.mjs` |
| one wheel across all three surfaces | `tests/unit/theme.test.mjs` |
| reduced motion, duration tokens, ring degradation | `tests/unit/theme.test.mjs` |
| the emitted page parses in a browser | `tests/unit/ui-page.test.mjs` (G65) |

**A property worth stating here is worth an acceptance criterion.** The sibling
widget's theming has not rotted precisely because one test asserts it; this
surface's had no such test and shipped six unreadable values and a
colour-blindness defect through a review that scored accessibility 3 → 9 (G66).
