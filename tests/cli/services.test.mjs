/**
 * `propagate services` end to end: exit codes, JSON shape, and the manifest column through the CLI.
 * Fixtures only. PROPAGATE_HUB_ROOT / SEARCH_ROOTS point discovery at the fixture hub.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeHub } from "../helpers/services-fixture.mjs";

// eslint-disable-next-line no-control-regex
const plain = (t) => t.replace(/\x1B\[[0-9;]*m/g, "");
const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function run(h, argv, extraEnv = {}, root = h.hub) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_STATE_DIR: process.env.PROPAGATE_STATE_DIR ?? path.join(tmpdir(), "propagate-test-state"),
      PROPAGATE_HUB_ROOT: h.hub,
      PROPAGATE_SEARCH_ROOTS: root,
      PROPAGATE_SERVICES_FILE: h.integrations.servicesFile,
      PROPAGATE_SERVICES_DIR: h.integrations.servicesDir,
      PROPAGATE_DEPLOY_FILE: h.integrations.deployFile,
      GOTCHA_GUARD_GLOBAL: h.gotchasFile,
      PROPAGATE_SERVICES_MIN_UNITS: "1",
      ...extraEnv,
    },
  });
}

test("services --json: exit 1 on findings, one JSON shape, per-service unit counts", () => {
  const h = makeHub();
  try {
    const r = run(h, ["services", "--json"]);
    assert.equal(r.status, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.shape, "propagate-services/1");
    assert.equal(j.state, "ok");
    assert.deepEqual(Object.fromEntries(j.services.map((s) => [s.id, s.unit_count])), { vercel: 2, doppler: 1, telegram: 1 });
    assert.ok(j.findings.length > 0);
  } finally {
    h.cleanup();
  }
});

test("services --service/--workspace narrow the output; text output lists units then findings", () => {
  const h = makeHub();
  try {
    const j = JSON.parse(run(h, ["services", "--json", "--service", "vercel", "--workspace", "Ws"]).stdout);
    assert.deepEqual(j.services.map((s) => s.id), ["vercel"]);
    const t = run(h, ["services"]);
    assert.equal(t.status, 1);
    assert.match(plain(t.stdout), /vercel\s+2 unit\(s\)/);
    assert.match(t.stdout, /# findings/);
    assert.match(t.stdout, /UNPAGED/);
    assert.equal(run(h, ["services", "--service"]).status, 2, "a flag with no value is refused, not ignored");
  } finally {
    h.cleanup();
  }
});

test("an empty root exits 2 with the blind-scan message, in text and JSON", () => {
  const h = makeHub();
  const empty = mkdtempSync(path.join(tmpdir(), "services-empty-"));
  try {
    const t = run(h, ["services"], { PROPAGATE_SERVICES_MIN_UNITS: "10" }, empty);
    assert.equal(t.status, 2, t.stderr);
    assert.match(t.stdout, /gone blind/);
    const j = run(h, ["services", "--json"], { PROPAGATE_SERVICES_MIN_UNITS: "10" }, empty);
    assert.equal(j.status, 2);
    assert.equal(JSON.parse(j.stdout).state, "could-not-run");
  } finally {
    rmSync(empty, { recursive: true, force: true });
    h.cleanup();
  }
});

test("a missing services.yml exits 2 with the reason", () => {
  const h = makeHub();
  try {
    const r = run(h, ["services"], { PROPAGATE_SERVICES_FILE: path.join(h.hub, "nope.yml") });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /could-not-run.*not found/);
  } finally {
    h.cleanup();
  }
});

test("manifest prints the services column and the credential gap, and is unchanged without services.yml", () => {
  const h = makeHub();
  try {
    const on = run(h, ["manifest", h.ws]);
    assert.match(plain(on.stdout), /p1\s.*svc vercel/);
    assert.match(plain(on.stdout), /service, no credential location/);
    // An unset file falls back to <hub>/scripts/execution/services.yml, so point the hub elsewhere.
    const elsewhere = mkdtempSync(path.join(tmpdir(), "services-nohub-"));
    try {
      const off = run(h, ["manifest", h.ws], { PROPAGATE_SERVICES_FILE: "", PROPAGATE_HUB_ROOT: elsewhere });
      assert.equal(off.status, 0, off.stderr);
      assert.doesNotMatch(plain(off.stdout), /svc |service, no credential location|services/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});
