When this applies: steps 7 to 10, from assembling the brief to applying it.

# The gate

`P kb review assemble <dir>` merges the lanes with `searches.json` and `fetched.json` and writes `brief.json`,
or refuses and writes nothing. Exit 2 names a lane file that was not understood: re-run that lane.

`P kb review check <dir>` decides. It writes nothing. Typical refusals and what to fix:

- `QUOTE_NOT_FOUND`: the quote is not in the saved body. Re-run that lane; never edit the quote.
- `SOURCE_NOT_FETCHED`: re-fetch it, then assemble again.
- `CITATION_MISMATCH`: an included source no claim cites, or the reverse. Re-run the lane.
- `SEARCH_UNLOGGED`: a search is missing from `searches.json`; run it through `kb discover`.
- `PROTOCOL_*`: the protocol is unapproved, uncommitted, or changed. Never edit the brief to match; ask the
  maintainer.
- `STANDARD_ROW_TIER` and `DUPLICATE_REFERENCE`: the proposal is refused; drop or reshape it in the lane.

`P kb review agree <dir>` prints the blind sample. The second rater is a model, and the maintainer reads nothing she
has not read:

1. `--rater-brief` prints the sample as JSON (urls, saved-text paths, the protocol criteria). Hand exactly that to one
   `propagate:literature-rater` in the foreground: never the lanes' decisions or reasons. Save its JSON object.
2. Record it with `--record <file> --rater <model id> --rater-kind model-referenced --apply`. Add
   `--override <DECISIONS entry id>` only when the protocol still names a person as second reviewer; `check` then
   warns `SCREENING_RATER_MODEL_OVERRIDE` instead of refusing.
3. `--disagreements` lists each lane-vs-rater disagreement and the tolerable count.
   - **0 disagreements:** apply.
   - **Within the count:** file the lines as one `needs:rupali` issue, one word each (`lane` or `rater`); after the
     maintainer answers, save `{<url>: lane|rater}` and run `--adjudicate <file> --apply`.
   - **Over the count (exit 1):** re-run the lanes with a changed brief, assemble, and agree again; the sample widens
     (T7). After 2 re-runs it says `stuck`: put it in the waiting digest with a recommendation.
   - **Kappa undefined (exit 1):** the sample has no inclusions to compare. That is not low agreement.

An `unreliable` verdict means the screening is not trusted: re-run the lanes with sharper criteria rather than arguing
with the score.

`P kb review apply <dir>` re-runs the gate and writes `brief.md`, new `evaluate` reference entries and
`candidates.md`; it refuses on any refusal and when the sample is missing. Report the counts, the limitations
paragraph, each `not_retrieved` source, and any flagged injected instruction.
