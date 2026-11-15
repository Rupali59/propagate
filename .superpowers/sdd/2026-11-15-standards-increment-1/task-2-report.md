# Task 2 report

## Built
- lib/standards/parse.mjs: `parsePage(text, file)`; problems never throw. Duplicate ids keep both rows and add `duplicate row id X (lines a, b)`. Missing Check gives `{kind:"none",target:null}`. Unknown check kind or state is a problem.
- lib/standards/registry.mjs: `loadRegistry(file)` (schema_version 1, `standards:` mapping; null path = "standards not configured"; broken = "standards.yml unreadable: <err>"; empty mapping = not zero standards) and `loadStandards({standardsFile, standardsDir})` (joins pages; missing page and id mismatch are problems; other standards still load).
- lib/core/config.mjs: INTEGRATIONS `standardsFile`, `standardsDir` plus both env names in INTEGRATIONS_DIAGNOSTIC.
- tests/portability/paths-migration.test.mjs: the two keys added to the pinned set.

## RED then GREEN
RED: tests/unit/standards-parse.test.mjs failed to load (modules absent). GREEN: 14/14, paths-migration 14/14 (scoped runs, PROPAGATE_STATE_DIR temp). Two first-run failures were my wrong expected line numbers (14/31, not 17/36); fixed in the test, not the code.

## Mutation
Replaced `if (ls.length > 1) problems.push` with `if (false) ...`: "a duplicate row id is a problem" went red (13 pass, 1 fail). Restored, cmp identical.

## Concerns
- Registry shape (schema_version + `standards:` map, like services.yml) is my choice from design §2.1; Task 3+ should confirm.
- Version field is raw text ("acme-tool 3.47.7"); Task 3 must extract semver.
- No tests/unit/config*.test.mjs exists; only paths-migration pins the keys.
