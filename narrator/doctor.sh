#!/bin/sh
# Finds out why the Narrator is silent, stuck or deaf to its controls. Changes nothing, apart from one harmless
# "unknown command" line it sends to the Narrator's socket to see whether it is really reading it.
#
#   sh narrator/doctor.sh [--minutes N]
#
# Checks, in order: the process and its voice sidecar; whether the socket answers and the Narrator reads it; mute, the voice
# engine and the voice; the Herdr app, the overlay and the hooks; and what the log says about the last N minutes (default 15).
# It prints counts and error names, never any spoken text. It ends with what to do about each problem it found.
# Exit status is 1 when it found a FAIL, 0 otherwise.
set -u
LC_ALL=C; export LC_ALL

MIN=15
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) shift; MIN="${1:-}"; case "$MIN" in ''|*[!0-9]*) echo "--minutes needs a number" >&2; exit 2 ;; esac ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

DIR=$(cd "$(dirname "$0")" && pwd -P)
SOCK="${NARRATOR_SOCK:-$HOME/.narrator/narrator.sock}"
LOG="${NARRATOR_LOG:-$HOME/.narrator/narrator.log}"
CONFIG="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
if [ -f "$CONFIG" ]; then set -a; . "$CONFIG"; set +a; fi # the same way start.sh reads it: values there win
STATE="$(dirname "$CONFIG")/state.json"
VOICE_DIR="${NARRATOR_VOICE_DIR:-$HOME/narrator-voice}"
VOICES="${NARRATOR_QWEN_VOICES_DIR:-$HOME/.narrator/voices}"
PY="${NARRATOR_PYTHON:-$VOICE_DIR/.venv/bin/python}"
APP_DIR="${NARRATOR_HERDR_APP_DIR:-$HOME/.config/herdr-app}"
CLAUDE_SETTINGS="${NARRATOR_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
: >"$tmp/fixes"
BAD=0 WARN=0
ok() { printf '  ok    %s\n' "$*"; }
info() { printf '  ...   %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  WARN  %s\n' "$*"; }
bad() { BAD=$((BAD + 1)); printf '  FAIL  %s\n' "$*"; }
fix() { printf '  - %s\n' "$*" >>"$tmp/fixes"; }
count() { c=$(printf '%s' "$1" | grep -c .); echo "${c:-0}"; }

# Processes by what they run, not just by name: an editor with narrator.mjs open is not the Narrator.
node_pids() { for p in $(pgrep -f 'narrator\.mjs' 2>/dev/null); do case $(ps -o comm= -p "$p" 2>/dev/null) in */node|node) echo "$p" ;; esac; done; }
sidecar_pids() { for p in $(pgrep -f 'kokoro_sidecar\.py' 2>/dev/null); do case $(ps -o comm= -p "$p" 2>/dev/null) in *ython*) echo "$p" ;; esac; done; }
answers() { [ -S "$SOCK" ] && printf '' | /usr/bin/nc -U -w 1 "$SOCK" >/dev/null 2>&1; }

echo "Process"
np=$(node_pids)
nn=$(count "$np")
p1=$(printf '%s\n' "$np" | head -1)
case "$nn" in
  0)
    bad "the Narrator is not running"
    fix "start it: sh narrator/restart.sh"
    ;;
  1)
    ok "running as pid $p1, up $(ps -o etime= -p "$p1" | tr -d ' ')"
    script=$(ps -o command= -p "$p1" | awk '{print $NF}')
    [ "$script" = "$DIR/narrator.mjs" ] || warn "it runs a different checkout: $script"
    ;;
  *)
    bad "$nn Narrators are running (pids $(echo $np)): they would both try to speak"
    fix "stop the extras: sh narrator/restart.sh"
    ;;
esac
sp=$(sidecar_pids)
sn=$(count "$sp")
if [ "$sn" = 0 ]; then
  [ "$nn" -ge 1 ] && { bad "the voice sidecar is not running, so nothing can be spoken"; fix "sh narrator/restart.sh"; }
else
  ok "voice sidecar running (pid $(echo $sp))"
  for p in $sp; do
    parent=$(ps -o ppid= -p "$p" | tr -d ' ')
    printf '%s\n' "$np" | grep -qx "$parent" || { warn "sidecar pid $p has no Narrator as its parent (left over from a crash)"; fix "sh narrator/restart.sh clears leftovers"; }
  done
fi

echo "Socket and controls"
if [ ! -S "$SOCK" ]; then
  if [ "$nn" -ge 1 ]; then
    bad "no socket at $SOCK although it is running: plugin keys and Stop hooks cannot reach it"
    fix "sh narrator/restart.sh (it recreates the socket)"
  else
    info "no socket (normal while it is not running)"
  fi
elif ! answers; then
  bad "$SOCK exists but refuses connections (a stale file): every control does nothing"
  fix "sh narrator/restart.sh (it removes the stale socket first)"
else
  before=$(grep -c '"unknown command","len":12' "$LOG" 2>/dev/null); before=${before:-0}
  printf '{"cmd":"doctor-probe"}\n' | /usr/bin/nc -U -w 1 "$SOCK" >/dev/null 2>&1
  sleep 2
  after=$(grep -c '"unknown command","len":12' "$LOG" 2>/dev/null); after=${after:-0}
  if [ "$after" -gt "$before" ]; then
    ok "the socket answers and the Narrator reads what it is sent"
  elif [ ! -f "$LOG" ]; then
    warn "the socket answers, but there is no log at $LOG to confirm it is reading"
  else
    bad "the socket accepts connections but the Narrator did not act on a probe within 2 s: it is hung, so the controls do nothing"
    fix "sh narrator/restart.sh"
  fi
fi
if [ -f "$STATE" ] && grep -q '"NARRATOR_MUTED": *true' "$STATE"; then
  warn "it is muted, so it speaks nothing"
  fix "unmute: sh narrator/plugin/send.sh mute (or the mute key)"
else
  ok "not muted"
fi

echo "Voice"
tts="${NARRATOR_TTS:-kokoro}"
if [ ! -x "$PY" ]; then
  bad "no voice Python at $PY"
  fix "sh narrator/install.sh (add --qwen for the Qwen voice)"
elif [ "$tts" = qwen ]; then
  v="${NARRATOR_QWEN_VOICE:-ryan}"
  out=$("$PY" -I -c 'import sys
sys.path.insert(0, sys.argv[1])
from qwen_voice import PRESETS, resolve
try:
    r = resolve(sys.argv[2], sys.argv[3], sys.argv[4])
    print(("CLONE " if r["custom"] else ("PRESET " if sys.argv[2] in PRESETS else "UNKNOWN ")) + r["model"])
except ValueError as e:
    print("ERROR " + str(e))' "$DIR/sidecar" "$v" "$VOICES" "${NARRATOR_QWEN_MODEL:-}" 2>&1 | tail -1)
  case "$out" in
    "CLONE "*) ok "engine qwen, cloned voice \"$v\" (model ${out#CLONE })" ;;
    "PRESET "*) ok "engine qwen, preset voice \"$v\" (model ${out#PRESET })" ;;
    "UNKNOWN "*) bad "engine qwen, voice \"$v\" is neither a preset nor a folder in $VOICES"; fix "set NARRATOR_QWEN_VOICE to a preset or an installed voice in $CONFIG" ;;
    "ERROR "*) bad "voice \"$v\": ${out#ERROR }"; fix "reinstall it: sh narrator/add-voice.sh $v <audio> \"<transcript>\"" ;;
    *) bad "could not check the Qwen voice: $out" ;;
  esac
  model=${out#* }
  case "$out" in
    CLONE*|PRESET*)
      if "$PY" -I -c 'import mlx_audio' 2>/dev/null; then
        ok "mlx-audio is installed"
      else
        bad "mlx-audio is not installed in $PY"; fix "sh narrator/install.sh --qwen"
      fi
      cache="$HOME/.cache/huggingface/hub/models--$(printf '%s' "$model" | sed 's|/|--|g')"
      [ -d "$cache" ] || { warn "the model $model is not downloaded yet: the first start downloads it and can look hung for minutes"; fix "wait for the download, or watch: tail -f $LOG"; }
      ;;
  esac
else
  if [ -f "$VOICE_DIR/models/kokoro-v1.0.onnx" ] && [ -f "$VOICE_DIR/models/voices-v1.0.bin" ]; then
    ok "engine kokoro, voice ${NARRATOR_VOICE:-af_heart}"
  else
    bad "the Kokoro model files are missing from $VOICE_DIR/models"; fix "sh narrator/install.sh"
  fi
fi
if [ -n "$p1" ] && [ -f "$CONFIG" ]; then
  started=$(date -j -f '%a %b %e %T %Y' "$(ps -o lstart= -p "$p1")" +%s 2>/dev/null)
  changed=$(stat -f %m "$CONFIG" 2>/dev/null)
  if [ -n "$started" ] && [ -n "$changed" ] && [ "$changed" -gt "$started" ]; then
    warn "config.env changed after the Narrator started: it still runs the old settings"
    fix "sh narrator/restart.sh"
  fi
fi

echo "Herdr and hooks"
if [ "${NARRATOR_BACKEND:-}" = herdr-app ]; then
  for t in herdr-app hc; do command -v "$t" >/dev/null 2>&1 || { bad "$t is not on PATH"; fix "put $t on PATH (or in the PATH that Herdr starts the Narrator with)"; }; done
  if command -v herdr-app >/dev/null 2>&1; then
    if /usr/bin/perl -e 'alarm 5; exec @ARGV' herdr-app ls >/dev/null 2>&1; then
      ok "the Herdr app answers (herdr-app ls)"
    else
      bad "herdr-app ls fails or hangs: the Narrator cannot see which pane you focus"
      fix "open the Herdr app; the Narrator keeps polling and recovers by itself"
    fi
  fi
else
  command -v herdr >/dev/null 2>&1 || warn "herdr is not on PATH"
  if [ -n "$p1" ] && ! ps eww -p "$p1" 2>/dev/null | grep -q 'HERDR_SOCKET_PATH='; then
    bad "the running Narrator has no HERDR_SOCKET_PATH, so it cannot reach Herdr"
    fix "start it from inside Herdr (the Narrator: start action), or set NARRATOR_BACKEND=herdr-app in $CONFIG"
  fi
fi
plugin_dir=$(cat "$(dirname "$CONFIG")/plugin-dir" 2>/dev/null)
if [ -z "$plugin_dir" ]; then
  warn "no plugin-dir file: the Herdr app overlay cannot find the control scripts"
  fix "sh narrator/install.sh --yes"
elif [ ! -f "$plugin_dir/send.sh" ]; then
  bad "plugin-dir points at $plugin_dir, which has no send.sh: the overlay's buttons run nothing"
  fix "sh narrator/install.sh --yes (it rewrites plugin-dir)"
elif [ "$plugin_dir" != "$DIR/plugin" ]; then
  warn "plugin-dir points at another checkout: $plugin_dir"
else
  ok "plugin-dir points at this checkout"
fi
if [ -d "$APP_DIR" ]; then
  mod="$APP_DIR/mods/narrator"
  if [ ! -f "$mod/main.js" ]; then
    warn "the Herdr app overlay is not installed"; fix "sh narrator/install.sh --yes"
  elif cmp -s "$DIR/herdr-app-mod/main.js" "$mod/main.js" && cmp -s "$DIR/herdr-app-mod/mod.json" "$mod/mod.json"; then
    key=$(sed -n 's/.*"\([^"]*\)": *"mod.open:narrator".*/\1/p' "$APP_DIR/keys.json" 2>/dev/null | head -1)
    ok "overlay is current${key:+, opens with $key}"
    [ -n "$key" ] || { warn "no key is bound to the overlay in keys.json"; fix "sh narrator/install.sh --yes"; }
  else
    warn "the installed overlay differs from this checkout's"; fix "sh narrator/install.sh --yes (it copies the overlay again)"
  fi
fi
if [ -f "$CLAUDE_SETTINGS" ] && grep -q 'narrator-stop-hook' "$CLAUDE_SETTINGS"; then
  hook=$(grep -o '[^" ]*narrator-stop-hook\.sh' "$CLAUDE_SETTINGS" | head -1)
  hook=$(printf '%s' "$hook" | sed "s|^~|$HOME|")
  if [ -f "$hook" ]; then ok "the Claude Code Stop hook is installed"; else bad "the Stop hook in $CLAUDE_SETTINGS points at a missing file: $hook"; fix "sh narrator/install.sh --yes"; fi
else
  warn "no Claude Code Stop hook: summaries wait for polling instead of arriving when a reply ends"
  fix "sh narrator/install.sh --yes"
fi

echo "Log, last $MIN minutes"
if [ ! -f "$LOG" ]; then
  warn "no log at $LOG"
else
  cutoff=$(date -u -v-"$MIN"M +%Y-%m-%dT%H:%M:%S)
  tail -n 20000 "$LOG" | awk -v c="$cutoff" '/^\{"t":"/ { if (substr($0, 7, 19) >= c) print }' >"$tmp/recent"
  last() { grep "$1" "$LOG" | tail -1 | cut -c7-25; }
  n() { c=$(grep -c "$1" "$tmp/recent"); echo "${c:-0}"; }
  s=$(last '"msg":"spoke"'); info "last spoke: ${s:-never in this log} UTC (now $(date -u +%Y-%m-%dT%H:%M:%S))"
  c=$(n '"msg":"herdr-app poll failed"')
  if [ "$c" -gt 0 ]; then bad "$c failed polls of the Herdr app: the Narrator is blind to focus changes"; fix "open the Herdr app (herdr-app ls must work)"; else ok "no failed Herdr polls"; fi
  l1=$(last 'login lapsed'); l2=$(last 'credentials are back')
  if [ "$(n 'login lapsed')" -gt 0 ] && { [ -z "$l2" ] || [ "$l2" \< "$l1" ]; }; then
    bad "the summary provider's login has lapsed (since $l1 UTC): no new summaries"
    fix "aws sso login --profile ${NARRATOR_AWS_PROFILE:-<profile>} (the typeform-dev profile needs the VPN)"
  fi
  c=$(n '"msg":"summary failed"')
  if [ "$c" -gt 0 ]; then
    errs=$(grep '"msg":"summary failed"' "$tmp/recent" | sed -n 's/.*"err":"\([^"]*\)".*/\1/p' | sort | uniq -c | sort -rn | head -3 | awk '{printf "%s x%s  ", $2, $1}')
    warn "$c failed summaries: ${errs:-no error name logged}"
    case "$errs" in *AccessDenied*) fix "AccessDenied: check the AWS profile (${NARRATOR_AWS_PROFILE:-unset}) and the VPN" ;; esac
  else
    ok "no failed summaries"
  fi
  c=$(n '"msg":"empty summary"'); [ "$c" -gt 0 ] && info "$c empty summaries (the pane had nothing new to say, or the model returned nothing)"
  c=$(n '"msg":"sidecar exited"'); [ "$c" -gt 0 ] && { bad "the voice sidecar exited $c time(s)"; fix "sh narrator/restart.sh, then watch $LOG"; }
  c=$(n 'hook socket unavailable'); [ "$c" -gt 0 ] && { bad "the hook socket could not start: plugin keys and Stop hooks never reach it"; fix "sh narrator/restart.sh (another Narrator may hold the socket)"; }
  c=$(n 'hook without a pane id'); [ "$c" -gt 0 ] && warn "$c Stop hooks arrived without a pane id (HERDR_PANE_ID unset where the hook runs)"
  c=$(grep -c ' start.sh: ' "$LOG"); if [ "${c:-0}" -gt 0 ]; then info "start.sh said:"; grep ' start.sh: ' "$LOG" | tail -2 | cut -c1-200 | sed 's/^/          /'; fi
fi

echo
if [ "$BAD" = 0 ] && [ "$WARN" = 0 ]; then
  echo "Nothing wrong found. If a control still does nothing, restart it: sh narrator/restart.sh"
else
  echo "$BAD failure(s), $WARN warning(s). What to do:"
  awk '!seen[$0]++' "$tmp/fixes"
fi
[ "$BAD" = 0 ]
