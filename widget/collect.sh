#!/bin/bash
# collect.sh — resolve node, then emit the queue payload as JSON.
#
# WHY THIS EXISTS AND THE WIDGET DOES NOT CALL `node` DIRECTLY. Übersicht is a
# GUI app: it inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), NOT your
# shell's. `node` here is /opt/homebrew/bin/node, so the obvious
# `node "$HOME/.../cli.mjs" queue --json` fails with `node: command not found`.
# Measured 2026-09-17 with `env -i PATH=/usr/bin:/bin ...` BEFORE shipping —
# rule:delegation-criteria §5: run the command from the environment the consumer
# is actually in, not the one you happen to have.
#
# Homebrew's prefix differs by architecture (/opt/homebrew on ARM, /usr/local on
# Intel), so this probes rather than hardcoding one.
#
# ON FAILURE IT EMITS JSON, NOT NOTHING. A collector that prints an empty string
# makes the widget render "unreadable output" — true, but it does not say WHY.
# `{"error": "..."}` renders the actual reason on the desktop
# (rule:discernment-checks §2).

set -uo pipefail

CLI="$HOME/Documents/GitHub/propagate/cli.mjs"

NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node/current/bin/node"; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE" ]; then
  printf '{"error":"node not found — tried /opt/homebrew, /usr/local, /usr/bin and PATH"}\n'
  exit 0
fi
if [ ! -f "$CLI" ]; then
  printf '{"error":"propagate cli.mjs not found at %s"}\n' "$CLI"
  exit 0
fi

OUT="$("$NODE" "$CLI" queue --json 2>/dev/null)"
RC=$?
if [ $RC -ne 0 ] || [ -z "$OUT" ]; then
  # Capture the child's status immediately (G-C: a wrapper's exit code is not
  # its child's) and report it rather than letting an empty string read as calm.
  printf '{"error":"propagate queue exited %s"}\n' "$RC"
  exit 0
fi
printf '%s\n' "$OUT"
