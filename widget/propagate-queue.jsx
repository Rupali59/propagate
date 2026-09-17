// propagate-queue — the disposition backlog on the desktop layer.
//
// WHY IT NAMES EDGES INSTEAD OF COUNTING THEM. The complaint this answers was
// "I see something drifting, but can't see what". A widget that renders `48
// actionable` is the same failure in a nicer font. Every row below carries the
// workspace-qualified path, because 53 files in this tree are named CLAUDE.md
// and `CLAUDE.md → CLAUDE.md` was the correct rendering of seven different
// edges until 2026-09-17.
//
// NO IMPORTS, deliberately — the convention `claude-usage.jsx` set and the
// reason it gives: a widget that fails to resolve a relative import fails
// SILENTLY on the desktop layer, and there is no headless test that renders
// this file.
//
// INTERACTION IS IMPOSSIBLE HERE. Übersicht removes the tracking area and sets
// ignoresMouseEvents:YES on the desktop layer, so `:hover` never fires. Nothing
// may live in a tooltip; every fact must be legible in the static render. That
// is why the edge id is shown inline — it is what you type into
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
// §2 — prefer derive-on-demand over remember-in-background; that rule records a
// 60-second watcher that ran 4,420 times and found nothing in 4,384 of them.
// Drift does not change faster than commits, and the monitor already runs on a
// 30-minute cadence, so a 5-minute derive is ahead of the thing it watches.
export const refreshFrequency = 300000;

export const className = `
  left: 20px; top: 20px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #e6edf3;
  width: 430px;
  background: rgba(11,13,16,0.88);
  border: 1px solid rgba(90,105,125,0.35);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.45);
  -webkit-font-smoothing: antialiased;

  .hd { display:flex; align-items:baseline; gap:8px; margin-bottom:2px; }
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
     history are majority no-op (N85) — a queue that hides that trains you to
     answer "no" without looking. */
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

// Flat function components, no JSX nested inside a helper that Übersicht's
// transform cannot resolve — claude-usage.jsx records "Can't find variable:
// React" at render time as the failure mode this avoids.
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

export const render = ({ output, error }) => {
  if (error) return <div className="warn">propagate queue — {String(error)}</div>;

  let d;
  try {
    d = JSON.parse(output);
  } catch (e) {
    // Rendering nothing here would be indistinguishable from a clean tree.
    return <div className="warn">propagate queue — unreadable output</div>;
  }

  // `queue --json` emits `{error, items:null}` rather than an empty queue when
  // it cannot derive, precisely so this branch exists.
  if (d.error) return <div className="warn">propagate queue — {d.error}</div>;
  if (!d.items) return <div className="warn">propagate queue — no items field</div>;

  const s = d.summary;

  // ZERO DECLARED IS NOT A CLEAN TREE — it is a scan that found no graph at all,
  // which is what a broken config looks like (an unreadable PROPAGATE_STATE_DIR
  // yields `{items:[], declared:0}`). Rendering that green would be exactly the
  // defect filed as N87: a report whose population excluded the failures still
  // printing a pass. Caught here by running the command with a bad state dir
  // rather than by reasoning about it.
  if (d.declared === 0) {
    return (
      <div>
        <div className="hd"><span className="ttl">propagate</span></div>
        <div className="warn">0 edges declared — nothing was scanned, not a clean tree</div>
        <div className="foot">check the config: propagate doctor</div>
      </div>
    );
  }

  if (d.items.length === 0) {
    // "Nothing actionable" and "nothing declared" are different facts, so the
    // denominator is shown even when the numerator is zero.
    return (
      <div>
        <div className="hd"><span className="ttl">propagate</span></div>
        <div className="ok">no actionable edges</div>
        <div className="foot">{d.declared} declared · derived {String(d.generatedAt).slice(11, 16)}</div>
      </div>
    );
  }

  const shown = d.items.slice(0, 4);

  return (
    <div>
      <div className="hd">
        <span className="ttl">propagate</span>
        <span className="big">{s.total}</span>
        <span className="of">actionable of {d.declared} declared</span>
      </div>

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

      <div className="foot">derived {String(d.generatedAt).slice(11, 16)} · sorted: needs-a-look first</div>
    </div>
  );
};
