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
#
# STALE IS NOT DEAD (2026-10-15). A `propagate ui` started 3 Oct still held
# 127.0.0.1:4599 and answered the token in ~/.propagate/ui-url with 404 — it was
# alive, but its token was gone. The old check (any non-2xx = down) would have
# started a SECOND server onto a held port, and every CTA opened a dead page. So
# the check now requests the SAME token URL the click will open and sorts the
# answer three ways: 200 = reuse; no answer and nothing on the port = dead, start;
# anything else (404/403, or a port held with no answer) = STALE.
#
# REPLACING A STALE SERVER IS ONLY EVER DONE TO A VERIFIED ONE. The pid recorded
# beside the URL (ui-pid) is killed only if `ps -o command=` still shows
# `cli.mjs ui` for it — pids are reused, and a recorded number is a claim. If no
# pid is recorded, or it names something else, and the port is still held, this
# script kills nothing and starts nothing: it names the holder and exits 1.
# Messages go to stderr like the script's other failures; Übersicht's run()
# rejects on them and the widget shows the text.
#
# A SERVER BEHIND ITS FILES IS STALE TOO (2026-10-15, outside review F5). The page
# is read from disk on every request, but the server's own code is whatever it was
# started with, so after an edit an old server serves a NEW page that talks to OLD
# endpoints: 200 on every request and a client that fails in ways nothing logs. A
# live server is therefore also asked GET /api/version and its build id compared
# with the id of the files on disk; a difference makes it stale, and the stale
# path below replaces it (with the same pid-verification, so it kills nothing it
# cannot identify). A server old enough to have NO /api/version answers
# "no such endpoint" and is stale by that fact. Anything else unreadable is
# "cannot tell" and is left alone: a restart that cannot be justified is how a
# healthy UI gets replaced on every click.
#
# The disk id is `cat <files> | shasum | cut`, with no node, because the tests stub
# node with a script that sleeps. lib/report/ui-build.mjs states the same
# algorithm and tests/unit/ui-server-support.test.mjs asserts the two agree.
#
# TEST SEAMS (env, defaults are the real thing): PROPAGATE_NODE, PROPAGATE_CLI,
# PROPAGATE_OPEN. curl / lsof / ps are resolved from PATH so a test can stub them.

set -uo pipefail

STATE="${PROPAGATE_STATE_DIR:-$HOME/.propagate}"
URL_FILE="$STATE/ui-url"
LOG="$STATE/ui.log"
PID_FILE="$STATE/ui-pid"
CLI="${PROPAGATE_CLI:-$HOME/Documents/GitHub/propagate/cli.mjs}"
OPEN="${PROPAGATE_OPEN:-/usr/bin/open}"
VIEW="${1:-}"

mkdir -p "$STATE"

NODE="${PROPAGATE_NODE:-}"
[ -z "$NODE" ] && for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && { echo "node not found" >&2; exit 1; }

# Classify the remembered server by asking it the exact question a click asks.
# Echoes: live | dead | stale. `-m 2` because a hung port must not hang the click.
port_of_url() { printf '%s' "$1" | sed -n 's#^http://127\.0\.0\.1:\([0-9][0-9]*\)/.*#\1#p'; }
port_holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n1; }

PORT=4599   # commands/ui.mjs default; overridden by the remembered URL
[ -s "$URL_FILE" ] && { p="$(port_of_url "$(cat "$URL_FILE")")"; [ -n "$p" ] && PORT="$p"; }

# The build id of the files on disk, or empty when they cannot be read (cannot tell).
disk_build() {
  local c; c="$(dirname "$CLI")/commands"
  [ -f "$c/ui.mjs" ] && [ -f "$c/ui.client.js" ] && ls "$c"/ui/css/*.css >/dev/null 2>&1 || return 0
  ( export LC_ALL=C; cat "$c/ui.mjs" "$c/ui.client.js" "$c"/ui/css/*.css | shasum -a 256 | cut -c1-16 ) 2>/dev/null
}

# echoes: behind | current | unknown. Only asked of a server that answered the page.
version_state() {
  local base token body build want
  base="$(sed -n 's#^\(http://127\.0\.0\.1:[0-9]*\)/.*#\1#p' "$URL_FILE")"
  token="$(sed -n 's#.*[?&]token=\([a-f0-9]*\).*#\1#p' "$URL_FILE")"
  want="$(disk_build)"
  { [ -n "$base" ] && [ -n "$token" ] && [ -n "$want" ]; } || { echo unknown; return; }
  body="$(curl -sS -m 2 "$base/api/version?token=$token" 2>/dev/null || true)"
  build="$(printf '%s' "$body" | sed -n 's#.*"build":"\([0-9a-f]*\)".*#\1#p')"
  if [ -n "$build" ]; then
    [ "$build" = "$want" ] && echo current || echo behind
  elif printf '%s' "$body" | grep -q 'no such endpoint'; then
    echo behind
  else
    echo unknown
  fi
}

classify() {
  local code=000
  if [ -s "$URL_FILE" ]; then
    code="$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "$(cat "$URL_FILE")" 2>/dev/null || true)"
  fi
  case "$code" in
    2??|3??)
      # `behind` is stale for a different reason than a refused token; classify runs
      # in a subshell, so the reason travels in the word it echoes.
      [ "$(version_state)" = behind ] && { echo behind; return; }
      echo live; return ;;
  esac
  # Not a good answer. Dead only if nothing is listening; a 404/403, or a port
  # that is held but did not answer, is a server we cannot talk to: stale.
  if [ -n "$(port_holder "$PORT")" ]; then echo stale; else echo dead; fi
}

start_ui() {
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
  local pid=$!
  disown 2>/dev/null || true

  # Wait for the server to SAY its URL. Polling the log rather than the port,
  # because a bound port without the printed token is useless here.
  URL=""
  for _ in $(seq 1 40); do
    URL="$(grep -m1 -o 'http://127\.0\.0\.1:[0-9]*/?token=[a-f0-9]*' "$LOG" 2>/dev/null || true)"
    [ -n "$URL" ] && break
    sleep 0.25
  done
  if [ -z "$URL" ]; then
    # Attributable failure: say the server did not announce itself, and leave the
    # log for a reader. Silence here would read as "the click did nothing".
    echo "propagate ui did not print a URL within 10s — see $LOG" >&2
    exit 1
  fi
  printf '%s' "$URL" > "$URL_FILE"
  printf '%s' "$pid" > "$PID_FILE"
}

STATUS="$(classify)"
STALE_WHY="its token is not accepted"
if [ "$STATUS" = behind ]; then
  STALE_WHY="it is running older code than the files on disk (its /api/version build differs)"
  STATUS=stale
fi
if [ "$STATUS" = stale ]; then
  RECORDED=""
  [ -s "$PID_FILE" ] && RECORDED="$(tr -dc '0-9' < "$PID_FILE")"
  CMD=""
  [ -n "$RECORDED" ] && CMD="$(ps -o command= -p "$RECORDED" 2>/dev/null || true)"
  case "$CMD" in
    *"cli.mjs ui"*)
      kill -TERM "$RECORDED" 2>/dev/null || true
      for _ in $(seq 1 20); do
        [ -z "$(port_holder "$PORT")" ] && break
        sleep 0.25
      done
      HOLDER="$(port_holder "$PORT")"
      if [ -n "$HOLDER" ]; then
        echo "stopped propagate ui pid $RECORDED but port $PORT is still held by pid $HOLDER ($(ps -o command= -p "$HOLDER" 2>/dev/null || echo unknown)) — not starting a second server" >&2
        exit 1
      fi
      STATUS=dead
      ;;
    *)
      HOLDER="$(port_holder "$PORT")"
      echo "port $PORT is held by pid ${HOLDER:-unknown} ($( [ -n "$HOLDER" ] && ps -o command= -p "$HOLDER" 2>/dev/null || echo unknown)) and ${STALE_WHY}; it is not a propagate ui this script started (recorded pid: ${RECORDED:-none}), so it was left running and no second server was started — stop it yourself, then click again" >&2
      exit 1
      ;;
  esac
fi

[ "$STATUS" = dead ] && start_ui

# NO SPECIAL CASE FOR THE GRAPH ANY MORE. It used to be generated to a loose
# file and opened directly, which made it a second destination with its own
# lifetime and no way back to anything else. The UI serves it at /graph now, so
# every link from the widget lands on the SAME page with the tabs still there.
URL="$(cat "$URL_FILE")"
# The view is a fragment, not a path: the UI is one page today, and a path that
# 404s is worse than a fragment the page can ignore. When step 5 lands real
# views, the fragment is what they route on.
[ -n "$VIEW" ] && URL="${URL}#${VIEW}"

"$OPEN" "$URL"
