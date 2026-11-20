# The Narrator in the Herdr app

The Narrator works with the Herdr app as well as the terminal UI. In the app it watches your terminals by polling `herdr-app` and `hc` (both must be on your `PATH`), so set `NARRATOR_BACKEND=herdr-app` in `~/.narrator/config.env`. `install.sh` sets that for you when it finds the app and no `herdr` binary.

This folder is the app's remote control for the Narrator: a small overlay with replay, mute, start and quit. `install.sh` copies `mod.json` and `main.js` into `~/.config/herdr-app/mods/narrator/` and binds `cmd-shift-n` to open it. To do that yourself, copy the two files and add this under `global` in `~/.config/herdr-app/keys.json`:

```json
"cmd-shift-n": "mod.open:narrator"
```

The mod finds the plugin scripts through `~/.narrator/plugin-dir`, which `install.sh` writes. If you did not run it, put the path of the `plugin/` folder in that file. Mods hot-reload.

## Use

The overlay shows whether the Narrator is muted or speaking, and one key does the rest:

| Key | Action |
|-----|--------|
| `r` | Replay the last line |
| `m` | Toggle mute |
| `s` | Start the Narrator |
| `q` | Quit the Narrator |
| `x` | Restart the Narrator (stops it completely, then starts it; picks up `config.env` changes) |

## Starting at login

The app has no startup hook for mods. Instead, the first Claude Code Stop hook that finds the Narrator's socket dead starts it for you. You can also press `s` in the overlay or run `sh plugin/start.sh`. Starting it twice is safe.

## Check it works

```sh
pgrep -fl 'narrator.mjs|kokoro_sidecar'   # both should be listed
tail -f ~/.narrator/narrator.log          # "narrator is listening", then "summary stored" after a Claude turn
```

`herdr-app poll failed ... Connection refused` in the log means the Herdr app is not open.
