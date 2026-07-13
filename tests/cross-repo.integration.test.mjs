import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { processCrossRepo, __setCrossPathsForTest } from "../watcher.mjs";
import { __setPartnerRootsForTest } from "../lib/cross-repo.mjs";
import { readLedger } from "../lib/ledger.mjs";

async function touch(p, when) { const t = when ?? new Date(); await utimes(p, t, t); }

test("pull edge fires on external file change; bootstrap seeds silently", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "xint-"));
  const mb = path.join(parent, "Motherboard"); await mkdir(path.join(mb, "sdk"), { recursive: true });
  const iface = path.join(mb, "sdk", "iface.ts"); await writeFile(iface, "v1");
  const vk = path.join(parent, "Vipin Kaushik"); await mkdir(path.join(vk, "server"), { recursive: true });
  await writeFile(path.join(vk, "server", "impl.ts"), "impl");
  await writeFile(path.join(vk, ".propagates-cross.yml"), `
platform_contracts:
  - watch: ../Motherboard/sdk/iface.ts
    kind: contract
    why: sdk interface my server implements
    for: server/impl.ts
`);
  const crossJsonl = path.join(parent, "PROPAGATION_CROSS_LEDGER.jsonl");
  __setPartnerRootsForTest([realpathSync(mb)]);   // partner roots are realpath'd (B3 guard)
  __setCrossPathsForTest({ searchRoots: [parent], crossJsonl, crossMd: path.join(parent, "PROPAGATION_CROSS_LEDGER.md") });

  const state = { mtimes: {}, lastRunAt: 0, version: 1 };
  const ifaceReal = realpathSync(iface);   // rows/state key on realpath, not the /var symlink
  // First run: bootstrap-seed, NO fire
  const n1 = await processCrossRepo(state, new Set());
  assert.equal(n1, 0, "bootstrap seeds silently");
  assert.ok(state.mtimes[ifaceReal] !== undefined, "external watch file seeded");

  // Change the external file → fire one inbound row
  await new Promise((r) => setTimeout(r, 10));
  await writeFile(iface, "v2"); await touch(iface);
  const n2 = await processCrossRepo(state, new Set());
  assert.equal(n2, 1, "external change fires one row");
  const rows = await readLedger(crossJsonl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "inbound");
  assert.equal(rows[0].partner, "Motherboard");
  assert.ok(rows[0].correlation_id, "row has a logical-edge correlation_id");
});
