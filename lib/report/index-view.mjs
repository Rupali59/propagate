/**
 * index-view.mjs — the cross-workspace answer, derived and never remembered.
 *
 * WHY THIS EXISTS. Every question that spans workspaces currently needs its own
 * reader: which workspaces carry open work, which registers exist at all, what
 * could not be read. PR-003 asked whether that means propagation state wants a
 * database. The answer taken on 2026-09-24 was not yet — collapse the parsers and
 * DERIVE the view instead.
 *
 * PURE BY CONSTRUCTION, and that is the load-bearing property rather than a style
 * preference. It takes already-read data and returns an answer: no file reads, no
 * cache, no state. So it cannot go stale, and it "cannot miss a change that
 * happened while it was not looking" — `rule:delegation-criteria` §2, whose worked
 * example is a 60-second watcher that ran 4,420 times and found nothing in 4,384,
 * replaced by a command deriving the same answer in 1.2s.
 *
 * T2 OF THE MEASUREMENT CONTRACT POINTS AT THIS FILE. If it ever acquires a cache,
 * a state file or a staleness check, the derive-on-demand premise failed and a
 * database was the right answer. That is the test set against the recommendation,
 * and it is checkable by reading the imports: this module imports nothing.
 */

/** Workspace name from a register path, relative to the search roots. */
function workspaceOf(file, roots) {
  const p = String(file ?? "");
  for (const r of roots) {
    const root = String(r).replace(/\/+$/, "");
    if (p.startsWith(root + "/")) {
      const rest = p.slice(root.length + 1);
      const first = rest.split("/")[0];
      if (first && first.endsWith(".md")) return "(root)"; // a register at the root itself
      return first || "(root)";
    }
  }
  return "(outside the search roots)";
}

/**
 * @param {{registers?: Array<object>, roots?: string[]}} input
 * @returns {{byWorkspace: Record<string, object>, byKind: Record<string, object>, unreadable: Array<object>, corpus: {files: number, read: number, unreadable: number}, reason: string|null}}
 */
export function indexView({ registers = [], roots = [] } = {}) {
  const byWorkspace = {};
  const byKind = {};
  const unreadable = [];

  for (const r of registers) {
    // AN UNREADABLE REGISTER CONTRIBUTES NO COUNT. Its contents are UNKNOWN, not
    // zero, and folding it in as zero is the reader inventing an answer about work
    // it never saw (`rule:discernment-checks` §2 and §6). 3 of this tree's 105
    // register files parse to an unknown shape today.
    const ws = workspaceOf(r.file, roots);
    const w = (byWorkspace[ws] ??= { live: 0, entries: 0, finished: 0, files: 0, unread: 0 });
    w.files++;

    const k = (byKind[r.kind ?? "(unclassified)"] ??= { files: 0, live: 0, unread: 0 });
    k.files++;

    if (r.unread) {
      w.unread++;
      k.unread++;
      unreadable.push({ file: r.file, workspace: ws, kind: r.kind ?? null, reason: r.reason ?? "no reason recorded" });
      continue;
    }

    w.live += Number(r.live) || 0;
    w.entries += Number(r.entries) || 0;
    w.finished += Number(r.finished) || 0;
    k.live += Number(r.live) || 0;
  }

  const corpus = {
    files: registers.length,
    unreadable: unreadable.length,
    read: registers.length - unreadable.length,
  };

  // AN EMPTY CORPUS IS A REFUSAL, NOT A CLEAN BILL OF HEALTH. This is G68 applied
  // to a new reader before it can repeat it: `0 open` over a corpus of zero files
  // and `0 open` over a healthy tree must not render alike.
  const reason = registers.length === 0 ? "no registers were supplied — nothing was examined, which is not the same as no open work" : null;

  return { byWorkspace, byKind, unreadable, corpus, reason };
}
