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

  /* ── THE INHERITED SYSTEM, NOT A FORK ────────────────────────────────────
     These tokens come from claude-usage-widget, which carries 103 of them with
     light and dark palettes, a 5-step spacing scale and a documented concentric
     bezel. The plan said to inherit it and cite it rather than re-invent, and
     the first shipped version re-invented anyway: a cool grey-blue palette, a
     fixed-width bar and a value floating mid-row. Side by side with the design
     sketch the difference was obvious and entirely self-inflicted.

     Two surfaces sharing one desktop must share one visual language, which is
     the same reason rule:tool-priority exists: the divergence is never one
     decision, it is nine copies later. */

  --fg: rgba(255,255,255,0.92);
  --dim: rgba(235,235,245,0.52);
  --dimmer: rgba(235,235,245,0.38);
  --track: rgba(235,235,245,0.16);

  --ok: #5fd07c;
  --caution: #e0a53a;
  --warn: #ff8f6b;
  --accent: #e09a5c;
  --unknown: rgba(235,235,245,0.40);

  --DRIFTED: #e0a53a;
  --DIVERGED: #ff8f6b;
  --REVERSED: #a276cb;

  --s1: 3px; --s2: 6px; --s3: 9px; --s4: 12px; --s5: 15px;
  --r-shell: 20px; --r-core: 15px;

  --shell: rgba(255,255,255,0.07);
  --core: linear-gradient(180deg, rgba(44,44,46,0.82) 0%, rgba(28,28,30,0.76) 100%);
  --edge: rgba(255,255,255,0.13);
  --edge-core: rgba(255,255,255,0.09);
  --specular: rgba(255,255,255,0.16);
  --cast-near: rgba(0,0,0,0.34);
  --cast-far: rgba(0,0,0,0.52);

  font: 11px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  letter-spacing: -.005em;
  -webkit-font-smoothing: antialiased;
  color: var(--fg);

  /* THE CONCENTRIC DOUBLE BEZEL. The shell is a 5px translucent frame; the core
     sits inside it at the smaller radius. Both carry an inset specular highlight
     along the top edge, which is what makes it read as a physical object on a
     photographic wallpaper rather than a flat rectangle pasted onto one. */
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
  .shell.dragging { border-color: rgba(224,154,92,0.55); }
  .core {
    border-radius: var(--r-core);
    background: var(--core);
    border: .5px solid var(--edge-core);
    box-shadow: inset 0 1px 0 0 var(--specular);
    padding: 13px 16px 15px;
  }

  /* The grip is the header strip, not a small handle: a 12px target is
     unhittable on a layer where the cursor is already doing something else. */
  .grip { cursor: grab; padding-bottom: var(--s1); }
  .shell.dragging .grip { cursor: grabbing; }

  .hd { display: flex; align-items: baseline; gap: var(--s3); }
  .ttl { font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); }
  .big { font-size: 20px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
  .big.warn { color: var(--caution); }
  .big.fail { color: var(--warn); }
  .big.ok { color: var(--ok); }
  .big.unknown { color: var(--unknown); }
  .of { color: var(--dim); }

  .grp { font-size: 9px; font-weight: 600; letter-spacing: .11em; text-transform: uppercase;
         color: var(--dimmer); margin: var(--s4) 0 var(--s1); }

  /* ROW RHYTHM: 60px label, 9px gap, a bar that FLEXES to fill, then a 74px
     right-aligned value column. The value column is what makes four rows
     comparable at a glance; a value floating mid-row has to be hunted for. */
  .row { display: flex; align-items: center; gap: var(--s3); height: 16px; margin-top: var(--s1); }
  .row.act { cursor: pointer; }
  .lbl { width: 60px; flex: 0 0 60px; color: var(--dim); white-space: nowrap; }
  .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--track); position: relative; overflow: hidden; min-width: 90px; }
  .fil { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--unknown); }
  .fil.ok { background: var(--ok); }
  .fil.warn { background: var(--caution); }
  .fil.fail { background: var(--warn); }
  .fil.unknown { background: repeating-linear-gradient(90deg, var(--track) 0 3px, transparent 3px 6px); }
  .val { width: 74px; flex: 0 0 74px; text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); white-space: nowrap; }
  .val .u { color: var(--dim); }
  .val.warn { color: var(--caution); }
  .val.fail { color: var(--warn); }
  .val.unknown { color: var(--unknown); }

  /* Aligned to the bar, not the label: the sub-line is about the bar above it. */
  .sub { margin-left: 69px; color: var(--dimmer); font-size: 10px; margin-top: 1px; }

  /* NOT-YET-BUILT IS A DIMMED ROW, NOT FOUR REPETITIONS OF A SENTENCE. The
     first version printed "not built yet" on every unbuilt row -- four times,
     in a card with nine rows, which is more words about what is missing than
     about what is there. The dimming carries it, and the footer states the
     count once. */
  .row.soon .lbl, .row.soon .val { opacity: .55; }
  .row.soon .bar { opacity: .5; }

  .grid { display: flex; gap: var(--s4); margin-top: var(--s4); flex-wrap: wrap; }
  .runhd { font-size: 9px; color: var(--dimmer); letter-spacing: .05em; margin-bottom: var(--s1); }
  .cells { display: flex; flex-wrap: wrap; max-width: 340px; gap: 2px; align-content: flex-start; }
  .cell { width: 7px; height: 7px; border-radius: 1.5px; background: var(--unknown); }
  .cell.DRIFTED { background: var(--DRIFTED); }
  .cell.DIVERGED { background: var(--DIVERGED); }
  .cell.REVERSED { background: var(--REVERSED); }
  .cell.stale { outline: 1px solid rgba(224,165,58,0.55); }

  .foot { display: flex; gap: var(--s4); margin-top: var(--s4); color: var(--dim); font-size: 10px;
          border-top: .5px solid rgba(255,255,255,.07); padding-top: var(--s2); align-items: baseline; }
  .foot .lk { cursor: pointer; color: var(--accent); }
  .foot .sp { margin-left: auto; }
  .foot .stale { color: var(--caution); }
  .warn { color: var(--warn); }
  .ok { color: var(--ok); }
  .gate { font-size: 10px; color: var(--dim); margin-top: var(--s2); }
  .gate b { color: var(--caution); font-weight: 600; }
`;

// Open a control. `run` is the documented shell-out; open-ui.sh starts the
// server if it is not up and opens the URL the server printed, because the
// per-start token means the URL cannot be constructed, only read.
function openView(route, dispatch) {
  dispatch({ type: 'CLICKED' });
  run(`bash "$HOME/Documents/GitHub/propagate/widget/open-ui.sh" ${JSON.stringify(route).replace(/"/g, "'")}`);
}

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

const Run = ({ g }) => (
  <div className="run">
    <div className="runhd">{g.state.toLowerCase()} {g.count}</div>
    <div className="cells">
      {g.cells.map((c) => (
        <span
          key={c.edge_id}
          className={`cell ${c.state}${c.age === 'stale' ? ' stale' : ''}`}
        />
      ))}
    </div>
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
  const { output, error, pos, dragging, moved, interactive } = state;
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
        <b>rows are inert</b> — Übersicht needs an interaction shortcut + Accessibility access
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
    </div>,
    <div>
      {d.groups.map((g) => (
        <div key={g.key}>
          <div className="grp">{g.label}</div>
          {g.rows.map((r) => <Row key={r.key} r={r} dispatch={dispatch} />)}
        </div>
      ))}

      {d.grid && d.grid.length
        ? <div className="grid">{d.grid.map((g) => <Run key={g.state} g={g} />)}</div>
        : null}

      <div className="foot">
        <span className="lk" onClick={() => openView("graph", dispatch)}>graph &#8250;</span>
        <span className="lk" onClick={() => openView("/queue", dispatch)}>queue &#8250;</span>
        {soon ? <span>{soon} not built</span> : null}
        <span className={stale ? "sp stale" : "sp"}>
          {snap.ok ? `snapshot ${ageText(snap.ageMs)}` : (snap.reason || "no snapshot")}
        </span>
      </div>
      {gate}
    </div>,
  );
};
