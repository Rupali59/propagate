import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuoteLength, findQuote, htmlToText, normalizeText, wordCount } from "../../lib/research/quotes.mjs";

const SENTENCE = "The study didn't find any effect of the intervention on outcomes";

test("a curly apostrophe in the quote matches a straight one in the page, and the reverse", () => {
  const page = "Intro. The study didn't find any effect of the intervention on outcomes, they said.";
  const curly = "The study didn’t find any effect of the intervention on outcomes";
  const r = findQuote(page, curly);
  assert.equal(r.found, true, "curly quote must match a straight page apostrophe");
  assert.equal(r.offset, normalizeText(page).indexOf("The study"));
  assert.equal(findQuote("Intro. The study didn’t find any effect of the intervention on outcomes", SENTENCE).found, true, "straight quote must match a curly page apostrophe");
});

test("curly double quotes, nbsp and soft hyphens do not break a match", () => {
  const page = "He called it “the most ro­bust result” we have seen in this field.";
  assert.equal(findQuote(page, 'called it "the most robust result" we have seen in this field').found, true);
});

test("a quote that spans a [link](url) in the page matches the plain words", () => {
  const page = "Results were [significantly better than the baseline](https://example.com/a_b(c)) across all trials in the sample.";
  const r = findQuote(page, "Results were significantly better than the baseline across all trials");
  assert.equal(r.found, true);
  assert.equal(normalizeText(page).includes("example.com"), false, "the url must not survive normalisation");
});

test("emphasis, code and heading marks are stripped; snake_case survives", () => {
  assert.equal(normalizeText("## **Bold** and *italic* and `code` and _under_ text"), "Bold and italic and code and under text");
  assert.equal(normalizeText("the my_var_name field"), "the my_var_name field");
  assert.equal(normalizeText("![a chart](img.png) caption"), "a chart caption");
});

test("a 2-word quote is refused, even though it occurs in the page", () => {
  const r = findQuote("the intervention failed on every outcome we measured", "the intervention");
  assert.equal(r.found, false);
  assert.equal(r.offset, -1);
  assert.match(r.refused, /2 words; 6-15 are required/);
});

test("the length bounds are 6 and 15 words, inclusive", () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(checkQuoteLength(words(5)).ok, false);
  assert.equal(checkQuoteLength(words(6)).ok, true);
  assert.equal(checkQuoteLength(words(15)).ok, true);
  assert.equal(checkQuoteLength(words(16)).ok, false);
  assert.equal(findQuote(words(16), words(16)).found, false, "an over-long quote is refused, not matched");
});

test("a paraphrase is not found; found false carries no refusal", () => {
  const r = findQuote("The study found no effect of the intervention on outcomes at all", "The research detected zero impact from the intervention on outcomes");
  assert.deepEqual(r, { found: false, offset: -1 });
});

test("wordCount is measured after normalisation", () => {
  assert.equal(wordCount("[one two](http://x) **three**"), 3);
  assert.equal(wordCount(""), 0);
});

test("htmlToText drops scripts, keeps block breaks, decodes entities, and the result is quotable", () => {
  const html = `<html><head><title>T</title><style>p{}</style></head><body><script>var x="not text"</script><h1>Head</h1><p>It&rsquo;s a &quot;fine&quot; day &amp; night.</p><p>Second&nbsp;para <a href="/x">with link</a>.</p></body></html>`;
  const t = htmlToText(html);
  assert.equal(t.includes("not text"), false);
  assert.equal(t.includes("T\n"), false, "head content is dropped");
  assert.match(t, /Head\n+It’s a "fine" day & night\.\n+Second para with link\./);
  assert.equal(findQuote(t, "It's a \"fine\" day & night. Second para with link.").found, true);
});
