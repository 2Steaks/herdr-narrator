#!/bin/bash
# The visible debug pane (herdr plugin pane open --plugin narrator --entrypoint narrator --placement tab).
# Normal startup is start.sh, which runs the Narrator hidden. Send narrator.quit first: two Narrators would both speak.
# Name this tab "the Narrator", then run the Narrator in the foreground with its log also copied to the log file.
# Naming is best effort. It must never stop the Narrator from starting. HERDR_PANE_ID is its own pane here, so it ignores it.
if [ -n "${HERDR_BIN_PATH:-}" ] && [ -n "${HERDR_TAB_ID:-}" ]; then
  "$HERDR_BIN_PATH" tab rename "$HERDR_TAB_ID" Narrator >/dev/null 2>&1 || true
fi
mkdir -p "$HOME/.narrator"
exec node ../narrator.mjs 2> >(tee -a "${NARRATOR_LOG:-$HOME/.narrator/narrator.log}" >&2)
