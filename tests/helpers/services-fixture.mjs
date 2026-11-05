/**
 * A fixture hub for the services module: one workspace, four units, a services.yml, a page folder,
 * a gotchas index and a deploy.yml. Fixtures only; the real hub is never read.
 *
 * Units (workspace `Ws`):
 *   p1  pnpm, package.json depends on @vercel/analytics          sidecar: NO credentials:
 *   p2  npm, vercel.json + .env.example (VERCEL_TOKEN) + a .env.local holding a canary
 *       secret name the scan must never see                      sidecar: credentials declared
 *   p3  uv, only a deploy.yml row                                sidecar: credentials declared
 *   p4  npm, depends on node-telegram-bot-api                    sidecar: credentials declared
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const NOW = Date.parse("2026-11-05T00:00:00Z");

export const ENVIRONMENTS_YAML = `    environments:
      local: { note: laptop }
      development: { doppler_config: dev }
      preview: { doppler_config: stg, protection: standard }
      production: { doppler_config: prd, protection: all }
`;

export function servicesYaml({ vercelFiles = '["vercel.json"]', vercelEnvs = ENVIRONMENTS_YAML, schema = 1, extra = "" } = {}) {
  return `schema_version: ${schema}
services:
  vercel:
    title: Vercel
    status: deep
    page: rules/conventions/services/vercel.md
    accounts:
      - { name: tathya-59, kind: team, owner: Rupali }
    limits:
      - { name: crons, value: 100, unit: per-project, source_url: "https://example.com/a", verified: 2026-01-01 }
      - { name: builds, value: 6000, unit: per-month, source_url: "https://example.com/b", verified: unverified }
      - { name: fresh, value: 1, unit: x, source_url: "https://example.com/c", verified: 2026-10-20 }
    detect:
      deps: ["@vercel/analytics"]
      files: ${vercelFiles}
      env: ["VERCEL_*"]
    hazards: [G-AA, G-ZZ, G-NOPE]
${vercelEnvs}  doppler:
    title: Doppler
    status: deep
    page: rules/conventions/services/doppler.md
    detect:
      registries: [{ file: deploy, field: doppler }]
  telegram:
    title: Telegram
    status: stub
    page: rules/conventions/services/telegram.md
    detect:
      deps: ["node-telegram-bot-api"]
${extra}`;
}

export const GOTCHAS = `# global

### G-AA · a hazard with a trigger
**Trigger:** \`vercel\\s+git\\s+connect\`
**Fires on:** \`vercel git connect\`
body.

### G-ZZ · a hazard with no trigger line
body only.
`;

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * @param {{services?: string, noPages?: boolean}} [o]
 * @returns {{hub:string, ws:string, integrations:object, gotchasFile:string, workspaces:object[], cleanup:()=>void}}
 */
export function makeHub({ services = servicesYaml(), pages = ["vercel", "telegram"], credentials = { p1: false } } = {}) {
  const hub = mkdtempSync(path.join(tmpdir(), "services-"));
  const ws = path.join(hub, "Ws");
  put(path.join(hub, "scripts/execution/services.yml"), services);
  for (const id of pages) put(path.join(hub, `rules/conventions/services/${id}.md`), `# ${id}\n`);
  put(path.join(hub, "rules/gotchas-global.md"), GOTCHAS);
  put(path.join(hub, "scripts/execution/deploy.yml"), "deployments:\n  Ws/p3:\n    doppler: proj-p3\n");
  put(path.join(ws, ".propagates.yml"), "workspace: true\n");
  const sidecar = (name, withCreds) =>
    put(
      path.join(ws, "propagation/state", name, ".sidecar.yml"),
      `schema_version: 1\nproject: ${name}\nrepo_root: ${name}\nremote: https://x/${name}.git\n` +
        (withCreds ? "credentials:\n  deployed: { see: some-doc }\n" : ""),
    );
  for (const n of ["p1", "p2", "p3", "p4"]) sidecar(n, credentials[n] !== false);
  put(path.join(ws, "p1/pnpm-lock.yaml"), "");
  put(path.join(ws, "p1/package.json"), JSON.stringify({ dependencies: { "@vercel/analytics": "1.0.0" } }));
  put(path.join(ws, "p2/package-lock.json"), "{}");
  put(path.join(ws, "p2/package.json"), "{}");
  put(path.join(ws, "p2/vercel.json"), "{}");
  put(path.join(ws, "p2/.env.example"), "VERCEL_TOKEN=\nOTHER=1\n");
  put(path.join(ws, "p2/.env.local"), "VERCEL_CANARY=hunter2\n");
  put(path.join(ws, "p3/uv.lock"), "");
  put(path.join(ws, "p4/package-lock.json"), "{}");
  put(path.join(ws, "p4/package.json"), JSON.stringify({ dependencies: { "node-telegram-bot-api": "1" } }));
  const integrations = {
    servicesFile: path.join(hub, "scripts/execution/services.yml"),
    servicesDir: path.join(hub, "rules/conventions/services"),
    deployFile: path.join(hub, "scripts/execution/deploy.yml"),
    portsFile: null,
    mongoFile: null,
    accessFile: null,
  };
  return {
    hub,
    ws,
    integrations,
    gotchasFile: path.join(hub, "rules/gotchas-global.md"),
    workspaces: [{ name: "Ws", root: ws }],
    cleanup: () => rmSync(hub, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** Options the report builder needs to stay inside the fixture. */
export const opts = (h, extra = {}) => ({
  workspaces: h.workspaces,
  integrations: h.integrations,
  hubRoot: h.hub,
  gotchasFile: h.gotchasFile,
  minUnits: 1,
  now: NOW,
  ...extra,
});
