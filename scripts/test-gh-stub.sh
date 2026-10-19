#!/bin/sh
# Stands in for `gh` under `npm run test:propagate` (PROPAGATE_GH_BIN points here), so no test can reach
# real GitHub. A test that needs gh installs its own fake and passes it through PROPAGATE_GH_BIN or an
# injected `gh` option; reaching THIS script means a test forgot to, which is the bug. Exit 1 with a loud
# message rather than 0 with empty output: a silent success here would read as "0 open issues".
echo "test-gh-stub: a test ran the real gh path. Give it a fake (PROPAGATE_GH_BIN or the gh option); argv: $*" >&2
exit 1
