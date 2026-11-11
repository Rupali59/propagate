# design-workflow: the full workflow

*Section of the parent skill (`design-workflow`). Read it when you are planning or doing UI work. It has no frontmatter on purpose: with one it would become a discoverable skill.*

## The ten steps

| # | Step | Artefact | Check |
|---|---|---|---|
| 1 | **Understand the docs and audit** what exists | the product DESIGN.md read; an inventory of existing components | `propagate design deps` lists what the change touches (not built yet: #243); reuse before build |
| 2 | **Proposal / need** | one paragraph: what, why, and why no existing component fits | named in the plan; plan-approval check (#244) |
| 3 | **Foundations as tokens** | colour, type, spacing, elevation and motion tokens in the token source | schema and drift check between spec and code |
| 4 | **Motion and imagery spec** | DESIGN.md Motion (easing and duration tokens; each moment's trigger and reduced-motion fallback) and Imagery | motion tokens validated like any token; the reduced-motion path exists |
| 5 | **Concept prototype** | a sketch, mock or in-app prototype | design review of the real system, not only a mock |
| 6 | **Design spec (definition of ready)** | anatomy, tokens used, states (component and screen), responsive behaviour, accessibility notes | spec completeness against the definition of done |
| 7 | **Implement per stack** | the component built from tokens only | the token-bypass check; code review |
| 8 | **Verify** | test results | accessibility, visual regression, the state matrix exercised, motion evaluation |
| 9 | **Document and release** | DESIGN.md Decisions Log updated; catalog entry | **reference integrity**: every name the doc asserts resolves (`curate-docs report`, built in #242) |
| 10 | **Adopt and maintain** | a maturity status per component (draft, then stable) | curate-docs on the doc; checks in CI |

## Definition of done for a component

- reuse is justified;
- tokens only;
- the state matrix is covered;
- responsive and globalised (hi/en);
- accessible: guidelines plus a screen reader;
- tested: unit and visual regression;
- documented with do's and don'ts;
- motion uses tokens and has a reduced-motion path (our addition: neither Carbon nor GOV.UK lists motion).

**Where sources disagree, decided here.** Design-first for anything users see (code-first against
design-first handoff), because the failure this prevents is builds that ignore decided design.
Shipping before full compliance is allowed only as `draft`, never as `stable`.

## The matrix

A cell names an existing tool first. `custom` appears only where none fits, and each custom cell names its issue.

| Step | flutter | web | other |
|---|---|---|---|
| 1 audit + deps | **custom** Dart deriver (#243) | **custom** TS deriver (#248) | when reached |
| 3 tokens + drift | spec-to-Dart test | CSS variables + Tailwind theme | when reached |
| 4 motion | `animations`, `disableAnimations` | motion library, `prefers-reduced-motion` | when reached |
| 6 states | `WidgetStateProperty` + Widgetbook | Storybook per state | when reached |
| 7 token bypass | **custom** analyzer lint (#245) | ESLint rule | when reached |
| 8 a11y | `meetsGuideline` | axe via Playwright | when reached |
| 8 visual | Alchemist / goldens | Playwright screenshots | when reached |
| 8 motion | **custom** frame goldens (#246) | **custom** Playwright (#246) | when reached |
| 9 reference integrity | **custom** curate-docs rule (#242) | same rule | same rule |

## Sources

Brad Frost, Atomic Design ch. 4 and governance process; GOV.UK contribution criteria; Carbon
component checklist and motion; Fluent 2 motion; the DTCG token format (a draft); the
Curtis/Figma doneness matrix. EightShapes and Material 3 were consulted but not verified.
