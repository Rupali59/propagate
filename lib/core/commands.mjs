/**
 * commands.mjs — the CLI's subcommands as DATA, so the help text and the flag
 * validator cannot disagree.
 *
 * WHY THIS EXISTS (ISSUES N69, S1). There was no unknown-flag rejection
 * anywhere in this CLI, so `verify --edge X --disposition d --note "<the whole
 * justification>"` was accepted, exited 0, printed a tick and an event id, and
 * dropped the note on the floor. Twenty real verification events landed that
 * way, closing a 15-edge cascade, carrying no record of why. The store is
 * append-only and those edges have since resolved, so the justifications can
 * never be attached later by any supported path — the loss is permanent at the
 * moment the command returns.
 *
 * A dropped argument is an absence that attributes to nothing
 * (`rule:discernment-checks` §2). This table is what makes it attributable.
 *
 * WHY A TABLE RATHER THAN A CHECK. The obvious fix is a per-subcommand
 * allowlist beside the parser. That is a second list, and a second list drifts:
 * add a flag, forget the allowlist, and a working command starts refusing. This
 * repo has paid for that exact shape twice (G70: a curated population that
 * proves nothing about what it omits; G71: an extraction that silently grew).
 *
 * So the table carries BOTH the usage text and the flag kinds, `renderUsage()`
 * builds the help line from it, and `validateFlags()` validates against it.
 * They read the same object, so they cannot disagree — and a test asserts every
 * flag appearing in an `args` string is declared in that command's `flags`,
 * which closes the remaining gap between the two fields.
 *
 * TRANSCRIBED, NOT INVENTED. Every entry below comes from the usage literal
 * that shipped at HEAD, and `tests/unit/cli-commands.test.mjs` asserts
 * `renderUsage()` is BYTE-IDENTICAL to it. That assertion is what makes this a
 * refactor rather than a rewrite of the interface.
 *
 * ON `value` vs `boolean`: it is load-bearing. It is what lets the validator
 * skip a flag's ARGUMENT instead of mistaking `--reason "see --edge for why"`
 * for an unknown flag. A boolean-only allowlist would reject legitimate text.
 */

/**
 * @typedef {{args: string, flags: Record<string, "value"|"boolean">}} Command
 * @type {Record<string, Command>}
 */
export const COMMANDS = {
  "status": { args: "", flags: { "--json": "boolean", "--cross": "boolean", "--all": "boolean" } },
  "doctor": { args: "", flags: { "--json": "boolean" } },
  "migrate-refs": { args: "<workspace> [--apply] [--json]", flags: { "--apply": "boolean", "--json": "boolean" } },
  "release": { args: "--check [--json]", flags: { "--check": "value", "--json": "boolean" } },
  "init": { args: "<dir> [--workspace|--edges-only]", flags: { "--edges-only": "boolean", "--workspace": "boolean" } },
  "reload": { args: "", flags: {  } },
  "check": { args: "[--changed|--range <a>..<b>|--staged] [--strict]", flags: { "--changed": "boolean", "--range": "value", "--staged": "boolean", "--strict": "boolean", "--json": "boolean" } },
  "drain": { args: "[--all] [--close <id>[,<id>...] --status <done|wontfix|partial> [--reason ...] [--notes ...] [--closed-by ...]] [--group <correlation_id> ...] [--json]", flags: { "--all": "boolean", "--close": "value", "--closed-by": "value", "--group": "value", "--json": "boolean", "--notes": "value", "--reason": "value", "--status": "value", "--cross": "boolean" } },
  "reconcile": { args: "[--all] [--inbound] [--group-by glob|node|none] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--json]", flags: { "--all": "boolean", "--downstream-ref": "value", "--group-by": "value", "--inbound": "boolean", "--json": "boolean", "--ref": "value", "--source-ref": "value" } },
  "why": { args: "<edge_id> [--all] [--json]", flags: { "--all": "boolean", "--json": "boolean" } },
  "verify": { args: "(--edge <id>|--node <id>|--glob <pattern>) [--state <STATE>] --disposition <d> [--reason ...|--note ...] [--out-of-order] [--ref <ref> | --source-ref <ref> --downstream-ref <ref>] [--apply] [--json]", flags: { "--apply": "boolean", "--disposition": "value", "--downstream-ref": "value", "--edge": "value", "--glob": "value", "--json": "boolean", "--node": "value", "--note": "value", "--out-of-order": "boolean", "--reason": "value", "--ref": "value", "--source-ref": "value", "--state": "value" } },
  "bootstrap": { args: "[--baseline-from-git|--baseline-all|--none] [--bound <n>] [--apply] [--json]", flags: { "--apply": "boolean", "--baseline-all": "boolean", "--baseline-from-git": "boolean", "--bound": "value", "--json": "boolean", "--none": "boolean" } },
  "inventory": { args: "[--json|--emit-rows]", flags: { "--emit-rows": "boolean", "--json": "boolean" } },
  "skills": { args: "[--json]", flags: { "--json": "boolean" } },
  "skills-create": { args: "<name> <intent>", flags: {  } },
  "skills-promote": { args: "<name>", flags: {  } },
  "skills-demote": { args: "<name>", flags: {  } },
  "skills-reap": { args: "[--apply]", flags: { "--apply": "boolean" } },
  "backlog": { args: "[--json]", flags: { "--json": "boolean" } },
  "goals": { args: "[--json]", flags: { "--json": "boolean" } },
  "plans": { args: "[--check] [--root <path> ...] [--json]", flags: { "--check": "boolean", "--json": "boolean", "--root": "value" } },
  "ui": { args: "[--port <n>]", flags: { "--port": "value" } },
  "queue": { args: "[--json]", flags: { "--json": "boolean" } },
  "surface": { args: "[--json]", flags: { "--json": "boolean" } },
  "graph-index": { args: "[--emit sqlite|cypher] [--out <path>] [--json]", flags: { "--emit": "value", "--json": "boolean", "--out": "value" } },
  "graph": { args: "[--all] [--node <path>] [--include-unverified] [--html <path>] [--json]", flags: { "--all": "boolean", "--html": "value", "--include-unverified": "boolean", "--json": "boolean", "--node": "value" } },
  "monitor": { args: "[--dry-run] [--json]", flags: { "--dry-run": "boolean", "--json": "boolean" } },
  "manifest": { args: "<workspace> [--json]", flags: { "--json": "boolean" } },
  "docs": { args: "[<file>...|--all|--kinds|--structure [--tables]|--superseded [<doc>]]", flags: { "--all": "boolean", "--kinds": "boolean", "--structure": "value", "--superseded": "value", "--tables": "boolean", "--check": "boolean", "--dry-run": "boolean", "--force": "boolean", "--json": "boolean", "--doctrine": "boolean", "--reference": "boolean", "--undeclared": "boolean" } },
  "journal": { args: "--since <iso> [--until <iso>] [--json]", flags: { "--json": "boolean", "--since": "value", "--until": "value" } },
  "rollup": { args: "[--check|--dry-run] [--force] [--json]", flags: { "--check": "boolean", "--dry-run": "boolean", "--force": "boolean", "--json": "boolean" } },
  "claims check": { args: "[--json]", flags: { "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean", "--apply": "boolean" } },
  "claims judge": { args: "<file> [--json]", flags: { "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean", "--apply": "boolean" } },
  "claims render": { args: "<file> [--apply] [--json]", flags: { "--apply": "boolean", "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean" } },
  "claims contradict": { args: "<authored-file> [--json]", flags: { "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean", "--apply": "boolean" } },
  "claims restate": { args: "[--json]", flags: { "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean", "--apply": "boolean" } },
  "claims verdict": { args: "[--apply] [--json] < verdicts.json", flags: { "--apply": "boolean", "--json": "boolean", "--run": "boolean", "--outcome": "boolean", "--reason": "boolean" } },
  "claims answer": { args: "<file> start|end --run <id> --outcome <o> [--json]", flags: { "--json": "boolean", "--outcome": "value", "--run": "value", "--reason": "boolean", "--apply": "boolean" } },
  "reminders": { args: "[--list <name>] [--json]", flags: { "--json": "boolean", "--list": "value", "--apply": "boolean" } },
  "reminders sync": { args: "[--apply] [--json]", flags: { "--apply": "boolean", "--json": "boolean", "--list": "boolean" } },

  // ── handled by cli.mjs, documented by no usage string ──────────────────
  //
  // Measured 2026-09-26: cli.mjs dispatches 41 modes and the usage literal
  // named 33. These eight are the difference. Four of them (`freeze-ledger`,
  // `migrate-ledger`, `relocate-ledger`, `rules`) print their OWN usage line
  // when misused; `caps`, `registers`, `setup` and `migrate` print none.
  //
  // `flags: null` means NOT YET ENUMERATED, and validateFlags() therefore lets
  // them through untouched. That is deliberate and it is the conservative
  // choice: guessing a flag list from a skim of the code risks refusing a flag
  // that works today, which is a worse failure than the one being fixed. Four
  // of these WRITE (`registers`, and the three ledger movers), so a wrong
  // allowlist here breaks a repair tool at the moment it is needed.
  //
  // They are listed rather than omitted so the gap is a NAMED set a test
  // asserts, not an absence nobody can see — `rule:discernment-checks` §2. The
  // set can only shrink, and shrinking it means transcribing a real usage line.
  "caps": { args: null, flags: null },
  "freeze-ledger": { args: null, flags: null },
  "migrate": { args: null, flags: null },
  "migrate-ledger": { args: null, flags: null },
  "registers": { args: null, flags: null },
  "relocate-ledger": { args: null, flags: null },
  "rules": { args: null, flags: null },
  "setup": { args: null, flags: null },
};

/** The usage line, rebuilt from the table. Byte-identical to the literal it replaced. */
export function renderUsage() {
  const entries = Object.entries(COMMANDS)
    // `args: null` is "handled but undocumented" and must not appear here; `args: ""`
    // is a real entry that simply takes no arguments (`status`, `doctor`, `reload`).
    .filter(([, c]) => c.args !== null)
    .map(([name, c]) => (c.args ? `${name} ${c.args}` : name));
  return `usage: node cli.mjs [${entries.join("|")}]`;
}

/**
 * Which command an argv belongs to. Longest match first: `claims check` and
 * `reminders sync` are their own entries and must not resolve to `claims` or
 * `reminders`, which mean different things.
 *
 * @returns {{name: string, rest: string[]}|null} null when the mode is unknown,
 *   which is the CALLER's error to report — this module does not own that
 *   message, and inventing a second one would be two truths about one failure.
 */
export function resolveCommand(argv) {
  const two = `${argv[0]} ${argv[1]}`;
  if (COMMANDS[two]) return { name: two, rest: argv.slice(2) };
  if (COMMANDS[argv[0]]) return { name: argv[0], rest: argv.slice(1) };
  return null;
}

/** Levenshtein, small and local — a suggestion is worth more than a bare refusal. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** The closest declared flag, when it is close enough to be worth naming. */
function nearest(flag, known) {
  let best = null, bestD = Infinity;
  for (const k of known) {
    const d = distance(flag, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 3 ? best : null;
}

/**
 * Reject flags this command does not declare.
 *
 * THE POINT IS THE `value` SKIP. `--reason "see --edge for why"` must not
 * report `--edge` as an unknown flag, so a value-taking flag consumes the token
 * after it. That is why `flags` records a kind rather than a bare list.
 *
 * `--flag=value` is REFUSED rather than accepted, and deliberately: `get()` in
 * cli.mjs reads `args[args.indexOf(flag) + 1]`, so the `=` form has never
 * worked — it silently yields `undefined`. Accepting it here would recreate
 * N69 in a new place: an argument that looks taken and is not.
 *
 * @param {string[]} argv typically `process.argv.slice(2)`
 * @returns {{ok: true, name: string} | {ok: false, name: string|null, code: string, message: string}}
 */
export function validateFlags(argv) {
  const cmd = resolveCommand(argv);
  if (!cmd) return { ok: true, name: null };   // unknown mode — the caller's message, not ours

  const spec = COMMANDS[cmd.name];
  // Not yet enumerated — see the block in the table. Passing through is the
  // conservative behaviour; refusing on an unknown allowlist would break a
  // command that works.
  if (spec.flags === null) return { ok: true, name: cmd.name, unvalidated: true };
  const known = Object.keys(spec.flags);

  for (let i = 0; i < cmd.rest.length; i++) {
    const tok = cmd.rest[i];
    if (typeof tok !== "string" || !tok.startsWith("--")) continue;

    if (tok.includes("=")) {
      const [name] = tok.split("=");
      return {
        ok: false, name: cmd.name, code: "equals-form",
        message: `${cmd.name}: ${tok} — this CLI takes ${name} <value>, not ${name}=<value>. ` +
          "The = form has never worked; it reads as undefined.",
      };
    }

    if (Object.hasOwn(spec.flags, tok)) {
      if (spec.flags[tok] === "value") i++;       // skip the argument, never validate it
      continue;
    }

    const hint = nearest(tok, known);
    return {
      ok: false, name: cmd.name, code: "unknown-flag",
      message: `${cmd.name}: unknown flag ${tok}` + (hint ? ` — did you mean ${hint}?` : "") +
        `\n  known flags: ${known.join(" ") || "(none)"}`,
    };
  }
  return { ok: true, name: cmd.name };
}
