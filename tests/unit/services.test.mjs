/**
 * Tests for lib/report/services.mjs, lib/report/doctor/services.mjs and the manifest services column.
 * Fixtures only (tests/helpers/services-fixture.mjs); the real hub is never read.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test tests/unit/services.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { loadServices, buildServicesReport, derive, collectUnits, unitsFromManifest, annotateManifest, ENV_NAMES, FINDING_STATES } from "../../lib/report/services.mjs";
import { workspaceManifest } from "../../lib/report/manifest.mjs";
import { checkServices } from "../../lib/report/doctor/services.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { makeHub, opts, servicesYaml, ENVIRONMENTS_YAML } from "../helpers/services-fixture.mjs";

const states = (r) => r.findings.map((f) => f.state + (f.cause ? `/${f.cause}` : ""));
const svc = (r, id) => r.services.find((s) => s.id === id);

test("fixture hub plus fixture units produce the expected unit x service matrix, with evidence kinds", () => {
  const h = makeHub();
  try {
    const r = buildServicesReport(opts(h));
    assert.equal(r.state, "ok", r.reason);
    assert.equal(r.units_scanned, 4);
    const row = (u, s) => r.matrix.find((x) => x.unit === u && x.service === s);
    assert.deepEqual(row("p1", "vercel").evidence.map((e) => e.kind), ["dep"]);
    // p2 is detected by TWO independent kinds, kept separate.
    assert.deepEqual(row("p2", "vercel").evidence.map((e) => e.kind), ["file", "env-name"]);
    assert.deepEqual(row("p3", "doppler").evidence, [{ kind: "registry", detail: "deploy.yml:doppler" }]);
    assert.deepEqual(row("p4", "telegram").evidence.map((e) => e.kind), ["dep"]);
    assert.equal(r.matrix.length, 4, "no other unit x service pair may appear");
    assert.deepEqual([svc(r, "vercel").unit_count, svc(r, "doppler").unit_count, svc(r, "telegram").unit_count], [2, 1, 1]);
  } finally {
    h.cleanup();
  }
});

test("env names come from .env*.example only: a real .env.local is never opened", () => {
  const h = makeHub();
  try {
    const r = buildServicesReport(opts(h));
    const p2 = r.matrix.find((x) => x.unit === "p2" && x.service === "vercel");
    const names = p2.evidence.filter((e) => e.kind === "env-name").map((e) => e.detail);
    assert.deepEqual(names, ["VERCEL_TOKEN"], "VERCEL_CANARY lives only in .env.local, which must not be read");
  } finally {
    h.cleanup();
  }
});

test("every finding state has a fixture that produces it", () => {
  const h = makeHub();
  try {
    const r = buildServicesReport(opts(h));
    const by = (s) => r.findings.filter((f) => f.state === s);
    assert.equal(by("UNPAGED").length, 1);
    assert.equal(by("UNPAGED")[0].service, "doppler", "doppler is used and has no page file");
    assert.equal(by("STUB-IN-USE")[0].service, "telegram");
    // The two staleness causes are reported separately, never merged.
    assert.deepEqual(by("STALE-LIMIT").map((f) => f.cause).sort(), ["over-90-days", "unverified"]);
    assert.ok(!by("STALE-LIMIT").some((f) => /fresh/.test(f.detail)), "a limit verified 16 days ago is not stale");
    const hz = by("HAZARD-UNTRIGGERED");
    assert.deepEqual(hz.map((f) => f.hazard).sort(), ["G-NOPE", "G-ZZ"], "G-AA is live, so it is not reported");
    assert.match(hz.find((f) => f.hazard === "G-ZZ").detail, /no live \*\*Trigger:\*\*/);
    assert.match(hz.find((f) => f.hazard === "G-NOPE").detail, /not in the global gotchas index/);
    const nc = by("NO-CREDENTIAL-LOCATION");
    assert.deepEqual(nc.map((f) => f.unit), ["p1"], "only p1 has a sidecar without credentials: and uses a credentialed service");
    assert.equal(by("ENV-UNKNOWN")[0].service, "doppler", "deep, in use, no environments block");
    assert.equal(by("ENV-UNKNOWN").length, 1, "vercel declares environments; the stub is exempt");
    // could-not-run is produced by the cases below; SCAN-SKIPPED and UNIT-NOT-ON-DISK by their own tests at the
    // end of this file (a throwing manifest, a not-on-disk project), which this fixture hub has neither of.
    const elsewhere = new Set(["could-not-run", "SCAN-SKIPPED", "UNIT-NOT-ON-DISK"]);
    assert.deepEqual([...new Set(r.findings.map((f) => f.state))].sort(), FINDING_STATES.filter((s) => !elsewhere.has(s)).sort());
    assert.equal(r.exit, 1);
  } finally {
    h.cleanup();
  }
});

test("unknown schema_version is could-not-run with the reason, never zero services", () => {
  const h = makeHub({ services: servicesYaml({ schema: 2 }) });
  try {
    const r = buildServicesReport(opts(h));
    assert.equal(r.state, "could-not-run");
    assert.match(r.reason, /schema_version is 2/);
    assert.equal(r.exit, 2);
    assert.deepEqual(r.services, []);
    assert.deepEqual(states(r), ["could-not-run"]);
  } finally {
    h.cleanup();
  }
});

test("a missing, unparseable or wrong-shape services.yml is could-not-run, each with its own reason", () => {
  const h = makeHub();
  try {
    const f = h.integrations.servicesFile;
    assert.match(loadServices(null).reason, /not configured/);
    assert.match(loadServices(path.join(h.hub, "nope.yml")).reason, /not found/);
    writeFileSync(f, "schema_version: 1\nservices: [unclosed");
    assert.match(loadServices(f).reason, /unparseable/);
    writeFileSync(f, "schema_version: 1\nservices: {}\n");
    assert.match(loadServices(f).reason, /no `services:` mapping/);
    writeFileSync(f, "- just\n- a list\n");
    assert.match(loadServices(f).reason, /not a mapping/);
  } finally {
    h.cleanup();
  }
});

test("environments: the four canonical keys load and are carried in the JSON; any other key is a schema problem", () => {
  const h = makeHub();
  try {
    const ok = buildServicesReport(opts(h));
    assert.deepEqual(Object.keys(svc(ok, "vercel").environments), [...ENV_NAMES]);
    assert.equal(svc(ok, "vercel").environments.preview.doppler_config, "stg");
    assert.equal(svc(ok, "doppler").environments, null, "absent block reads as null, not as an empty set");

    for (const bad of ["staging", "prod", "dev", "stg"]) {
      writeFileSync(h.integrations.servicesFile, servicesYaml({ vercelEnvs: ENVIRONMENTS_YAML + `      ${bad}: { x: 1 }\n` }));
      const l = loadServices(h.integrations.servicesFile);
      assert.equal(l.ok, false, `${bad} must be rejected`);
      assert.ok(l.problems.some((p) => p.includes(`environments.${bad}`) && /unknown environment/.test(p)), `${bad}: ${l.reason}`);
    }
  } finally {
    h.cleanup();
  }
});

test("schema problems are all reported, none dropped", () => {
  const h = makeHub({ services: servicesYaml({ vercelFiles: "[a]", extra: "  Bad_Id:\n    status: maybe\n" }) });
  try {
    const l = loadServices(h.integrations.servicesFile);
    assert.equal(l.ok, false);
    assert.ok(l.problems.some((p) => /Bad_Id: id must be lowercase/.test(p)));
    assert.ok(l.problems.some((p) => /Bad_Id: status must be deep or stub/.test(p)));
    assert.ok(l.problems.some((p) => /Bad_Id: page is required/.test(p)));
  } finally {
    h.cleanup();
  }
});

test("an empty root is a blind scan: could-not-run, exit 2, named as such", () => {
  const h = makeHub();
  try {
    const r = buildServicesReport({ ...opts(h), workspaces: [], minUnits: 10 });
    assert.equal(r.state, "could-not-run");
    assert.equal(r.exit, 2);
    assert.match(r.reason, /the scan has gone blind: only 0 unit\(s\)/);
    // And the floor applies to a non-empty but too-small tree, not just to nothing.
    const small = buildServicesReport(opts(h, { minUnits: 5 }));
    assert.match(small.reason, /only 4 unit\(s\).*floor is 5/);
  } finally {
    h.cleanup();
  }
});

test("removing one detect rule turns that unit's file evidence off, for that reason only", () => {
  const h = makeHub({ services: servicesYaml({ vercelFiles: "[]" }) });
  try {
    const r = buildServicesReport(opts(h));
    const p2 = r.matrix.find((x) => x.unit === "p2" && x.service === "vercel");
    // p2 still matches through env-name, so the unit survives and ONLY the removed kind disappears.
    assert.deepEqual(p2.evidence.map((e) => e.kind), ["env-name"]);
    assert.equal(r.matrix.length, 4);
  } finally {
    h.cleanup();
  }
});

test("--service and --workspace filter the output, and an unknown name is could-not-run, not empty", () => {
  const h = makeHub();
  try {
    const one = buildServicesReport(opts(h, { service: "telegram" }));
    assert.deepEqual(one.services.map((s) => s.id), ["telegram"]);
    assert.deepEqual(one.findings.map((f) => f.state), ["STUB-IN-USE"]);
    assert.match(buildServicesReport(opts(h, { service: "nope" })).reason, /no service named "nope"/);
    assert.match(buildServicesReport(opts(h, { workspace: "Nope" })).reason, /no workspace named "Nope"/);
    assert.equal(buildServicesReport(opts(h, { workspace: "Ws" })).matrix.length, 4);
  } finally {
    h.cleanup();
  }
});

test("derive is unit x service from units alone: a unit with no evidence has no row", () => {
  const h = makeHub();
  try {
    const l = loadServices(h.integrations.servicesFile);
    const units = collectUnits(h.workspaces, { integrations: h.integrations });
    assert.deepEqual(derive(units, l.services, {}).map((r) => `${r.unit}:${r.service}`).sort(), ["p1:vercel", "p2:vercel", "p4:telegram"], "no registry rows given, so p3 has no evidence");
  } finally {
    h.cleanup();
  }
});

test("manifest services column: ids per unit, and a gap for a credentialed service with no credentials: declared", () => {
  const h = makeHub();
  try {
    const m = workspaceManifest(h.ws, { integrations: h.integrations });
    const before = JSON.stringify(m);
    // Not configured: manifest is untouched.
    assert.deepEqual(annotateManifest(m, { integrations: { ...h.integrations, servicesFile: null } }), { state: "not-configured" });
    assert.equal(JSON.stringify(m), before);

    assert.deepEqual(annotateManifest(m, { integrations: h.integrations }), { state: "ok" });
    const ids = Object.fromEntries(m.projects.flatMap((p) => p.units.map((u) => [u.rel, u.services])));
    assert.deepEqual(ids, { p1: ["vercel"], p2: ["vercel"], p3: ["doppler"], p4: ["telegram"] });
    const gaps = m.gaps.filter((g) => g.kind === "service-no-credential-location");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].project, "p1");
    assert.match(gaps[0].detail, /needs vercel/);

    const bad = { ...h.integrations, servicesFile: path.join(h.hub, "nope.yml") };
    const m2 = workspaceManifest(h.ws, { integrations: h.integrations });
    assert.equal(annotateManifest(m2, { integrations: bad }).state, "could-not-run");
    assert.ok(m2.projects.every((p) => p.units.every((u) => !("services" in u))), "a could-not-run must not leave empty columns that read as 'no services'");
  } finally {
    h.cleanup();
  }
});

test("doctor module: info when unconfigured, inconclusive when broken, one pass line when clean, warn on findings", async () => {
  const h = makeHub();
  try {
    const run = async (extra) => {
      const reporter = new Reporter();
      await checkServices({ reporter, ...opts(h), ...extra });
      return reporter;
    };
    const none = await run({ integrations: { ...h.integrations, servicesFile: null } });
    assert.deepEqual(none.entries.map((e) => e.kind), ["info"]);
    assert.equal(none.problems, 0);

    const found = await run({});
    assert.deepEqual(found.entries.map((e) => e.kind), ["warn"], "findings are one warn line, never a failure");
    assert.equal(found.problems, 0);
    assert.match(found.entries[0].detail, /1 UNPAGED/);

    const broken = await run({ integrations: { ...h.integrations, servicesFile: path.join(h.hub, "nope.yml") } });
    assert.deepEqual(broken.entries.map((e) => e.kind), ["inconclusive"]);
    assert.equal(broken.problems, 1);

    const blind = await run({ minUnits: 99 });
    assert.deepEqual(blind.entries.map((e) => e.kind), ["inconclusive"]);
    assert.match(blind.entries[0].detail, /gone blind/);
  } finally {
    h.cleanup();
  }

  // A clean tree: every unit credentialed, no limits, no hazards, pages present, environments declared.
  const clean = makeHub({
    services: `schema_version: 1
services:
  vercel:
    title: Vercel
    status: deep
    page: rules/conventions/services/vercel.md
    accounts: [{ name: a }]
    detect: { deps: ["@vercel/analytics"], files: ["vercel.json"] }
${ENVIRONMENTS_YAML}`,
    credentials: {},
  });
  try {
    const reporter = new Reporter();
    await checkServices({ reporter, ...opts(clean) });
    assert.deepEqual(reporter.entries.map((e) => e.kind), ["pass"], "clean is exactly one line");
    assert.equal(reporter.problems, 0);
  } finally {
    clean.cleanup();
  }
});

// ── 2026-11-05 review fixes: absence is attributable, and registries join at the project root ──

test("a workspace whose manifest throws is reported as skipped, never silently dropped", () => {
  const skipped = [];
  const units = collectUnits([{ name: "Broken", root: "/x/Broken" }], {
    skipped,
    manifest: () => { throw new Error("sidecar unreadable"); },
  });
  assert.equal(units.length, 0);
  assert.deepEqual(skipped, [{ workspace: "Broken", reason: "sidecar unreadable" }]);
});

test("a declared project not on disk is reported, not counted as using no services (Sindhu sipl-tms, 2026-11-05)", () => {
  const notOnDisk = [];
  const m = {
    workspace: "Ws",
    workspaceRoot: "/x/Ws",
    projects: [
      { project: "app", onDisk: false, isWorkspaceItself: false, repo_root: "Ws/app", units: [{ rel: "Ws/app", toolchain: "unknown" }] },
      { project: "workspace", onDisk: true, isWorkspaceItself: true, repo_root: "Ws", units: [{ rel: "Ws", toolchain: "none" }] },
    ],
  };
  assert.deepEqual(unitsFromManifest(m, { notOnDisk }), []);
  assert.deepEqual(notOnDisk, [{ workspace: "Ws", project: "app", repo_root: "Ws/app" }]);
});

test("a registry row keyed by the project root matches a unit below it (SSJK-astro-darpan/tools)", () => {
  const units = [{ workspace: "Ws", project: "site", rel: "site/tools", abs: "/nonexistent/Ws/site/tools" }];
  const services = [{ id: "cloudflare", detect: { deps: [], files: [], env: [], registries: [{ file: "deploy", field: "cloudflare_pages" }] } }];
  const rows = derive(units, services, { registryRows: { deploy: { "Ws/site": { cloudflare_pages: "site" } } } });
  assert.deepEqual(rows.map((r) => `${r.unit}:${r.service}:${r.evidence[0].detail}`), ["site/tools:cloudflare:deploy.yml:cloudflare_pages"]);
});

test("an ancestor row is ignored when the project has several units, and `none` is not a value (SSJK-mb/server, astro-darpan)", () => {
  const svc = [{ id: "vercel", detect: { deps: [], files: [], env: [], registries: [{ file: "deploy", field: "vercel" }] } }];
  const multi = ["server", "ui"].map((n) => ({ workspace: "Ws", project: "mb", rel: `mb/${n}`, abs: `/nonexistent/Ws/mb/${n}` }));
  assert.deepEqual(derive(multi, svc, { registryRows: { deploy: { "Ws/mb": { vercel: "mb-ui" } } } }), [], "two units: the project row names neither");
  const one = [{ workspace: "Ws", project: "site", rel: "site/tools", abs: "/nonexistent/Ws/site/tools" }];
  assert.deepEqual(derive(one, svc, { registryRows: { deploy: { "Ws/site": { vercel: "none" } } } }), [], "vercel: none means no Vercel project");
});
