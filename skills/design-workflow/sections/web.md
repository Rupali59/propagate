# web (Next.js / React): the design workflow, per step

*Section of the parent skill (`design-workflow`). Read it when the surface is Next.js or React. It has no frontmatter on purpose: with one it would become a discoverable skill.*

| Step | How, on the web |
|---|---|
| 1 audit + deps | **custom:** a TypeScript deriver for components, tokens and files a change touches (#248). Until it ships, search the component directory by hand. |
| 3 tokens + drift | CSS variables plus the Tailwind theme as the token source; a test that every token named in DESIGN.md is defined in the stylesheet. |
| 4 motion | A motion library (framer-motion / motion) with durations and easings from tokens; honour `prefers-reduced-motion`. |
| 6 states | One Storybook story per state. |
| 7 token bypass | An ESLint rule against raw colours and a `var()` with no defined token. |
| 8 a11y | axe, driven by Playwright. |
| 8 visual | Playwright screenshots. |
| 8 motion | **custom:** the same frame-evaluation idea as Flutter, in Playwright (#246). |
| 9 reference integrity | **custom:** `curate-docs report` resolves backticked names against `.ts`, `.tsx`, `.js`, `.jsx`, `.css` source with comments stripped (#242, built). |
