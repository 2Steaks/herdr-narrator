#!/bin/sh
# Claude Code Stop hook for the Narrator. Reads the hook JSON on stdin, adds HERDR_PANE_ID, and sends one line to
# The Narrator's socket, then exits 0 at once. Plain sh + nc because Node's own startup would eat the 50 ms budget. It never
# prints anything and never fails the Stop.
# When the Narrator is not answering it starts it with plugin/start.sh (a no-op if it is up) from the same detached job,
# waits for its socket, and sends the line then, so the first Summary after a cold start is not lost.
# NARRATOR_AUTOSTART=0 turns the start off; NARRATOR_START overrides the path to start.sh.
sock="${NARRATOR_SOCK:-$HOME/.narrator/narrator.sock}"
here=$(cd "$(dirname "$0")" && pwd -P) || exit 0
start="${NARRATOR_START:-$(dirname "$here")/plugin/start.sh}"
autostart="${NARRATOR_AUTOSTART:-1}"
if [ ! -S "$sock" ] && { [ "$autostart" = 0 ] || [ ! -x "$start" ]; }; then exit 0; fi
# Herdr gives HERDR_PANE_ID; the Herdr app gives HC_TERMINAL_ID (t7), which is what its backend uses as a pane id.
pane=$(printf %s "${HERDR_PANE_ID:-$HC_TERMINAL_ID}" | tr -cd 'A-Za-z0-9:_.-')
# Hook JSON is one object; strip newlines so it stays on one line (raw newlines cannot occur inside JSON strings).
body=$(tr -d '\n\r')
msg=$(printf '{"pane_id":"%s","hook":%s}' "$pane" "${body:-null}")
# Everything slow runs in a detached background job with every fd redirected: a live but wedged the Narrator (accepts,
# never reads) or a cold start must not hold Claude's Stop. nc's -w 1 only bounds the orphaned job.
(
  send() { printf '%s\n' "$msg" | /usr/bin/nc -U -w 1 "$sock"; }
  [ -S "$sock" ] && send && exit 0
  [ "$autostart" = 0 ] || [ ! -x "$start" ] && exit 0
  # One starter at a time: several panes can finish while the Narrator is down. A lock older than a minute is stale.
  lock="$sock.starting"
  find "$lock" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    "$start"
  fi
  i=0
  while [ "$i" -lt 25 ]; do
    [ -S "$sock" ] && printf '' | /usr/bin/nc -U -w 1 "$sock" && { send; exit 0; }
    sleep 0.2
    i=$((i + 1))
  done
) >/dev/null 2>&1 </dev/null &
exit 0
