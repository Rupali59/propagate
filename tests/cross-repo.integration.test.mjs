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
  // state keys on the LEXICAL abs path (stable across deletion), not realpath.
  const ifaceKey = path.resolve(vk, "../Motherboard/sdk/iface.ts");
  // First run: bootstrap-seed, NO fire
  const n1 = await processCrossRepo(state, new Set());
  assert.equal(n1, 0, "bootstrap seeds silently");
  assert.ok(state.mtimes[ifaceKey] !== undefined, "external watch file seeded");

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

test("rename fires a moved row (known target now missing)", async () => {
  const { rm } = await import("node:fs/promises");
  const parent = await mkdtemp(path.join(tmpdir(), "xren-"));
  const mb = path.join(parent, "Motherboard"); await mkdir(mb, { recursive: true });
  const playbook = path.join(mb, "PLAYBOOK.md"); await writeFile(playbook, "v1");
  const vk = path.join(parent, "Vipin Kaushik"); await mkdir(vk, { recursive: true });
  await writeFile(path.join(vk, "DESIGN.md"), "d");
  await writeFile(path.join(vk, ".propagates-cross.yml"), `
shared_conventions:
  - watch: ../Motherboard/PLAYBOOK.md
    why: design derives from playbook
    for: DESIGN.md
`);
  const crossJsonl = path.join(parent, "PROPAGATION_CROSS_LEDGER.jsonl");
  __setPartnerRootsForTest([realpathSync(mb)]);
  __setCrossPathsForTest({ searchRoots: [parent], crossJsonl, crossMd: path.join(parent, "PROPAGATION_CROSS_LEDGER.md") });

  const state = { mtimes: {}, lastRunAt: 0, version: 1 };
  await processCrossRepo(state, new Set());           // bootstrap seed
  const playbookKey = path.resolve(vk, "../Motherboard/PLAYBOOK.md");
  assert.ok(state.mtimes[playbookKey] !== undefined, "seeded before rename");

  await rm(playbook);                                 // the rename/move: file gone, edge still declared
  const rows0 = (await readLedger(crossJsonl)).length;
  await processCrossRepo(state, new Set());
  const rows1 = await readLedger(crossJsonl);
  assert.equal(rows1.length, rows0 + 1, "missing-while-declared fires a moved row");
  assert.match(rows1.at(-1).change, /moved|missing|dead/i);
  assert.equal(rows1.at(-1).partner, "Motherboard");
});
