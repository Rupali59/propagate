# Vendored libraries for `propagate ui`

Copied from the npm registry tarballs, not installed: propagate ships two ways (npm, and a
marketplace symlink that never runs `npm install`), so `node_modules` cannot be assumed.
Each file is inlined by `page()` in `cli/ui.mjs` as its own `<script>` BEFORE the client.
Nothing here is edited. To update one, replace the file, re-derive the sha256 below, and
re-run `tests/unit/ui-page.test.mjs` (it pins the script count and parses every script).

| file | package | version | licence | source | sha256 |
|---|---|---|---|---|---|
| `preact.js` | preact | 10.29.8 | not re-derived here; see the file header | npm registry | `shasum -a 256 cli/vendor/preact.js` |
| `hooks.js` | preact/hooks | 10.29.8 | as above | npm registry | `shasum -a 256 cli/vendor/hooks.js` |
| `htm.js` | htm | 3.1.1 | as above | npm registry | `shasum -a 256 cli/vendor/htm.js` |
| `d3.min.js` | d3 (`dist/d3.min.js`) | 7.9.0 | ISC (`LICENSE.d3`) | npm registry, `d3@7.9.0` tarball | `f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539` |
| `plot.umd.min.js` | @observablehq/plot (`dist/plot.umd.min.js`) | 0.6.17 | ISC (`LICENSE.observablehq-plot`) | npm registry, `@observablehq/plot@0.6.17` tarball | `4358086467740777dd788d6b27a95cebdbaefdd50c730a3060117073bd7134cb` |

Added 2026-10-16 for the Overview view (d3 and Plot). Plot's UMD build needs the `d3` global,
so `d3.min.js` loads first. Verify any row with `shasum -a 256 cli/vendor/<file>`.

Why a chart library at all, when the rest of the UI draws its own SVG: `DESIGN.md` §5.
