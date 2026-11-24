#!/bin/sh
# Pick a voice from a menu, write it to the Narrator's config.env, and restart the Narrator.
#
#   sh narrator/pick-voice.sh [VOICE] [--list] [--no-restart] [--dry-run]
#
#   (no VOICE)    show a menu of every voice: Qwen presets, your cloned voices, and the Kokoro voices
#   VOICE         skip the menu and select that voice (a name from --list)
#   --list        print the voices, one per line as "engine voice", and exit
#   --no-restart  update config.env only
#   --dry-run     say what would change and change nothing
#
# A Kokoro voice sets NARRATOR_TTS=kokoro and NARRATOR_VOICE. A Qwen preset or a cloned voice sets NARRATOR_TTS=qwen and
# NARRATOR_QWEN_VOICE. config.env is saved as config.env.bak-before-narrator before the first change. Uses fzf for the menu when
# it is installed, a numbered prompt otherwise. The restart is restart.sh, so run this from a Herdr pane unless
# NARRATOR_BACKEND=herdr-app is set. NARRATOR_VOICE_DIR, NARRATOR_QWEN_VOICES_DIR and NARRATOR_CONFIG move the locations.
set -eu
LC_ALL=C; export LC_ALL

RESTART=1 DRY=0 LIST=0 CHOICE=
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --dry-run) DRY=1 ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    *) [ -z "$CHOICE" ] || { echo "one voice at a time (try --help)" >&2; exit 2; }; CHOICE=$arg ;;
  esac
done

DIR=$(cd "$(dirname "$0")" && pwd)
VOICE_DIR="${NARRATOR_VOICE_DIR:-$HOME/narrator-voice}"
VOICES="${NARRATOR_QWEN_VOICES_DIR:-$HOME/.narrator/voices}"
CONFIG="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
ok() { printf '  ok   %s\n' "$*"; }
die() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
cfg() { ( [ -f "$CONFIG" ] && . "$CONFIG"; eval "printf '%s' \"\${$1:-}\"" ); }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# One "engine voice" per line. Kokoro names come from the voice pack the sidecar loads.
{
  for v in serena vivian uncle_fu ryan aiden ono_anna sohee eric dylan; do echo "qwen $v"; done
  for d in "$VOICES"/*/; do
    [ -f "${d}reference.wav" ] || continue
    n=$(basename "$d")
    case "$n" in *.bak-before-narrator) continue ;; esac
    echo "qwen $n"
  done
  PY="$VOICE_DIR/.venv/bin/python"
  if [ -x "$PY" ] && [ -f "$VOICE_DIR/models/voices-v1.0.bin" ]; then
    "$PY" -c 'import sys, numpy as np; print("\n".join(sorted(np.load(sys.argv[1], allow_pickle=True).files)))' \
      "$VOICE_DIR/models/voices-v1.0.bin" 2>/dev/null | sed 's/^/kokoro /' || true
  else
    echo "no Kokoro voice pack in $VOICE_DIR; Kokoro voices left out" >&2
  fi
} >"$tmp/voices"

if [ "$LIST" = 1 ]; then cat "$tmp/voices"; exit 0; fi

# What is selected now, to mark it in the menu.
if [ "$(cfg NARRATOR_TTS)" = qwen ]; then CUR="qwen $(cfg NARRATOR_QWEN_VOICE)"; else CUR="kokoro $(cfg NARRATOR_VOICE)"; fi
[ "$CUR" != "qwen " ] || CUR="qwen ryan"
[ "$CUR" != "kokoro " ] || CUR="kokoro af_heart"

# Menu lines look like "qwen   rick   (cloned)  <- current"; the engine and voice are the first two fields.
label() {
  while read -r eng v; do
    kind=
    if [ "$eng" = qwen ]; then if [ -f "$VOICES/$v/reference.wav" ]; then kind="cloned"; else kind="preset"; fi; fi
    mark=; [ "$eng $v" != "$CUR" ] || mark="  <- current"
    printf '%-7s %-16s %s%s\n' "$eng" "$v" "$kind" "$mark"
  done
}

if [ -n "$CHOICE" ]; then
  line=$(awk -v c="$CHOICE" '$2 == c { print; exit }' "$tmp/voices")
  [ -n "$line" ] || die "no voice called \"$CHOICE\". See: sh narrator/pick-voice.sh --list"
  # Names can exist in two engines (an "eric" preset, say); say so rather than guess.
  [ "$(awk -v c="$CHOICE" '$2 == c' "$tmp/voices" | wc -l)" -le 1 ] || die "\"$CHOICE\" exists in more than one engine; use the menu"
else
  [ -t 0 ] && [ -t 1 ] || die "no terminal for the menu. Pass a voice name instead (see --list)"
  label <"$tmp/voices" >"$tmp/menu"
  if command -v fzf >/dev/null 2>&1; then
    picked=$(fzf --prompt='voice> ' --height=60% --reverse <"$tmp/menu") || { echo "No change."; exit 0; }
  else
    awk '{ printf "%3d) %s\n", NR, $0 }' "$tmp/menu"
    printf 'Number (blank to cancel): '
    read -r n || n=
    [ -n "$n" ] || { echo "No change."; exit 0; }
    case "$n" in *[!0-9]*) die "not a number: $n" ;; esac
    picked=$(sed -n "${n}p" "$tmp/menu")
    [ -n "$picked" ] || die "no entry $n"
  fi
  line=$(echo "$picked" | awk '{ print $1, $2 }')
fi

ENGINE=${line%% *}
VOICE=${line#* }

set_config() {
  if [ -f "$CONFIG" ] && grep -q "^$1=" "$CONFIG"; then
    sed "s|^$1=.*|$1=$2|" "$CONFIG" >"$tmp/config.new" && cat "$tmp/config.new" >"$CONFIG"
  else
    printf '%s=%s\n' "$1" "$2" >>"$CONFIG"
  fi
}

if [ "$ENGINE $VOICE" = "$CUR" ]; then
  echo "$ENGINE/$VOICE is already selected."
  [ "$RESTART" = 1 ] && [ "$DRY" = 0 ] || exit 0
  echo "Restarting anyway."
elif [ "$DRY" = 1 ]; then
  echo "would select $ENGINE/$VOICE in $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")"
  if [ -f "$CONFIG" ] && [ ! -f "$CONFIG.bak-before-narrator" ]; then cp "$CONFIG" "$CONFIG.bak-before-narrator"; fi
  if [ "$ENGINE" = qwen ]; then
    set_config NARRATOR_TTS qwen
    set_config NARRATOR_QWEN_VOICE "$VOICE"
  else
    set_config NARRATOR_TTS kokoro
    set_config NARRATOR_VOICE "$VOICE"
  fi
  ok "selected $ENGINE/$VOICE in $CONFIG"
fi

if [ "$RESTART" = 0 ]; then echo "Restart the Narrator to hear it."; exit 0; fi
if [ "$DRY" = 1 ]; then sh "$DIR/restart.sh" --dry-run; exit 0; fi
echo "Restarting the Narrator"
sh "$DIR/restart.sh"
