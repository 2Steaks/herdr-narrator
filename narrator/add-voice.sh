#!/bin/sh
# Installs a cloned voice for the Qwen3-TTS engine from a short recording.
#
#   sh narrator/add-voice.sh <name> <audio file> "<exact transcript>" [--use] [--dry-run]
#
#   name        letters, digits, "_" and "-"; not one of the Qwen preset names
#   audio file  3 to 10 seconds of one person speaking, no music (wav, m4a, mp3 or anything afconvert reads)
#   transcript  what the recording says, word for word; a loose transcript gives a worse clone
#   --use       also set NARRATOR_TTS=qwen and NARRATOR_QWEN_VOICE=<name> in the Narrator's config.env
#   --dry-run   print what would happen and change nothing
#
# The voice lands in ~/.narrator/voices/<name>/ (reference.wav at 24 kHz mono, transcript.txt). Running it again for the
# same name moves the old folder to <name>.bak-before-narrator first. config.env is saved as config.env.bak-before-narrator
# before the first change. The first render downloads the Qwen3-TTS Base model. Needs install.sh --qwen to have run.
# NARRATOR_QWEN_VOICES_DIR, NARRATOR_VOICE_DIR and NARRATOR_CONFIG move the three locations.
set -eu
LC_ALL=C; export LC_ALL  # so [a-z] in the name check means ASCII lowercase only

USE=0 DRY=0 NAME= SRC= TRANSCRIPT= N=0
for arg in "$@"; do
  case "$arg" in
    --use) USE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    *)
      N=$((N + 1))
      case "$N" in 1) NAME=$arg ;; 2) SRC=$arg ;; 3) TRANSCRIPT=$arg ;; *) echo "too many arguments (try --help)" >&2; exit 2 ;; esac
      ;;
  esac
done

DIR=$(cd "$(dirname "$0")" && pwd)
VOICE_DIR="${NARRATOR_VOICE_DIR:-$HOME/narrator-voice}"
VOICES="${NARRATOR_QWEN_VOICES_DIR:-$HOME/.narrator/voices}"
CONFIG="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
ok() { printf '  ok   %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*"; }
die() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

[ "$N" = 3 ] || { echo "usage: sh narrator/add-voice.sh <name> <audio file> \"<transcript>\" [--use] [--dry-run]" >&2; exit 2; }
case "$NAME" in
  ''|*[!a-z0-9_-]*) die "the name must be lowercase letters, digits, \"_\" or \"-\": $NAME" ;;
  ryan|serena|vivian|uncle_fu|aiden|ono_anna|sohee|eric|dylan) die "$NAME is a Qwen preset; pick another name" ;;
esac
[ -f "$SRC" ] || die "no such audio file: $SRC"
[ -n "$(printf '%s' "$TRANSCRIPT" | tr -d '[:space:]')" ] || die "the transcript is empty"
command -v afconvert >/dev/null 2>&1 || die "afconvert not found (this script uses macOS's converter)"
PY="$VOICE_DIR/.venv/bin/python"
[ -x "$PY" ] || die "no voice environment at $VOICE_DIR. Run: sh narrator/install.sh --qwen"
"$PY" -c 'import mlx_audio' 2>/dev/null || die "mlx-audio is not installed. Run: sh narrator/install.sh --qwen"

echo "Installing the voice \"$NAME\" in $VOICES/$NAME"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
afconvert -f WAVE -d LEI16@24000 -c 1 "$SRC" "$tmp/reference.wav" || die "could not convert $SRC to 24 kHz mono wav"
secs=$(afinfo "$tmp/reference.wav" | awk '/estimated duration/ {printf "%d", $3}')
ok "converted to 24 kHz mono, about ${secs:-?} s"
if [ -n "$secs" ] && [ "$secs" -lt 3 ]; then warn "under 3 s: the clone will be thin. 5 to 10 s works best."; fi
if [ -n "$secs" ] && [ "$secs" -gt 15 ]; then warn "over 15 s: longer is slower to encode and rarely better. 5 to 10 s works best."; fi

if [ -d "$VOICES/$NAME" ]; then
  run rm -rf "$VOICES/$NAME.bak-before-narrator"
  run mv "$VOICES/$NAME" "$VOICES/$NAME.bak-before-narrator"
  ok "moved the old $NAME to $NAME.bak-before-narrator"
fi
run mkdir -p "$VOICES/$NAME"
if [ "$DRY" = 1 ]; then
  echo "  would copy the converted audio to $VOICES/$NAME/reference.wav and write transcript.txt"
else
  cp "$tmp/reference.wav" "$VOICES/$NAME/reference.wav"
  printf '%s\n' "$TRANSCRIPT" >"$VOICES/$NAME/transcript.txt"
  ok "wrote reference.wav and transcript.txt"
fi

echo "Trying the voice without a speaker (the first run downloads the Base model)"
if [ "$DRY" = 1 ]; then
  echo "  would start the sidecar silently with this voice and ask it to speak one line"
else
  fifo="$tmp/in"
  mkfifo "$fifo"
  NARRATOR_SIDECAR_SILENT=1 NARRATOR_TTS=qwen NARRATOR_QWEN_VOICE="$NAME" NARRATOR_QWEN_VOICES_DIR="$VOICES" \
    "$PY" "$DIR/sidecar/kokoro_sidecar.py" <"$fifo" >"$tmp/out" 2>"$tmp/err" &
  pid=$!
  exec 3>"$fifo"
  echo '{"op":"speak","id":1,"key":"add-voice","text":"Ready."}' >&3
  waited=0
  while [ "$waited" -lt 600 ] && kill -0 "$pid" 2>/dev/null && ! grep -q '"event": "started"' "$tmp/out"; do
    sleep 2; waited=$((waited + 2))
  done
  if grep -q '"event": "started"' "$tmp/out"; then
    ok "the voice renders"
  else
    tail -n 5 "$tmp/err" >&2
    echo '{"op":"quit"}' >&3 2>/dev/null || true
    die "the sidecar did not render a line with this voice (last stderr lines above)"
  fi
  echo '{"op":"quit"}' >&3
  exec 3>&-
  wait "$pid" 2>/dev/null || true
fi

# set_config KEY VALUE: replaces a "KEY=" line or appends one; saves the first copy as .bak-before-narrator.
set_config() {
  if [ -f "$CONFIG" ] && grep -q "^$1=" "$CONFIG"; then
    sed "s|^$1=.*|$1=$2|" "$CONFIG" >"$tmp/config.new" && cat "$tmp/config.new" >"$CONFIG"
  else
    printf '%s=%s\n' "$1" "$2" >>"$CONFIG"
  fi
}
if [ "$USE" = 1 ]; then
  echo "Selecting the voice in $CONFIG"
  if [ "$DRY" = 1 ]; then
    echo "  would set NARRATOR_TTS=qwen and NARRATOR_QWEN_VOICE=$NAME"
  else
    mkdir -p "$(dirname "$CONFIG")"
    if [ -f "$CONFIG" ] && [ ! -f "$CONFIG.bak-before-narrator" ]; then cp "$CONFIG" "$CONFIG.bak-before-narrator"; fi
    set_config NARRATOR_TTS qwen
    set_config NARRATOR_QWEN_VOICE "$NAME"
    ok "NARRATOR_TTS=qwen, NARRATOR_QWEN_VOICE=$NAME"
  fi
  echo "Restart the Narrator to hear it."
else
  echo "To use it, set NARRATOR_TTS=qwen and NARRATOR_QWEN_VOICE=$NAME in $CONFIG, then restart the Narrator."
fi
