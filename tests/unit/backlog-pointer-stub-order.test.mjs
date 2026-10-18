/**
 * backlog-pointer-stub-order.test.mjs — a SHORT register that `tasks export --apply` has delegated
 * must read as `delegated`, not `pointer-stub`.
 *
 * `isPointerStubText` matches any heading containing "moved" in a file of 40 lines or fewer, and the
 * export writes `### Moved to GitHub <date>`. Before 0.15.36 the pointer-stub test ran first, so the
 * register the export had just delegated counted nothing and named no tracker. Both directions are
 * pinned: the delegated file stays delegated, and a genuine pointer stub is still a pointer stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTodoLikeFile } from "../../lib/report/backlog.mjs";

test("a short delegated register with a '### Moved to GitHub' heading is delegated", () => {
  const text = [
    "# TODOS", "",
    "**Open work lives in [GitHub issues](https://github.com/o/r/issues?q=label:project:p) — not in this file.**",
    "This file keeps finished entries and one pointer line per moved entry; file new work as an issue.", "",
    "## Finished", "", "### Moved to GitHub 2026-10-17", "",
    "- PR-001 · Thing — **MOVED** → [#1](https://github.com/o/r/issues/1) (2026-10-17)", "",
  ].join("\n");
  const p = parseTodoLikeFile(text, "/x/TODOS.md");
  assert.equal(p.format, "delegated");
  assert.equal(p.delegatedTo, "https://github.com/o/r/issues?q=label:project:p");
});

test("a genuine pointer stub is still a pointer stub", () => {
  const p = parseTodoLikeFile("# DECISIONS — moved\n\nThis file now lives at ../elsewhere/DECISIONS.md\n", "/x/DECISIONS.md");
  assert.equal(p.format, "pointer-stub");
});
