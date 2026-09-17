// propagate-queue — the disposition backlog on the desktop layer, draggable.
//
// WHY IT NAMES EDGES INSTEAD OF COUNTING THEM. The complaint this answers was
// "I see something drifting, but can't see what". A widget rendering `48
// actionable` is that same failure in a nicer font. Every row carries the
// workspace-qualified path, because 53 files in this tree are named CLAUDE.md
// and `CLAUDE.md → CLAUDE.md` was the correct rendering of seven different edges
// until 2026-09-17.
//
// NO IMPORTS, deliberately — the convention claude-usage.jsx set, and its
// reason: a widget that fails to resolve a relative import fails SILENTLY on the
// desktop layer, and there is no headless test that renders this file.
//
// ── HOW DRAGGING WORKS HERE, AND WHY IT IS BUILT THIS WAY ──────────────────
//
// Übersicht has no drag-to-move. These are from the documented API, read rather
// than guessed:
//
//   className     "CSS rules controlling widget positioning", converted to a
//                 class via Emotion ONCE. It is STATIC, so a container position
//                 can never come from state. This is the constraint that shapes
//                 everything below.
//   render        receives (props, dispatch).
//   updateState   (event, previousState) => nextState, which becomes the props
//                 passed to render. Providing it REPLACES the default, so this
//                 file must still handle the command's own {output, error}
//                 events — otherwise the widget drags beautifully and never
//                 shows any data.
//   initialState  the state before any command has run.
//
// So position cannot live in className. The container stays at the origin with
// no box of its own, and the rendered card is `position: fixed` with left/top
// from state — which escapes the container and addresses the screen.
//
// INTERACTION IS A USER SETUP STEP, NOT A CODE ONE. From the docs: "in order to
// receive click events you need to configure an interaction shortcut and give
// Übersicht accessibility access." Until that is done this widget still renders
// and refreshes perfectly; it simply will not drag. The footer says which state
// it is in rather than letting a dead drag look like a broken widget.
//
// Because `:hover` never fires on the non-interactive desktop layer, no fact
// lives in a tooltip. The edge id is inline because it is what you paste into
// `propagate verify --edge <id>`, and there is nowhere else to put it.

// Absolute path: Übersicht runs widget commands from its own widgets directory.
//
// Via collect.sh rather than `node` directly: Übersicht inherits launchd's PATH,
// which does not contain /opt/homebrew/bin. Verified with `env -i` before
// shipping — the direct form fails with `node: command not found`.
export const command = 'bash "$HOME/Documents/GitHub/propagate/widget/collect.sh"';

// 5 minutes. Measured 2026-09-17: `queue --json` costs 1.12s, so this is ~0.37%
// duty — the same order as claude-usage.jsx's file-read collector at 60s.
//
// Deliberately NOT backed by a sampler writing a cache file. rule:delegation-criteria
// §2 prefers derive-on-demand; that rule records a 60-second watcher that ran
// 4,420 times and found nothing in 4,384 of them. Drift does not change faster
// than commits, and the monitor already runs every 30 minutes, so a 5-minute
// derive is ahead of the thing it watches.
export const refreshFrequency = 300000;

const STORE_KEY = 'propagate-queue.pos';
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

export const initialState = { output: '', error: null, pos: loadPos(), dragging: false, moved: false };

// A custom updateState REPLACES the default, so the command's own events are
// handled here too. Forgetting that is the failure mode this comment exists for.
export const updateState = (event, previousState) => {
  const prev = previousState || initialState;
  if (!event) return prev;

  if (event.type === 'DRAG_START') return { ...prev, dragging: true, moved: true };
  if (event.type === 'DRAG_MOVE') return { ...prev, pos: event.pos };
  if (event.type === 'DRAG_END') {
    savePos(prev.pos);
    return { ...prev, dragging: false };
  }
  if (event.type === 'RESET_POS') {
    savePos(DEFAULT_POS);
    return { ...prev, pos: DEFAULT_POS };
  }

  // The documented default command event shape.
  if (event.error) return { ...prev, error: String(event.error) };
  if (typeof event.output === 'string') return { ...prev, output: event.output, error: null };
  return prev;
};

// The container is NOT positioned from state — className is static. It sits at
// the origin carrying only the styles; `.card` holds the real position.
export const className = `
  left: 0; top: 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  -webkit-font-smoothing: antialiased;

  .card {
    position: fixed;
    width: 430px;
    color: #e6edf3;
    background: rgba(11,13,16,0.88);
    border: 1px solid rgba(90,105,125,0.35);
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.45);
  }
  .card.dragging { border-color: rgba(47,129,247,0.7); box-shadow: 0 12px 40px rgba(0,0,0,0.6); }

  /* The grip is the whole header strip, not a small handle — a 12px target is
     unhittable on a layer where the cursor is already doing something else. */
  .grip { padding:10px 14px 2px; cursor: grab; }
  .card.dragging .grip { cursor: grabbing; }
  .body { padding: 0 14px 12px; }

  .hd { display:flex; align-items:baseline; gap:8px; }
  .ttl { font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#8b98a8; }
  .big { font-size:20px; font-weight:700; line-height:1; }
  .of  { font-size:11.5px; color:#8b98a8; }

  .states { display:flex; gap:10px; margin:6px 0 2px; font-size:11.5px; }
  .chip { padding:1px 6px; border-radius:4px; font-weight:700; letter-spacing:.03em; }
  .DRIFTED  { background:rgba(180,83,9,0.28);  color:#f0b429; }
  .DIVERGED { background:rgba(185,28,28,0.28); color:#ff7b72; }
  .REVERSED { background:rgba(109,40,217,0.28);color:#c4b5fd; }
  .UNMATCHED{ background:rgba(55,65,81,0.35);  color:#9aa7b8; }

  /* The noise line is the one number that changes how hard you should look, so
     it sits under the header rather than at the bottom. 83% of edges with real
     history are majority no-op (N85) — a queue that hides that trains a reader
     to answer "no" without looking. */
  .noise { font-size:11.5px; color:#8b98a8; margin-bottom:8px; }
  .noise b { color:#f0b429; }

  .row { border-top:1px solid rgba(90,105,125,0.18); padding:6px 0 5px; }
  .r1 { display:flex; align-items:center; gap:7px; font-size:11px; }
  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color:#8b98a8; }
  .hist { margin-left:auto; color:#6f7d8f; font-size:10.5px; }
  .hist.warn { color:#a1791f; }
  .pair { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size:11px; line-height:1.45; margin-top:3px; word-break:break-all; color:#cdd7e2; }
  .arr { color:#5d6b7d; }

  .more { font-size:11px; color:#6f7d8f; padding-top:7px; }
  .warn { color:#ff7b72; font-size:12px; }
  .ok   { color:#3fb950; font-size:12px; }
  .foot { font-size:10.5px; color:#5d6b7d; margin-top:8px; }
`;

// Flat components. claude-usage.jsx records "Can't find variable: React" as the
// failure mode when a helper nests JSX in a way the transform cannot resolve.
const Row = ({ it }) => (
  <div className="row">
    <div className="r1">
      <span className={`chip ${it.state}`}>{it.state}</span>
      <span className="id">{it.edge_id}</span>
      <span className={it.judgedCount > 0 && it.noiseRatio >= 0.5 ? 'hist warn' : 'hist'}>
        {it.judgedCount === 0
          ? 'never judged'
          : `${it.judgedCount}x · ${Math.round(it.noiseRatio * 100)}% no-op`}
      </span>
    </div>
    <div className="pair">
      {it.sourceShort} <span className="arr">&#8594;</span> {it.downstreamShort}
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

export const render = (state, dispatch) => {
  const { output, error, pos, dragging, moved } = state;
  const at = pos || DEFAULT_POS;

  // The footer distinguishes "drag is available and untried" from "drag works" —
  // if interaction is not configured, nothing here fires and the hint stays,
  // which is the honest reading rather than a widget that looks broken.
  const hint = moved ? 'drag the header · double-click to reset' : 'drag the header to move';

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

  // collect.sh emits {"error": ...} rather than nothing, precisely so this
  // branch can name the reason on the desktop.
  if (d.error || !d.items) {
    return card(bareHead, <div className="warn">{d.error || 'no items field'}</div>);
  }

  // ZERO DECLARED IS NOT A CLEAN TREE — it is a scan that found no graph at all,
  // which is what a broken config looks like. Green here would be the defect
  // filed as N87: a report whose population excluded the failures still printing
  // a pass.
  if (!d.expanded) {
    return card(
      bareHead,
      <div>
        <div className="warn">0 edges scanned — not a clean tree</div>
        <div className="foot">check the config: propagate doctor</div>
      </div>,
    );
  }

  const s = d.summary;
  const stamp = String(d.generatedAt).slice(11, 16);

  if (d.items.length === 0) {
    return card(
      bareHead,
      <div>
        <div className="ok">no actionable edges</div>
        <div className="foot">{d.expanded} edges · {d.declared} declared · derived {stamp} · {hint}</div>
      </div>,
    );
  }

  const shown = d.items.slice(0, 4);
  return card(
    <div className="hd">
      <span className="ttl">propagate</span>
      <span className="big">{s.total}</span>
      <span className="of">actionable of {d.expanded}</span>
    </div>,
    <div>
      <div className="states">
        {Object.keys(s.byState).map((k) => (
          <span key={k} className={`chip ${k}`}>{s.byState[k]} {k}</span>
        ))}
      </div>
      <div className="noise">
        {s.neverJudged} never judged · <b>{s.highNoise}</b> mostly no-op
      </div>
      {shown.map((it) => <Row key={it.edge_id} it={it} />)}
      {d.items.length > shown.length
        ? <div className="more">+{d.items.length - shown.length} more · propagate ui</div>
        : null}
      <div className="foot">derived {stamp} · {hint}</div>
    </div>,
  );
};
