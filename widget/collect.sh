#!/bin/bash
# collect.sh — resolve node, then emit the SURFACE payload as JSON.
#
# WHY THIS EXISTS AND THE WIDGET DOES NOT CALL `node` DIRECTLY. Übersicht is a
# GUI app: it inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), NOT your
# shell's. `node` here is /opt/homebrew/bin/node, so the obvious
# `node "$HOME/.../cli.mjs" surface --json` fails with `node: command not found`.
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

# ONE COMMAND, NOT TWO. `surface --json` already merges the cached doctor
# snapshot with the live queue, the register census and the gotcha census — so
# this shells out once. Doing the merge HERE, in shell, would put a second
# implementation of "what is actionable" on the desktop layer, which is the
# thing lib/report/surface.mjs exists to prevent.
#
# The snapshot half is a READ of a file the monitor already wrote; nothing in
# this path ever runs doctor, which costs 37s and would blow the refresh budget
# by a factor of thirty. Measured end to end: ~0.7s.
OUT="$("$NODE" "$CLI" surface --json 2>/dev/null)"
RC=$?
if [ $RC -ne 0 ] || [ -z "$OUT" ]; then
  # Capture the child's status immediately (G-C: a wrapper's exit code is not
  # its child's) and report it rather than letting an empty string read as calm.
  #
  # NOTE rc 2 is a DERIVATION failure that still printed a JSON object carrying
  # its own error — the widget would rather show that reason than this generic
  # one, so only a genuinely empty stdout falls through to here.
  if [ -n "$OUT" ]; then printf '%s\n' "$OUT"; exit 0; fi
  printf '{"error":"propagate surface exited %s with no output"}\n' "$RC"
  exit 0
fi
printf '%s\n' "$OUT"
