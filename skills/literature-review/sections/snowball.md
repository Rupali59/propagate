When this applies: step 6, the one snowball round.

# Snowball

Exactly one round (Wohlin 2014), and only from sources a round-1 lane marked `included`. A source a lane excluded is
not a starting point, and neither is anything a snowball lane itself includes.

1. Collect the `suggestions` of round-1 lanes. Each names a query or a DOI and the included source it came from.
2. Accept a suggestion only if it serves a protocol question and passes the protocol's criteria at a glance. You
   accept or drop; you do not screen the source itself, the round-2 lane does.
3. A query goes through `P kb discover <dir> "<query>" --lane <id>` so the search is logged; a DOI goes straight to
   `P kb fetch <dir> <doi-url>`. Then fetch the candidates it found.
4. Hand the new bodies to round-2 lanes (`round: 2`, `from` naming the originating included shas). Same brief,
   same budgets, same rules as round 1.
5. Suggestions made by round-2 lanes are recorded as gaps in your report and not followed.

`assemble` refuses a second round (`SNOWBALL_EXCEEDED`) and a round started from an excluded or unknown source
(`SNOWBALL_SOURCE_EXCLUDED`). Those refusals are the protocol working, not an obstacle to route around.
