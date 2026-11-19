#!/bin/sh
# Herdr plugin action for the Narrator: send one command line (replay, mute or quit) to Narrator's socket.
# Does nothing, and exits 0, when the Narrator is not running. Prints nothing.
sock="${NARRATOR_SOCK:-$HOME/.narrator/narrator.sock}"
case "$1" in
  replay|mute|quit) ;;
  *) exit 2 ;;
esac
[ -S "$sock" ] || exit 0
printf '{"cmd":"%s"}\n' "$1" | /usr/bin/nc -U -w 1 "$sock" >/dev/null 2>&1
exit 0
