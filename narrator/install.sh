#!/bin/sh
# Installs everything the Narrator needs on this machine, then prints the two settings changes it will not make for you.
#
#   sh narrator/install.sh [--qwen] [--bedrock] [--yes | --no-integrate] [--dry-run]
#
#   --qwen          also install mlx-audio so NARRATOR_TTS=qwen works (Apple Silicon only; the model downloads on first use).
#                   Cloned voices are added afterwards with add-voice.sh.
#   --bedrock       also install the AWS SDK so NARRATOR_LLM=bedrock works (skipped by default)
#   --yes           wire the Narrator into Herdr and Claude Code without asking
#   --no-integrate  do not touch Herdr or Claude Code settings; print the steps instead
#   --dry-run       print what would happen and change nothing
#
# Safe to run again: it skips whatever already exists. Wiring in edits the Herdr config, Claude Code's settings.json and
# the Herdr app's keys.json, and saves a copy of each as <file>.bak-before-narrator first.
# NARRATOR_VOICE_DIR (default ~/narrator-voice) is where the Python environment and the Kokoro model files go.
set -eu

QWEN=0 BEDROCK=0 DRY=0 YES=0 NOINT=0
for arg in "$@"; do
  case "$arg" in
    --qwen) QWEN=1 ;;
    --bedrock) BEDROCK=1 ;;
    --yes) YES=1 ;;
    --no-integrate) NOINT=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

DIR=$(cd "$(dirname "$0")" && pwd)
VOICE_DIR="${NARRATOR_VOICE_DIR:-$HOME/narrator-voice}"
CONFIG="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
KOKORO_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
ok() { printf '  ok   %s\n' "$*"; }
note() { printf '  ...  %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*"; }
die() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

echo "Checking this machine"
[ "$(uname -s)" = Darwin ] || warn "only macOS has been tried; audio device following uses CoreAudio and is skipped elsewhere"

node=$(command -v node || true)
if [ -z "$node" ]; then node=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true); fi
[ -n "$node" ] || die "node not found. Install Node 24 or newer (https://nodejs.org)."
major=$("$node" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || die "node $major found at $node; the Narrator needs 24 or newer."
ok "node $("$node" -v)"
npm=$(dirname "$node")/npm
[ -x "$npm" ] || npm=$(command -v npm || true)
[ -n "$npm" ] || die "npm not found next to node."

command -v uv >/dev/null 2>&1 || die "uv not found. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh"
ok "uv $(uv --version | awk '{print $2}')"

for tool in herdr-app hc herdr; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool on PATH"; else warn "$tool not on PATH (the Narrator needs herdr, or herdr-app and hc for the Herdr app)"; fi
done
if [ "$QWEN" = 1 ]; then
  [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die "--qwen needs Apple Silicon (mlx-audio runs on the Apple GPU)."
fi

echo "Installing Node packages"
if [ "$BEDROCK" = 1 ]; then run "$npm" install --prefix "$DIR" --silent; else run "$npm" install --prefix "$DIR" --silent --omit=optional; fi
ok "packages in $DIR/node_modules"

echo "Setting up the voice in $VOICE_DIR"
run mkdir -p "$VOICE_DIR/models"
if [ -x "$VOICE_DIR/.venv/bin/python" ]; then
  ok "python environment already there"
else
  run uv venv --python 3.12 --quiet "$VOICE_DIR/.venv"
  ok "python environment created"
fi
pkgs="kokoro-onnx numpy sounddevice soundfile"
[ "$QWEN" = 1 ] && pkgs="$pkgs mlx-audio"
# shellcheck disable=SC2086
run uv pip install --quiet --python "$VOICE_DIR/.venv/bin/python" $pkgs
ok "voice packages: $pkgs"

fetch() { # name expected-bytes
  dest="$VOICE_DIR/models/$1"
  if [ -f "$dest" ] && [ "$(wc -c <"$dest" | tr -d ' ')" = "$2" ]; then ok "$1 already downloaded"; return; fi
  note "downloading $1 ($(($2 / 1000000)) MB)"
  run curl -fL --progress-bar -o "$dest.part" "$KOKORO_URL/$1"
  if [ "$DRY" = 0 ]; then
    [ "$(wc -c <"$dest.part" | tr -d ' ')" = "$2" ] || { rm -f "$dest.part"; die "$1 came down the wrong size; try again."; }
    mv "$dest.part" "$dest"
  fi
  ok "$1"
}
fetch kokoro-v1.0.onnx 325532387
fetch voices-v1.0.bin 28214398

echo "Writing the settings file"
if [ -f "$CONFIG" ]; then
  ok "$CONFIG already exists, left alone"
elif [ "$DRY" = 1 ]; then
  echo "  would write $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")"
  umask 077 # the file can hold an API key
  {
    echo "# The Narrator settings, read by narrator/plugin/start.sh at launch. Restart the Narrator after editing."
    echo
    echo "# Who writes the spoken summaries: anthropic (an API key), openai (Ollama, LM Studio or any OpenAI-compatible server), or bedrock."
    echo "NARRATOR_LLM=anthropic"
    echo "# ANTHROPIC_API_KEY=sk-ant-..."
    echo "# For a free local model instead: NARRATOR_LLM=openai, NARRATOR_LLM_MODEL=llama3.2 (needs: ollama pull llama3.2)"
    echo
    echo "# The name the summaries use for you."
    echo "# NARRATOR_USER_NAME=Sam"
    echo
    echo "# Where Herdr runs: leave unset for the terminal UI, or herdr-app for the desktop app."
    if [ -d "${NARRATOR_HERDR_APP_DIR:-$HOME/.config/herdr-app}" ] && ! command -v herdr >/dev/null 2>&1; then
      echo "NARRATOR_BACKEND=herdr-app"
    else
      echo "# NARRATOR_BACKEND=herdr-app"
    fi
    echo
    echo "# The voice engine: kokoro (default) or qwen (needs install.sh --qwen)."
    echo "# NARRATOR_TTS=kokoro"
    echo "# NARRATOR_VOICE=af_heart"
    if [ "$QWEN" = 1 ]; then echo "NARRATOR_TTS=qwen"; fi
    if [ "$VOICE_DIR" != "$HOME/narrator-voice" ]; then
      echo
      echo "NARRATOR_VOICE_DIR=$VOICE_DIR"
      echo "NARRATOR_PYTHON=$VOICE_DIR/.venv/bin/python"
    fi
  } >"$CONFIG"
  ok "wrote $CONFIG (edit it, then restart the Narrator)"
fi

echo "Recording where the plugin lives"
if [ "$DRY" = 1 ]; then
  echo "  would write $(dirname "$CONFIG")/plugin-dir"
else
  mkdir -p "$(dirname "$CONFIG")"
  printf '%s\n' "$DIR/plugin" >"$(dirname "$CONFIG")/plugin-dir" # the Herdr app mod reads this to find the scripts
  ok "wrote $(dirname "$CONFIG")/plugin-dir"
fi

echo "Trying the voice without a speaker"
if [ "$DRY" = 1 ]; then
  echo "  would start the sidecar silently and ask it to speak one line"
else
  reply=$( (echo '{"op":"speak","id":1,"key":"install","text":"Ready."}'; sleep 4; echo '{"op":"quit"}') |
    NARRATOR_SIDECAR_SILENT=1 NARRATOR_VOICE_DIR="$VOICE_DIR" "$VOICE_DIR/.venv/bin/python" "$DIR/sidecar/kokoro_sidecar.py" 2>/dev/null || true)
  case "$reply" in
    *'"event": "started"'*) ok "the voice renders" ;;
    *) die "the voice sidecar did not render a line. Run it by hand to see why: $VOICE_DIR/.venv/bin/python $DIR/sidecar/kokoro_sidecar.py" ;;
  esac
fi


HERDR_CONFIG="${NARRATOR_HERDR_CONFIG:-$HOME/.config/herdr/config.toml}"
CLAUDE_SETTINGS="${NARRATOR_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
APP_DIR="${NARRATOR_HERDR_APP_DIR:-$HOME/.config/herdr-app}"
integrate() { "$node" "$DIR/integrate.mjs" "$@"; }

echo "Wiring into Herdr and Claude Code"
go=0
if [ "$NOINT" = 1 ]; then
  note "skipped (--no-integrate)"
elif [ "$YES" = 1 ]; then
  go=1
elif [ -t 0 ] && [ "$DRY" = 0 ]; then
  cat <<EOS
  This will, saving a .bak-before-narrator copy of each file first:
    - link the Herdr plugin from $DIR/plugin (if herdr is installed)
    - add four key bindings to $HERDR_CONFIG
    - add a Stop hook to $CLAUDE_SETTINGS (if Claude Code is installed)
    - install the app overlay into $APP_DIR (if the Herdr app is installed)
EOS
  printf '  Go ahead? [y/N] '
  read -r answer || answer=n
  case "$answer" in [yY]*) go=1 ;; esac
else
  note "not asked (no terminal); re-run with --yes to do it, or follow the steps below"
fi

if [ "$go" = 1 ] && [ "$DRY" = 1 ]; then
  echo "  would link the plugin, add keys, add the Stop hook and install the app overlay"
elif [ "$go" = 1 ]; then
  if command -v herdr >/dev/null 2>&1; then
    if herdr plugin list 2>/dev/null | grep -q "local:$DIR/plugin"; then ok "Herdr plugin already linked"
    elif herdr plugin link "$DIR/plugin" >/dev/null 2>&1; then ok "Herdr plugin linked"
    else warn "could not link the plugin; run: herdr plugin link $DIR/plugin"; fi
    ok "Herdr keys: $(integrate keys "$HERDR_CONFIG")"
  else
    warn "herdr not found; skipped the plugin link and keys"
  fi
  if [ -d "$(dirname "$CLAUDE_SETTINGS")" ]; then ok "Claude Code Stop hook: $(integrate hook "$CLAUDE_SETTINGS" "$DIR/hook/narrator-stop-hook.sh")"
  else warn "no $(dirname "$CLAUDE_SETTINGS"); skipped the Stop hook (is Claude Code installed?)"; fi
  if [ -d "$APP_DIR" ]; then
    mkdir -p "$APP_DIR/mods/narrator"
    cp "$DIR/herdr-app-mod/mod.json" "$DIR/herdr-app-mod/main.js" "$APP_DIR/mods/narrator/"
    ok "Herdr app overlay installed; key: $(integrate appkeys "$APP_DIR/keys.json")"
  else
    note "no Herdr app found; skipped the overlay"
  fi
fi

if [ "$go" = 1 ] && [ "$DRY" = 0 ]; then
  cat <<EOF

Installed and wired in. Two things are left:

1. Give the Narrator a model. Edit $CONFIG and set ANTHROPIC_API_KEY (or switch NARRATOR_LLM to openai for Ollama).
2. Restart Herdr and any open Claude Code sessions so they pick up the keys and the hook, then start the Narrator with:
     sh $DIR/plugin/start.sh
EOF
else
  cat <<EOF

Installed. Two things are left:

1. Give the Narrator a model. Edit $CONFIG and set ANTHROPIC_API_KEY (or switch NARRATOR_LLM to openai for Ollama).

2. Hook it into Herdr and Claude Code. Either re-run with --yes, or do it by hand:
     herdr plugin link $DIR/plugin
   then add the keys and the Stop hook described in $DIR/README.md ("Wiring it in by hand"), and start it with:
     sh $DIR/plugin/start.sh
EOF
fi
