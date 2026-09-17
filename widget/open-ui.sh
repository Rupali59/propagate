#!/bin/bash
# open-ui.sh — make a widget click land on a RUNNING control, not a document.
#
# WHY THIS EXISTS. The design review's sharpest finding was that most CTAs
# "opened the file in your editor" — which relocates the problem rather than
# solving it. A click has to reach something that ACCEPTS a judgement. That
# something is `propagate ui`, which is a server, so the click has to be able to
# start one.
#
# THE PER-START TOKEN IS THE WHOLE DIFFICULTY. `propagate ui` binds loopback and
# mints a fresh token every start, then prints the only URL that works:
#
#   propagate ui — http://127.0.0.1:8899/?token=<32 hex>
#
# So the URL cannot be constructed, only READ from what the server said. This
# script starts the server if it is not up, waits for that line, and opens it.
#
# IT MUST NOT START A SECOND SERVER. Two servers means two tokens, and the older
# browser tab silently 403s on its next write — a failure that looks like the
# tool being broken rather than a stale tab. So an existing, reachable URL is
# reused; only an unreachable one is replaced.
#
# NOT A DAEMON. Nothing schedules this; it runs when a human clicks, and the
# server it starts is an ordinary background process the human can kill. See
# rule:delegation-criteria §2 — this is on-demand, which is the standing bias.

set -uo pipefail

STATE="${PROPAGATE_STATE_DIR:-$HOME/.propagate}"
URL_FILE="$STATE/ui-url"
LOG="$STATE/ui.log"
CLI="$HOME/Documents/GitHub/propagate/cli.mjs"
VIEW="${1:-}"

mkdir -p "$STATE"

NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && { echo "node not found" >&2; exit 1; }

# Is the remembered server still answering? `curl -o /dev/null` with a short
# timeout, because a hung port must not hang the click.
alive() {
  [ -s "$URL_FILE" ] || return 1
  local u; u="$(cat "$URL_FILE")"
  curl -fsS -m 2 -o /dev/null "$u" 2>/dev/null
}

if ! alive; then
  : > "$LOG"
  # NO `setsid` HERE. It is a LINUX utility and does not exist on macOS, so
  # `nohup setsid …` fails with `nohup: setsid: No such file or directory`, no
  # server starts, and the click does nothing but write a line to a log nobody
  # opens. Written from habit and caught only by RUNNING it — the script had
  # been committed, reviewed and described in a commit message first.
  #
  # `nohup … &` plus `disown` is the macOS equivalent: nohup makes it immune to
  # the SIGHUP it would get when this shell exits, and disown drops it from the
  # job table. Verified: the server outlives this script.
  nohup "$NODE" "$CLI" ui >>"$LOG" 2>&1 </dev/null &
  disown 2>/dev/null || true

  # Wait for the server to SAY its URL. Polling the log rather than the port,
  # because a bound port without the printed token is useless here.
  for _ in $(seq 1 40); do
    URL="$(grep -m1 -o 'http://127\.0\.0\.1:[0-9]*/?token=[a-f0-9]*' "$LOG" 2>/dev/null || true)"
    [ -n "$URL" ] && break
    sleep 0.25
  done
  if [ -z "${URL:-}" ]; then
    # Attributable failure: say the server did not announce itself, and leave the
    # log for a reader. Silence here would read as "the click did nothing".
    echo "propagate ui did not print a URL within 10s — see $LOG" >&2
    exit 1
  fi
  printf '%s' "$URL" > "$URL_FILE"
fi

URL="$(cat "$URL_FILE")"
# The view is a fragment, not a path: the UI is one page today, and a path that
# 404s is worse than a fragment the page can ignore. When step 5 lands real
# views, the fragment is what they route on.
[ -n "$VIEW" ] && URL="${URL}#${VIEW}"

/usr/bin/open "$URL"
