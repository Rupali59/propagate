#!/usr/bin/env bash
# judge.sh — record one disposition, from the desktop.
#
# WHY A SCRIPT AND NOT AN INLINE `run()`. Übersicht's run() takes a shell
# string, and a reason is free text a person just typed. Building that command
# by concatenation in JSX puts user input one quote away from the shell. Here
# the arguments arrive as argv and are passed through as argv; nothing is
# re-parsed.
#
# THIS IS A WRITE PATH WITH NO EVIDENCE PANE. The desktop card cannot show a
# diff, so the widget requires a second click to confirm before calling this at
# all. That gate lives in the widget; what lives HERE is the other half:
#
#   * --apply is spelled out on the command line below, never defaulted. The
#     CLI's own guard is what performs the write, and running this script
#     cannot reach it by accident (rule:safety-flag-needs-a-test).
#   * A reason under 12 characters is refused before the CLI is invoked, so the
#     failure is legible on the desktop rather than an exit code nobody sees.
#   * Output goes to a log the widget can surface, because a silent failure on
#     a desktop widget is indistinguishable from success.
set -uo pipefail

STATE="${PROPAGATE_STATE_DIR:-$HOME/.propagate}"
LOG="$STATE/widget-judge.log"
CLI="$HOME/Documents/GitHub/propagate/cli.mjs"
mkdir -p "$STATE"

EDGE="${1:-}"
DISP="${2:-}"
REASON="${3:-}"

say () { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1" >> "$LOG"; printf '%s\n' "$1"; }

[ -n "$EDGE" ] || { say "refused: no edge_id"; exit 2; }
[ -n "$DISP" ] || { say "refused: no disposition"; exit 2; }
if [ "${#REASON}" -lt 12 ]; then
  say "refused: a reason of 12+ characters is required (got ${#REASON})"
  exit 2
fi

NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || { say "refused: node not found"; exit 2; }
[ -f "$CLI" ] || { say "refused: cli.mjs not at $CLI"; exit 2; }

OUT="$("$NODE" "$CLI" verify --edge "$EDGE" --disposition "$DISP" --reason "$REASON" --apply 2>&1)"
RC=$?
if [ $RC -eq 0 ]; then
  say "recorded $DISP on $EDGE"
else
  # Exit 3 is the ordering guard: this edge has an unsettled ancestor. Say so
  # in the words the CLI used rather than inventing a summary.
  say "refused (exit $RC): $(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')"
fi
exit $RC
