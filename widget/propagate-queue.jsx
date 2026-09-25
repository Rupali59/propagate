// propagate — the whole propagation picture on the desktop layer, draggable.
//
// WHAT CHANGED AND WHY. The first version rendered ONE slice — drift — and
// called it propagation. The correction that produced this file was blunt:
// *"put the different parts of propagation here, and where is the hub doctor."*
// Doctor is the health spine of this tool and the widget ignored it completely.
//
// So the spine is now doctor's own sections, in three groups that answer three
// different questions: what is DRIFTING, what work is WRITTEN DOWN, and is the
// MACHINERY sound. The registers in particular were being shown as one dim grey
// `·` line inside doctor — 329 written-down items rendered as a sentence — and
// an earlier draft of this widget compressed that even further, to the word
// "ok". They are first-class rows here.
//
// EVERY NUMBER COMES FROM `propagate surface --json`. This file derives nothing.
// Two renderers each computing "actionable" is how they end up disagreeing while
// each stays internally consistent (N86), so the widget, the web UI and the CLI
// all read one payload from lib/report/surface.mjs.
//
// A FOURTH THING, ADDED LATER, LIVES BESIDE THE HEADLINE RATHER THAN AS A
// FOURTH GROUP. "What changed since I last looked" had no home on any
// surface — the `d.changed` badge in the header is that home. It answers a
// different kind of question than EDGES/REGISTERS/HEALTH (what MOVED, not
// what STATE something is in), and it stays ONE number, never a table of the
// individual edges that changed — see lib/report/surface.mjs's
// buildChangedSummary.
//
// ── THE IMPORT RULE, CORRECTED ─────────────────────────────────────────────
//
// This file used to say "NO IMPORTS, deliberately". That was wrong, and the
// wrongness mattered: it ruled out `uebersicht` itself, which is how a widget
// shells out and therefore how any click does anything.
//
// The real rule is **no RELATIVE imports**. A relative specifier that fails to
// resolve on the desktop layer fails SILENTLY — no console, no test, no render.
// `uebersicht` is guaranteed to resolve; Übersicht's own `Probe` control imports
// `run` from it.
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
//
// Position therefore cannot live in className. The container sits at the origin
// with no box of its own; the card is `position: fixed` with left/top from
// state, which escapes the container and addresses the screen.
//
// NO JSX FRAGMENTS (G8). Übersicht compiles with `pragma:'html'` and sets no
// `pragmaFrag`, so `<div>` becomes `html('div', …)` and works, while `<>…</>`
// falls back to babel's default `React.Fragment` — not in a widget bundle's
// scope. Flat elements and arrays only.
//
// Because `:hover` never fires on the desktop layer, no fact lives in a
// tooltip. Everything that matters is inline.

import { run } from 'uebersicht';

// Absolute path: Übersicht runs widget commands from its own widgets directory.
// Via collect.sh rather than `node` directly, because Übersicht inherits
// launchd's PATH, which has no /opt/homebrew/bin. Verified with
// `env -i PATH=/usr/bin:/bin` before shipping, not after.
export const command = 'bash "$HOME/Documents/GitHub/propagate/widget/collect.sh"';

// 5 minutes. Measured 2026-09-17: the whole payload costs 0.67s under the GUI
// environment, so this is ~0.22% duty.
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
  // Judging from the desktop. `arm` is the disposition awaiting a SECOND
  // click: this card has no evidence pane, so the confirm IS the review.
  sel: null,
  reason: '',
  arm: null,
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

  // Every branch spreads ...prev (G11). Übersicht REPLACES widget state on each
  // command run, so a branch returning a fresh object silently drops the
  // position, the interactive flag, and a half-typed reason.
  if (event.type === 'SELECT') {
    return { ...prev, interactive: true, sel: event.cell, reason: '', arm: null, note: null };
  }
  if (event.type === 'REASON') return { ...prev, reason: event.value };
  if (event.type === 'ARM') return { ...prev, arm: event.disp, note: null };
  if (event.type === 'CLOSE') return { ...prev, sel: null, arm: null, reason: '', note: null, busy: false };
  if (event.type === 'BUSY') return { ...prev, busy: true, arm: null };
  if (event.type === 'NOTE') return { ...prev, busy: false, arm: null, note: event.text };
  // A forced refresh replaces the command's output in place. `error: null`
  // because a successful manual run is evidence the previous failure is over.
  if (event.type === 'REFRESHED') return { ...prev, output: event.output, error: null, busy: false };

  // The documented default command event shape.
  if (event.error) return { ...prev, error: String(event.error) };
  if (typeof event.output === 'string') return { ...prev, output: event.output, error: null };
  return prev;
};

// The container is NOT positioned from state — className is static. It sits at
// the origin carrying only the styles; `.card` holds the real position.
//
// WIDTH IS `max-content`, NOT A NUMBER (G9). That entry: *"a fixed card width is
// a claim about the cell count, and it rotted immediately"* — a 470px card whose
// heatmap needed 630px, drawing cells outside the rounded corner onto the
// wallpaper, with correct DOM, valid CSS, passing tests and the right data.
// `overflow` is visible by default, so nothing catches it but looking. This plan
// originally specified 430px fixed, which is the same claim.
export const className = `
  left: 0; top: 0;

  /* ── TWO COLOUR FAMILIES, DISJOINT BY CONSTRUCTION ───────────────────────
     The first version shared hexes between them and nobody could see it:

       --caution  #e0a53a  bar fill, value, headline   ordinal "needs attention"
       --DRIFTED  #e0a53a  grid cell                   categorical, one state
       --warn     #ff8f6b  bar fill, value, headline   ordinal "failing"
       --DIVERGED #ff8f6b  grid cell                   categorical, one state

     Two hexes, two meanings each, on one card. Rendered it looks fine, which is
     why the design review passed it -- the collision exists only in the token
     table. Recorded as G66.

     STATUS is ordinal: a closed enum ok | warn | fail | unknown, from
     lib/report/surface.mjs. Unknown gets NO hue and falls back to --dim, which
     is the sibling widget's own convention rather than a new idea.

     EDGE STATE is its own family, and the values are lifted verbatim from
     lib/graph/graph-html.mjs -- the graph page this widget links to in its own
     footer, which already carried a themed state palette. So the two surfaces
     now agree on what DRIFTED looks like, and nothing was invented.

     The st- and edge- prefixes exist so a future collision is visible in the
     NAME, not only in the hex. A test asserts no hex appears in both families.

     ── THEME ────────────────────────────────────────────────────────────────
     Light is the base; one prefers-color-scheme block redefines every palette
     token. No colour gets its only definition inside the media query. This
     matches the sibling widget exactly (it has ONE such block and no JS), and
     the reason the widget shipped dark-only is G66: the design sketch was that
     sibling's dark branch over a fake dark desktop, so there was nothing in the
     picture to notice as missing.

     If both themes do not render when macOS Appearance is toggled, that is
     WKWebView not inheriting the system appearance -- not a bug in this
     stylesheet. The sibling's README names the same failure mode. */

  /* Theme-independent: geometry, never colour. */
  --s1: 3px; --s2: 6px; --s3: 9px; --s4: 12px; --s5: 15px;
  --r-shell: 20px; --r-core: 15px;

  /* LIGHT — macOS window material over a bright desktop. --shell is the OUTER
     bezel only; text sits on --core, so it can be thin without costing
     legibility. The cast shadow is tinted to the ground rather than black,
     which is what separates the card from a pale wallpaper. */
  --fg: #1c1c1e;
  --dim: rgba(60, 60, 67, 0.58);
  --dimmer: rgba(60, 60, 67, 0.42);
  --track: rgba(60, 60, 67, 0.13);

  /* THE WHEEL, and it is the SAME wheel commands/ui.css and
     lib/graph/graph-html.mjs use -- one number per role, asserted identical by
     tests/unit/theme.test.mjs. Authored in OKLCH so lightness and chroma stay
     separable: the previous fix scaled hex toward black for contrast and
     dragged chroma down with it, which is what made this card brown.
     Ubersicht is WebKit, and Safari 16.4+ has relative colour. */
  --h-warn: 28; --h-caution: 80; --h-ok: 145;
  --h-drift: 195; --h-accent: 250; --h-reverse: 285; --h-diverge: 340;

  --st-ok:        oklch(.535 .129 var(--h-ok));
  --st-caution:   oklch(.555 .115 var(--h-caution));
  --st-warn:      oklch(.567 .150 var(--h-warn));
  --st-accent:    oklch(.551 .130 var(--h-accent));

  --edge-drift:   oklch(.541 .090 var(--h-drift));
  --edge-reverse: oklch(.564 .160 var(--h-reverse));
  --edge-diverge: oklch(.573 .170 var(--h-diverge));
  --edge-stale: oklch(from var(--st-caution) l c h / .7);

  --shell: rgba(255, 255, 255, 0.16);
  --core: linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(252,250,249,0.78) 100%);
  --edge: rgba(0, 0, 0, 0.10);
  --edge-core: rgba(255, 255, 255, 0.85);
  --specular: rgba(255, 255, 255, 0.85);
  --cast-near: rgba(60, 50, 42, 0.10);
  --cast-far: rgba(60, 50, 42, 0.24);
  --hair: rgba(0, 0, 0, 0.09);

  font: 11px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  letter-spacing: -.005em;
  -webkit-font-smoothing: antialiased;
  color: var(--fg);

  @media (prefers-color-scheme: dark) {
    --fg: rgba(255, 255, 255, 0.92);
    --dim: rgba(235, 235, 245, 0.52);
    --dimmer: rgba(235, 235, 245, 0.38);
    --track: rgba(235, 235, 245, 0.16);

    --st-ok:        oklch(.779 .130 var(--h-ok));
    --st-caution:   oklch(.780 .130 var(--h-caution));
    --st-warn:      oklch(.779 .125 var(--h-warn));
    --st-accent:    oklch(.781 .114 var(--h-accent));

    --edge-drift:   oklch(.779 .110 var(--h-drift));
    --edge-reverse: oklch(.781 .114 var(--h-reverse));
    --edge-diverge: oklch(.780 .170 var(--h-diverge));
    --edge-stale: oklch(from var(--st-caution) l c h / .55);

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
     behind an element in the document -- so the material is built from a
     layered base, a hairline and a ground-tinted shadow instead. */
  .shell {
    position: fixed;
    width: max-content;
    max-width: 560px;
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
    padding: 13px 16px 15px;
  }

  .grip { cursor: grab; padding-bottom: var(--s1); }
  .shell.dragging .grip { cursor: grabbing; }

  .hd { display: flex; align-items: baseline; gap: var(--s3); }
  .ttl { font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); }
  .big { font-size: 20px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
  .big.warn { color: var(--st-caution); }
  .big.fail { color: var(--st-warn); }
  .big.ok { color: var(--st-ok); }
  .big.unknown { color: var(--dim); }
  .of { color: var(--dim); }

  /* THE CHANGED BADGE. "What changed since I last looked" -- ONE number,
     pushed to the far end of the header row. No fixed width (G9's family):
     the count can grow past one digit and the badge must not clip it. */
  .chg {
    margin-left: auto;
    font-size: 9px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 8px;
    background: rgba(127,127,127,.14);
    color: var(--dim);
    white-space: nowrap;
  }
  .chg.none { color: var(--fg); background: rgba(127,127,127,.22); }

  .grp { font-size: 9px; font-weight: 600; letter-spacing: .11em; text-transform: uppercase;
         color: var(--dimmer); margin: var(--s4) 0 var(--s1); }

  /* 60px label, 9px gap, a bar that FLEXES, then a 74px right-aligned value
     column -- which is what makes nine rows comparable at a glance. */
  .row { display: flex; align-items: center; gap: var(--s3); height: 16px; margin-top: var(--s1); }
  .row.act { cursor: pointer; }
  .lbl { width: 60px; flex: 0 0 60px; color: var(--dim); white-space: nowrap; }
  .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--track); position: relative; overflow: hidden; min-width: 90px; }
  .fil { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--dim); }
  /* NEUTRAL IS NOT COLOURLESS, and that distinction is the whole point.
     A row with tone "none" carries a REAL proportion -- Issues is 87 of 117
     still open -- it just is not a condition anyone should act on today. The
     previous rule gave those rows no fill colour at all, so six of ten bars
     drew in the same grey as their own empty track and the card read as
     monochrome. That is not restraint, it is an unreadable bar.
     So: the ACCENT hue means "this is a measurement", the STATUS ramp means
     "this is a condition". Same split the two colour families already draw,
     applied one level down. */
  .fil.none { background: var(--st-accent); opacity: .85; }
  .fil.ok { background: var(--st-ok); }
  .fil.warn { background: var(--st-caution); }
  .fil.fail { background: var(--st-warn); }
  .fil.unknown { background: repeating-linear-gradient(90deg, var(--track) 0 3px, transparent 3px 6px); }
  .val { width: 74px; flex: 0 0 74px; text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); white-space: nowrap; }
  .val .u { color: var(--dim); }
  .val.warn { color: var(--st-caution); }
  .val.fail { color: var(--st-warn); }
  .val.unknown { color: var(--dim); }

  .sub { margin-left: 69px; color: var(--dimmer); font-size: 10px; margin-top: 1px; }

  /* Not-yet-built is a dimmed row plus one footer count, never four copies of
     the same sentence in a nine-row card. */
  .row.soon .lbl, .row.soon .val { opacity: .55; }
  .row.soon .bar { opacity: .5; }

  .grid { display: flex; gap: var(--s4); margin-top: var(--s4); flex-wrap: wrap; }
  .runhd { font-size: 9px; color: var(--dimmer); letter-spacing: .05em; margin-bottom: var(--s1); }
  .cells { display: flex; flex-wrap: wrap; max-width: 340px; gap: 2px; align-content: flex-start; }
  .cell { width: 7px; height: 7px; border-radius: 1.5px; background: var(--dim); }
  .cell.DRIFTED { background: var(--edge-drift); }
  .cell.DIVERGED { background: var(--edge-diverge); }
  .cell.REVERSED { background: var(--edge-reverse); }
  .cell.stale { outline: 1px solid var(--edge-stale); }

  .foot { display: flex; gap: var(--s4); margin-top: var(--s4); color: var(--dim); font-size: 10px;
          border-top: .5px solid var(--hair); padding-top: var(--s2); align-items: baseline; }
  .foot .lk { cursor: pointer; color: var(--st-accent); }
  .foot .sp { margin-left: auto; }
  .foot .stale { color: var(--st-caution); }
  .warn { color: var(--st-warn); }
  .ok { color: var(--st-ok); }
  .gate { font-size: 10px; color: var(--dim); margin-top: var(--s2); }
  .gate b { color: var(--st-caution); font-weight: 600; }

  /* MOTION. Seven moments in the web UI; three here, because a desktop card is
     glanced at rather than worked in. Each still answers something a static
     frame cannot: that a cell is selected, that a write is armed, that a
     refresh is running. Durations are tokens so the reduced-motion block can
     reach all of them. */
  --t-fast: 120ms; --t-base: 160ms; --ease: cubic-bezier(.22,.61,.36,1);

  .cell { transition: transform var(--t-fast) var(--ease), outline-color var(--t-fast) var(--ease); cursor: pointer; }
  .cell:hover { transform: scale(1.35); }
  .cell.on { outline: 2px solid var(--fg); outline-offset: 1px; transform: scale(1.35); }

  .rf { margin-left: auto; font-size: 12px; opacity: .7; }
  .rf:hover { opacity: 1; }

  /* The judge panel: the one place this card writes. */
  .judge { margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--hair); }
  .jlabel { font-size: 10.5px; color: var(--fg); line-height: 1.35; }
  .jmeta { font-size: 9.5px; color: var(--dim); margin: 2px 0 var(--s2); font-family: ui-monospace, Menlo, monospace; }
  .jreason {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 10.5px;
    padding: 4px 6px; border-radius: 5px; border: 1px solid var(--hair);
    background: rgba(127,127,127,.10); color: var(--fg); outline: none;
  }
  .jreason:focus { border-color: var(--st-accent); }
  .jrow { display: flex; gap: 5px; flex-wrap: wrap; margin-top: var(--s2); }
  .jbtn {
    font-size: 9.5px; padding: 3px 7px; border-radius: 5px; cursor: pointer;
    background: rgba(127,127,127,.12); color: var(--fg);
    transition: background var(--t-base) var(--ease), color var(--t-base) var(--ease);
  }
  .jbtn:hover { background: rgba(127,127,127,.22); }
  /* ARMED IS LOUD ON PURPOSE. The next click writes to an append-only ledger
     and there is no diff on this card to review first. */
  .jbtn.armed { background: var(--st-warn); color: var(--core-ink, #fff); font-weight: 600; }
  .jbtn.off { opacity: .4; cursor: default; }
  .jbtn.ghost { background: transparent; color: var(--dim); }
  .jnote { font-size: 9.5px; color: var(--dim); margin-top: var(--s2); line-height: 1.4; }

  @media (prefers-reduced-motion: reduce) {
    .cell, .jbtn { transition-duration: .01ms; }
    .cell:hover, .cell.on { transform: none; }
    .cell.on { outline-width: 3px; }
  }
`;

// Open a control. `run` is the documented shell-out; open-ui.sh starts the
// server if it is not up and opens the URL the server printed, because the
// per-start token means the URL cannot be constructed, only read.
function openView(route, dispatch) {
  dispatch({ type: 'CLICKED' });
  run(`bash "$HOME/Documents/GitHub/propagate/widget/open-ui.sh" ${JSON.stringify(route).replace(/"/g, "'")}`);
}

// FORCED REFRESH. refreshFrequency is five minutes, which is right for a
// desktop card and wrong the moment you have just judged something and want to
// see it go. run() resolves with stdout, so the same collector the schedule
// uses can be driven by hand.
function forceRefresh(dispatch) {
  dispatch({ type: 'BUSY' });
  run('bash "$HOME/Documents/GitHub/propagate/widget/collect.sh"')
    .then((out) => dispatch({ type: 'REFRESHED', output: out }))
    .catch((e) => dispatch({ type: 'NOTE', text: String(e) }));
}

// JUDGE, from the desktop.
//
// ARM THEN CONFIRM, and that is not ceremony. The web UI shows a diff before
// you judge; this card has no room for one, so the second click is the entire
// review step. widget/judge.sh carries the other half of the guard: --apply is
// spelled out there rather than defaulted, and a reason under 12 characters is
// refused before the CLI is reached.
//
// Arguments go through as ARGV, never concatenated into the command string —
// the reason is free text somebody just typed.
function confirmJudge(sel, disp, reason, dispatch) {
  dispatch({ type: 'BUSY' });
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  run('bash "$HOME/Documents/GitHub/propagate/widget/judge.sh" '
    + q(sel.edge_id) + ' ' + q(disp) + ' ' + q(reason))
    .then((out) => {
      dispatch({ type: 'NOTE', text: String(out).trim().split('\n').pop() });
      forceRefresh(dispatch);
    })
    .catch((e) => dispatch({ type: 'NOTE', text: String(e) }));
}

// Which dispositions a state may legally take. Mirrors lib/report/queue.mjs's
// ALLOWED_NON_DIVERGED: a DIVERGED edge takes exactly one, and offering the
// others would be offering refusals.
const DISPS = (state) => (state === 'DIVERGED'
  ? ['both-reconciled']
  : ['no-change-needed', 'propagated', 'deferred']);

// Flat components. claude-usage.jsx records "Can't find variable: React" as the
// failure mode when a helper nests JSX in a way the transform cannot resolve.
// One row OWNS its sub-line rather than the caller emitting a sibling. That is
// not tidiness: emitting both from a `.map` returns an ARRAY per iteration, so
// the children become a nested array. React flattens those; Übersicht compiles
// with `pragma:'html'`, which is hyperscript and not React, and nothing here
// proves it flattens the same way. A construct that needs an untested
// assumption about the renderer has no business in a file with no headless
// test — the same reasoning that bans JSX fragments (G8).
const Row = ({ r, dispatch }) => {
  const live = !!(r.cta && r.cta.available);
  return (
    <div className="rowgrp">
      <div
        className={live ? "row act" : "row soon"}
        onClick={live ? () => openView(r.cta.route, dispatch) : undefined}
      >
        <span className="lbl">{r.label}</span>
        <span className="bar">
          <span
            className={`fil ${r.tone}`}
            style={{ width: r.ratio == null ? "100%" : `${Math.round(r.ratio * 100)}%` }}
          />
        </span>
        <span className={`val ${r.tone}`}>
          {r.value == null ? "—" : r.value} <span className="u">{r.unit}</span>
        </span>
      </div>
      {(r.extra || []).length ? <div className="sub">{r.extra.join(" · ")}</div> : null}
    </div>
  );
};

const Run = ({ g, sel, dispatch }) => (
  <div className="run">
    <div className="runhd">{g.state.toLowerCase()} {g.count}</div>
    <div className="cells">
      {g.cells.map((c) => (
        <span
          key={c.edge_id}
          title={c.label}
          className={`cell ${c.state}${c.age === 'stale' ? ' stale' : ''}${sel && sel.edge_id === c.edge_id ? ' on' : ''}`}
          onClick={() => dispatch({ type: 'SELECT', cell: c })}
        />
      ))}
    </div>
  </div>
);

// The judge panel. One flat component: nesting JSX in a helper is what produces
// "Can't find variable: React" under Übersicht's hyperscript pragma (G8).
const Judge = ({ sel, reason, arm, busy, note, dispatch }) => (
  <div className="judge">
    <div className="jlabel">{sel.label}</div>
    <div className="jmeta">{sel.edge_id} · {sel.state}{sel.noiseRatio >= 0.5 ? ' · mostly no-op' : ''}</div>
    <input
      className="jreason"
      type="text"
      value={reason}
      placeholder="why (12+ chars) — lands in the ledger"
      onInput={(e) => dispatch({ type: 'REASON', value: e.target.value })}
    />
    <div className="jrow">
      {DISPS(sel.state).map((dp) => (
        <span
          key={dp}
          className={`jbtn${arm === dp ? ' armed' : ''}${reason.trim().length < 12 ? ' off' : ''}`}
          onClick={() => {
            if (reason.trim().length < 12) return;
            if (arm === dp) confirmJudge(sel, dp, reason.trim(), dispatch);
            else dispatch({ type: 'ARM', disp: dp });
          }}
        >
          {arm === dp ? 'confirm ' + dp : dp}
        </span>
      ))}
      <span className="jbtn ghost" onClick={() => dispatch({ type: 'CLOSE' })}>close</span>
    </div>
    {busy ? <div className="jnote">writing…</div> : null}
    {note ? <div className="jnote">{note}</div> : null}
    {arm ? <div className="jnote">click again to confirm — this writes to the ledger</div> : null}
  </div>
);

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

function ageText(ms) {
  if (ms == null) return 'unknown age';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m old`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h old` : `${Math.round(h / 24)}d old`;
}

export const render = (state, dispatch) => {
  const { output, error, pos, dragging, moved, interactive, sel, reason, arm, busy, note } = state;
  const at = pos || DEFAULT_POS;

  const card = (head, body) => (
    <div className={dragging ? "shell dragging" : "shell"} style={{ left: at.left, top: at.top }}>
      <div className="core">
        <div
          className="grip"
          onMouseDown={(e) => beginDrag(e, at, dispatch)}
          onDoubleClick={() => dispatch({ type: "RESET_POS" })}
        >
          {head}
        </div>
        {body}
      </div>
    </div>
  );

  const bareHead = <div className="hd"><span className="ttl">propagate</span></div>;

  if (error) return card(bareHead, <div className="warn">{String(error)}</div>);

  let d;
  try {
    d = JSON.parse(output);
  } catch (e) {
    // Rendering nothing here would be indistinguishable from a clean tree.
    return card(bareHead, <div className="warn">collect.sh — unreadable output</div>);
  }

  // collect.sh and `surface --json` both emit {"error": ...} rather than
  // nothing, precisely so this branch can name the reason on the desktop.
  if (d.error || !d.groups) {
    return card(bareHead, <div className="warn">{d.error || 'no groups field'}</div>);
  }

  const h = d.headline || { value: null, label: '', tone: 'unknown' };
  // "WHAT CHANGED SINCE I LAST LOOKED" HAD NO HOME ON ANY SURFACE — the badge
  // that fixes that. ONE number, not a table (see surface.mjs's
  // buildChangedSummary): a count and a tone, nothing per-edge reaches this
  // file. Same fallback shape as `h` above, for the same reason — an older
  // collect.sh that predates this field must not throw reading it.
  const ch = d.changed || { value: null, label: '', tone: 'unknown' };

  // DECISION 1 — GATE THE CLICKS, NOT THE CARD. An earlier draft hid the whole
  // widget behind a setup card until interaction was configured. Drawing it
  // showed that the gate ALSO hides the stale-snapshot warning and the failing
  // check, which are the two things most worth seeing. claude-usage.jsx settled
  // this for its pager under G5: nothing is hidden behind an interaction you
  // cannot perform. The card always renders; rows are simply inert, and one dim
  // line says why.
  const gate = interactive || moved
    ? null
    : (
      <div className="gate">
        <b>clicks do nothing yet</b> — turn on Übersicht&#8217;s Interaction toggle
        (menu bar icon &#8250; Interaction), or run
        <b> defaults write tracesOf.Uebersicht enableInteraction -bool true</b> and restart it
      </div>
    );

  const snap = d.snapshot || {};
  const stale = snap.ok && snap.ageMs != null && snap.ageMs > 3600000;
  // Stated ONCE in the footer rather than repeated on every unbuilt row. Four
  // copies of "not built yet" is more words about what is missing than about
  // what is there; the rows carry it by dimming instead.
  const soon = d.groups.reduce((n, g) => n + g.rows.filter((r) => !(r.cta && r.cta.available)).length, 0);

  return card(
    <div className="hd">
      <span className="ttl">propagate</span>
      <span className={`big ${h.tone}`}>{h.value == null ? '?' : h.value}</span>
      <span className="of">
        {h.value == null ? h.label : `${h.label} · ${d.edges.declared} declared`}
      </span>
      {ch.value != null ? <span className={`chg ${ch.tone}`}>{ch.value} {ch.label}</span> : null}
    </div>,
    <div>
      {d.groups.map((g) => (
        <div key={g.key}>
          <div className="grp">{g.label}</div>
          {g.rows.map((r) => <Row key={r.key} r={r} dispatch={dispatch} />)}
        </div>
      ))}

      {d.grid && d.grid.length
        ? <div className="grid">{d.grid.map((g) => <Run key={g.state} g={g} sel={sel} dispatch={dispatch} />)}</div>
        : null}

      {sel
        ? <Judge sel={sel} reason={reason} arm={arm} busy={busy} note={note} dispatch={dispatch} />
        : null}

      <div className="foot">
        <span className="lk" onClick={() => openView("/ready", dispatch)}>ready &#8250;</span>
        <span className="lk" onClick={() => openView("/analytics", dispatch)}>charts &#8250;</span>
        <span className="lk" onClick={() => openView("/graph", dispatch)}>graph &#8250;</span>
        {soon ? <span>{soon} not built</span> : null}
        <span className="lk rf" onClick={() => forceRefresh(dispatch)}>{busy ? "…" : "\u21bb"}</span>
        <span className={stale ? "sp stale" : "sp"}>
          {snap.ok ? `snapshot ${ageText(snap.ageMs)}` : (snap.reason || "no snapshot")}
        </span>
      </div>
      {gate}
    </div>,
  );
};
