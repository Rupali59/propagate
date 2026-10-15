// propagate — the whole propagation picture on the desktop layer, draggable.
//
// WHAT THIS IS NOW (rewritten 2026-10-15 to the locked "variant A" target, the
// large landscape card; compacted 2026-10-15, revision 3). Top to bottom: a
// changed pill, HEALTH as one row of eight icon pills, WORKLIST as a donut of
// edge states beside a contribution calendar sized to the card's content width,
// LEVERAGE at full width (which edges hold the blocked ones back), VELOCITY
// (judgements per day, split changed / no-change) beside COMMANDS (usage and the
// top five; the 14-day chart only once three days carry data), and a footer
// carrying the freshness clocks and, only when thin, the headroom note. The
// previous version was nine ratio-bar rows
// plus an edge grid plus a judge panel; none of that survives.
//
// EVERY NUMBER COMES FROM `propagate surface --json`; THE WIDGET DRAWS, IT
// DOES NOT DERIVE (N86). The one thing it computes is GEOMETRY — donut arc
// angles, which calendar cell a day lands in, bar heights — because the payload
// is pure data (decision D4). That arithmetic lives in the marked pure:charts
// block below, plain JS with no JSX and no imports, so tests/unit/widget-charts
// .test.mjs can run it in node:vm and assert the maths.
//
// A SECTION THAT CANNOT BE COMPUTED SAYS WHY. Every section renders its
// unknown / none-recorded / missing state as "can't tell — <reason>", never as
// a 0 (rule:discernment-checks §2, §6). A bare 0 on this card would be
// indistinguishable from a clean tree.
//
// THE CARD MUST MAKE SENSE WITH ZERO CLICKS. Übersicht 1.6 (read from its source
// 2026-10-15): with enableInteraction on (the default), a widget in the FOREGROUND
// window (inBackground absent = foreground) gets the mouse only after its page JS
// posts widgetEnter on hover (server/src/detectWidgetHover.js); that window sits at
// kCGNormalWindowLevel-1, so any app window over the card swallows the click; and
// the README requires Accessibility access. There is no API to ask whether any of
// that holds, so nothing is hidden behind
// one: every colour is paired with an icon or a label (Apple HIG: convey
// meaning without relying on colour), and the clicks are only shortcuts —
// worklist /judge, leverage /unblock, velocity and commands /activity, health
// /health, the pill /activity (routes renamed 2026-10-15, plan F11) — through widget/open-ui.sh.
//
// DESKTOP JUDGING WAS REMOVED (decision D15, 2026-10-15). This file used to
// carry a judge panel and shell out to widget/judge.sh, which writes events to
// an append-only ledger — the highest-consequence action on the surface,
// offered on a layer that may not take clicks at all. The CTAs open /judge and
// /unblock, where the evidence is.
//
// ── THE IMPORT RULE ────────────────────────────────────────────────────────
//
// **No RELATIVE imports.** A relative specifier that fails to resolve on the
// desktop layer fails SILENTLY — no console, no test, no render. `uebersicht` is
// guaranteed to resolve; Übersicht's own `Probe` control imports `run` from it.
// That is also why icons are VENDORED into this file (the lucide block below)
// rather than imported: the widget is a symlink and the marketplace install runs
// no `npm install`. Icons render as inline SVG with stroke=currentColor.
//
// ── CONSTRAINTS READ FROM THE DOCS, NOT GUESSED ────────────────────────────
//
//   className     "CSS rules controlling widget positioning", compiled to a
//                 class by Emotion ONCE. STATIC — a container position can
//                 never come from state. This shapes everything below.
//   render        receives (props, dispatch).
//   updateState   (event, previousState) => nextState. Providing it REPLACES
//                 the default, so this file must still handle the command's own
//                 {output, error} events, and must spread ...prev or Übersicht's
//                 per-command state wipe drops the position. Both failures are
//                 silent.
//   initialState  the state before any command has run.
//   run(cmd)      resolves with stdout and REJECTS on error, so every run() has
//                 a .catch that dispatches an attributable error the card shows.
//                 open-ui.sh exits 1 with a message on stderr when the port is
//                 held by something it will not kill.
//
// Position therefore cannot live in className. The container sits at the origin
// with no box of its own; the card is `position: fixed` with left/top from
// state, which escapes the container and addresses the screen.
//
// NO JSX FRAGMENTS (G8). Übersicht compiles with `pragma:'html'` and sets no
// `pragmaFrag`, so `<div>` becomes `html('div', …)` and works, while `<>…</>`
// falls back to babel's default `React.Fragment` — not in a widget bundle's
// scope. Flat elements and arrays only. (`html` is window.html, the host's
// React.createElement; the icon helper calls it directly for the same reason.)
//
// Because `:hover` never fires on the desktop layer, no fact lives in a
// tooltip or a hover state. Everything that matters is inline.
//
// TEXT NEVER UNDER 11px, MARGINS 11–16px, SYSTEM FONT, AND `width: max-content`
// ON THE CARD, NEVER A FIXED PX WIDTH (Apple HIG widgets; G9). The card is as
// wide as its widest child; the charts are SVG of intrinsic size.

import { run } from 'uebersicht';

// Absolute path: Übersicht runs widget commands from its own widgets directory.
// Via collect.sh rather than `node` directly, because Übersicht inherits
// launchd's PATH, which has no /opt/homebrew/bin. Verified with
// `env -i PATH=/usr/bin:/bin` before shipping, not after.
export const command = 'bash "$HOME/Documents/GitHub/propagate/widget/collect.sh"';

// 5 minutes. The whole payload costs about a second under the GUI environment.
//
// The expensive half — doctor, at 37s — is NOT run here. It is read from a
// snapshot the monitor already writes on its existing 30-minute tick. That
// split is the same one claude-usage-widget uses, and it is why this stays a
// glance surface instead of a spinner.
export const refreshFrequency = 300000;

const STORE_KEY = 'propagate-surface.pos';
const DEFAULT_POS = { left: 20, top: 20 };

// localStorage is not mentioned in the Übersicht docs either way, so it is used
// defensively: a throw here (quota, a future sandbox) must cost the remembered
// position and nothing else. Persistence must never break the render.
function loadPos() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_POS;
    const p = JSON.parse(raw);
    if (typeof p.left !== 'number' || typeof p.top !== 'number') return DEFAULT_POS;
    return p;
  } catch (e) {
    return DEFAULT_POS;
  }
}

function savePos(pos) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(pos));
  } catch (e) {
    /* the position will not survive a restart; everything else still works */
  }
}

export const initialState = {
  output: '',
  error: null,
  pos: loadPos(),
  dragging: false,
  moved: false,
  // Set the first time any click handler fires. This is the ONLY reliable
  // evidence that Übersicht interaction is configured — there is no API to ask.
  interactive: false,
  // The last click or refresh that FAILED, as text. run() rejects with whatever
  // the script wrote to stderr; showing it is what makes a dead click
  // attributable instead of silent.
  note: null,
  busy: false,
};

// A custom updateState REPLACES the default, so the command's own events are
// handled here too. Every branch spreads ...prev (G11): Übersicht replaces
// widget state on each command run, so a branch that returns a fresh object
// silently drops the position and the interactive flag.
export const updateState = (event, previousState) => {
  const prev = previousState || initialState;
  if (!event) return prev;

  if (event.type === 'DRAG_START') return { ...prev, dragging: true, moved: true, interactive: true };
  if (event.type === 'DRAG_MOVE') return { ...prev, pos: event.pos };
  if (event.type === 'DRAG_END') {
    savePos(prev.pos);
    return { ...prev, dragging: false };
  }
  if (event.type === 'RESET_POS') {
    savePos(DEFAULT_POS);
    return { ...prev, pos: DEFAULT_POS };
  }
  if (event.type === 'CLICKED') return { ...prev, interactive: true };
  if (event.type === 'RUN_OK') return { ...prev, note: null };
  if (event.type === 'RUN_ERROR') return { ...prev, note: event.text, busy: false };
  if (event.type === 'BUSY') return { ...prev, busy: true };
  // A forced refresh replaces the command's output in place. `error: null`
  // because a successful manual run is evidence the previous failure is over.
  if (event.type === 'REFRESHED') return { ...prev, output: event.output, error: null, note: null, busy: false };

  // The documented default command event shape.
  if (event.error) return { ...prev, error: String(event.error) };
  if (typeof event.output === 'string') return { ...prev, output: event.output, error: null };
  return prev;
};

// The container is NOT positioned from state — className is static. It sits at
// the origin carrying only the styles; `.shell` holds the real position.
//
// WIDTH IS `max-content`, NOT A NUMBER (G9). That entry: *"a fixed card width is
// a claim about the cell count, and it rotted immediately"* — a 470px card whose
// heatmap needed 630px, drawing cells outside the rounded corner onto the
// wallpaper, with correct DOM, valid CSS, passing tests and the right data.
// `overflow` is visible by default, so nothing catches it but looking.
export const className = `
  left: 0; top: 0;

  /* ── TWO COLOUR FAMILIES, DISJOINT BY CONSTRUCTION ───────────────────────
     STATUS is ordinal: a closed enum ok | fail | accepted-only | unknown.
     Unknown gets NO hue and falls back to --dim, the sibling widget's own
     convention. EDGE STATE is its own family (which side moved, not how bad),
     with values lifted verbatim from lib/graph/graph-html.mjs, so the surfaces
     agree on what DRIFTED looks like. The st- and edge- prefixes exist so a
     collision is visible in the NAME. Recorded as G66.

     CHART FILLS ARE CLASSES IN THIS STRING, NEVER HEX IN THE SVG. A fill written
     as an attribute would be invisible to tests/unit/theme.test.mjs, which
     derives its token population from the var() uses in this literal (G70).

     ── THEME ────────────────────────────────────────────────────────────────
     Light is the base; one prefers-color-scheme block redefines every palette
     token. No colour gets its only definition inside the media query. If both
     themes do not render when macOS Appearance is toggled, that is WKWebView
     not inheriting the system appearance, not a bug in this stylesheet. */

  /* Theme-independent: geometry, never colour. The widget's own 3/6/9/12/15
     scale (DESIGN.md section 2). */
  --s1: 3px; --s2: 6px; --s3: 9px; --s4: 12px; --s5: 15px;
  --r-shell: 20px; --r-core: 15px;

  /* LIGHT — macOS window material over a bright desktop. --shell is the OUTER
     bezel only; text sits on --core. The cast shadow is tinted to the ground
     rather than black, which separates the card from a pale wallpaper. */
  --fg: #1c1c1e;
  --dim: rgba(60, 60, 67, 0.62);
  --dimmer: rgba(60, 60, 67, 0.42);
  --track: rgba(60, 60, 67, 0.13);

  /* THE WHEEL, the SAME wheel commands/ui/css and lib/graph/graph-html.mjs use,
     asserted identical by tests/unit/theme.test.mjs. OKLCH so lightness and
     chroma stay separable. Übersicht is WebKit; Safari 16.4+ has relative
     colour. */
  --h-warn: 28; --h-caution: 80; --h-ok: 145;
  --h-drift: 195; --h-accent: 250; --h-reverse: 285; --h-diverge: 340;

  --st-ok:        oklch(.535 .129 var(--h-ok));
  --st-caution:   oklch(.555 .115 var(--h-caution));
  --st-warn:      oklch(.567 .150 var(--h-warn));
  --st-accent:    oklch(.551 .130 var(--h-accent));

  --edge-drift:   oklch(.541 .090 var(--h-drift));
  --edge-reverse: oklch(.564 .160 var(--h-reverse));
  --edge-diverge: oklch(.573 .170 var(--h-diverge));

  --shell: rgba(255, 255, 255, 0.16);
  --core: linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(252,250,249,0.78) 100%);
  --edge: rgba(0, 0, 0, 0.10);
  --edge-core: rgba(255, 255, 255, 0.85);
  --specular: rgba(255, 255, 255, 0.85);
  --cast-near: rgba(60, 50, 42, 0.10);
  --cast-far: rgba(60, 50, 42, 0.24);
  --hair: rgba(0, 0, 0, 0.09);

  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  letter-spacing: -.005em;
  -webkit-font-smoothing: antialiased;
  color: var(--fg);

  @media (prefers-color-scheme: dark) {
    --fg: rgba(255, 255, 255, 0.92);
    --dim: rgba(235, 235, 245, 0.60);
    --dimmer: rgba(235, 235, 245, 0.38);
    --track: rgba(235, 235, 245, 0.16);

    --st-ok:        oklch(.779 .130 var(--h-ok));
    --st-caution:   oklch(.780 .130 var(--h-caution));
    --st-warn:      oklch(.779 .125 var(--h-warn));
    --st-accent:    oklch(.781 .114 var(--h-accent));

    --edge-drift:   oklch(.779 .110 var(--h-drift));
    --edge-reverse: oklch(.781 .114 var(--h-reverse));
    --edge-diverge: oklch(.780 .170 var(--h-diverge));

    --shell: rgba(255, 255, 255, 0.07);
    --core: linear-gradient(180deg, rgba(44,44,46,0.82) 0%, rgba(28,28,30,0.76) 100%);
    --edge: rgba(255, 255, 255, 0.13);
    --edge-core: rgba(255, 255, 255, 0.09);
    --specular: rgba(255, 255, 255, 0.16);
    --cast-near: rgba(0, 0, 0, 0.34);
    --cast-far: rgba(0, 0, 0, 0.52);
    --hair: rgba(255, 255, 255, 0.07);
  }

  /* The concentric double bezel: a 5px translucent frame, the core inside it at
     the smaller radius, both with an inset specular along the lit top edge.
     backdrop-filter cannot help here -- the wallpaper is behind the WINDOW, not
     behind an element in the document. */
  .shell {
    position: fixed;
    width: max-content;
    padding: 5px;
    border-radius: var(--r-shell);
    background: var(--shell);
    border: .5px solid var(--edge);
    box-shadow: 0 1px 1px var(--cast-near), 0 12px 32px -8px var(--cast-far), inset 0 1px 0 0 var(--specular);
  }
  .shell.dragging { border-color: var(--st-accent); }
  .core {
    border-radius: var(--r-core);
    background: var(--core);
    border: .5px solid var(--edge-core);
    box-shadow: inset 0 1px 0 0 var(--specular);
    padding: 11px;
    display: flex; flex-direction: column; gap: 11px;
  }

  /* TOP STRIP. The title is the drag handle; the pill is a click target. */
  .hd { display: flex; align-items: center; gap: var(--s3); cursor: grab; }
  .shell.dragging .hd { cursor: grabbing; }
  .ttl { font-size: 14px; font-weight: 600; color: var(--dim); }
  .warn { color: var(--st-warn); }
  .ok { color: var(--st-ok); }

  /* THE CHANGED PILL. "What changed since I last looked" -- ONE number. No fixed
     width (G9's family): the count can grow and the pill must not clip it. Not a
     filled badge: translucent ground, accent text, so ink-on-fill never applies. */
  .chg {
    margin-left: auto;
    font-size: 12px;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 11px;
    border: .5px solid var(--st-accent);
    background: rgba(127,127,127,.10);
    color: var(--st-accent);
    white-space: nowrap;
    cursor: pointer;
  }
  .chg.none { color: var(--fg); border-color: var(--hair); background: rgba(127,127,127,.22); }
  .chg.unknown { color: var(--dim); border-color: var(--hair); cursor: default; }

  /* PANELS. One quiet container per section; 11px inside and between (HIG's
     tight Mac-desktop margin; revision 3 compacted the card from 16-20px). */
  .pn { border: .5px solid var(--hair); border-radius: 12px; padding: 11px; background: rgba(127,127,127,.05); }
  /* 640px is the content width every panel is laid out against: the calendar's
     week count is DERIVED from it (CARD_INNER in the script is this less the
     panel padding, and widget-contract asserts they agree). The shell stays
     width: max-content (G9); this fixes the stack so one panel's one-line
     max-content cannot widen the card past the grid the others were drawn on. */
  .stack { display: flex; flex-direction: column; gap: 11px; width: 640px; }
  .act { cursor: pointer; }
  .row2 { display: flex; gap: 11px; align-items: stretch; }
  .row2 > .pn { flex: 1 1 0; }
  .ph { display: flex; align-items: center; flex-wrap: wrap; gap: 3px var(--s2); margin-bottom: 4px; }
  .st { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .sb { color: var(--dim); }
  .sp { margin-left: auto; color: var(--dim); white-space: nowrap; }
  .why { display: flex; align-items: center; gap: var(--s2); color: var(--dim); }
  .ic { flex: 0 0 auto; display: block; }

  /* HEALTH PILLS, ONE row of eight. Each carries its section icon AND a status
     glyph whose SHAPE differs (check, alert, minus, question), so no state is
     colour alone. Icon and glyph share the top line and the label sits under
     them, which is what lets eight pills fit the card's content width. accepted-
     only is deliberately grey: a failure someone declared permanent is neither ok
     nor a failure. */
  .hgrid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: var(--s2); }
  .pill { display: flex; flex-direction: column; gap: 2px; font-size: 11px; padding: 5px 5px; border: .5px solid var(--hair); border-radius: 8px; background: rgba(127,127,127,.06); white-space: nowrap; }
  .pill .pt { display: flex; align-items: center; justify-content: space-between; gap: var(--s1); }
  .pill .ps { display: flex; align-items: center; gap: var(--s1); font-weight: 600; }
  .pill.ok .ps { color: var(--st-ok); }
  .pill.fail { border-color: var(--st-warn); }
  .pill.fail .ps { color: var(--st-warn); }
  .pill.accepted-only .ps { color: var(--dim); }
  .pill.unknown .ps { color: var(--dim); }
  .hnote { margin-top: var(--s2); color: var(--dim); display: flex; align-items: center; gap: var(--s2); }

  /* WORKLIST: donut + legend on the left, calendar on the right. */
  .wl { display: flex; gap: 11px; align-items: flex-start; }
  .lg { display: flex; flex-direction: column; gap: var(--s2); padding-top: var(--s3); width: 128px; flex: 0 0 auto; }
  .lgr { display: flex; align-items: center; gap: var(--s2); }
  .lgr .n { margin-left: auto; padding-left: var(--s2); font-variant-numeric: tabular-nums; }
  .sw { width: 10px; height: 10px; border-radius: 5px; background: var(--dim); flex: 0 0 auto; }
  .sw.DRIFTED { background: var(--edge-drift); }
  .sw.REVERSED { background: var(--edge-reverse); }
  .sw.DIVERGED { background: var(--edge-diverge); }
  .sw.UNMATCHED { background: var(--dim); }
  .sw.other { background: var(--dimmer); }
  .sw.chgd { background: var(--st-ok); }
  .sw.nochg { background: var(--st-ok); opacity: .35; }
  .cap { margin-top: var(--s2); color: var(--dim); }

  /* CHART FILLS. Classes here, tokens only. */
  .track { fill: none; stroke: var(--track); stroke-width: 18; }
  .arc { fill: none; stroke-width: 18; }
  .arc.DRIFTED { stroke: var(--edge-drift); }
  .arc.REVERSED { stroke: var(--edge-reverse); }
  .arc.DIVERGED { stroke: var(--edge-diverge); }
  .arc.UNMATCHED { stroke: var(--dim); }
  .arc.other { stroke: var(--dimmer); }
  .t { fill: var(--dim); font-size: 11px; }
  .tn { fill: var(--fg); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .cc { fill: var(--track); }
  .cc.l1 { fill: var(--st-caution); fill-opacity: .30; }
  .cc.l2 { fill: var(--st-caution); fill-opacity: .50; }
  .cc.l3 { fill: var(--st-caution); fill-opacity: .75; }
  .cc.l4 { fill: var(--st-caution); }
  .cc.today { stroke: var(--fg); stroke-width: 1.5; }
  .bc { fill: var(--st-ok); }
  .bn { fill: var(--st-ok); fill-opacity: .35; }
  .bu { fill: var(--st-accent); }
  .bz { fill: var(--dimmer); }

  /* LEVERAGE. A root's two numbers are both labelled: "frees N now" is what
     settling it releases on its own, "upstream of M" is how many blocked edges
     list it at all (D14). Never "unblocks". */
  .lv { display: flex; flex-direction: column; gap: var(--s2); }
  .lvh { display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap; }
  .rt { display: flex; align-items: center; gap: 11px; }
  /* A root's label is never ellipsised by CSS: compactPath() elides DIRECTORIES
     only, so a filename always survives. */
  .rn { flex: 1 1 auto; white-space: nowrap; }
  .mt { height: 8px; border-radius: 4px; background: var(--track); flex: 0 0 auto; }
  .mf { height: 8px; border-radius: 4px; background: var(--st-accent); }
  .nums { color: var(--dim); white-space: nowrap; min-width: 235px; text-align: right; }
  .nums b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .big { font-size: 14px; font-weight: 600; }
  .keys { display: flex; gap: var(--s4); margin-top: var(--s2); color: var(--dim); }
  .keys span { display: flex; align-items: center; gap: var(--s2); }

  /* COMMANDS */
  .cmd { display: flex; flex-direction: column; gap: var(--s2); }
  .tc { display: flex; flex-direction: column; gap: 4px; }
  .tcr { line-height: 1.25; }
  .tot { display: flex; align-items: center; gap: 11px; color: var(--dim); white-space: nowrap; }
  .tot span { display: flex; align-items: center; gap: var(--s1); }
  .tot b { color: var(--fg); }
  .tcr { display: flex; align-items: center; gap: var(--s3); }
  .tcr .nm { width: 78px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tcr .n { margin-left: auto; font-variant-numeric: tabular-nums; }

  /* HEADROOM, shown only when thin (or when it cannot be told), now INLINE in the
     footer row instead of its own boxed row. Amber text AND a gauge icon AND the
     number, so colour is never alone. */
  .hr { display: flex; align-items: center; gap: var(--s2); color: var(--st-caution); }
  .hr .sb { color: var(--dim); }

  .err { display: flex; align-items: flex-start; gap: var(--s2); color: var(--st-warn); contain: inline-size; white-space: normal; overflow-wrap: anywhere; }
  .foot { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 11px; color: var(--dim); border-top: .5px solid var(--hair); padding-top: 6px; }
  .foot .rf { cursor: pointer; font-size: 14px; }
  .foot .stale { color: var(--st-caution); display: flex; align-items: center; gap: var(--s1); }
  .foot .sp { margin-left: auto; display: flex; gap: 11px; }
  .gate { color: var(--dim); contain: inline-size; white-space: normal; }
  .gate b { color: var(--st-caution); font-weight: 600; }
`;

// ---- pure:charts begin ----
// PURE GEOMETRY AND LABELS. Plain JS: no JSX, no imports, nothing exported by
// name — tests/unit/widget-charts.test.mjs extracts the text between these
// markers and runs it in node:vm (decision D12). Everything the widget computes
// rather than reads from the payload is here, so the arithmetic is testable
// without a renderer. The block must stay self-contained: a reference to
// anything defined outside it is a ReferenceError in the vm and a failing test.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;
const WORKLIST_ORDER = ['DRIFTED', 'REVERSED', 'DIVERGED', 'UNMATCHED', 'other'];

// 'YYYY-MM-DD' -> UTC midnight in ms, or null. UTC arithmetic on purpose: the
// payload's days are already LOCAL days (surface.mjs localDay), so this only
// needs a calendar, and UTC has no DST hour to fall into.
function isoToUtc(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function utcToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// A Date's LOCAL calendar day. Not toISOString(): that is UTC, which names the
// wrong day for the first hours of an IST morning.
function localISO(date) {
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

// 'YYYY-MM-DD' -> 'Oct 12'
function shortDate(iso) {
  const ms = isoToUtc(iso);
  if (ms == null) return String(iso);
  const when = new Date(ms);
  return MONTHS[when.getUTCMonth()] + ' ' + when.getUTCDate();
}

function baseName(p) {
  const s = String(p == null ? '' : p);
  return s.slice(s.lastIndexOf('/') + 1);
}

function agoText(ms) {
  if (ms == null || !isFinite(ms)) return 'unknown time';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}

// Why a section cannot be drawn, or null when it can. A missing section, an
// unknown one and a none-recorded one are all "can't tell" with a reason.
function whyNot(section) {
  if (section == null) return 'missing from the payload';
  if (section.status != null && section.status !== 'ok') return section.reason || String(section.status);
  return null;
}

// DONUT. Slices in the edge-family order, angles clockwise from 12 o'clock.
// Sweeps sum to 360 exactly (the last slice takes the remainder), a single slice
// is one full ring, and an empty population is total 0 with no arcs — the caller
// draws the bare track, never a division by zero.
function donutArcs(byState) {
  const src = byState || {};
  const slices = WORKLIST_ORDER
    .map((key) => ({ key: key, count: Number(src[key]) > 0 ? Number(src[key]) : 0 }))
    .filter((s) => s.count > 0);
  const total = slices.reduce((n, s) => n + s.count, 0);
  const arcs = [];
  let at = 0;
  slices.forEach((s, i) => {
    const last = i === slices.length - 1;
    const sweep = last ? 360 - at : (s.count / total) * 360;
    arcs.push({ key: s.key, count: s.count, startDeg: at, sweepDeg: sweep, full: slices.length === 1 });
    at += sweep;
  });
  return { total: total, arcs: arcs };
}

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// SVG path for one ring segment. A full ring cannot be one arc (start == end
// draws nothing), so it is two half arcs.
function arcPath(cx, cy, r, startDeg, sweepDeg) {
  const f = (n) => String(Math.round(n * 100) / 100);
  if (sweepDeg >= 359.999) {
    const a = polar(cx, cy, r, startDeg);
    const b = polar(cx, cy, r, startDeg + 180);
    return 'M' + f(a[0]) + ' ' + f(a[1]) + ' A' + r + ' ' + r + ' 0 1 1 ' + f(b[0]) + ' ' + f(b[1])
      + ' A' + r + ' ' + r + ' 0 1 1 ' + f(a[0]) + ' ' + f(a[1]);
  }
  const p = polar(cx, cy, r, startDeg);
  const q = polar(cx, cy, r, startDeg + sweepDeg);
  return 'M' + f(p[0]) + ' ' + f(p[1]) + ' A' + r + ' ' + r + ' 0 ' + (sweepDeg > 180 ? 1 : 0) + ' 1 ' + f(q[0]) + ' ' + f(q[1]);
}

// CONTRIBUTION CALENDAR. Columns are Monday-start weeks, the LAST column holds
// `todayISO`, rows are Monday..Sunday. A day with no items is a real cell at
// level 0 (a visible baseline), never a missing one; days after today in the
// last week are `future` and the renderer skips them. Items outside the window
// are COUNTED (`outside`), not dropped, so the caption can say so.
function calendarCells(calendar, todayISO, weeks) {
  const nWeeks = weeks > 0 ? Math.floor(weeks) : 9;
  const today = isoToUtc(todayISO);
  if (today == null) {
    return { error: 'today is not a YYYY-MM-DD date: ' + todayISO, cols: [], months: [], max: 0, outside: 0, future: 0, firstISO: null, lastISO: null };
  }
  const todayRow = (new Date(today).getUTCDay() + 6) % 7;
  const lastMonday = today - todayRow * DAY_MS;
  const firstMonday = lastMonday - (nWeeks - 1) * 7 * DAY_MS;

  const counts = new Map();
  let outside = 0;
  let future = 0;
  for (const c of calendar || []) {
    const ms = isoToUtc(c.day);
    const n = Number(c.count) > 0 ? Number(c.count) : 0;
    if (ms == null || n === 0) continue;
    if (ms < firstMonday) outside += n;
    else if (ms > today) future += n;
    else counts.set(c.day, (counts.get(c.day) || 0) + n);
  }
  const max = Math.max(0, ...counts.values());

  const cols = [];
  const months = [];
  let prevMonth = -1;
  for (let w = 0; w < nWeeks; w += 1) {
    const cells = [];
    for (let r = 0; r < 7; r += 1) {
      const ms = firstMonday + (w * 7 + r) * DAY_MS;
      const iso = utcToIso(ms);
      const count = counts.get(iso) || 0;
      const level = count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((4 * count) / max)));
      cells.push({ iso: iso, row: r, col: w, count: count, level: level, future: ms > today, today: ms === today });
    }
    cols.push(cells);
    const month = new Date(firstMonday + w * 7 * DAY_MS).getUTCMonth();
    if (month !== prevMonth) months.push({ col: w, label: MONTHS[month] });
    prevMonth = month;
  }
  return { error: null, cols: cols, months: months, max: max, outside: outside, future: future, firstISO: utcToIso(firstMonday), lastISO: utcToIso(lastMonday) };
}

// BAR HEIGHTS. Scaled to the largest value; 0 stays 0 (the caller draws a
// baseline tick for it, so zero is visible rather than missing); any positive
// value is at least 1px so a small day never vanishes.
function barHeights(values, maxPx) {
  const vs = (values || []).map((v) => (Number(v) > 0 ? Number(v) : 0));
  const max = Math.max(0, ...vs);
  if (max === 0) return vs.map(() => 0);
  return vs.map((v) => (v === 0 ? 0 : Math.max(1, Math.round((v / max) * maxPx))));
}

// STACKED BARS for velocity: total height scales to the busiest day, split into
// a changed part (solid, on top) and a no-change part (light, below). Each part
// keeps at least 1px while it is non-zero.
function stackBars(days, maxPx) {
  const list = days || [];
  const heights = barHeights(list.map((row) => row.total), maxPx);
  return list.map((row, i) => {
    const h = heights[i];
    const changed = Number(row.changed) > 0 ? Number(row.changed) : 0;
    const noChange = Number(row.noChange) > 0 ? Number(row.noChange) : 0;
    let changedPx = 0;
    if (h > 0 && changed > 0) {
      changedPx = Math.round((changed / (changed + noChange)) * h);
      changedPx = Math.max(1, Math.min(changedPx, noChange > 0 && h > 1 ? h - 1 : h));
    }
    return { day: row.day, h: h, changedPx: changedPx, noChangePx: h - changedPx };
  });
}

// X-axis ticks: the day of the month, plus the month name on the first bar and
// whenever a month starts.
function dayTicks(days) {
  return (days || []).map((row, i) => {
    const iso = String(row.day);
    const dom = Number(iso.slice(8, 10));
    return { label: String(dom), month: i === 0 || dom === 1 ? MONTHS[Number(iso.slice(5, 7)) - 1] : null };
  });
}

// HEALTH PILLS: eight fixed pills over the doctor sections. A pill's status is
// the WORST of the sections it covers (fail > accepted-only > ok > unknown), so
// "Workspaces" is one pill over every `Workspace: *` section. Nothing is hidden
// by the fixed set: a failing section no pill covers is returned in
// `otherFailing` and the widget names it.
const HEALTH_PILLS = [
  { label: 'Delivery', icon: 'truck', names: ['Delivery'] },
  { label: 'Discovery', icon: 'search', names: ['Discovery integrity'] },
  { label: 'Backlog', icon: 'inbox', names: ['Backlog'] },
  { label: 'Budget', icon: 'gauge', names: ['Instruction budget'] },
  { label: 'Workspaces', icon: 'folders', prefix: 'Workspace: ' },
  { label: 'Metrics', icon: 'activity', names: ['Metrics'] },
  { label: 'Registers', icon: 'book-open', names: ['Registers'] },
  { label: 'Cross-repo', icon: 'git-branch', names: ['Cross-repo'] },
];
const STATUS_RANK = { fail: 3, 'accepted-only': 2, ok: 1, unknown: 0 };

function healthPills(sections) {
  const all = sections || [];
  const claimed = new Set();
  const pills = HEALTH_PILLS.map((def) => {
    const mine = all.filter((s) => (def.prefix ? String(s.key).startsWith(def.prefix) : def.names.indexOf(s.key) !== -1));
    mine.forEach((s) => claimed.add(s.key));
    if (mine.length === 0) {
      return { label: def.label, icon: def.icon, status: 'unknown', fail: 0, accepted: 0, count: 0, reason: 'no such section in the doctor snapshot' };
    }
    let status = 'unknown';
    for (const s of mine) if ((STATUS_RANK[s.status] || 0) > STATUS_RANK[status]) status = s.status;
    return {
      label: def.label,
      icon: def.icon,
      status: status,
      fail: mine.reduce((n, s) => n + (s.fail || 0), 0),
      accepted: mine.reduce((n, s) => n + (s.accepted || 0), 0),
      count: mine.length,
      reason: status === 'unknown' ? 'the section recorded no checks' : null,
    };
  });
  const otherFailing = all.filter((s) => s.status === 'fail' && !claimed.has(s.key)).map((s) => s.key);
  return { pills: pills, otherFailing: otherFailing };
}

// HOW MANY CALENDAR WEEKS FIT. The card's width is derived from its content (G9),
// so the calendar cannot ask the card how wide it is; the caller states the
// width it was given and this returns the whole weeks that fit in it: a left
// label gutter, then `step` per week, the last cell needing only its own width.
function calendarWeeks(availPx, labelPx, stepPx, cellPx) {
  const room = availPx - labelPx - cellPx;
  return room < 0 ? 1 : Math.floor(room / stepPx) + 1;
}

// WHETHER THE 14-DAY BAR CHART IS WORTH DRAWING. A chart of thirteen empty days
// and one bar says nothing a number does not, so it waits for `minDays` days
// that carry data (default 3). Until then the widget says when recording began.
function shouldDrawDays(days, minDays) {
  const min = minDays > 0 ? minDays : 3;
  return (days || []).filter((row) => Number(row.count) > 0).length >= min;
}

// The first day in the window that carries data, or null when none does.
function recordingSince(days) {
  const hit = (days || []).find((row) => Number(row.count) > 0);
  return hit ? hit.day : null;
}

// A PATH LABEL THAT NEVER LOSES ITS FILENAME. Untouched when it fits. Otherwise
// only DIRECTORIES are elided, most expendable first: the middle ones
// (first/…/last/file), then all but the first (first/…/file), then all of them
// (…/file). When even that is too long the filename still wins: truncating
// "README.md" to "READ…" names nothing, so the result may exceed maxChars.
function compactPath(label, maxChars) {
  const s = String(label == null ? '' : label);
  if (s.length <= maxChars) return s;
  const parts = s.split('/');
  const file = parts[parts.length - 1];
  const dirs = parts.slice(0, -1).filter((d) => d !== '' && d !== '\u2026');
  if (dirs.length === 0) return s;
  const tries = [];
  if (dirs.length > 2) tries.push(dirs[0] + '/\u2026/' + dirs[dirs.length - 1] + '/' + file);
  if (dirs.length > 1) tries.push(dirs[0] + '/\u2026/' + file);
  for (const t of tries) if (t.length <= maxChars) return t;
  return '\u2026/' + file;
}
// ---- pure:charts end ----

// ---- vendored:lucide begin ----
// VENDORED — lucide 1.55.0 (ISC), https://lucide.dev. Generated by scripts/vendor-lucide-icons.mjs; do not edit by hand.
// package: lucide
// version: 1.55.0
// license: ISC
// icons: activity, book-open, check, circle-alert, circle-question-mark, folders, gauge, git-branch, inbox, minus, search, terminal, truck
// sha256: 70eabbc629ace96eea360634949ca38270f67a98bdc82b1c65a4f9f05be42173
const LUCIDE_ICONS = {
  "activity": [["path",{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}]],
  "book-open": [["path",{"d":"M12 5v16"}],["path",{"d":"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"}]],
  "check": [["path",{"d":"M20 6 9 17l-5-5"}]],
  "circle-alert": [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],
  "circle-question-mark": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],
  "folders": [["path",{"d":"M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"}],["path",{"d":"M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"}]],
  "gauge": [["path",{"d":"m12 14 4-4"}],["path",{"d":"M3.34 19a10 10 0 1 1 17.32 0"}]],
  "git-branch": [["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],
  "inbox": [["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],
  "minus": [["path",{"d":"M5 12h14"}]],
  "search": [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],
  "terminal": [["path",{"d":"M12 19h8"}],["path",{"d":"m4 17 6-6-6-6"}]],
  "truck": [["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M15 18H9"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]]
};
// ---- vendored:lucide end ----

// Open a control. `run` is the documented shell-out; open-ui.sh starts the
// server if it is not up (or replaces a stale one) and opens the URL the server
// printed, because the per-start token means the URL cannot be constructed, only
// read. It exits 1 with a message on stderr when it will not guess — run()
// rejects with that text and the card shows it, so a dead click says why.
// `route` is always one of this file's literal constants, never payload text.
function openView(route, dispatch) {
  dispatch({ type: 'CLICKED' });
  run('bash "$HOME/Documents/GitHub/propagate/widget/open-ui.sh" \'' + route + '\'')
    .then(() => dispatch({ type: 'RUN_OK' }))
    .catch((e) => dispatch({ type: 'RUN_ERROR', text: 'could not open ' + route + ' — ' + String(e) }));
}

// FORCED REFRESH. refreshFrequency is five minutes; run() resolves with stdout,
// so the same collector the schedule uses can be driven by hand.
function forceRefresh(dispatch) {
  // A click that reached this handler IS the evidence interaction works. Without
  // this the ↻ button refreshed the card while "not clicked yet" stayed up — only
  // section clicks (openView) cleared it (2026-10-15, found from a screenshot).
  dispatch({ type: 'CLICKED' });
  dispatch({ type: 'BUSY' });
  run('bash "$HOME/Documents/GitHub/propagate/widget/collect.sh"')
    .then((out) => dispatch({ type: 'REFRESHED', output: out }))
    .catch((e) => dispatch({ type: 'RUN_ERROR', text: 'refresh failed — ' + String(e) }));
}

// Drag via WINDOW listeners attached on mousedown and removed on mouseup, not
// React handlers on the card: the pointer routinely leaves the card mid-drag,
// and a card-scoped mousemove stops firing the moment it does.
function beginDrag(e, pos, dispatch) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const from = { left: pos.left, top: pos.top };
  dispatch({ type: 'DRAG_START' });

  const onMove = (ev) => {
    dispatch({
      type: 'DRAG_MOVE',
      // Clamped so the card cannot be dragged off-screen and stranded. There is
      // no window manager on this layer to recover it, and the only other way
      // back would be clearing localStorage by hand.
      pos: {
        left: Math.max(0, Math.min(window.innerWidth - 60, from.left + (ev.clientX - startX))),
        top: Math.max(0, Math.min(window.innerHeight - 40, from.top + (ev.clientY - startY))),
      },
    });
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    dispatch({ type: 'DRAG_END' });
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ── components ─────────────────────────────────────────────────────────────
// Flat components. claude-usage.jsx records "Can't find variable: React" as the
// failure mode when a helper nests JSX in a way the transform cannot resolve;
// every element below is a plain host element or one of these named functions.
//
// The payload sections keep ONE alias each, everywhere: wl worklist, lev
// leverage, vel velocity, use usage, hr headroom, hl health, plus rt (a leverage
// root), sec (a health section) and cmd (a top command). tests/unit/widget-
// contract.test.mjs reads `<alias>.<field>` off this file and asserts the real
// payload has it, so an alias must never name anything else.

const STATUS = {
  ok: { icon: 'check' },
  fail: { icon: 'circle-alert' },
  'accepted-only': { icon: 'minus' },
  unknown: { icon: 'circle-question-mark' },
};

const STATE_LABEL = { DRIFTED: 'drifted', REVERSED: 'reversed', DIVERGED: 'both sides', UNMATCHED: 'unmatched', other: 'other' };

// Icons are vendored node data (above), rendered as inline SVG. A name that is
// not in the block renders a visible "?" instead of nothing — an icon that
// silently vanishes on a desktop with no console is the failure the
// widget-icons test exists for.
const Icon = ({ icon, size }) => {
  const nodes = LUCIDE_ICONS[icon];
  const px = size || 16;
  if (!nodes) return <span className="ic">?</span>;
  return (
    <svg className="ic" width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {nodes.map((n, i) => html(n[0], Object.assign({ key: i }, n[1])))}
    </svg>
  );
};

const CantTell = ({ why }) => (
  <div className="why"><Icon icon="circle-question-mark" size={14} /><span>can&#8217;t tell &#8212; {why}</span></div>
);

const HealthPanel = ({ hl, dispatch }) => {
  const why = hl && hl.ok === false ? (hl.reason || 'no doctor snapshot') : (hl ? null : 'missing from the payload');
  const parts = why ? null : healthPills(hl.sections);
  return (
    <div className="pn act" onClick={() => openView('/health', dispatch)}>
      {why ? <div className="ph"><span className="st">Health</span></div> : null}
      {why ? <CantTell why={why} /> : (
        <div className="hgrid">
          {parts.pills.map((p) => (
            <div key={p.label} className={`pill ${p.status}`}>
              <span className="pt">
                <Icon icon={p.icon} size={16} />
                <span className="ps">
                  <Icon icon={STATUS[p.status].icon} size={14} />
                  {p.status === 'fail' ? <span>{p.fail} fail</span> : null}
                  {p.status === 'accepted-only' ? <span>{p.accepted} ok&#8217;d</span> : null}
                </span>
              </span>
              <span className="pl">{p.label}</span>
            </div>
          ))}
        </div>
      )}
      {why ? null : parts.pills.filter((p) => p.status === 'unknown').map((p) => (
        <div key={p.label} className="hnote"><Icon icon="circle-question-mark" size={14} /><span>can&#8217;t tell &#8212; {p.label}: {p.reason}</span></div>
      ))}
      {why ? null : parts.otherFailing.map((k) => (
        <div key={k} className="hnote warn"><Icon icon="circle-alert" size={14} /><span>also failing: {k}</span></div>
      ))}
    </div>
  );
};

const DONUT = 112;

const Donut = ({ wl }) => {
  const dn = donutArcs(wl.byState);
  return (
    <svg width={DONUT} height={DONUT} viewBox={`0 0 ${DONUT} ${DONUT}`}>
      <circle className="track" cx={DONUT / 2} cy={DONUT / 2} r={DONUT / 2 - 12} />
      {dn.arcs.map((a) => <path key={a.key} className={`arc ${a.key}`} d={arcPath(DONUT / 2, DONUT / 2, DONUT / 2 - 12, a.startDeg, a.sweepDeg)} />)}
      <text className="tn" x={DONUT / 2} y={DONUT / 2 + 3} textAnchor="middle">{dn.total}</text>
      <text className="t" x={DONUT / 2} y={DONUT / 2 + 19} textAnchor="middle">queued</text>
    </svg>
  );
};

// THE WORKLIST ROW'S WIDTH BUDGET, stated rather than measured (className is
// static, there is no resize event, and the card is as wide as its widest child
// so it cannot be asked). The card's content width is CARD_INNER = 618px (a 640px
// panel less its 11px padding twice, and .stack in the stylesheet is 640px); the
// donut takes 112, the legend 128 and two 11px gaps, which leaves CAL_W = 356px
// for the calendar, and calendarWeeks(356, 16, 15, 13) is 22 weeks. Change one number and the others
// follow; nothing here is a fixed card width.
const CARD_INNER = 618;
const CAL_W = CARD_INNER - DONUT - 128 - 22;
const CAL_LABEL = 16;
const CAL_STEP = 15;
const CAL_CELL = 13;
const CAL_WEEKS = calendarWeeks(CAL_W, CAL_LABEL, CAL_STEP, CAL_CELL);

const Calendar = ({ cal }) => {
  const L = CAL_LABEL;
  const T = 14;
  const STEP = CAL_STEP;
  const W = L + (cal.cols.length - 1) * STEP + CAL_CELL;
  const H = T + 7 * STEP;
  const ROWS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {cal.months.map((m) => <text key={m.label + m.col} className="t" x={L + m.col * STEP} y="11">{m.label}</text>)}
      {ROWS.map((r, i) => <text key={i} className="t" x="0" y={T + i * STEP + 11}>{r}</text>)}
      {cal.cols.map((col) => col.filter((c) => !c.future).map((c) => (
        <rect
          key={c.iso}
          className={`cc l${c.level}${c.today ? ' today' : ''}`}
          x={L + c.col * STEP}
          y={T + c.row * STEP}
          width={CAL_CELL}
          height={CAL_CELL}
          rx="3"
        />
      )))}
    </svg>
  );
};

const WorklistPanel = ({ wl, today, dispatch }) => {
  if (!wl) {
    return <div className="pn"><div className="ph"><Icon icon="inbox" size={16} /><span className="st">Worklist</span></div><CantTell why="missing from the payload" /></div>;
  }
  const keys = ['DRIFTED', 'REVERSED', 'DIVERGED', 'UNMATCHED'].concat(wl.byState.other > 0 ? ['other'] : []);
  const cal = calendarCells(wl.calendar, today, CAL_WEEKS);
  return (
    <div className="pn act" onClick={() => openView('/judge', dispatch)}>
      <div className="ph">
        <Icon icon="inbox" size={16} />
        <span className="st">Worklist</span>
        {wl.toJudge == null
          ? <span className="sb">&#8212; can&#8217;t tell how many to judge: {wl.toJudgeReason}</span>
          : <span className="sb">&#8212; {wl.toJudge} to judge</span>}
        {cal.error ? null : (
          <span className="sp">
            last checked {shortDate(cal.firstISO)} &#8211; {shortDate(cal.lastISO)} &#183; {wl.never} never
            {cal.outside > 0 ? ` · ${cal.outside} older` : ''}
            {cal.max > 0 ? ` · busiest day ${cal.max}` : ''}
          </span>
        )}
      </div>
      <div className="wl">
        <Donut wl={wl} />
        <div className="lg">
          {keys.map((k) => (
            <div key={k} className="lgr"><span className={`sw ${k}`} /><span>{STATE_LABEL[k]}</span><span className="n">{wl.byState[k]}</span></div>
          ))}
        </div>
        {cal.error ? <CantTell why={cal.error} /> : <Calendar cal={cal} />}
      </div>
    </div>
  );
};

// A root label is "<file> -> <file>" with directories elided by compactPath, never
// the filenames. 22 characters per side is what the full-width row can carry next
// to the meter and the numbers.
const ROOT_PATH_CHARS = 22;

const LeveragePanel = ({ lev, dispatch }) => {
  const head = (
    <div className="ph">
      <Icon icon="git-branch" size={16} />
      <span className="st">Leverage</span>
      {lev ? <span className="sp">top {lev.roots.length} of {lev.rootsTotal} roots</span> : null}
    </div>
  );
  if (!lev) return <div className="pn">{head}<CantTell why="missing from the payload" /></div>;
  const ups = barHeights(lev.roots.map((rt) => rt.upstreamOf), 56);
  return (
    <div className="pn act" onClick={() => openView('/unblock', dispatch)}>
      {head}
      <div className="lvh">
        <span className="big">{lev.blocked} blocked &#183; {lev.needAllRoots} need several roots</span>
        <span className="sb">
          {lev.bottleneck
            ? `bottleneck: ${baseName(lev.bottleneck.file)} · holds back ${lev.bottleneck.blockedEdges}`
            : `no single bottleneck — ${lev.bottleneckReason}`}
        </span>
      </div>
      <div className="lv" style={{ marginTop: 6 }}>
        {lev.roots.map((rt, i) => (
          <div key={rt.edge_id} className="rt">
            <span className="rn">{compactPath(rt.source, ROOT_PATH_CHARS)} &#8594; {compactPath(rt.downstream, ROOT_PATH_CHARS)}</span>
            <span className="mt" style={{ width: 56 }}><span className="mf" style={{ display: 'block', width: ups[i] }} /></span>
            <span className="nums">frees <b>{rt.freesNow}</b> now &#183; upstream of <b>{rt.upstreamOf}</b>{rt.inQueue ? '' : ' · not in queue'}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const VelocityPanel = ({ vel, dispatch }) => {
  const why = whyNot(vel);
  const head = (
    <div className="ph">
      <Icon icon="activity" size={16} />
      <span className="st">Velocity</span>
      {why ? <span className="sb">&#8212; judgements per day</span> : [
        <span key="l" className="keys"><span><span className="sw chgd" />changed</span><span><span className="sw nochg" />no change needed</span></span>,
        <span key="f" className="sp">
          {vel.noChangeShareOfEvents == null ? 'no events in the window' : `${Math.round(vel.noChangeShareOfEvents * 100)}% no-change (${vel.events} events)`}
        </span>,
      ]}
    </div>
  );
  if (why) return <div className="pn">{head}<CantTell why={why} /></div>;
  const STEP = 19;
  const BASE = 54;
  const bars = stackBars(vel.days, 52);
  const ticks = dayTicks(vel.days);
  const W = vel.days.length * STEP;
  return (
    <div className="pn act" onClick={() => openView('/activity', dispatch)}>
      {head}
      <svg width={W} height={BASE + 28} viewBox={`0 0 ${W} ${BASE + 28}`}>
        {bars.map((b, i) => (
          <g key={b.day}>
            {b.h === 0 ? <rect className="bz" x={i * STEP} y={BASE - 2} width="14" height="2" /> : null}
            {b.noChangePx > 0 ? <rect className="bn" x={i * STEP} y={BASE - b.noChangePx} width="14" height={b.noChangePx} /> : null}
            {b.changedPx > 0 ? <rect className="bc" x={i * STEP} y={BASE - b.h} width="14" height={b.changedPx} /> : null}
            <text className="t" x={i * STEP + 7} y={BASE + 13} textAnchor="middle">{ticks[i].label}</text>
            {ticks[i].month ? <text className="t" x={i === 0 ? 0 : i * STEP + 7} y={BASE + 26} textAnchor={i === 0 ? "start" : "middle"}>{ticks[i].month}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
};

const CommandsPanel = ({ use, dispatch }) => {
  const why = whyNot(use);
  // Fewer than three days with data: a chart of mostly-empty bars says nothing a
  // number does not, so say when recording began instead (shouldDrawDays).
  const draw = !why && shouldDrawDays(use.days, 3);
  const since = why ? null : recordingSince(use.days);
  const head = (
    <div className="ph">
      <Icon icon="terminal" size={16} />
      <span className="st">Commands</span>
      {draw
        ? <span className="sb">&#8212; last {use.windowDays} days</span>
        : (since ? <span className="sb">&#8212; recording since {shortDate(since)}</span> : null)}
    </div>
  );
  if (why) return <div className="pn">{head}<CantTell why={why} /></div>;
  const STEP = 20;
  const BASE = 52;
  const hs = barHeights(use.days.map((day) => day.count), 48);
  const ticks = dayTicks(use.days);
  const W = use.days.length * STEP;
  const widths = barHeights(use.top.map((cmd) => cmd.count), 110);
  return (
    <div className="pn act" onClick={() => openView('/activity', dispatch)}>
      {head}
      <div className="cmd">
        {draw ? (
          <svg width={W} height={BASE + 28} viewBox={`0 0 ${W} ${BASE + 28}`}>
            {hs.map((h, i) => (
              <g key={use.days[i].day}>
                {h === 0 ? <rect className="bz" x={i * STEP} y={BASE - 2} width="14" height="2" /> : <rect className="bu" x={i * STEP} y={BASE - h} width="14" height={h} />}
                <text className="t" x={i * STEP + 7} y={BASE + 13} textAnchor="middle">{ticks[i].label}</text>
                {ticks[i].month ? <text className="t" x={i === 0 ? 0 : i * STEP + 7} y={BASE + 26} textAnchor={i === 0 ? "start" : "middle"}>{ticks[i].month}</text> : null}
              </g>
            ))}
          </svg>
        ) : null}
        <div className="tc">
          <div className="tot">
            <span><b>{use.total}</b> {use.origin || 'interactive'} runs</span>
            {use.failures > 0
              ? <span className="warn"><Icon icon="circle-alert" size={12} />{use.failures} failed</span>
              : <span>0 failed</span>}
            {use.refusals > 0 ? <span>{use.refusals} refused</span> : null}
          </div>
          {use.top.map((cmd, i) => (
            <div key={cmd.command} className="tcr">
              <span className="nm">{cmd.command}</span>
              <span className="mt" style={{ width: 110 }}><span className="mf" style={{ display: 'block', width: widths[i] }} /></span>
              <span className="n">{cmd.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// HEADROOM. Only when thin — or when it cannot be told, because a missing
// number must not read as a roomy budget. Inline in the footer row; no CTA (the
// UI has no view for it), so the line names the command to run instead.
const HeadroomLine = ({ hr }) => {
  const why = whyNot(hr);
  if (why) return <span className="why"><Icon icon="circle-question-mark" size={14} /><span>can&#8217;t tell &#8212; instruction headroom: {why}</span></span>;
  if (!hr.thin) return null;
  return (
    <span className="hr">
      <Icon icon="gauge" size={14} />
      <span>{baseName(hr.directory)}: {hr.headroom >= 0 ? `${hr.headroom} chars of instruction budget left` : `${-hr.headroom} chars OVER the instruction budget`}</span>
    </span>
  );
};

export const render = (state, dispatch) => {
  const { output, error, pos, dragging, moved, interactive, busy, note } = state;
  const at = pos || DEFAULT_POS;

  const card = (head, body) => (
    <div className={dragging ? "shell dragging" : "shell"} style={{ left: at.left, top: at.top }}>
      <div className="core">
        <div
          className="hd"
          onMouseDown={(e) => {
            // The pill is a click target, not a handle.
            if (e.target.closest && e.target.closest('.chg')) return;
            beginDrag(e, at, dispatch);
          }}
          onDoubleClick={() => dispatch({ type: "RESET_POS" })}
        >
          {head}
        </div>
        {body}
      </div>
    </div>
  );

  const bareHead = <span className="ttl">propagate</span>;

  if (error) return card(bareHead, <div className="err"><Icon icon="circle-alert" size={14} /><span>{String(error)}</span></div>);

  let d;
  try {
    d = JSON.parse(output);
  } catch (e) {
    // Rendering nothing here would be indistinguishable from a clean tree.
    return card(bareHead, <div className="err"><Icon icon="circle-alert" size={14} /><span>collect.sh — unreadable output</span></div>);
  }

  // collect.sh and `surface --json` both emit {"error": ...} rather than
  // nothing, precisely so this branch can name the reason on the desktop.
  if (d.error) {
    return card(bareHead, <div className="err"><Icon icon="circle-alert" size={14} /><span>{d.error}</span></div>);
  }

  // "WHAT CHANGED SINCE I LAST LOOKED" — ONE number, never a table (see
  // surface.mjs's buildChangedSummary). The same absent-field fallback shape as
  // every section below: an older collect.sh that predates a field must not
  // throw reading it.
  const ch = d.changed || { value: null, label: '', tone: 'unknown' };

  // DECISION 1 — GATE THE CLICKS, NOT THE CARD. An earlier draft hid the whole
  // widget behind a setup card until interaction was configured. Drawing it
  // showed that the gate ALSO hides the stale-snapshot warning and the failing
  // check, which are the two things most worth seeing. The card always renders;
  // clicks are simply inert, and one dim line says why.
  const gate = interactive || moved
    ? null
    : (
      <div className="gate">
        <b>not clicked yet</b> — clicks need Übersicht allowed in System Settings
        &#8250; Privacy &amp; Security &#8250; <b>Accessibility</b>, and work only where no
        app window covers the card. This line goes after the first click lands.
      </div>
    );

  const snap = d.snapshot || {};
  const wl = d.worklist;
  const lev = d.leverage;
  const vel = d.velocity;
  const use = d.usage;
  const hr = d.headroom;
  const hl = d.health;
  const today = localISO(new Date());

  // FRESHNESS, TWO CLOCKS. "updated" is when THIS payload was collected: it
  // should refresh every 5 minutes, so past 15 it is amber and says why. "doctor"
  // is the cached health snapshot, which the monitor writes on a 30-minute tick,
  // so it is amber only past an hour.
  const payloadAge = d.generatedAt ? Date.now() - Date.parse(d.generatedAt) : null;
  const payloadStale = payloadAge == null || payloadAge > 900000;
  const doctorStale = snap.ok && snap.ageMs != null && snap.ageMs > 3600000;

  return card(
    ch.value != null
      ? [
        <span key="t" className="ttl">propagate</span>,
        <span key="c" className={`chg ${ch.tone}`} onClick={() => openView('/activity', dispatch)}>{ch.value} new</span>,
      ]
      : [
        <span key="t" className="ttl">propagate</span>,
        <span key="c" className="chg unknown">changes: can&#8217;t tell</span>,
      ],
    <div className="stack">
      <HealthPanel hl={hl} dispatch={dispatch} />
      <WorklistPanel wl={wl} today={today} dispatch={dispatch} />
      <LeveragePanel lev={lev} dispatch={dispatch} />
      <div className="row2">
        <VelocityPanel vel={vel} dispatch={dispatch} />
        <CommandsPanel use={use} dispatch={dispatch} />
      </div>
      {note ? <div className="err"><Icon icon="circle-alert" size={14} /><span>{note}</span></div> : null}
      <div className="foot">
        <span className="rf" onClick={() => forceRefresh(dispatch)}>{busy ? "…" : "↻"}</span>
        <HeadroomLine hr={hr} />
        <span className="sp">
          <span className={payloadStale ? "stale" : ""}>
            {payloadStale ? <Icon icon="circle-alert" size={12} /> : null}
            updated {agoText(payloadAge)}
          </span>
          <span className={doctorStale ? "stale" : ""}>
            {doctorStale ? <Icon icon="circle-alert" size={12} /> : null}
            {snap.ok ? `doctor ${agoText(snap.ageMs)}` : `doctor: can't tell — ${snap.reason || 'no snapshot'}`}
          </span>
        </span>
      </div>
      {gate}
    </div>,
  );
};
