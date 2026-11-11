import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { legacyCrossEntries } from "../../lib/edges/cross-repo.mjs";

// `.propagates-cross.yml` is retired (propagate#117): doctor reports every leftover
// entry and nothing fires from it. These tests keep the N68 corpus guarantees that
// the old `checkCrossRepo` tests held, now over `legacyCrossEntries`.

test("legacyCrossEntries lists each push and pull entry with its file", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-"));
  const ws = path.join(parent, "clientQ"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Platform/one.json
    kind: contract
    why: first entry
    for: x.ts
  - watch: ../Platform/two.json
    kind: contract
    why: second entry
    for: y.ts
`);
  const res = legacyCrossEntries([parent]);
  assert.equal(res.entries.length, 2);
  assert.equal(res.files, 1, "the corpus is reported, not just the verdict (N68)");
  assert.deepEqual(res.entries.map((e) => e.kind), ["pull", "pull"]);
});

test("legacyCrossEntries reaches a sidecar nested under another (N68)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-nest-"));
  const ws = path.join(parent, "Workspace"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Platform/a.json
    kind: contract
    why: the OUTER sidecar, which used to end the walk
    for: outer.ts
`);
  const proj = path.join(ws, "project"); await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../../Platform/b.json
    kind: contract
    why: the nested sidecar, invisible before N68
    for: inner.ts
`);
  const res = legacyCrossEntries([parent]);
  assert.equal(res.files, 2, "BOTH files must be opened — this is the regression guard");
  assert.equal(res.entries.length, 2);
  assert.equal(res.unreadable.length, 0);
});

test("an unparseable legacy file is reported as unreadable, never as clean (N68)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-bad-"));
  const ws = path.join(parent, "Workspace"); await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, ".propagates-cross.yml"), "platform_contracts: [ : : not yaml\n");
  const res = legacyCrossEntries([parent]);
  assert.equal(res.unreadable.length, 1);
  assert.equal(res.files, 0, "and it does not inflate the scanned count");
});
