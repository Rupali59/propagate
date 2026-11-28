# widget/ has moved

The propagate queue widget now lives in the native widgets app:
`Rupali/claude-usage-widget/widgets/Sources/PropagateQueue/` (Rupali59/claude-usage-widget#128, decision D42 there:
the SwiftUI app is the renderer). It runs `cli.mjs surface --json` by absolute path, so the data stays here.

## What is still in this directory, and why

| File | Why it stays for now |
|---|---|
| `propagate-queue.jsx`, `collect.sh` | The live Übersicht widget is a symlink to `propagate-queue.jsx`. They go when that link is removed, after the new panel has been seen; then `tests/unit/widget-{contract,charts,icons}.test.mjs`, the widget entries in `theme.test.mjs`, `state-vocabulary-floor.test.mjs` and `ui-page.test.mjs`, and `scripts/vendor-lucide-icons.mjs` go with them. |
| `open-ui.sh` | Not widget-only: `lib/report/notify.mjs` builds its click command from it, and the new panel calls it to open a route. It is propagate's UI opener and stays. |

The payload contract the new widget reads is `lib/report/surface.mjs` (its decoder is `QueueContract.swift` in the
module above). A field renamed there changes both renderers.
