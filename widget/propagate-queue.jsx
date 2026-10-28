// propagate — the whole propagation picture on the desktop layer, draggable.
//
// WHAT THIS IS NOW (rewritten 2026-10-28, QUEUE FIRST; the 2026-10-15 "variant A"
// card it replaces had ~60 numbers, ~110 calendar cells and ~40 bars, and the one
// answer a person opens it for was 12px dim subtext). The review and its findings
// F1-F13: /Users/rupali.b/.claude/plans/crispy-imagining-lemon.md, saved in the
// workspace as UX-REVIEW-2026-10-28-widget.md. Top to bottom:
//   header      the title and a "N changed since <day>" pill
//   QUEUE       "92 to judge now" as the largest element, "of 162 in queue", ONE
//               segmented bar split by what a person can DO (judge / pick a side /
//               blocked), the age of the queue in words, and small edge-state chips
//   KEEPING UP  "nothing judged in N days" (amber, with an icon) or "N judged in 14
//               days", plus a compact sparkline of verdicts per day
//   START HERE  the top roots to settle, in plain words ("settling it frees N blocked")
//   HEALTH      one line: failing sections named and deep-linked, "health ok" otherwise
//   footer      refresh, headroom when thin, the two freshness clocks, the click gate
// Deleted on purpose: Commands (propagate measuring itself; "556 failed" read as an
// alarm about the user's work; it stays in /activity), the contribution calendar, the
// edge-state donut and the cascade bar. Hover detail is formatting only (tipLines).
//
// EVERY NUMBER COMES FROM `propagate surface --json`; THE WIDGET DRAWS, IT
// DOES NOT DERIVE (N86). The one thing it computes is GEOMETRY — the queue
// bar's percentages, sparkline bar heights — because the payload
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
// queue /judge, /unblock, velocity /activity, health
// /health, the pill /judge (routes renamed 2026-10-15, plan F11) — through widget/open-ui.sh.
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
// No fact lives in a tooltip or a hover state; everything that matters is inline. Hover is
// AFFORDANCE only (2026-10-15): a foreground widget's window tracks the mouse, so `:hover` does
// fire there, and every clickable item now says so. It never changes what the card states.
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
  if (event.type === 'TIP') return { ...prev, tip: event.tip };
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
  --tip-bg: rgba(255, 255, 255, 0.97);

  /* THE WHEEL, the SAME wheel cli/ui/css and lib/graph/graph-html.mjs use,
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
    --tip-bg: rgba(44, 44, 46, 0.97);

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

  /* PANELS. One quiet container per section; 11px inside and between. */
  .pn { border: .5px solid var(--hair); border-radius: 12px; padding: 11px; background: rgba(127,127,127,.05); }
  /* 440px is the stack's layout width: the queue bar's segments are percentages of it, so it
     must be a definite width. The shell stays width: max-content (G9). */
  .stack { display: flex; flex-direction: column; gap: 11px; width: 440px; }
  .act { cursor: pointer; }
  .ph { display: flex; align-items: center; flex-wrap: wrap; gap: 3px var(--s2); margin-bottom: 4px; }
  .st { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .sb { color: var(--dim); }
  .sp { margin-left: auto; color: var(--dim); white-space: nowrap; }
  .why { display: flex; align-items: center; gap: var(--s2); color: var(--dim); }
  .ic { flex: 0 0 auto; display: block; }

  /* QUEUE. The hero number is the largest thing on the card. The bar is split by what a
     person can DO; every segment has a text key with its count under it, so colour is
     never alone. */
  .hero { display: flex; align-items: baseline; gap: var(--s3); }
  .hero .big { font-size: 28px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .hero .of { margin-left: auto; color: var(--dim); white-space: nowrap; }
  .qbar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--track); margin-top: var(--s3); }
  .qs { display: block; height: 100%; }
  .qs.judge { background: var(--st-accent); }
  .qs.decide { background: var(--edge-diverge); }
  .qs.blocked { background: var(--dimmer); }
  .qkeys { display: flex; flex-wrap: wrap; gap: 3px 11px; margin-top: var(--s2); }
  .qk { display: flex; align-items: center; gap: var(--s2); white-space: nowrap; }
  .qk b { font-variant-numeric: tabular-nums; }
  .sw { width: 10px; height: 10px; border-radius: 5px; background: var(--dim); flex: 0 0 auto; }
  .sw.judge { background: var(--st-accent); }
  .sw.decide { background: var(--edge-diverge); }
  .sw.blocked { background: var(--dimmer); }
  .sw.DRIFTED { background: var(--edge-drift); }
  .sw.REVERSED { background: var(--edge-reverse); }
  .sw.DIVERGED { background: var(--edge-diverge); }
  .sw.UNMATCHED { background: var(--dim); }
  .sw.other { background: var(--dimmer); }
  .ages { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 11px; margin-top: var(--s3); color: var(--dim); }
  .ages b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ages .old { color: var(--st-caution); display: flex; align-items: center; gap: var(--s1); }
  .ages .old b { color: var(--st-caution); }
  .chips { display: flex; flex-wrap: wrap; gap: 3px 11px; margin-top: var(--s2); color: var(--dim); }
  .chip { display: flex; align-items: center; gap: var(--s1); white-space: nowrap; }
  .chip b { font-variant-numeric: tabular-nums; }

  /* KEEPING UP. One line and a sparkline: idle days are amber WITH an icon and words. */
  .keep { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
  .keep .idle { color: var(--st-caution); display: flex; align-items: center; gap: var(--s2); font-weight: 600; }
  .keep .spark { margin-left: auto; }
  .bc { fill: var(--st-ok); }
  .bz { fill: var(--dimmer); }

  /* START HERE. A root's number is labelled in words: "settling it frees N blocked". */
  .lv { display: flex; flex-direction: column; gap: var(--s2); }
  .rt { display: flex; align-items: center; gap: 11px; }
  /* min-width:0 lets the path column shrink; without it a long dir line pushed .nums past the card edge (seen 2026-10-28) */
  .rn { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; white-space: nowrap; }
  .rn > span { overflow: hidden; text-overflow: ellipsis; }
  .rdir { color: var(--dim); font-size: 11px; }
  .nums { flex: none; color: var(--dim); white-space: nowrap; text-align: right; }
  .nums b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }

  /* HEALTH, one line. Failing sections are named (icon + words + count, amber-red), accepted-only
     reds are counted and grey, unknown ones are named as "can't tell". */
  .hl { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 11px; color: var(--dim); }
  .hl .bad { color: var(--st-warn); display: flex; align-items: center; gap: var(--s1); font-weight: 600; white-space: nowrap; }
  .hl .cant { display: flex; align-items: center; gap: var(--s1); white-space: nowrap; }
  .hl .okl { color: var(--st-ok); display: flex; align-items: center; gap: var(--s1); }

  /* HOVER IS AFFORDANCE, NEVER INFORMATION (2026-10-15). Every fact stays inline; hover only says
     "this is clickable". Possible since the foreground window tracks the mouse (Übersicht 1.6
     detectWidgetHover.js). widget-contract.test.mjs allows only these properties under :hover. */
  .pn.act, .hv { cursor: pointer; }
  .hv { border-radius: 6px; }
  .pn.act:hover { box-shadow: inset 0 0 0 1px var(--track); }
  .hv:hover { background-color: var(--track); }
  .qs.hv:hover { opacity: .75; }
  /* Shapes are targets too: opacity says "this one". A transparent .hit rect makes an EMPTY day hoverable. */
  .vz { cursor: pointer; }
  .vz:hover { opacity: .7; }
  .hit { fill: none; pointer-events: all; }
  /* THE TOOLTIP. Fixed to the Übersicht window (clientX/Y are window coordinates), above the card,
     never catching the mouse itself so it cannot flicker under the pointer. */
  .tip { position: fixed; z-index: 10; pointer-events: none; background: var(--tip-bg); color: var(--fg);
         border-radius: 8px; padding: 7px 10px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18); font-size: 12px; line-height: 1.45; white-space: nowrap; }
  .tip .tt { font-weight: 600; }
  .tip .tl { color: var(--dim); }

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

// 'YYYY-MM-DD' -> UTC midnight in ms, or null. UTC arithmetic on purpose: the
// payload's days are already LOCAL days (surface.mjs localDay), so this only
// needs a calendar, and UTC has no DST hour to fall into.
function isoToUtc(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
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

// BAR HEIGHTS. Scaled to the largest value; 0 stays 0 (the caller draws a
// baseline tick for it, so zero is visible rather than missing); any positive
// value is at least 1px so a small day never vanishes.
function barHeights(values, maxPx) {
  const vs = (values || []).map((v) => (Number(v) > 0 ? Number(v) : 0));
  const max = Math.max(0, ...vs);
  if (max === 0) return vs.map(() => 0);
  return vs.map((v) => (v === 0 ? 0 : Math.max(1, Math.round((v / max) * maxPx))));
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
      return { label: def.label, icon: def.icon, section: def.prefix || def.names[0], status: 'unknown', fail: 0, accepted: 0, count: 0, reason: 'no such section in the doctor snapshot' };
    }
    let status = 'unknown';
    for (const s of mine) if ((STATUS_RANK[s.status] || 0) > STATUS_RANK[status]) status = s.status;
    return {
      label: def.label,
      icon: def.icon,
      section: def.prefix || def.names[0],
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

// LARGEST-REMAINDER ROUNDING to 0.1: percentages that sum to EXACTLY 100, so a bar never over- or
// under-fills its track. All zeros in, all zeros out (no division by zero).
function apportion(ns) {
  const total = ns.reduce((t, n) => t + n, 0);
  if (!(total > 0)) return ns.map(() => 0);
  const tenths = ns.map((n) => (n / total) * 1000);
  const floors = tenths.map(Math.floor);
  let left = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = tenths.map((t, i) => [t - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) floors[order[k][1]] += 1;
  return floors.map((f) => f / 10);
}

// THE QUEUE BAR (2026-10-28): the whole queue split by what a person can DO, in the payload's own
// counts (worklist.toJudge / decide / blocked, which sum to total). A zero part is OMITTED, never a
// zero-width sliver. Any null part means the fix-order join is missing and the split is UNKNOWN, so
// the answer is [] and the caller says "can't tell": a partial bar would be a bar that lies.
// The widget derives no number here; only the geometry (pct) is computed.
function queueParts(wl) {
  if (!wl) return [];
  const raw = [
    { key: 'judge', label: 'to judge', n: wl.toJudge },
    { key: 'decide', label: 'pick a side', n: wl.decide },
    { key: 'blocked', label: 'blocked', n: wl.blocked },
  ];
  if (raw.some((p) => p.n == null || !(Number(p.n) >= 0))) return [];
  const parts = raw.filter((p) => Number(p.n) > 0);
  const pcts = apportion(parts.map((p) => Number(p.n)));
  return parts.map((p, i) => ({ key: p.key, label: p.label, n: Number(p.n), pct: pcts[i] }));
}

// THE HEALTH LINE (2026-10-28): the eight pills reduced to what a person needs. Failing pills are
// NAMED; unknown ones are named as "can't tell"; accepted-only reds are only counted. A failing
// section no pill covers rides along in otherFailing, so nothing hides behind the fixed set.
function healthSummary(sections) {
  const h = healthPills(sections);
  return {
    failing: h.pills.filter((p) => p.status === 'fail'),
    unknown: h.pills.filter((p) => p.status === 'unknown'),
    accepted: h.pills.filter((p) => p.status === 'accepted-only').length,
    otherFailing: h.otherFailing,
  };
}

// "Oct 21" for the changed pill's window start, in the reader's LOCAL day, or null when the payload
// carries no usable timestamp. Null means "say 'in the stream'"; a time is never invented.
function sinceText(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const when = new Date(iso);
  return isNaN(when.getTime()) ? null : shortDate(localISO(when));
}

// Where a root row's click goes. A root that is in the queue opens Judge on that edge; anything
// else opens Unblock. The id is interpolated into a single-quoted shell argument by openView, so
// only [0-9a-z] ids are allowed through; anything else falls back to /unblock.
function rootRoute(root) {
  const id = String((root && root.edge_id) || '');
  return root && root.inQueue && /^[0-9a-z]+$/.test(id) ? '/judge?edge=' + id : '/unblock';
}
// A CLICK TARGET FOR EVERY ITEM (2026-10-15, "give me cta for everything"). Deep links ride in
// the hash (`/health?section=Delivery`, `/judge?state=DRIFTED`), and openView puts the route in a
// SINGLE-QUOTED shell argument, so this is the one builder every route goes through: only the
// views the page routes, and only [A-Za-z0-9 _:-] parameter values, URL-encoded. Anything else
// is dropped, so the worst case is a click that opens the right view unfiltered.
const VIEWS = ['/judge', '/unblock', '/health', '/activity', '/registers', '/reminders', '/graph'];
function viewRoute(path, params) {
  const base = VIEWS.indexOf(path) >= 0 ? path : '/judge';
  const q = Object.keys(params || {})
    .filter((k) => /^[a-z]+$/.test(k) && /^[A-Za-z0-9 _:-]+$/.test(String(params[k] == null ? '' : params[k])))
    .map((k) => k + '=' + encodeURIComponent(String(params[k])));
  return q.length ? base + '?' + q.join('&') : base;
}
// HOVER DETAIL (2026-10-15, "hover should show labels or info which we already have, formatted").
// Every tooltip is built HERE from values the card already holds, so hover adds formatting, never a
// new fact: nothing lives only in a tooltip, and the card still reads with no mouse at all.
// Returns { title, lines } or null; the widget renders it and adds nothing.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAYS[dt.getUTCDay()] + ' ' + Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1];
}
function pctOf(n, total) {
  return total > 0 ? Math.round((n / total) * 100) + '%' : null;
}
function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}
function tipLines(kind, v) {
  if (!v) return null;
  if (kind === 'state') {
    const p = pctOf(v.n, v.total);
    return { title: v.label, lines: [plural(v.n, 'edge'), p ? p + ' of ' + v.total + ' queued' : null, 'click to judge these'].filter(Boolean) };
  }
  if (kind === 'queue') {
    const p = pctOf(v.n, v.total);
    return { title: v.label, lines: [plural(v.n, 'edge'), p ? p + ' of ' + v.total + ' in the queue' : null, v.hint].filter(Boolean) };
  }
  if (kind === 'verdicts') {
    if (!(v.total > 0)) return { title: fmtDay(v.day), lines: ['no verdicts recorded'] };
    return { title: fmtDay(v.day), lines: [plural(v.total, 'verdict'), v.changed + ' changed · ' + v.noChange + ' no change needed'] };
  }
  if (kind === 'pill') {
    const s = v.status === 'fail' ? plural(v.fail, 'failing check') : v.status === 'accepted-only' ? plural(v.accepted, 'accepted red') : v.status === 'ok' ? 'all checks pass' : "can't tell";
    return { title: v.label, lines: [s, v.count > 1 ? 'across ' + v.count + ' sections' : null, 'click to open this section'].filter(Boolean) };
  }
  return null;
}
// ---- pure:charts end ----

// ---- vendored:lucide begin ----
// VENDORED — lucide 1.55.0 (ISC), https://lucide.dev. Generated by scripts/vendor-lucide-icons.mjs; do not edit by hand.
// package: lucide
// version: 1.55.0
// license: ISC
// icons: activity, book-open, check, circle-alert, circle-question-mark, folders, gauge, git-branch, hourglass, inbox, search, truck
// sha256: 379ac49492ea92f29aaa42f2ab1cf851b47fba3725f4a76b73a121a4b0670a9e
const LUCIDE_ICONS = {
  "activity": [["path",{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}]],
  "book-open": [["path",{"d":"M12 5v16"}],["path",{"d":"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"}]],
  "check": [["path",{"d":"M20 6 9 17l-5-5"}]],
  "circle-alert": [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],
  "circle-question-mark": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],
  "folders": [["path",{"d":"M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"}],["path",{"d":"M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"}]],
  "gauge": [["path",{"d":"m12 14 4-4"}],["path",{"d":"M3.34 19a10 10 0 1 1 17.32 0"}]],
  "git-branch": [["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]],
  "hourglass": [["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]],
  "inbox": [["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],
  "search": [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],
  "truck": [["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M15 18H9"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]]
};
// ---- vendored:lucide end ----

// Open a control. `run` is the documented shell-out; open-ui.sh starts the
// server if it is not up (or replaces a stale one) and opens the URL the server
// printed, because the per-start token means the URL cannot be constructed, only
// read. It exits 1 with a message on stderr when it will not guess — run()
// rejects with that text and the card shows it, so a dead click says why.
// `route` is always one of this file's literal constants, never payload text.
// HOVER: the one way a shape shows its tooltip. Content always comes from tipLines (pure, tested).
const tipOn = (dispatch, tip) => (e) => { if (tip) dispatch({ type: 'TIP', tip: { title: tip.title, lines: tip.lines, x: e.clientX, y: e.clientY } }); };
const tipOff = (dispatch) => () => dispatch({ type: 'TIP', tip: null });

// Worklist state -> where it is judged. One mapping for the legend row AND its donut arc.
const stateRoute = (k) => (k === 'DIVERGED' ? viewRoute('/judge', { chip: 'both' }) : k === 'other' ? '/judge' : viewRoute('/judge', { state: k }));

// An item inside a clickable panel: its own target, not the panel's.
const go = (route, dispatch) => (e) => { if (e && e.stopPropagation) e.stopPropagation(); openView(route, dispatch); };

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

// Where each queue part is judged. The "pick a side" part is the DIVERGED chip of Judge.
const QUEUE_ROUTE = { judge: '/judge', decide: viewRoute('/judge', { chip: 'both' }), blocked: '/unblock' };
const QUEUE_HINT = { judge: 'click to judge these', decide: 'click to pick a side', blocked: 'click to see what blocks them' };

// ONE PANEL ANSWERS "how much needs me, and where do I start": the hero number, the bar split by what
// can be done, the age of the queue in words, and the edge-state chips. Counts come from the payload.
const QueuePanel = ({ wl, dispatch }) => {
  if (!wl) {
    return <div className="pn"><div className="ph"><Icon icon="inbox" size={16} /><span className="st">Queue</span></div><CantTell why="missing from the payload" /></div>;
  }
  const parts = queueParts(wl);
  const ages = wl.ages;
  const keys = ['DRIFTED', 'REVERSED', 'DIVERGED', 'UNMATCHED'].concat(wl.byState.other > 0 ? ['other'] : []);
  return (
    <div className="pn act" onClick={() => openView('/judge', dispatch)}>
      <div className="hero">
        {wl.toJudge == null
          ? <CantTell why={'how many to judge: ' + wl.toJudgeReason} />
          : [<span key="n" className="big">{wl.toJudge}</span>, <span key="l">to judge now</span>]}
        <span className="of">of {wl.total} in queue</span>
      </div>
      {parts.length > 0 ? (
        <div className="qbar">
          {parts.map((p) => <span key={p.key} className={'qs hv ' + p.key} style={{ width: p.pct + '%' }} onClick={go(QUEUE_ROUTE[p.key], dispatch)}
            onMouseEnter={tipOn(dispatch, tipLines('queue', { label: p.label, n: p.n, total: wl.total, hint: QUEUE_HINT[p.key] }))} onMouseLeave={tipOff(dispatch)} />)}
        </div>
      ) : null}
      {parts.length > 0 ? (
        <div className="qkeys">
          {parts.map((p) => (
            <span key={p.key} className="qk hv" onClick={go(QUEUE_ROUTE[p.key], dispatch)}
              onMouseEnter={tipOn(dispatch, tipLines('queue', { label: p.label, n: p.n, total: wl.total, hint: QUEUE_HINT[p.key] }))} onMouseLeave={tipOff(dispatch)}>
              <span className={'sw ' + p.key} /><span>{p.label}</span><b>{p.n}</b>
            </span>
          ))}
        </div>
      ) : (wl.total === 0 ? <div className="sb">the queue is empty</div> : <CantTell why="the split by action needs the fix-order join" />)}
      {ages ? (
        <div className="ages">
          <span>waiting</span>
          {ages.today > 0 ? <span>today <b>{ages.today}</b></span> : null}
          <span>&#8804;7d <b>{ages.week}</b></span>
          <span>&#8804;15d <b>{ages.fortnight}</b></span>
          {ages.stale > 0
            ? <span className="old"><Icon icon="hourglass" size={12} />over 15d <b>{ages.stale}</b></span>
            : <span>over 15d <b>0</b></span>}
          <span>never <b>{ages.never}</b></span>
        </div>
      ) : <CantTell why="this collector sends no queue ages (older propagate)" />}
      <div className="chips">
        {keys.map((k) => (
          <span key={k} className="chip hv" onClick={go(stateRoute(k), dispatch)}
            onMouseEnter={tipOn(dispatch, tipLines('state', { label: STATE_LABEL[k], n: wl.byState[k], total: wl.total }))} onMouseLeave={tipOff(dispatch)}>
            <span className={'sw ' + k} />{STATE_LABEL[k]} <b>{wl.byState[k]}</b>
          </span>
        ))}
      </div>
    </div>
  );
};

// KEEPING UP. The most important trend on the card gets a sentence: idleDays is computed in the
// payload, the widget only picks the wording and draws the bars.
const KeepingUpLine = ({ vel, dispatch }) => {
  const why = whyNot(vel);
  if (why) return <div className="pn"><CantTell why={'verdict history: ' + why} /></div>;
  const STEP = 12;
  const BASE = 18;
  const hs = barHeights(vel.days.map((row) => row.total), 16);
  const W = vel.days.length * STEP;
  const idle = vel.idleDays;
  return (
    <div className="pn act keep" onClick={() => openView('/activity', dispatch)}>
      {idle != null && idle >= 2
        ? <span className="idle"><Icon icon="circle-alert" size={14} />nothing judged in {idle} days</span>
        : <span>{vel.events} judged in {vel.windowDays} days</span>}
      <svg className="spark" width={W} height={BASE} viewBox={`0 0 ${W} ${BASE}`}>
        {hs.map((h, i) => (
          <g key={vel.days[i].day} className="vz" onClick={go('/activity', dispatch)}
            onMouseEnter={tipOn(dispatch, tipLines('verdicts', vel.days[i]))} onMouseLeave={tipOff(dispatch)}>
            <rect className="hit" x={i * STEP} y="0" width="9" height={BASE} />
            {h === 0 ? <rect className="bz" x={i * STEP} y={BASE - 2} width="9" height="2" /> : <rect className="bc" x={i * STEP} y={BASE - h} width="9" height={h} />}
          </g>
        ))}
      </svg>
    </div>
  );
};

// START HERE: the roots whose settling frees blocked edges, in plain words. The data is the old
// leverage payload; only the copy changed (F10).
const StartHere = ({ lev, dispatch }) => {
  const head = <div className="ph"><Icon icon="git-branch" size={16} /><span className="st">Start here</span></div>;
  if (!lev) return <div className="pn">{head}<CantTell why="missing from the payload" /></div>;
  const cas = lev.cascade;
  if (!cas) return <div className="pn act" onClick={() => openView('/unblock', dispatch)}>{head}<CantTell why="this collector sends no cascade (older propagate)" /></div>;
  if (cas.blocked === 0) return <div className="pn act" onClick={() => openView('/unblock', dispatch)}>{head}<div className="sb">nothing is blocked</div></div>;
  const rows = lev.roots.filter((rt) => rt.freesNow > 0);
  return (
    <div className="pn act" onClick={() => openView('/unblock', dispatch)}>
      {head}
      <div className="lv">
        {rows.length === 0 ? <div className="sb">no single edge frees a blocked one on its own</div> : null}
        {rows.map((rt) => {
          const sp = rt.sourceParts || { name: baseName(rt.source), dir: '' };
          const dp = rt.downstreamParts || { name: baseName(rt.downstream), dir: '' };
          return (
            <div key={rt.edge_id} className="rt hv" onClick={go(rootRoute(rt), dispatch)}>
              <span className="rn" title={`${rt.source} → ${rt.downstream}`}>
                <span>{sp.name}{dp.name !== sp.name ? ' → ' + dp.name : ''}</span>
                <span className="rdir">{sp.dir}/ &#8594; {dp.dir}/</span>
              </span>
              <span className="nums">{rt.inQueue ? '' : 'never verified · '}settling it frees <b>{rt.freesNow}</b> blocked</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// HEALTH, one line. Only failing or can't-tell sections are named; each deep-links to its section.
const HealthLine = ({ hl, dispatch }) => {
  const why = hl && hl.ok === false ? (hl.reason || 'no doctor snapshot') : (hl ? null : 'missing from the payload');
  if (why) return <div className="hl"><span className="cant"><Icon icon="circle-question-mark" size={14} />can&#8217;t tell &#8212; health: {why}</span></div>;
  const sm = healthSummary(hl.sections);
  const clean = sm.failing.length === 0 && sm.unknown.length === 0 && sm.otherFailing.length === 0;
  return (
    <div className="hl">
      {clean ? <span className="okl hv" onClick={go('/health', dispatch)}><Icon icon="check" size={14} />health ok</span> : <span className="st">health</span>}
      {sm.failing.map((p) => (
        <span key={p.label} className="bad hv" onClick={go(viewRoute('/health', { section: p.section }), dispatch)}
          onMouseEnter={tipOn(dispatch, tipLines('pill', p))} onMouseLeave={tipOff(dispatch)}>
          <Icon icon={p.icon} size={14} />{p.label} {p.fail} fail
        </span>
      ))}
      {sm.otherFailing.map((k) => <span key={k} className="bad"><Icon icon="circle-alert" size={14} />{k} failing</span>)}
      {sm.unknown.map((p) => (
        <span key={p.label} className="cant hv" onClick={go(viewRoute('/health', { section: p.section }), dispatch)}>
          <Icon icon="circle-question-mark" size={14} />can&#8217;t tell &#8212; {p.label}: {p.reason}
        </span>
      ))}
      {sm.accepted > 0 ? <span>{sm.accepted} accepted</span> : null}
    </div>
  );
};

// HEADROOM. Only when thin — or when it cannot be told, because a missing
// number must not read as a roomy budget. Inline in the footer row; no CTA (the
// UI has no view for it), so the line names the command to run instead.
const HeadroomLine = ({ hr, dispatch }) => {
  const why = whyNot(hr);
  if (why) return <span className="why"><Icon icon="circle-question-mark" size={14} /><span>can&#8217;t tell &#8212; instruction headroom: {why}</span></span>;
  if (!hr.thin) return null;
  return (
    <span className="hr hv" onClick={go(viewRoute('/health', { section: 'Instruction budget' }), dispatch)}>
      <Icon icon="gauge" size={14} />
      <span>{baseName(hr.directory)}: {hr.headroom >= 0 ? `${hr.headroom} chars of instruction budget left` : `${-hr.headroom} chars OVER the instruction budget`}</span>
    </span>
  );
};

export const render = (state, dispatch) => {
  const { output, error, pos, dragging, moved, interactive, busy, note, tip } = state;
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
  // The window comes from the stream payload's own `since`; with none, say "in the stream".
  const since = sinceText(ch.since);

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
  const hr = d.headroom;
  const hl = d.health;

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
        <span key="c" className={`chg hv ${ch.tone}`} onClick={go('/judge', dispatch)}>{!since ? `${ch.value} changed in the stream`
          : ch.sinceSource === 'cursor' ? `${ch.value} changed since you looked (${since})`
            : ch.sinceSource === 'default-7d' ? `${ch.value} changed in 7 days` : `${ch.value} changed since ${since}`}</span>,
      ]
      : [
        <span key="t" className="ttl">propagate</span>,
        <span key="c" className="chg unknown">changes: can&#8217;t tell</span>,
      ],
    <div className="stack">
      <QueuePanel wl={wl} dispatch={dispatch} />
      <KeepingUpLine vel={vel} dispatch={dispatch} />
      <StartHere lev={lev} dispatch={dispatch} />
      <HealthLine hl={hl} dispatch={dispatch} />
      {note ? <div className="err"><Icon icon="circle-alert" size={14} /><span>{note}</span></div> : null}
      <div className="foot">
        <span className="rf hv" onClick={() => forceRefresh(dispatch)}>{busy ? "…" : "↻"}</span>
        <HeadroomLine hr={hr} dispatch={dispatch} />
        <span className="sp">
          <span className={'hv ' + (payloadStale ? "stale" : "")} onClick={() => forceRefresh(dispatch)}>
            {payloadStale ? <Icon icon="circle-alert" size={12} /> : null}
            updated {agoText(payloadAge)}
          </span>
          <span className={'hv ' + (doctorStale ? "stale" : "")} onClick={go('/health', dispatch)}>
            {doctorStale ? <Icon icon="circle-alert" size={12} /> : null}
            {snap.ok ? `doctor ${agoText(snap.ageMs)}` : `doctor: can't tell — ${snap.reason || 'no snapshot'}`}
          </span>
        </span>
      </div>
      {gate}
      {tip ? (
        <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <div className="tt">{tip.title}</div>
          {tip.lines.map((l) => <div key={l} className="tl">{l}</div>)}
        </div>
      ) : null}
    </div>,
  );
};
