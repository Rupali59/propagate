import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReadmeCommands, commandGroupTitles, COMMANDS } from "../../lib/core/commands.mjs";
import { spliceCommands, START, END } from "../../scripts/readme-commands.mjs";

const README = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");

test("README command section equals the text generated from COMMANDS", () => {
  const generated = renderReadmeCommands();
  assert.ok(generated.split("\n").filter((l) => l.startsWith("- `propagate ")).length >= Object.keys(COMMANDS).length,
    "the generator emitted fewer lines than COMMANDS has entries: it has gone blind");
  assert.equal(spliceCommands(README, generated), README,
    "README.md's command section is stale. Regenerate it with: npm run readme:commands");
});

test("README names every command group in its intro", () => {
  const intro = README.slice(0, README.indexOf(START));
  const titles = commandGroupTitles();
  assert.ok(titles.length >= 5, "only " + titles.length + " groups found: the scan has gone blind");
  for (const t of titles) {
    assert.ok(intro.includes(`**${t}**`), `README intro does not name the "${t}" area; add it above ${START} (edge: lib/core/commands.mjs -> README.md)`);
  }
  assert.ok(README.includes(END));
});
