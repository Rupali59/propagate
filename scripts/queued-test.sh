#!/bin/sh
# Runs propagate's test suite through the machine-wide test queue (#437, #428).
# Usage: queued-test.sh [--profile lane|gate] [test paths...]   (no paths = the test:propagate globs)
# With `test-queue` on PATH and `test-queue where` succeeding, the run is queued. Otherwise it runs unqueued and
# says so on stderr, so a missing tool never blocks a test run. Exits with the run's own code.
set -u
profile=lane
if [ "${1:-}" = "--profile" ]; then
  profile="${2:-}"
  [ -n "$profile" ] || { echo "queued-test: --profile needs lane or gate" >&2; exit 2; }
  shift 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 2

[ -n "${PROPAGATE_STATE_DIR:-}" ] || PROPAGATE_STATE_DIR=$(mktemp -d)
export PROPAGATE_STATE_DIR
export PROPAGATE_GH_BIN="$root/scripts/test-gh-stub.sh"

if [ "$#" -eq 0 ]; then
  set -- 'tests/**/*.test.mjs' 'hooks/**/*.test.mjs'
fi

if ! command -v test-queue >/dev/null 2>&1; then
  echo "test-queue: not installed, lock: unavailable (running unqueued)" >&2
  exec node --test "$@"
fi
where=$(test-queue where 2>/dev/null) || where=""
if [ -z "$where" ]; then
  echo "test-queue: installed without the where subcommand, lock: unavailable (running unqueued)" >&2
  exec node --test "$@"
fi
exec test-queue run --profile "$profile" -- node "$where/adapters/node-tap.mjs" -- node --test --test-reporter=tap "$@"
