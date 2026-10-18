/**
 * The widget's vendored Lucide block: pinned, hashed, and complete.
 *
 * WHY (decision E8/D9). The widget cannot import an icon package — Übersicht
 * resolves no relative import for a symlinked widget and the marketplace install
 * runs no `npm install` — so a subset of Lucide's node data is COPIED into the
 * file, between `// ---- vendored:lucide begin ----` and `end`, by
 * scripts/vendor-lucide-icons.mjs. `lucide` is not in package.json.
 *
 * A PINNED COPY NOTHING CHECKS IS THE DRIFT THIS PROJECT EXISTS TO DETECT
 * (cli/vendor/preact.js says the same of its own copy). So the header
 * records package, version, license, the icon list and a sha256 of the block
 * body, and this file proves three things:
 *   1. the recorded sha256 matches the body — a hand edit fails here;
 *   2. every icon the widget references is IN the block — a missing glyph is a
 *      silent "?" on a desktop with no console;
 *   3. the header's icon list is the block's keys, and the pin is what the
 *      script pins.
 * The mutation gate for (1) is recorded in the commit message / report: change
 * one character of one path and this goes red for the stated reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";

import { PKG, VERSION, LICENSE, BEGIN, END, referencedIcons } from "../../scripts/vendor-lucide-icons.mjs";

const WIDGET = path.join(import.meta.dirname, "../../widget/propagate-queue.jsx");
const src = readFileSync(WIDGET, "utf8");

function block() {
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  assert.ok(i !== -1 && j !== -1 && j > i, "no vendored:lucide block in the widget - this suite has gone blind");
  const lines = src.slice(i, j).split("\n");           // BEGIN line ... last body line
  const shaAt = lines.findIndex((l) => l.startsWith("// sha256: "));
  assert.ok(shaAt !== -1, "the block header has no sha256 line");
  const header = Object.fromEntries(lines.slice(0, shaAt + 1)
    .filter((l) => /^\/\/ [a-z0-9]+: /.test(l))
    .map((l) => [l.slice(3, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  // The body is every line after the sha256 line up to the end marker, joined
  // with "\n" and no trailing newline - exactly what the script hashes.
  const body = lines.slice(shaAt + 1).join("\n").replace(/\n$/, "");
  return { header, body };
}

test("the vendored block records its provenance and the pin matches the script's", () => {
  const { header } = block();
  assert.equal(header.package, PKG);
  assert.equal(header.version, VERSION);
  assert.equal(header.license, LICENSE);
  assert.match(header.sha256, /^[0-9a-f]{64}$/);
  assert.equal(PKG, "lucide");
  assert.equal(VERSION, "1.55.0", "the plan pins lucide 1.55.0; a bump is a decision, not a drift");
});

test("the recorded sha256 equals the sha256 of the block body (a hand edit fails here)", () => {
  const { header, body } = block();
  assert.ok(body.length > 500, "the block body is implausibly small - the extraction has gone blind");
  const actual = createHash("sha256").update(body).digest("hex");
  assert.equal(actual, header.sha256,
    "the vendored block was edited by hand or has drifted - regenerate it with scripts/vendor-lucide-icons.mjs, do not edit it");
});

test("every icon the widget references exists in the block, and the header lists exactly the block's keys", () => {
  const { header, body } = block();
  // JSON.stringify inside the vm: arrays built there are from another realm and fail deepStrictEqual.
  const icons = JSON.parse(vm.runInNewContext(`(() => { ${body}\n return JSON.stringify(Object.keys(LUCIDE_ICONS)); })()`));
  assert.ok(icons.length >= 10, `only ${icons.length} icons in the block - the plan vendors about ten`);

  const referenced = referencedIcons(src);
  assert.ok(referenced.length >= 10, `only ${referenced.length} icon references found in the widget - the scan has gone blind`);
  const missing = referenced.filter((n) => !icons.includes(n));
  assert.deepEqual(missing, [], `the widget references icons that are not vendored: ${missing.join(", ")}`);

  assert.deepEqual(header.icons.split(", "), [...icons].sort(), "the header's icon list is not the block's keys");
  // Every vendored icon is used: an unreferenced one is dead weight in a file that is read as a whole.
  const unused = icons.filter((n) => !referenced.includes(n));
  assert.deepEqual(unused, [], `vendored but never referenced: ${unused.join(", ")}`);
});

test("every icon is real node data: [tag, attrs] pairs the renderer can draw", () => {
  const { body } = block();
  const data = vm.runInNewContext(`(() => { ${body}\n return JSON.stringify(LUCIDE_ICONS); })()`);
  const icons = JSON.parse(data);
  const TAGS = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
  for (const [name, nodes] of Object.entries(icons)) {
    assert.ok(Array.isArray(nodes) && nodes.length > 0, `${name} has no nodes`);
    for (const [tag, attrs] of nodes) {
      assert.ok(TAGS.has(tag), `${name} uses <${tag}>, which the widget's Icon was not written for`);
      assert.equal(typeof attrs, "object", `${name}: ${tag} has no attribute object`);
    }
  }
});

test("icons render as inline SVG with stroke=currentColor", () => {
  assert.match(src, /stroke="currentColor"/, "the Icon component must stroke with currentColor so the theme colours it");
  assert.match(src, /<svg className="ic"/, "icons are inline SVG");
  assert.doesNotMatch(src.slice(0, src.indexOf(BEGIN)) + src.slice(src.indexOf(END)), /lucide-react|from ['"]lucide/, "lucide is vendored, never imported");
});
