# widget/ has moved

The propagate queue widget is the native panel in the widgets app:
`Rupali/claude-usage-widget/widgets/Sources/PropagateQueue/` (Rupali59/claude-usage-widget#128, decision D42 there:
the SwiftUI app is the renderer). It runs `cli.mjs surface --json` by absolute path, so the data stays here.

## What moved, and what is still in this directory

The Übersicht widget and its collector script were deleted in Rupali59/propagate#415, after the native panel had been
checked. Its tests went with it, except the contracts that are about the payload rather than the renderer, which now
live in `tests/unit/surface-payload-contract.test.mjs` (the payload's nested fields, view reachability, and that
every field the Swift decoder reads exists on the payload). The Lucide icon vendoring script went too: it only fed
the deleted widget.

| File | Why it stays |
|---|---|
| `open-ui.sh` | Not widget-only: `lib/report/notify.mjs` builds its click command from it, and the native panel calls it to open a route. It is propagate's UI opener. Tested by `tests/cli/widget-scripts.test.mjs`. |

The payload contract is `lib/report/surface.mjs`; its decoder is `QueueContract.swift` in the module above. A field
renamed there changes the panel, and `tests/unit/surface-payload-contract.test.mjs` fails when the decoder reads a
field the payload no longer carries (it skips with a stated reason when no claude-usage-widget clone surrounds this one).
