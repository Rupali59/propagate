import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStatus, setStatus, STATUSES, backfillFromRenames } from "../lib/state.mjs";
import { loadConfig } from "../lib/config.mjs";

const cfg = () =>
  loadConfig(mkdtempSync(path.join(tmpdir(), "cd-r-")), { home: mkdtempSync(path.join(tmpdir(), "cd-h-")) });
const tmp = () => mkdtempSync(path.join(tmpdir(), "cd-st-"));

/** Every byte of every file — the artifact a write gate must leave untouched. */
function snapshot(dir) {
  const parts = [];
  (function rec(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) rec(f);
      else parts.push(`${path.relative(dir, f)}|${statSync(f).size}|${readFileSync(f, "utf8")}`);
    }
  })(dir);
  return parts.join("\n--\n");
}

// ---------- reading ----------

test("no marking anywhere means active, and active is IMPLICIT (no key written)", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "# a\n");
  const s = readStatus(f, d, cfg());
  assert.equal(s.status, "active");
  assert.equal(s.source, "default");
});

test("frontmatter wins over every inference", () => {
  const d = tmp();
  mkdirSync(path.join(d, "docs/archive"), { recursive: true });
  const f = path.join(d, "docs/archive/x-superseded-2026-01-01.md");
  writeFileSync(f, "---\nstatus: active\n---\n# x\n");
  const s = readStatus(f, d, cfg());
  assert.equal(s.status, "active");
  assert.equal(
    s.source,
    "frontmatter",
    "inference is a default for docs nobody classified, never an override of someone who did",
  );
});

test("filename suffix is read when frontmatter is silent — the live convention", () => {
  const d = tmp();
  for (const [name, want] of [
    ["p-shipped-2026-06-15.md", "archived"],
    ["p-superseded-2026-05-05.md", "superseded"],
    ["p_stale-2026-06-28-endpoints.md", "archived"],
  ]) {
    const f = path.join(d, name);
    writeFileSync(f, "# p\n");
    const s = readStatus(f, d, cfg());
    assert.equal(s.status, want, name);
    assert.equal(s.source, "filename");
  }
});

test("directory is the weakest signal and still counts", () => {
  const d = tmp();
  mkdirSync(path.join(d, "docs/archive"), { recursive: true });
  const f = path.join(d, "docs/archive/old.md");
  writeFileSync(f, "# old\n");
  const s = readStatus(f, d, cfg());
  assert.equal(s.status, "archived");
  assert.equal(s.source, "directory");
});

test("an unknown status value is REPORTED, never silently treated as active", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "---\nstatus: sortof-dead\n---\n# a\n");
  const s = readStatus(f, d, cfg());
  assert.equal(s.status, "unknown");
  assert.equal(s.declared, "sortof-dead");
  assert.match(s.why, /not one of/);
});

// ---------- the write gate (rule:safety-flag-needs-a-test) ----------

test("WITHOUT --apply, no disposition touches a single byte of the tree", () => {
  const d = tmp();
  mkdirSync(path.join(d, "docs"));
  writeFileSync(path.join(d, "docs/a.md"), "# a\n");
  writeFileSync(path.join(d, "docs/b.md"), "---\ntitle: B\n---\n# b\n");
  const before = snapshot(d);
  for (const status of STATUSES) {
    for (const f of ["docs/a.md", "docs/b.md"]) {
      setStatus(
        path.join(d, f),
        { status, because: "shipped", supersededBy: "docs/z.md", on: "2026-08-19" },
        {},
      );
      assert.equal(snapshot(d), before, `${status} on ${f} WITHOUT --apply must not touch the tree`);
    }
  }
});

test("without --apply it still RETURNS the exact content it would have written", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "# a\n");
  const r = setStatus(f, { status: "archived", because: "shipped", on: "2026-08-19" }, {});
  assert.equal(r.applied, false);
  assert.match(r.after, /^---\nstatus: archived\n/);
  assert.match(r.after, /archived_because: shipped/);
  assert.ok(r.after.endsWith("# a\n"), "the body must survive untouched");
});

test("with --apply it writes, and only the frontmatter keys change", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "---\ntitle: A\ntags: [x]\n---\n# a\n\nbody\n");
  setStatus(f, { status: "archived", because: "dropped", on: "2026-08-19" }, { apply: true });
  const out = readFileSync(f, "utf8");
  assert.match(out, /title: A/, "existing keys must be preserved verbatim");
  assert.match(out, /tags: \[x\]/);
  assert.match(out, /status: archived/);
  assert.ok(out.endsWith("# a\n\nbody\n"), "body untouched");
});

test("setting status is idempotent — re-applying changes nothing", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "# a\n");
  const args = { status: "archived", because: "shipped", on: "2026-08-19" };
  setStatus(f, args, { apply: true });
  const once = readFileSync(f, "utf8");
  setStatus(f, args, { apply: true });
  assert.equal(readFileSync(f, "utf8"), once);
});

test("superseded requires naming what replaced it — an unnamed supersession is the known defect", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "# a\n");
  assert.throws(
    () => setStatus(f, { status: "superseded", on: "2026-08-19" }, { apply: true }),
    /superseded_by/,
    "75 of 105 supersession claims in this tree name no file; this refuses to add the 106th",
  );
});

test("an invalid status is refused before any write is attempted", () => {
  const d = tmp();
  const f = path.join(d, "a.md");
  writeFileSync(f, "# a\n");
  const before = snapshot(d);
  assert.throws(() => setStatus(f, { status: "deleted" }, { apply: true }), /not one of/);
  assert.equal(snapshot(d), before);
});

// ---------- backfill ----------

test("git rename pairs backfill a status and a reason from the encoded suffix", () => {
  const pairs = [
    {
      from: "docs/plans/2026-06-14-pr-drafts.md",
      to: "docs/archive/2026-06-14-pr-drafts-shipped-2026-06-15.md",
    },
    { from: "docs/a.md", to: "docs/archive/a-superseded-2026-05-05.md" },
    { from: "design/design-spec.md", to: "docs/design/design-spec.md" },
  ];
  const got = backfillFromRenames(pairs, cfg());
  assert.deepEqual(
    got.map((g) => [g.path, g.status, g.because, g.on]),
    [
      ["docs/archive/2026-06-14-pr-drafts-shipped-2026-06-15.md", "archived", "shipped", "2026-06-15"],
      ["docs/archive/a-superseded-2026-05-05.md", "superseded", "superseded", "2026-05-05"],
    ],
  );
  assert.equal(got.length, 2, "a plain move with no lifecycle suffix must not be inferred as archived");
});
