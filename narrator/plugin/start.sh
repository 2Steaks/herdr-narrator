#!/bin/sh
# Plugin startup hook: launch the Narrator as a hidden background process and exit at once. Never fails loudly.
#   - Does nothing when it already answers on its socket (never a second the Narrator).
#   - Her stdout and stderr are appended to ~/.narrator/narrator.log (rotated to .1 over 5 MB).
#   - It gets a session of its own, so it outlives this hook and anything Herdr does to its process group.
#   - node is found on PATH, then $NARRATOR_NODE, then the newest ~/.nvm/versions/node/*/bin/node.
# Herdr's startup environment may not have nvm or a shell profile, hence the lookup.
sock="${NARRATOR_SOCK:-$HOME/.narrator/narrator.sock}"
log="${NARRATOR_LOG:-$HOME/.narrator/narrator.log}"
here=$(cd "$(dirname "$0")" && pwd -P) || exit 0 # physical path: narrator.mjs compares argv[1] with its real URL
narrator="$(dirname "$here")/narrator.mjs"

if [ -S "$sock" ] && printf '' | /usr/bin/nc -U -w 1 "$sock" >/dev/null 2>&1; then exit 0; fi

mkdir -p "$(dirname "$log")" 2>/dev/null || exit 0
say() { printf '%s start.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$log" 2>/dev/null; }

# Rotate at launch: one old copy, replaced each time.
if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null | tr -d ' ')" -gt 5242880 ] 2>/dev/null; then
  mv -f "$log" "$log.1" 2>/dev/null
fi

newest_nvm_node() {
  for d in "$HOME"/.nvm/versions/node/v*; do
    [ -x "$d/bin/node" ] || continue
    v=${d##*/v}
    printf '%s %s\n' "$(printf '%s' "$v" | tr '.' ' ')" "$d/bin/node"
  done | sort -k1,1n -k2,2n -k3,3n | tail -n 1 | cut -d' ' -f4-
}

node=$(command -v node 2>/dev/null)
if [ -z "$node" ] && [ -n "${NARRATOR_NODE:-}" ] && [ -x "$NARRATOR_NODE" ]; then node=$NARRATOR_NODE; fi
if [ -z "$node" ]; then node=$(newest_nvm_node); fi
if [ -z "$node" ]; then
  say "no node found (looked on PATH, in NARRATOR_NODE and in ~/.nvm/versions/node); the Narrator was not started"
  exit 0
fi

# Settings live in ~/.narrator/config.env (KEY=value lines, e.g. NARRATOR_VOICE=af_aoede). Values there override the environment.
config="${NARRATOR_CONFIG:-$HOME/.narrator/config.env}"
if [ -f "$config" ]; then
  set -a
  . "$config"
  set +a
fi

# The Narrator has no pane of its own: a pane id inherited from wherever the hook ran must not make its ignore a real one.
unset HERDR_PANE_ID

# perl's setsid makes a new session and process group (macOS has no setsid binary). The subshell and `&` make
# perl a non-leader first, so setsid cannot fail.
if [ -x /usr/bin/perl ]; then
  ( /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$node" "$narrator" </dev/null >>"$log" 2>&1 & )
else
  say "no /usr/bin/perl: starting the Narrator with nohup, without a session of its own"
  ( nohup "$node" "$narrator" </dev/null >>"$log" 2>&1 & )
fi
exit 0
