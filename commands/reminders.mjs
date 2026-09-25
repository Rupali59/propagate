/**
 * `propagate reminders` — a read-only report over the `Claude TODO` Reminders
 * list, routed by body hashtag. Implements the read path of
 * `docs/plans/2026-09-23-reminders-todo-bridge.md`; the mutable stores (the
 * UUID<->PR-0NN identity map, the reconciliation log, `--apply`) are L5's,
 * not this command's — see the plan's "The L4/L5 boundary".
 *
 * WRITES NOTHING. No file under this command's control changes as a result
 * of running it, with or without `--json`, tested by
 * `tests/cli/reminders.test.mjs` snapshotting the whole state directory
 * byte-for-byte before and after.
 *
 * EXIT CODES, per F1 — the split this whole lane exists to make:
 *   0  ok — including a genuinely empty list. Zero reminders is a real result.
 *   2  inconclusive — could not look (TCC denial, missing list, timeout, …).
 *      Never renders as "0 reminders"; the reason is in both the text and
 *      the `--json` payload so it is machine-readable for whatever consumes
 *      this later (doctor's `inconclusive` entry kind, per N87 — wiring that
 *      in is explicitly L5's job, not this command's).
 */
import { readReminders, DEFAULT_LIST } from "../lib/reminders/read.mjs";

/**
 * @param {string[]} [argv]
 * @param {typeof console} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function remindersCmd(argv = [], io = console) {
  const asJson = argv.includes("--json");
  const listFlagIdx = argv.indexOf("--list");
  const listName = listFlagIdx !== -1 ? argv[listFlagIdx + 1] : DEFAULT_LIST;

  // Test-only seam, documented in lib/reminders/read.mjs — never set in
  // ordinary use.
  const fixturePath = process.env.PROPAGATE_REMINDERS_FIXTURE || undefined;

  const result = await readReminders({ listName, fixturePath });

  if (!result.ok) {
    if (asJson) {
      io.log(JSON.stringify({ ok: false, list: result.list, reason: result.reason, reasonDetail: result.reasonDetail, code: result.code }));
    } else {
      io.log(`reminders: could not read "${result.list}" — ${result.reason}`);
      io.log(`  ${result.reasonDetail}`);
      io.log(`  this is INCONCLUSIVE, not zero reminders — nothing was written`);
    }
    return 2;
  }

  if (asJson) {
    io.log(JSON.stringify(result));
    return 0;
  }

  render(result, io);
  return 0;
}

function render(result, io) {
  const { list, items, summary } = result;
  io.log(`reminders — "${list}" (${summary.total} item${summary.total === 1 ? "" : "s"})`);

  if (summary.total === 0) {
    io.log("  (empty)");
    return;
  }

  const byProject = new Map();
  for (const item of items) {
    if (item.route.kind !== "routed") continue;
    const key = item.route.project;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(item);
  }

  for (const [project, rows] of byProject) {
    io.log(`\n  ${project} (#${rows[0].route.tag})`);
    for (const r of rows) {
      const mark = r.completed ? "x" : " ";
      io.log(`    [${mark}] ${r.title}${r.completed && r.completedAt ? ` (completed ${r.completedAt})` : ""}`);
    }
  }

  const unknown = items.filter((i) => i.route.kind === "held-unknown-tag");
  if (unknown.length) {
    io.log(`\n  HELD — unresolvable tag (reported, not routed, not guessed):`);
    for (const r of unknown) io.log(`    #${r.route.tag} — ${r.title}`);
  }

  const untagged = items.filter((i) => i.route.kind === "held-untagged");
  if (untagged.length) {
    io.log(`\n  HELD — untagged (${untagged.length}), written nowhere:`);
    for (const r of untagged) io.log(`    ${r.title.slice(0, 72)}`);
  }
}
