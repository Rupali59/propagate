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
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  -webkit-font-smoothing: antialiased;

  .card {
    position: fixed;
    width: max-content;
    max-width: 560px;
    color: #e6edf3;
    background: rgba(11,13,16,0.88);
    border: 1px solid rgba(90,105,125,0.35);
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.45);
    font-variant-numeric: tabular-nums;
  }
  .card.dragging { border-color: rgba(47,129,247,0.7); box-shadow: 0 12px 40px rgba(0,0,0,0.6); }

  /* The grip is the whole header strip, not a small handle — a 12px target is
     unhittable on a layer where the cursor is already doing something else. */
  .grip { padding:11px 15px 3px; cursor: grab; }
  .card.dragging .grip { cursor: grabbing; }
  .body { padding: 0 15px 12px; }

  .hd { display:flex; align-items:baseline; gap:9px; }
  .ttl { font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#8b98a8; }
  .big { font-size:21px; font-weight:600; line-height:1; }
  .big.warn { color:#f0b429; }
  .big.fail { color:#ff7b72; }
  .big.ok   { color:#3fb950; }
  .big.unknown { color:#8b98a8; }
  .of  { font-size:11px; color:#8b98a8; }

  .grp { font-size:9.5px; font-weight:600; letter-spacing:.11em; color:#5d6b7d;
         margin:11px 0 4px; text-transform:uppercase; }

  /* The 60px label / 9px gap rhythm is inherited from claude-usage.jsx rather
     than re-invented — see the plan's visual spec. */
  .row { display:flex; align-items:center; gap:9px; padding:2px 0; font-size:11px; }
  .row.act { cursor:pointer; }
  .row.act:hover .lbl { color:#e6edf3; }
  .lbl { width:74px; flex:0 0 74px; color:#aab6c4; }
  /* The display:inline-block here IS LOAD-BEARING. These are span elements,
     and an inline element ignores width and height entirely — so every bar
     rendered as a hairline with no fill, on a card whose numbers were right.
     Nothing in the test suite could see it: the payload was right, the DOM was
     right, the CSS was valid. It took looking at the screen. */
  .track { display:inline-block; width:112px; flex:0 0 112px; height:6px; border-radius:3px;
           background:rgba(90,105,125,0.22); overflow:hidden; vertical-align:middle; }
  .fill { display:block; height:100%; border-radius:3px; background:#5d6b7d; min-width:1px; }
  .fill.ok { background:#3fb950; }
  .fill.warn { background:#f0b429; }
  .fill.fail { background:#ff7b72; }
  .fill.unknown { background:repeating-linear-gradient(90deg,#3a4552 0 3px,transparent 3px 6px); }
  .val { min-width:96px; }
  .val b { font-weight:600; }
  .val.warn b { color:#f0b429; }
  .val.fail b { color:#ff7b72; }
  .val.unknown b { color:#8b98a8; }
  .unit { color:#8b98a8; }
  .go { margin-left:auto; color:#5d6b7d; font-size:11px; padding-left:8px; }
  .row.act .go { color:#7d8fa3; }
  .go.soon { color:#4a5563; font-size:9.5px; letter-spacing:.04em; }

  .rowgrp { }
  .sub { font-size:10px; color:#6f7d8f; margin:0 0 3px 83px; }

  /* DECISION 2 — the grid groups by STATE into labelled, counted runs. The
     previous version encoded state by colour alone, in amber/red/violet: the
     deutan-protan confusion pair, on a 7px cell, with no hover available on
     this layer. Position and grouping carry the meaning now; colour is a
     redundant second channel. */
  .grid { display:flex; gap:16px; margin-top:11px; flex-wrap:wrap; }
  .run { }
  .runhd { font-size:9px; color:#6f7d8f; letter-spacing:.05em; margin-bottom:3px; }
  /* WRAPPING, not a fixed 2-row column flow. The plan specified one, and
     at today's counts it fits — but that is arithmetic about
     the data, which is precisely the claim G9 says rots. A wrapping flex run
     cannot push content past the card's edge at ANY count, so the max-width
     above stays a bound rather than a bet. */
  .cells { display:flex; flex-wrap:wrap; max-width:340px; gap:2px; align-content:flex-start; }
  .cell { width:7px; height:7px; border-radius:1.5px; background:#5d6b7d; }
  .cell.DRIFTED  { background:#b45309; }
  .cell.DIVERGED { background:#b91c1c; }
  .cell.REVERSED { background:#6d28d9; }
  .cell.stale { outline:1px solid rgba(240,180,41,0.55); outline-offset:0; }

  .warn { color:#ff7b72; font-size:12px; }
  .ok   { color:#3fb950; font-size:12px; }
  .foot { display:flex; gap:10px; font-size:10px; color:#5d6b7d; margin-top:10px;
          padding-top:8px; border-top:1px solid rgba(90,105,125,0.18); }
  .foot .sp { margin-left:auto; }
  .foot .lk { cursor:pointer; }
  .foot .lk:hover { color:#9aa7b8; }
  .stale { color:#f0b429; }
  .gate { font-size:9.5px; color:#4a5563; margin-top:6px; }
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
        className={live ? 'row act' : 'row'}
        onClick={live ? () => openView(r.cta.route, dispatch) : undefined}
      >
        <span className="lbl">{r.label}</span>
        <span className="track">
          <span
            className={`fill ${r.tone}`}
            style={{ width: r.ratio == null ? '100%' : `${Math.round(r.ratio * 100)}%` }}
          />
        </span>
        <span className={`val ${r.tone}`}>
          <b>{r.value == null ? '—' : r.value}</b> <span className="unit">{r.unit}</span>
        </span>
        <span className={live ? 'go' : 'go soon'}>{live ? '›' : 'not built yet'}</span>
      </div>
      {(r.extra || []).length ? <div className="sub">{r.extra.join(' · ')}</div> : null}
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
    <div className={dragging ? 'card dragging' : 'card'} style={{ left: at.left, top: at.top }}>
      <div
        className="grip"
        onMouseDown={(e) => beginDrag(e, at, dispatch)}
        onDoubleClick={() => dispatch({ type: 'RESET_POS' })}
      >
        {head}
      </div>
      <div className="body">{body}</div>
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
    : <div className="gate">rows need an Übersicht interaction shortcut + Accessibility access</div>;

  const snap = d.snapshot || {};
  const stale = snap.ok && snap.ageMs != null && snap.ageMs > 3600000;

  return card(
    <div className="hd">
      <span className="ttl">propagate</span>
      <span className={`big ${h.tone}`}>{h.value == null ? '?' : h.value}</span>
      <span className="of">
        {h.value == null
          ? h.label
          : `${h.label} of ${d.edges.expanded} edges · ${d.edges.declared} declared`}
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
        <span className="lk" onClick={() => openView('/queue', dispatch)}>queue &#8250;</span>
        <span className={stale ? 'sp stale' : 'sp'}>
          {snap.ok ? `snapshot ${ageText(snap.ageMs)}` : (snap.reason || 'no snapshot')}
        </span>
      </div>
      {gate}
    </div>,
  );
};
