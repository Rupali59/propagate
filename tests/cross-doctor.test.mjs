import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCrossRepo } from "../cli.mjs";
import { __setPartnerRootsForTest } from "../lib/cross-repo.mjs";

test("checkCrossRepo flags a missing external target", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xdoc-"));
  const mb = path.join(parent, "Motherboard"); await mkdir(mb, { recursive: true });
  await writeFile(path.join(mb, "motherboard.json"), "{}");
  const vk = path.join(parent, "Vipin Kaushik"); await mkdir(vk, { recursive: true });
  await writeFile(path.join(vk, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Motherboard/motherboard.json
    kind: contract
    why: real target present
    for: x.ts
  - watch: ../Motherboard/GONE.json
    kind: contract
    why: dead target
    for: y.ts
`);
  __setPartnerRootsForTest([realpathSync(mb)]);
  const res = await checkCrossRepo([parent]);
  assert.equal(res.missing, 1, "one dead external target detected");
  assert.equal(res.edges, 2);
});
