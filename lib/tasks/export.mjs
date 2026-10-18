/**
 * export.mjs — `propagate tasks export --apply` (R2): move open TODOS/ISSUES entries to GitHub
 * issues, then rewrite the register so it delegates to them.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING: a register is rewritten only when EVERY open item in it has
 * a confirmed issue URL (created now, or matched from an earlier run), and the file has nothing
 * held. A half-moved file is two registers, and the reader cannot tell which half is current.
 * So the file is decided BEFORE any write: a file with any held item creates nothing at all.
 *
 * WRITE ORDER PER ITEM: label(s) -> issue -> journal -> project item -> (once per file) register.
 * The issue is journaled the moment it exists, before anything that can fail after it, so a crash
 * leaves the journal naming every issue the run made. The hidden key in the issue body
 * (`<!-- propagate-task key=... -->`) is the second line of defence: a rerun lists the repo's
 * issues, matches by key, and creates nothing for what is already there. Matching is done locally
 * on `gh issue list --state all --json number,url,body` — never `gh search`, which is eventually
 * consistent and would duplicate on resume.
 *
 * THE JOURNAL (`<stateDir>/tasks-export.jsonl`) is append-only; the LAST row per (repo, key) wins.
 * `board` is null (the repo has no linked project), false (item not yet on the board) or true.
 * A row with `board:false` is retried on the next run, because `project item-add` is idempotent.
 *
 * BUDGET. Every content write (label create, issue create, project item-add) counts. Reads do not.
 * When the next write would exceed `budget` the run stops cleanly BEFORE it and reports what
 * remains; a rerun continues from the journal. Writes are spaced `throttleMs` apart (GitHub's
 * secondary limit is 80 content writes a minute).
 *
 * THE REWRITE is checked before it is written (`buildRewrite`), by routes other than the one that
 * cut it (G77: a check that shares the cut's boundaries cannot see the cut's error). Any failed
 * check leaves the file untouched and names the reason.
 *
 * NEVER IN SCOPE HERE: handover files (R3). They are skipped with a printed reason.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { scanStructure } from "../docs/tokens.mjs";
import { parseTodoLikeFile } from "../report/backlog.mjs";
import { entryBlock } from "./plan.mjs";
import { findAllSidecarsRecursive } from "../edges/edges.mjs";
import { loadSidecar } from "../edges/frontmatter.mjs";

export const JOURNAL_NAME = "tasks-export.jsonl";
export const DEFAULT_BUDGET = 400;
export const DEFAULT_THROTTLE_MS = 2000;

const KEY_RE = /<!-- propagate-task key=(.+?) -->/;
const ISSUE_URL_RE = /https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/issues\/(\d+)/;

class BudgetStop extends Error {}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const rowKey = (repo, key) => `${repo}\u0000${key}`;

// ─────────────────────────────────────────────────────────────────────────────
// Journal
// ─────────────────────────────────────────────────────────────────────────────

/** `{rows: Map<repo\0key,row>}` (last row wins) or `{error}`. A torn line is an error, not a skip. */
export function readJournal(file) {
  const rows = new Map();
  if (!existsSync(file)) return { rows };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `journal unreadable: ${err.message}` };
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    try {
      const r = JSON.parse(lines[i]);
      if (!r || typeof r.key !== "string" || typeof r.repo !== "string" || typeof r.url !== "string") throw new Error("row lacks key/repo/url");
      rows.set(rowKey(r.repo, r.key), r);
    } catch (err) {
      return { error: `journal ${file} line ${i + 1} is not a journal row (${err.message}) — fix or remove it; nothing was written` };
    }
  }
  return { rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure rewrite
// ─────────────────────────────────────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleWithoutId(title, id) {
  return String(title).replace(new RegExp(`^\\s*${escapeRe(id)}\\s*[·:—–-]\\s*`), "").trim();
}

/** Is the document, read to its end, outside a fence? Derived from scanStructure, not a second fence regexp. */
function endsOutsideFence(text) {
  return scanStructure(`${text}\n# propagate-sentinel\n`).headings.some((h) => h.text === "propagate-sentinel");
}

/**
 * Build the delegated register text for `text` with `moved` entries cut out and pointer lines in.
 *
 * @param {string} text the register as it is on disk now
 * @param {Array<{id:string,line:number,title:string,url:string,number:number}>} moved every open item, each with its issue
 * @param {{file:string,repo:string,projectLabel:string,date:string}} o
 * @returns {{ok:true,text:string,removedLines:number,insertedLines:string[]}|{ok:false,error:string}}
 */
export function buildRewrite(text, moved, { file, repo, projectLabel, date }) {
  const struct = scanStructure(text);
  const lines = struct.lines;
  const endsNL = text.endsWith("\n");
  const lastReal = endsNL ? lines.length - 1 : lines.length;
  const removed = new Set();

  for (const it of moved) {
    const first = lines[it.line - 1];
    if (first === undefined || struct.fenced.has(it.line)) {
      return { ok: false, error: `${it.id}: line ${it.line} is not an entry any more (fenced or past the end) — the file changed since it was planned` };
    }
    const shaped = /^#{1,6}\s/.test(first) || /^\s*-\s/.test(first);
    const looksRight = shaped && (first.includes(it.id) || /^\s*-\s*\[ \]/.test(first));
    if (!looksRight) return { ok: false, error: `${it.id}: line ${it.line} no longer holds this entry (${JSON.stringify(first.slice(0, 60))})` };
    const block = entryBlock(struct, { line: it.line });
    let end = block.endLine;
    if (block.isHeading) while (end < lastReal && lines[end].trim() === "") end++; // swallow the blank run after a heading block
    for (let l = it.line; l <= end; l++) removed.add(l);
  }

  const kept = [];
  lines.forEach((l, i) => {
    if (!removed.has(i + 1)) kept.push({ text: l, src: i + 1 });
  });

  // ── head ──
  const h1 = struct.headings.find((h) => h.depth === 1 && !removed.has(h.line));
  // A plain name is written as the pilot wrote it (`?q=label:project:propagate`); a name with a
  // space or other character is quoted and percent-encoded so the query still parses as one label.
  const q = /^[\w.:-]+$/.test(projectLabel) ? `label:${projectLabel}` : encodeURIComponent(`label:"${projectLabel}"`);
  const headUrl = `https://github.com/${repo}/issues?q=${q}`;
  const headLines = [
    `**Open work lives in [GitHub issues](${headUrl}) — not in this file.**`,
    "This file keeps finished entries and one pointer line per moved entry; file new work as an issue.",
  ];
  // ── pointers ──
  const pointerLines = moved.map((it) => `- ${it.id} · ${titleWithoutId(it.title, it.id)} — **MOVED** → [#${it.number}](${it.url}) (${date})`);
  const finished = struct.headings.find((h) => h.depth === 2 && /^finished\b/i.test(h.text) && !removed.has(h.line));
  const movedHeading = `### Moved to GitHub ${date}`;

  const out = [];
  const inserted = [];
  const push = (t) => { out.push(t); inserted.push(t); };
  const needBlankAfter = (idx) => kept[idx + 1] !== undefined && kept[idx + 1].text.trim() !== "";

  kept.forEach((k, idx) => {
    out.push(k.text);
    if (h1 && k.src === h1.line) {
      push("");
      for (const l of headLines) push(l);
      if (needBlankAfter(idx)) push("");
    }
    if (finished && k.src === finished.line) {
      push("");
      push(movedHeading);
      push("");
      for (const l of pointerLines) push(l);
      if (needBlankAfter(idx)) push("");
    }
  });
  if (!h1) {
    // No H1 to hang the head on: it goes first.
    out.unshift("", ...headLines);
    inserted.push("", ...headLines);
    if (out[headLines.length + 1]?.trim() !== "") { out.splice(headLines.length + 1, 0, ""); inserted.push(""); }
  }
  if (!finished) {
    // Append a Finished section before the file's final newline (if it has one).
    const tail = ["", "## Finished", "", movedHeading, "", ...pointerLines];
    const hadFinalEmpty = out.length > 0 && out[out.length - 1] === "";
    if (hadFinalEmpty) out.splice(out.length - 1, 0, ...tail);
    else out.push(...tail, "");
    inserted.push(...tail, ...(hadFinalEmpty ? [] : [""]));
  }

  const outText = out.join("\n");
  const verifyArgs = { before: text, after: outText, file, kept: kept.map((k) => k.text), keptSrc: kept.map((k) => k.src), inserted, moved, headUrl };
  const v = verifyRewrite(verifyArgs);
  if (!v.ok) return v;
  // `verifyArgs` is returned so a test can hand `verifyRewrite` a tampered `after` and watch it refuse.
  return { ok: true, text: outText, removedLines: removed.size, insertedLines: inserted, verifyArgs };
}

/**
 * Every check here reads the OUTPUT and compares it to the INPUT by a route other than the cut
 * (G77). Refusing is the default; each failure names itself.
 */
export function verifyRewrite({ before, after, file, kept, keptSrc, inserted, moved, headUrl }) {
  const struct = scanStructure(before);
  // 1. The reader sees a delegated register pointing at the URL the head names.
  const parsed = parseTodoLikeFile(after, file);
  if (parsed.format !== "delegated") return { ok: false, error: `re-parse reads format "${parsed.format}", not "delegated" — the head is not within the reader's window` };
  if (parsed.delegatedTo !== headUrl) return { ok: false, error: `re-parse delegatedTo is ${JSON.stringify(parsed.delegatedTo)}, not ${headUrl}` };

  // 2. Every kept line survives, in order; the rest is exactly what we inserted.
  const outLines = after.split("\n");
  const outStruct = scanStructure(after);
  let ki = 0;
  const extras = [];
  const fencedMismatch = [];
  for (let oi = 0; oi < outLines.length; oi++) {
    if (ki < kept.length && outLines[oi] === kept[ki]) {
      // 3. The same line keeps the same fenced status. (Headings are the case that matters, but
      // every line is checked: a fence delimiter moving flips everything below it.)
      if (struct.fenced.has(keptSrc[ki]) !== outStruct.fenced.has(oi + 1)) fencedMismatch.push(keptSrc[ki]);
      ki++;
    } else extras.push(outLines[oi]);
  }
  if (ki !== kept.length) return { ok: false, error: `only ${ki} of ${kept.length} kept lines were found, in order, in the output — text outside the removed blocks changed` };
  if (extras.length !== inserted.length || [...extras].sort().join("\n") !== [...inserted].sort().join("\n")) {
    return { ok: false, error: `the output carries ${extras.length} line(s) that are not kept text, expected exactly the ${inserted.length} inserted` };
  }
  if (fencedMismatch.length) return { ok: false, error: `fenced status changed for kept line(s) ${fencedMismatch.slice(0, 5).join(", ")}${fencedMismatch.length > 5 ? "…" : ""}` };
  if (endsOutsideFence(before) !== endsOutsideFence(after)) return { ok: false, error: "fence delimiters are no longer balanced" };

  // 4. Byte accounting: kept bytes + inserted bytes + newlines = output bytes.
  const b = (s) => Buffer.byteLength(s);
  const expected = kept.reduce((n, l) => n + b(l), 0) + inserted.reduce((n, l) => n + b(l), 0) + (kept.length + inserted.length - 1);
  if (b(after) !== expected) return { ok: false, error: `byte count ${b(after)} != kept+inserted ${expected}` };

  // 5. Each removed id is in exactly one pointer line.
  for (const it of moved) {
    const n = outLines.filter((l) => l.startsWith(`- ${it.id} · `) && l.includes("**MOVED**")).length;
    if (n !== 1) return { ok: false, error: `${it.id} appears in ${n} pointer line(s), not exactly 1` };
  }
  return { ok: true };
}

function writeAtomic(file, text) {
  const tmp = `${file}.propagate-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// gh
// ─────────────────────────────────────────────────────────────────────────────

function makeGh(gh) {
  if (typeof gh === "function") return gh;
  return (args, { input } = {}) => {
    const r = spawnSync(gh, args, { encoding: "utf8", timeout: 60000, input });
    if (r.error) return { status: 127, stdout: "", stderr: `${gh}: ${r.error.code || r.error.message}` };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

// ─────────────────────────────────────────────────────────────────────────────
// applyExport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} plan a successful `planExport` result
 * @param {object} o
 * @param {string|Function} [o.gh]
 * @param {string} o.stateDir
 * @param {number} [o.budget]
 * @param {number} [o.throttleMs]
 * @param {Date|(() => Date)} [o.now]
 * @param {string[]} [o.edgeRoots] extra roots searched for `.propagates.yml` edges that touch a rewritten file
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 */
export async function applyExport(plan, { gh = process.env.PROPAGATE_GH_BIN || "gh", stateDir, budget = DEFAULT_BUDGET, throttleMs = DEFAULT_THROTTLE_MS, now = () => new Date(), edgeRoots = [], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!plan?.ok) return { ok: false, error: plan?.error ?? "no plan" };
  if (!stateDir) return { ok: false, error: "stateDir is required (the journal lives there)" };
  if (!Number.isInteger(budget) || budget < 1) return { ok: false, error: "budget must be a positive integer" };
  const run = makeGh(gh);
  const date = (typeof now === "function" ? now() : now).toISOString().slice(0, 10);
  const journalPath = path.join(stateDir, JOURNAL_NAME);
  const journal = readJournal(journalPath);
  if (journal.error) return { ok: false, error: journal.error };
  mkdirSync(stateDir, { recursive: true });

  const state = { writes: 0, stopped: false };
  const repoCtx = new Map();
  const results = [];

  async function write(args, opts) {
    if (state.writes >= budget) throw new BudgetStop();
    if (state.writes > 0 && throttleMs > 0) await sleep(throttleMs);
    state.writes++;
    return run(args, opts);
  }

  /** READS for one target repo. {error} when anything could not be read — never a silent empty. */
  function loadRepo(repo) {
    if (repoCtx.has(repo)) return repoCtx.get(repo);
    const ctx = { repo, keys: new Map(), labels: new Set(), project: null, notes: [] };
    const fail = (msg) => { ctx.error = msg; repoCtx.set(repo, ctx); return ctx; };
    const li = run(["issue", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,url,body"]);
    if (li.status !== 0) return fail(`gh issue list failed: ${firstLine(li.stderr || li.stdout)}`);
    let issues;
    try { issues = JSON.parse(li.stdout); } catch { return fail("gh issue list output was not JSON"); }
    if (!Array.isArray(issues)) return fail("gh issue list output was not a list");
    if (issues.length >= 1000) return fail("gh issue list returned 1000 issues — the match could be truncated, so nothing is created");
    for (const i of issues) {
      const m = KEY_RE.exec(i.body ?? "");
      if (m) ctx.keys.set(m[1], { number: i.number, url: i.url });
    }
    const ll = run(["label", "list", "-R", repo, "--limit", "200", "--json", "name"]);
    if (ll.status !== 0) return fail(`gh label list failed: ${firstLine(ll.stderr || ll.stdout)}`);
    try { for (const l of JSON.parse(ll.stdout)) ctx.labels.add(String(l.name).toLowerCase()); } catch { return fail("gh label list output was not JSON"); }
    const [owner, name] = repo.split("/");
    const q = `query{repository(owner:"${owner}",name:"${name}"){projectsV2(first:5){nodes{number owner{... on User{login}... on Organization{login}}}}}}`;
    const pr = run(["api", "graphql", "-f", `query=${q}`]);
    if (pr.status !== 0) return fail(`gh api graphql (linked project) failed: ${firstLine(pr.stderr || pr.stdout)}`);
    try {
      const nodes = JSON.parse(pr.stdout)?.data?.repository?.projectsV2?.nodes ?? [];
      const n = nodes.find((x) => x?.number && x?.owner?.login);
      if (n) {
        ctx.project = { number: n.number, owner: n.owner.login };
        if (nodes.length > 1) ctx.notes.push(`${nodes.length} linked projects; using #${n.number}`);
      } else ctx.notes.push("no board");
    } catch { return fail("gh api graphql output was not JSON"); }
    repoCtx.set(repo, ctx);
    return ctx;
  }

  async function addToBoard(ctx, url) {
    const r = await write(["project", "item-add", String(ctx.project.number), "--owner", ctx.project.owner, "--url", url]);
    return r.status === 0 ? null : `project item-add failed: ${firstLine(r.stderr || r.stdout)}`;
  }

  function journalRow(row) {
    appendFileSync(journalPath, JSON.stringify(row) + "\n");
    journal.rows.set(rowKey(row.repo, row.key), row);
  }

  for (const f of plan.files) {
    const res = { file: f.file, kind: f.kind, status: null, reason: null, total: f.items.length, moved: 0, created: 0, matched: 0, repo: f.target?.repo ?? null, notes: [...(f.notes ?? [])] };
    results.push(res);

    // ── decide the file BEFORE any write ──
    if (f.kind === "handover") { res.status = "skipped"; res.reason = "handover registers are planned-only until R3 (--apply skips them)"; continue; }
    if (f.held.some((h) => h.reason === "delegated")) { res.status = "skipped"; res.reason = f.held[0].detail; continue; }
    if (!f.items.length) { res.status = "skipped"; res.reason = f.note ?? "no open items"; continue; }
    const heldReasons = [...f.held.map((h) => h.reason), ...f.items.flatMap((i) => i.held.map((h) => `${i.id}: ${h.reason}`))];
    if (heldReasons.length) { res.status = "held"; res.reason = `held (${heldReasons.join(", ")}) — nothing is created for this file`; continue; }
    if (state.stopped) { res.status = "not-started"; res.reason = "budget reached earlier in this run"; continue; }

    let text;
    try { text = readFileSync(f.file, "utf8"); } catch (err) { res.status = "failed"; res.reason = `register unreadable: ${err.message}`; continue; }
    if (f.textHash && sha(text) !== f.textHash) { res.status = "failed"; res.reason = "register changed since it was planned — rerun"; continue; }

    const ctx = loadRepo(f.target.repo);
    if (ctx.error) { res.status = "failed"; res.reason = `${f.target.repo}: ${ctx.error}`; continue; }
    for (const n of ctx.notes) if (!res.notes.includes(n)) res.notes.push(n);

    // ── issues ──
    const issues = []; // {id,line,title,url,number}
    let failed = null;
    try {
      for (const it of f.items) {
        const jr = journal.rows.get(rowKey(f.target.repo, it.key));
        const live = ctx.keys.get(it.key);
        let url, number;
        if (jr) {
          url = jr.url; number = jr.number;
          res.matched++;
          if (jr.board === false && ctx.project) {
            const e = await addToBoard(ctx, url);
            if (e) { failed = `${it.id}: ${e}`; break; }
            journalRow({ ...jr, ts: new Date().toISOString(), matched: true, board: true });
          }
        } else if (live) {
          url = live.url; number = live.number;
          res.matched++;
          let board = null;
          if (ctx.project) {
            const e = await addToBoard(ctx, url);
            board = e ? false : true;
            journalRow({ ts: new Date().toISOString(), key: it.key, file: f.file, repo: f.target.repo, number, url, matched: true, board });
            if (e) { failed = `${it.id}: ${e}`; break; }
          } else {
            journalRow({ ts: new Date().toISOString(), key: it.key, file: f.file, repo: f.target.repo, number, url, matched: true, board });
          }
        } else {
          for (const label of it.labels) {
            if (ctx.labels.has(label.toLowerCase())) continue;
            const r = await write(["label", "create", label, "-R", f.target.repo]);
            if (r.status !== 0 && !/already exists/i.test(`${r.stderr}${r.stdout}`)) { failed = `${it.id}: label create ${label}: ${firstLine(r.stderr || r.stdout)}`; break; }
            ctx.labels.add(label.toLowerCase());
          }
          if (failed) break;
          const dir = mkdtempSync(path.join(os.tmpdir(), "propagate-task-"));
          let r;
          try {
            const bodyFile = path.join(dir, "body.md");
            writeFileSync(bodyFile, it.body);
            r = await write(["issue", "create", "-R", f.target.repo, "--title", it.title, "--body-file", bodyFile, "--label", it.labels.join(",")]);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
          const m = r.status === 0 ? ISSUE_URL_RE.exec(r.stdout) : null;
          if (!m) { failed = `${it.id}: issue create failed: ${firstLine(r.stderr || r.stdout) || "no URL in output"}`; break; }
          url = m[0]; number = Number(m[2]);
          res.created++;
          ctx.keys.set(it.key, { number, url });
          // THE JOURNAL BEFORE ANYTHING THAT CAN FAIL AFTER THE ISSUE EXISTS.
          const row = { ts: new Date().toISOString(), key: it.key, file: f.file, repo: f.target.repo, number, url, matched: false, board: ctx.project ? false : null };
          journalRow(row);
          if (ctx.project) {
            const e = await addToBoard(ctx, url);
            if (e) { failed = `${it.id}: ${e}`; break; }
            journalRow({ ...row, ts: new Date().toISOString(), board: true });
          }
        }
        issues.push({ id: it.id, line: it.line, title: it.title, url, number });
      }
    } catch (err) {
      if (err instanceof BudgetStop) state.stopped = true;
      else throw err;
    }

    if (issues.length !== f.items.length) {
      res.moved = issues.length;
      res.status = state.stopped ? "partial-budget" : "partial-failed";
      res.reason = `${issues.length} of ${f.items.length} moved, register untouched${failed ? ` — ${failed}` : state.stopped ? ` — write budget ${budget} reached` : ""}`;
      continue;
    }

    // ── the register: only now, every item has a URL ──
    let nowText;
    try { nowText = readFileSync(f.file, "utf8"); } catch (err) { res.status = "failed"; res.reason = `register unreadable before rewrite: ${err.message}`; continue; }
    if (nowText !== text) { res.status = "failed"; res.reason = "register changed while issues were being created — issues are journaled; rerun"; continue; }
    const projectLabel = (f.items[0].labels.find((l) => l.startsWith("project:")) ?? `project:${f.project}`);
    const rw = buildRewrite(text, issues, { file: f.file, repo: f.target.repo, projectLabel, date });
    if (!rw.ok) { res.status = "refused"; res.reason = `rewrite refused, register untouched: ${rw.error}`; res.moved = issues.length; continue; }
    try {
      writeAtomic(f.file, rw.text);
    } catch (err) {
      res.status = "failed";
      res.reason = `register write failed (${err.message}); the issues are journaled, rerun`;
      res.moved = issues.length;
      continue;
    }
    res.status = "rewritten";
    res.moved = issues.length;
    res.removedLines = rw.removedLines;
    res.insertedLines = rw.insertedLines.length;
  }

  const rewritten = results.filter((r) => r.status === "rewritten");
  const edges = rewritten.length ? await edgesTouching(rewritten.map((r) => r.file), edgeRoots) : [];
  const remaining = results.filter((r) => ["partial-budget", "not-started"].includes(r.status)).length;
  const problems = results.filter((r) => ["failed", "partial-failed", "refused"].includes(r.status)).length;
  return {
    ok: true,
    mode: "apply",
    date,
    journal: journalPath,
    budget,
    writes: state.writes,
    stoppedByBudget: state.stopped,
    remainingFiles: remaining,
    problemFiles: problems,
    files: results,
    edges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `.propagates.yml` edges whose source or downstream is one of `files`. Searched under the repo that
 * holds each file and under `extraRoots`. A load failure is reported as an entry, not dropped.
 */
export async function edgesTouching(files, extraRoots = []) {
  const real = (p) => { try { return path.resolve(p); } catch { return p; } };
  const targets = new Set(files.map(real));
  const roots = new Set(extraRoots.filter((r) => r && existsSync(r)).map(real));
  for (const f of files) {
    const r = spawnSync("git", ["-C", path.dirname(f), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) roots.add(real(r.stdout.trim()));
  }
  const sidecars = new Set();
  for (const root of roots) {
    try { for (const s of await findAllSidecarsRecursive(root, [])) sidecars.add(s); } catch { /* an unreadable root contributes nothing; reported below */ }
  }
  const found = [];
  for (const sc of sidecars) {
    let doc;
    try { doc = await loadSidecar(sc); } catch (err) { found.push({ sidecar: sc, error: `could not load: ${err.message}` }); continue; }
    const dir = path.dirname(sc);
    for (const [src, entry] of Object.entries(doc.sources ?? {})) {
      const srcAbs = real(path.resolve(dir, src));
      for (const d of entry?.propagates_to ?? []) {
        const rel = typeof d === "string" ? d : d?.path;
        if (!rel) continue;
        const dsAbs = real(path.resolve(dir, rel));
        if (targets.has(srcAbs) || targets.has(dsAbs)) {
          found.push({ sidecar: sc, source: srcAbs, downstream: dsAbs, touched: targets.has(srcAbs) ? srcAbs : dsAbs });
        }
      }
    }
  }
  return found;
}
