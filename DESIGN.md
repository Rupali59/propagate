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
  const c=require("fs").readFileSync("commands/ui/css/10-tokens.css","utf8");
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

Authored in **OKLCH with relative derivation** (`commands/ui/css/10-tokens.css`). Lightness and
chroma are separable there, which is the entire reason: an earlier fix scaled hex
toward black to gain contrast and dragged chroma down with it, which is what made
these surfaces brown.

Requires Chrome 119 / Safari 16.4. Verified on this machine: Chrome 153, Safari 27.
`lib/report/color.mjs` resolves the notation for tests and any generator.

### The colour families, and which separation is load-bearing

| family | question it answers | shape | hues |
|---|---|---|---|
| **Status** | *how bad* | ordinal | warm arc — 28° warn, 80° caution, 145° ok |
| **Edge state** | *which side moved* | categorical | cool arc — 195° drift, 285° reverse, 340° diverge |
| **Chrome** | neither | — | 250° accent |
| **Refusal kind** | *why the tool would not act* | categorical | **borrows the wheel** — see below |

**Green → amber → red is a ramp people already read**, so status keeps it.
Edge state is not severity: DIVERGED is not "worse" than DRIFTED, it is a
different fact about which end of the edge moved. Putting it on warning hues is a
semantic error before it is a visual one. That is why status and edge state sit
on opposite halves of the wheel and why **no single token may belong to both**.

**Amended 2026-09-25, when the CONFLICTS division made the earlier wording
false.** This section used to end *"nothing may bridge them"*, and the panel that
shipped that day bridges them openly: its six refusal kinds take `--st-warn` and
`--st-caution` from status, `--edge-drift`, `--edge-reverse` and `--edge-diverge`
from edge state, and `--st-accent` from chrome. The wording is corrected rather
than the panel, because the rule it was reaching for is narrower than what it
said, and the difference matters.

**What the separation protects is a TOKEN's meaning, not a hue's exclusivity.**
`--st-warn` means *how bad*; `--edge-diverge` means *which side moved*. A token
that meant both would make the ramp unreadable. A *third* categorical set that
reuses those hues declares no new token and changes no existing one, so nothing
it does can make green mean "slightly broken" — which is the failure the rule
exists to prevent.

**Refusal kinds are that third set, and they spend every hue but one.** Six
kebab-case dispositions, six hues, and `--st-ok` is deliberately never among
them: green means *this is fine* everywhere else in `commands/ui/css/`, so putting
a refusal on it inverts the one association a reader has without being taught.
What frees that hue is muting `already-inserted` — the single row in the panel
that is **not** a failure takes `--dim` rather than a colour, so the hue that
would have inverted is simply never spent. All three design-review mockups
independently coloured six refusals across the full wheel and every one landed a
refusal on green; that is the default outcome of treating six enum values as
peers, which is why it needed deciding rather than assuming.

**Two things keep this honest, because prose cannot.** `tests/unit/theme.test.mjs`
derives the disposition list from `lib/reminders/sync.mjs` and
`lib/reminders/reconcile.mjs` and asserts the stylesheet (`commands/ui/css/*.css`, joined) styles each one — a
disposition with no rule renders as ink on no background, which is invisible
rather than wrong. And the same file's both-themes check reads every `var()` the
stylesheet uses, so these rules were covered the moment they were written. The
25° hue-gap floor is unaffected: it iterates the seven declared tokens, and
reusing a hue adds none.

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

`-hover` (−.06 L) · `-active` (−.10 L) · `-quiet` (a pale tint for backgrounds) ·
`--seg-quiet` (the quiet half of a two-part bar). A hover that is its own hex is free
to drift from its base; one built with `calc()` cannot. Roughly thirty values
collapse to seven definitions plus rules.

**No `color-mix()`, anywhere (2026-10-15, F1).** The redesign's first mockup built its
"no change needed" bar segment as an in-oklch `color-mix` of the accent and the field,
and the light render came out sage green: that interpolation takes the *short way
round the hue wheel* (250° toward 85°, through green). A relative derivation keeps the
hue fixed and moves only lightness and chroma, which is what "the same colour, quieter"
means. For a translucent tint, use `oklch(from var(--token) l c h / .22)`.
`tests/unit/theme.test.mjs` bans the function (comments stripped, with a floor on the
derivations it did find, so an emptied stylesheet cannot pass).

**A token derived *upward* in lightness (`calc(l + …)`) must be redefined *downward* in
both dark blocks.** Inherited into dark, where the base is already light, it clips to
white — and the both-themes test cannot see it, because an inherited token "resolves".
That is asserted by deriving the set from the light block, not by listing it.

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

`--s1`…`--s6` (4–32px) and `--r1`…`--r3` (3/6/10px) in `commands/ui/css/10-tokens.css`.

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
| verdict bar height | `--t-slow` | a day's total changed, not just its number |

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

Every view specifies **loading · empty · error · success · partial**, and the table
that makes that a requirement rather than an intention is the plan's *Interaction
states* (ticklish-gathering-brook, F5). The client holds to it with one transport
(`api()` in `commands/ui.client.js`): a 401, a non-2xx, a rejected fetch and a
non-JSON body each end in a sentence on screen. None leaves a skeleton — the old
wrapper was `fetch().then(r => r.json())`, and each way it could fail was a
different silent defect.

**Empty states name what remains elsewhere** — *"Nothing to judge (N edges checked).
K edges are blocked on M roots → Unblock"* — because an empty view is not an empty
system. `"Nothing matches this filter"` and `"Nothing in this view"` stay distinct
strings. **"Unknown" is never zero:** a velocity that could not be read says
`unknown: <reason>`, never fourteen empty bars; a day with no verdicts is drawn as a
*gap*, not as a bar of zero height.

**Views (superseded 2026-10-17).** The rail is five groups, derived from each division's `group`
and never from a position (`railGroups`, `DIVISIONS` in `commands/ui.client.js`): **TODAY** (Overview),
**SETTLE** (Judge, Unblock — the two that write), **MACHINERY** (Health, Claims, Rules, Caps, Skills),
**WORK** (Backlog, Goals, Registers, Reminders) and **HISTORY** (Activity, History, Graph). The 2026-10-15
"four task views and an Explore set" split, and its `explore` flag, are gone. Only Judge and Unblock write; every
other page reads, and where a page offers a command it is copied, never run.

**One count definition.** The unit is an edge. The Judge badge is the widget's own
`worklist.toJudge`, computed over the same items the list renders, so the two cannot
disagree; the page prints no number of its own.

Keyboard: every shortcut has a visible control. Disposition keys are built from
`item.allowed`, so the UI cannot offer one the write path will refuse.

| key | does |
|---|---|
| `j` `k` | move through the edges |
| `x` | tick the current row (a native checkbox with a label, so a mouse and a screen reader reach it too) |
| `⇧J` | one verdict for every ticked edge — only the dispositions **all** of them allow |
| `n` `p` `d` `r` | no-change-needed · propagated · deferred · both-reconciled |
| `u` | undo the held verdict (five seconds, then it is written) |
| `Esc` | clear the selection |

**Nothing is ever preselected.** An earlier idea auto-picked the edges whose downstream
diff was empty as "no-op likely". It was inverted: a source that moved under an
unchanged downstream *is* drift. Bulk is now an explicit choice, row by row, with one
shared reason.

### Component vocabulary (superseded 2026-10-17)

The 2026-10-15 table listed one-off classes (`.root`, `.hrow`, `.vel`, `.vcol`, `.vaxis`, `.shead`, `.sitem`,
`.hit`, `.bar`) that the 2026-10-16 rebuild deleted; `tests/unit/theme.test.mjs` asserts there is no `.bar` rule and
no native `title=`. The page is now built from a few shared components, each of which enforces the rules below.
**Derive the class list, never copy it:** the classes the client emits that the stylesheet defines are those in
`commands/ui/css/*.css` which `commands/ui.client.js` names in a `class=` (or a string it builds a class from);
the `.badge` state modifiers, `pl-`, `pri-`, `r-`, `s-`, `k-`, `c-`, `g-` and `vin-` families are composed at
runtime from a row's value, so a grep for the full name finds nothing. A value the client can emit and the stylesheet
has no rule for renders as ink on no background; a test renders every view and checks each class it saw.

| component | what it is | what it enforces |
|---|---|---|
| `Kpi` `{label, value, sub, route, act, tip, warn, cls}` → `.kpis` `.kpi` `.pick`/`.inert` `.ksub` | the one stat card: label, value, sub-line | **`route` is required.** A card with a `route` (or an `act`, a copy) is `.pick`; one that leads nowhere is `.inert` and its `tip` is the **reason**. No reason renders `KPI_NO_REASON`, a sentence that reads as a defect on purpose, and a test asserts it never appears. Both kinds take focus, because focus is how a keyboard user gets the tooltip. `.warn` colours the figure `--st-warn`, nothing else |
| `DataTable` → `table.t` `.dt-row` `.sortable` `.dt-flash` `.pager` | the one table; Unblock roots, Health, Claims, Rules, Caps, Skills, Backlog, Goals, Registers, Reminders and the Overview sources all render through it | sortable headers (`aria-sort`; `value` on a column makes it sortable; null sorts last both ways); **every row is focusable**, Enter or click runs its `route` or its `act`; a row with neither is `.inert` and its tooltip is the reason (`ROW_NO_REASON` otherwise, asserted never to appear). **Paging: `TABLE_PAGE_SIZE`, 50** — every row carries handlers and is focusable, so the DOM cost is per row (a large register is hundreds of rows), and 50 is the cap Registers already used. Sort and filter act on **every** row first and the window is cut from the result; a changed sort, filter or refresh returns to page 1; `[` and `]` page while a row has focus (PageUp and PageDown are left to scroll). A control inside a cell stops its own click, so Enter on a button never also fires the row |
| `PlotChart` → `.charts3` `.plot` `.chart` `.mix` | **the only chart engine** (Observable Plot; `VerdictsChart` is one component on the Overview and on Activity) | fills are palette tokens resolved at render; the tooltip is the page's own `.tip`; a bar leads somewhere (Overview bars open Activity, Activity bars open Judge) or its tooltip says there is no list behind it. If the library fails to load, "chart unavailable" with the reason replaces the chart. A day with no verdicts is a gap, not a bar of zero height |
| `ErrorBanner` → `.banner` | **the only error UI**, with "retry" | the server's reason is shown, never a bare "failed". A banner with no `retry` is one where trying again would change nothing (the data was read and is itself the problem). **Two hand-written banners stay on purpose:** the focused-section note (a status, not an error) and the stale-server notice (a restart is the cure, not a retry) |
| `NextStrip` → `.nextstrip` | the Overview's one next step, above the KPIs | derived from the inbox's own top root, so it is never empty: it opens Judge on that edge, offers the baseline command to copy (the UI writes no baseline), goes to Unblock's settle-together groups, or states why nothing is blocked |
| `MachineryTiles` → `.mach` (on `Kpi`) | one tile per machinery source (Claims, Rules, Caps, Skills, Backlog, Goals) | each opens its page; a source that failed reads "could not read — <reason>", never 0; the client asks only after `/api/surface` lands |
| `MachineryPage` frame | title, the question the page answers, loading, a banner carrying the server's reason, then children (a `DataTable` and a one-line summary) | an empty table names what was examined; the figure on the tile is derived from the rows on this page, so the two cannot disagree |
| `.chip` `.chips` `.filt` | a filter toggle (`aria-pressed`), not tabs | |
| `.badge` (+ state modifiers) | a state word on a fill | **no `.pill`** |
| `.ghead` `.nhead` `.newdot` `.fgroup` | Judge's workspace and node headers, the seen marker, Unblock's settle-together group | a node header ticks its edges and sends nothing; a verdict goes through the guarded bulk path |
| `.evgrid` `.evbox` | source and downstream evidence side by side | stacks below 1100px |
| `.cmdrow` `.cmd` | a command the reader pastes, with a copy button | the text is always visible, so a blocked clipboard leaves something to select |
| `.tip` | the one tooltip, at the pointer, for every chart shape, card and row | **no native `title=`.** `pointer-events: none`, `--card` ground and `--fg` ink; content is `tipText` and only ever values the page already holds. Focus shows it too |
| `.vopt` `.vmean` | a verdict button with its one-line meaning | wording in `docs/REFERENCE.md` §"What each verdict means" |
| `.sr` | the visually hidden `aria-live="polite"` region | announces verdicts, undo and bulk results, including refusals |

**Rules these components enforce, in one place.** (1) **Every element has a destination or a stated inert reason** —
a card, a row, a chart bar. (2) **Loading and could-not-read are different states** with different words ("loading…"
and "could not read" with the reason beneath); neither is "unknown", and neither is 0. (3) **A failed source is never
0:** one failed block is an error state with its reason while the others still render. (4) **One error banner, one
table, one chart engine, one stat card** — a new view composes them; it does not hand-build a fifth.

### Accessibility and layout (F3, F4)

The rail is `<nav aria-label="views">` with `aria-current="page"` on the open view.
The focus ring is 2px `--st-accent` at a 2px offset on every control. 44px touch
targets stay out (§5). The two-column views reuse the existing breakpoints: below
1100px the rail becomes a top strip and the evidence diffs stack; below 860px the
list sits above the detail.

## 5 · Deliberately not in the system

- **A chart library, EXCEPT in the web UI (amended 2026-10-16; widened 2026-10-17).** The page is
  one self-contained response with no build step, and charts used to be inline SVG that
  inherits the palette tokens. The owner then asked for a dashboard with more
  visualisations (a stacked bar per workspace, a waiting-time histogram, verdicts per
  day, all clickable), and hand-drawing a band axis, a legend and a stacked-bar layout
  three times is the larger cost. So `d3` 7.9.0 and `@observablehq/plot` 0.6.17 (both ISC)
  are vendored in `commands/vendor/` as plain `<script>` globals, with their sha256 and
  licences in `commands/vendor/README.txt`. **What did not change:** no colour comes from the
  library. Every fill is a palette token resolved at render (`resolveToken` in the client),
  the tooltip is the page's own `.tip`. Phase 1 (2026-10-16) then deleted the hand-drawn
  web charts (`Velocity`, `Spark`, `Bars`), so `PlotChart` is the only chart engine on every web view; the
  widget stays hand-drawn SVG. **If the library fails to load**, a chart prints "chart
  unavailable" with the reason in place of the charts and the KPIs and table still work.
- **A typeface.** The system font stack stays, chosen 2026-09-21 with the cost
  named: it is the "gave up on typography" signal, and a self-hosted face means
  a woff2 as a data URI in a single-response page.
- **44px touch targets.** Localhost desktop tool.
- **Uniform semantic lightness.** Measured; costs headroom and chroma for a
  spread already perceptually near-uniform.
- **A shared space scale with the widget.** Different ground, different scale.
- **An icon library, except in the widget.** The widget vendors a small Lucide subset
  (`lucide` 1.55.0, ISC, React-free node data) into a generated block, because Übersicht
  resolves no relative import and the marketplace install runs no `npm install`. Charts stay
  hand-drawn SVG on the widget only (see the first bullet).
  Decided 2026-10-13 (widget redesign, D3/D9).

---

## 6 · Where it is enforced

| property | asserted in |
|---|---|
| the resolver itself, pinned to pre-existing measurements | `tests/unit/color.test.mjs` |
| both themes complete, contrast, ink-on-fill, CVD, hue gaps | `tests/unit/theme.test.mjs` |
| one wheel across all three surfaces | `tests/unit/theme.test.mjs` |
| reduced motion, duration tokens, ring degradation | `tests/unit/theme.test.mjs` |
| the emitted page parses in a browser | `tests/unit/ui-page.test.mjs` (G65) |
| no `color-mix`, upward derivations redefined in dark, badge modifiers, focus ring, narrow stacking | `tests/unit/theme.test.mjs` |
| every view's four states, the per-edge reason, nothing preselected, the Judge badge equal to the rendered rows, the transport's failures | `tests/unit/ui-client.test.mjs` |
| no entity text in the emitted page | `tests/unit/ui-page.test.mjs` |
| every card and row has a destination or a stated reason (`KPI_NO_REASON`, `ROW_NO_REASON` never appear); table paging; one banner | `tests/unit/ui-client.test.mjs` |
| the rail's groups and their membership; each machinery tile's figure equals the rows on its page | `tests/unit/ui-rail-separator.test.mjs`, `tests/unit/machinery.test.mjs` |
| the tooltip is token-only and takes no pointer; no rendered view carries a native `title=`; `tipText` never prints NaN | `tests/unit/theme.test.mjs`, `tests/unit/ui-client.test.mjs` |

**A property worth stating here is worth an acceptance criterion.** The sibling
widget's theming has not rotted precisely because one test asserts it; this
surface's had no such test and shipped six unreadable values and a
colour-blindness defect through a review that scored accessibility 3 → 9 (G66).
