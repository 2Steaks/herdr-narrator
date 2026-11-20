#!/bin/sh
# Restarts the Narrator: asks it to quit, makes sure nothing is left of it, then starts it hidden the way Herdr does.
#
#   sh narrator/restart.sh [--dry-run] [--wait SECONDS]
#
# Order: send the quit command; after 5 s send SIGTERM to any Narrator still alive, after 3 more SIGKILL; stop leftover
# voice sidecars; remove a socket nobody answers on; run plugin/start.sh (it reads ~/.narrator/config.env); then wait up to
# SECONDS (default 120, because the first Qwen start may download a model) until the socket answers.
# It stops every node process running a narrator.mjs, from any checkout, since two Narrators would both speak.
# Without NARRATOR_BACKEND=herdr-app the Narrator needs HERDR_SOCKET_PATH, which only exists inside Herdr; run this from a Herdr
# pane then. It checks that first and stops nothing if it would not come back up.
set -u
LC_ALL=C; export LC_ALL

DRY=0 WAIT=120
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --wait) shift; WAIT="${1:-}"; case "$WAIT" in ''|*[!0-9]*) echo "--wait needs a number of seconds" >&2; exit 2 ;; esac ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

DIR=$(cd "$(dirname "$0")" && pwd -P)
SOCK="${NARRATOR_SOCK:-$HOME/.narrator/narrator.sock}"
LOG="${NARRATOR_LOG:-$HOME/.narrator/narrator.log}"
CONFIG="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
ok() { printf '  ok   %s\n' "$*"; }
note() { printf '  ...  %s\n' "$*"; }
die() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
cfg() { ( [ -f "$CONFIG" ] && . "$CONFIG"; eval "printf '%s' \"\${$1:-}\"" ); } # a value as start.sh will see it

node_pids() { for p in $(pgrep -f 'narrator\.mjs' 2>/dev/null); do case $(ps -o comm= -p "$p" 2>/dev/null) in */node|node) echo "$p" ;; esac; done; }
sidecar_pids() { for p in $(pgrep -f 'kokoro_sidecar\.py' 2>/dev/null); do case $(ps -o comm= -p "$p" 2>/dev/null) in *ython*) echo "$p" ;; esac; done; }
answers() { [ -S "$SOCK" ] && printf '' | /usr/bin/nc -U -w 1 "$SOCK" >/dev/null 2>&1; }
# gone SECONDS: true once no Narrator process is left.
gone() { i=0; while [ -n "$(node_pids)" ]; do [ "$i" -ge "$1" ] && return 1; sleep 1; i=$((i + 1)); done; return 0; }

[ -f "$DIR/plugin/start.sh" ] || die "no plugin/start.sh next to this script"
if [ "$(cfg NARRATOR_BACKEND)" != herdr-app ] && [ -z "${HERDR_SOCKET_PATH:-}" ]; then
  die "this setup needs HERDR_SOCKET_PATH, which only exists inside Herdr. Run this from a Herdr pane, or set NARRATOR_BACKEND=herdr-app in $CONFIG. Nothing was stopped."
fi

echo "Stopping the Narrator"
np=$(node_pids); sp=$(sidecar_pids)
if [ -z "$np" ] && [ -z "$sp" ] && ! [ -e "$SOCK" ]; then
  note "nothing running, nothing left over"
elif [ "$DRY" = 1 ]; then
  [ -n "$np" ] && echo "  would send quit, then SIGTERM/SIGKILL if needed, to pid $(echo $np)"
  [ -n "$sp" ] && echo "  would stop leftover voice sidecar pid $(echo $sp)"
  [ -e "$SOCK" ] && echo "  would remove $SOCK if nobody answers on it"
else
  if [ -n "$np" ] && answers; then
    sh "$DIR/plugin/send.sh" quit
    note "sent quit"
  fi
  if ! gone 5; then
    for p in $(node_pids); do kill -TERM "$p" 2>/dev/null; done
    note "it did not quit: sent SIGTERM"
    if ! gone 3; then
      for p in $(node_pids); do kill -KILL "$p" 2>/dev/null; done
      gone 2 || die "could not stop pid $(echo $(node_pids)). Nothing was started."
      note "it ignored SIGTERM: sent SIGKILL"
    fi
  fi
  [ -n "$np" ] && ok "the Narrator is stopped"
  sleep 1 # a clean quit also closes the sidecar; give it a moment before calling it a leftover
  left=$(sidecar_pids)
  if [ -n "$left" ]; then
    for p in $left; do kill -TERM "$p" 2>/dev/null; done
    sleep 1
    for p in $(sidecar_pids); do kill -KILL "$p" 2>/dev/null; done
    ok "stopped leftover voice sidecar pid $(echo $left)"
  fi
  if [ -e "$SOCK" ] && ! answers; then rm -f "$SOCK"; ok "removed a stale socket"; fi
  answers && die "something else still answers on $SOCK (not a Narrator process I can find). Nothing was started."
fi

echo "Starting the Narrator"
if [ "$DRY" = 1 ]; then
  echo "  would run plugin/start.sh and wait up to ${WAIT}s for $SOCK to answer"
  exit 0
fi
sh "$DIR/plugin/start.sh"
t=0
while [ "$t" -lt "$WAIT" ]; do
  if answers; then break; fi
  if [ "$t" -ge 5 ] && [ -z "$(node_pids)" ]; then
    echo "  FAIL it started and exited again. Last log lines:" >&2
    tail -n 6 "$LOG" 2>/dev/null | cut -c1-220 | sed 's/^/        /' >&2
    echo "  Run: sh narrator/doctor.sh" >&2
    exit 1
  fi
  sleep 1; t=$((t + 1))
done
if answers; then
  engine=$(cfg NARRATOR_TTS); engine=${engine:-kokoro}
  if [ "$engine" = qwen ]; then voice=$(cfg NARRATOR_QWEN_VOICE); voice=${voice:-ryan}; else voice=$(cfg NARRATOR_VOICE); voice=${voice:-af_heart}; fi
  ok "running as pid $(echo $(node_pids)) after ${t}s (voice: $engine, $voice)"
else
  echo "  FAIL no answer on $SOCK after ${WAIT}s (a first Qwen start may still be downloading its model). Last log lines:" >&2
  tail -n 6 "$LOG" 2>/dev/null | cut -c1-220 | sed 's/^/        /' >&2
  echo "  Run: sh narrator/doctor.sh   (or retry with --wait 600)" >&2
  exit 1
fi
