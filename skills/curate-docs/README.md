# curate-docs

**Markdown doc lifecycle for a repo whose docs have drifted** — orphaned files, plans
nobody triaged, an archive nobody drained, broken citations between docs. It builds a
citation graph from content, decides what state each document is in, and records that
state in the document itself. It never moves a file to "archive" it and never
regenerates an index to make the orphan count go down — see `SKILL.md` for why both of
those are the failure this tool exists to prevent.

## The pipeline

```
1 DERIVE ──▶ 2 DECLARE ──▶ 3 SALVAGE ──▶ 4 DRAIN ──▶ 5 RECONCILE
  report       state --set   merge live    drain       report again
  impact       --apply       facts fwd     --apply
```

Full detail, including which subskill (`design` vs `eng`) owns which step, is in
`SKILL.md` — this file does not restate it.

## Install

From the `tathya` marketplace, once registered:

```
/plugin install curate-docs@tathya
```

Or as a standalone checkout:

```bash
git clone https://github.com/Rupali59/curate-docs-skill.git
cd curate-docs-skill && npm install
npm test
```

## Commands

```bash
node cli.mjs <mode> <dir> [--extra-root <workspace>]
```

See `SKILL.md` for the mode list and `docs/GOTCHAS.md` before trusting a surprising
count out of any mode.
