When this applies: step 5 and step 6, dispatching researchers and saving what they return.

# Lanes

A lane is one research question and a set of saved sources. Make 3-5 lanes, each with its own question or its own
slice of the candidates, and never hand one source to two lanes.

**The brief** you send each `propagate:literature-researcher` carries: the lane id, the question and its id, the
protocol's inclusion and exclusion criteria quoted verbatim, the 10-15 tool-call budget, and the absolute path of
each handed body, `<state>/kb/fetched/<sha256>` (the file name is the sha256; `kb fetch` prints it). Nothing else:
the researcher has one tool, `Read`, and the guard confines it to those files. Run lanes in the foreground.

**The lane file** is `<dir>/lanes/<id>.json`, the file name equal to the lane id. It is the researcher's JSON object
with these fields added by you, and no other change:

- `model`: the model you dispatched (and `model_version` when known).
- `round`: `1` for the first pass, `2` for the snowball round.
- `handed`: the shas you gave that lane. This is your record, not the lane's claim.
- `brief`: the brief text you sent, so `ai_use.prompt_sha` covers it.
- `from` (round 2 only): the round-1 included sources the lane was started from.

A lane may return `decision: "not_retrieved"` for a handed file with no readable body (a citation line, a landing-page stub,
navigation text). `assemble` records it as not retrieved with `retrieval_reason` `lane: <the first token of its reason>`, so
it is never counted as excluded and never drawn into the agreement sample.

If a researcher returns prose or a broken object, re-dispatch that lane once with the correction. If it fails again,
report the lane as failed. Do not repair its claims, quotes or decisions by hand: a hand edit is a model-free claim
the gate cannot tell from the researcher's.

Read each lane's `flags`, `gaps` and `conflicts` before moving on; `assemble` carries conflicts into
`disagreements` and prints flags.
