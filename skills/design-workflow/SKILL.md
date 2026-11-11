---
name: design-workflow
description: Use when building or changing UI, components, design tokens, colours, typography, motion, imagery or a DESIGN.md, in any frontend stack (Flutter, Next.js, React, Obsidian, UI5), and before approving a plan that touches a rendered surface. Gives the ten-step design workflow, the definition of done for a component, and the per-stack way to do each step.
---

# design-workflow

A decided design must reach the build. Docs alone do not reach an agent, so this skill is routed by what
you are doing (UI work). Every step is stack-neutral (purpose, artefact, check). The full table, the
definition of done, the per-stack matrix and the sources are in `sections/workflow.md`; the per-stack
detail is in `sections/<stack>.md` (sections, not skills: Read the file when it applies).

## The ten steps

1. Understand the docs and audit what exists.
2. Proposal: what, why, and why no existing component fits.
3. Foundations as tokens.
4. Motion and imagery spec.
5. Concept prototype.
6. Design spec, the definition of ready.
7. Implement per stack, from tokens only.
8. Verify: accessibility, visual regression, states, motion.
9. Document and release; reference integrity.
10. Adopt and maintain, with a maturity status.

Design-first for anything users see. Shipping before full compliance is allowed only as `draft`, never `stable`.

## How to run it

1. **At plan time**, run step 1 before proposing anything: read the product DESIGN.md, then
   `propagate design deps` once it ships (until then: not built yet, #243; audit by hand).
2. Do steps 2 to 6 in the plan, 7 to 8 in the build, 9 to 10 before calling the work done.
3. For the stack in front of you, Read its section. For a stack with no section, the step is done
   with the stack's own tools, "when reached".
4. A name you write in a design doc goes in backticks. `curate-docs report` resolves them against
   the code and says `STALE` for a name that does not exist. A name designed but not built goes in
   the doc's frontmatter `designed-not-built:` list, and leaves it when built.

Read `sections/workflow.md` for each step's check and the definition of done.
