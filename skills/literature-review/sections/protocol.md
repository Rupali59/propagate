When this applies: step 1, writing the protocol the whole review is held to.

# The protocol

`kb review new` writes `protocol.md` from a template. Fill the front matter and the body before anything is searched,
because the gate refuses a protocol committed after the earliest logged search, and a brief whose `protocol_sha` no
longer matches the file (whitespace counts).

- **`questions`**: one `{id: RQ1, text: ...}` each, answerable from sources, not from opinion. A lane answers one.
- **`sources`**: per question, the engines to ask (`openalex`, `s2`, `arxiv`, `crossref`) and any grey-literature
  URLs by name. This is the only place grey literature enters: there is no web-search lane in v1.
- **`inclusion` / `exclusion`**: criteria numbered so a reason can cite one ("meets inclusion 2").
- **`restrictions`**: languages, date window, tiers searched, `lane_tool_calls`, and `snowball_rounds: 1`. Say here
  when the topic is covered thinly by these engines (books, non-open-access journals, a non-English corpus): then
  `not_retrieved` will be common, and it is counted in `brief.md`, not hidden.
- **`stopping`** and **`upkeep`**: the effort budget, and when the review is next due or retired.
- `approved: {by: null}` stays empty. A person fills it, and you commit the file after, not before.

Show the maintainer the finished protocol and stop. Do not run `kb discover` until `approved.by` is set and the
protocol is committed. Never edit an approved protocol: supersede it with a new review whose `supersedes:` names it.
