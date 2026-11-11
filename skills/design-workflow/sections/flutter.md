# flutter: the design workflow, per step

*Section of the parent skill (`design-workflow`). Read it when the surface is Flutter. It has no frontmatter on purpose: with one it would become a discoverable skill.*

| Step | How, in Flutter |
|---|---|
| 1 audit + deps | **custom:** a Dart deriver that lists which components, tokens and files a change touches, in both directions (#243). Until it ships, grep the widget catalog by hand. |
| 3 tokens + drift | The design spec is the source; a test compares it to the Dart theme (the pilot has `theme_test.dart`). DTCG plus code generation is optional. |
| 4 motion | The `animations` package; implicit and explicit animations; honour `MediaQuery.disableAnimations`. |
| 6 states | A `WidgetStateProperty` matrix per component, with one Widgetbook use case per state. |
| 7 token bypass | **custom:** an `analysis_server_plugin` lint, or a standalone `analyzer` tool, that flags raw colours and sizes in widgets (#245). |
| 8 a11y | `meetsGuideline` (tap target, label, contrast) in widget tests, plus a screen-reader pass. |
| 8 visual | Alchemist or the existing golden tests. |
| 8 motion | **custom:** frame goldens plus a reduced-motion test (#246). |
| 9 reference integrity | **custom:** `curate-docs report` resolves the DESIGN.md's backticked names against `.dart` source with comments stripped (#242, built). |
