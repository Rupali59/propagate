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

`P kb review agree <dir>` prints the blind sample: screening decisions the maintainer answers without seeing the
agent's, and quote-supports-claim checks. Take the answers as given and record them. An `unreliable` verdict means the
screening is not trusted: re-run the lanes with sharper criteria rather than arguing with the score.

`P kb review apply <dir>` re-runs the gate and writes `brief.md`, new `evaluate` reference entries and
`candidates.md`; it refuses on any refusal and when the sample is missing. Report the counts, the limitations
paragraph, each `not_retrieved` source, and any flagged injected instruction.
