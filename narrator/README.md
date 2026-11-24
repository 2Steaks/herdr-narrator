# Herdr Narrator

Speaks one sentence aloud when an AI coding agent in a Herdr pane finishes, gets blocked, or needs a decision. Look at a pane and it tells you what that agent is doing. Look at a tab and it gives a quick count of who is working, done or blocked.

```
Claude Code Stop hook ──► ~/.narrator/narrator.sock ◄── plugin keys / app overlay (replay, mute, start, quit)
                                  │
                          narrator.mjs (Node)
                       ┌──────────┼───────────┐
        Herdr (focus, status, pane text)   summary model        voice sidecar (Python)
                                           (Anthropic API,      Kokoro or Qwen3-TTS,
                                            Ollama or Bedrock)  plays on the default output
```

- **Summary.** When an agent's turn ends, the Narrator asks a small model for one sentence ("the API agent is waiting on a permission"), renders it to audio in the background, and plays it the moment you focus that pane.
- **Rollup.** Focus a tab and it says the state counts, blocked first ("One blocked, two done.").
- **Blocked alert.** If an agent in a pane you are not looking at gets blocked, it says so once.
- **No repeats.** A pane's line plays once per revision. Ask for it again with replay.

## Requirements

- Herdr (the terminal UI, the Herdr app, or both).
- macOS. Linux is untested. The Qwen voice needs Apple Silicon.
- Node 24 or newer, and [uv](https://docs.astral.sh/uv/).
- One way to write the summaries: an Anthropic API key, a local model through Ollama or LM Studio, or an AWS account with Bedrock access.

## Install

```sh
git clone <this repository> && cd <it>
sh narrator/install.sh
```

The installer checks your machine, creates the voice environment in `~/narrator-voice`, downloads the Kokoro models (about 350 MB), writes `~/.narrator/config.env`, and proves the voice renders. Then it offers to wire the Narrator into Herdr and Claude Code. It asks before editing anything and saves a `.bak-before-narrator` copy of each file first. Options:

| Flag | Effect |
| --- | --- |
| `--yes` | wire in without asking |
| `--no-integrate` | never touch Herdr or Claude Code settings |
| `--qwen` | also install the Qwen3-TTS voice (Apple Silicon) |
| `--bedrock` | also install the AWS SDK |
| `--dry-run` | show what would happen |

Running it again is safe. After installing, put a model in `~/.narrator/config.env`:

```sh
NARRATOR_LLM=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Restart Herdr and any open Claude Code sessions, then start it with `sh narrator/plugin/start.sh`. It also starts itself from the Stop hook when it is not running.

### Wiring it in by hand

The installer does these four things. Do them yourself if you answered no.

1. Link the plugin: `herdr plugin link <this checkout>/narrator/plugin`.
2. Add key bindings to `~/.config/herdr/config.toml`, one block per action (`narrator.replay`, `narrator.mute`, `narrator.start`, `narrator.quit`):

   ```toml
   [[keys.command]]
   key = "prefix+a"
   type = "plugin_action"
   command = "narrator.replay"
   description = "narrator replay (again)"
   ```

3. Add the Stop hook to `~/.claude/settings.json`:

   ```json
   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
       "command": "<this checkout>/narrator/hook/narrator-stop-hook.sh", "timeout": 2 } ] } ] } }
   ```

4. Herdr app only: copy `herdr-app-mod/mod.json` and `main.js` into `~/.config/herdr-app/mods/narrator/` and bind a key to `mod.open:narrator` in `~/.config/herdr-app/keys.json`. See [`herdr-app-mod/README.md`](herdr-app-mod/README.md).

## Configuration

Settings live in `~/.narrator/config.env` (`KEY=value` lines, read at launch; values there override the environment). Restart the Narrator after editing it: `narrator.quit`, then `sh narrator/plugin/start.sh`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `NARRATOR_LLM` | `anthropic` | Who writes the summaries: `anthropic`, `openai` or `bedrock` |
| `ANTHROPIC_API_KEY` | | Needed for `anthropic` |
| `NARRATOR_LLM_MODEL` | provider default | Model id (required for `openai`) |
| `NARRATOR_LLM_BASE_URL` | Anthropic API, or Ollama for `openai` | Point `openai` at any OpenAI-compatible server |
| `NARRATOR_LLM_API_KEY` | none | Key for the `openai` server, if it wants one |
| `NARRATOR_AWS_PROFILE`, `NARRATOR_AWS_REGION` | `default`, `eu-west-1` | For `bedrock` |
| `NARRATOR_USER_NAME` | "the user" | The name the summaries use for you |
| `NARRATOR_TTS` | `kokoro` | Voice engine: `kokoro` or `qwen` |
| `NARRATOR_VOICE` | `af_heart` | Kokoro voice id (ids starting with `b` use British English) |
| `NARRATOR_QWEN_VOICE`, `NARRATOR_QWEN_MODEL` | `ryan`, the 0.6B CustomVoice 8-bit (0.6B Base 8-bit for a cloned voice) | Qwen speaker or cloned voice name, and model |
| `NARRATOR_QWEN_VOICES_DIR` | `~/.narrator/voices` | Where cloned voices live (see Custom voices) |
| `NARRATOR_BACKEND` | Herdr socket | `herdr-app` to watch the Herdr app instead |
| `NARRATOR_DEBOUNCE_MS` | `400` | How still focus must be before it speaks |
| `NARRATOR_AUTOSTART` | on | `0` stops the Stop hook from starting it |

Paths and test switches: `NARRATOR_VOICE_DIR`, `NARRATOR_PYTHON`, `NARRATOR_SOCK`, `NARRATOR_LOG`, `NARRATOR_STATE`, `NARRATOR_CONFIG`, `NARRATOR_NODE`, `NARRATOR_SIDECAR_SILENT=1` (no audio), `NARRATOR_NO_SUMMARISER=1`.

### Summary providers

- **`anthropic`**: the Messages API with an API key. Default model `claude-haiku-5-5`.
- **`openai`**: any OpenAI-compatible chat endpoint. For a free local model: `NARRATOR_LLM=openai`, `NARRATOR_LLM_MODEL=llama3.2`, and `ollama pull llama3.2`. The base URL defaults to Ollama on `localhost:11434`.
- **`bedrock`**: Claude Haiku through the AWS SDK. Install with `--bedrock`.

If a login or key stops working (HTTP 401 or 403), the Narrator says so once and stays quiet until it works again. With no usable provider it logs why and only plays summaries it already has.

### Voices

Kokoro is the default: small, fast, and good. Qwen3-TTS (`--qwen`) sounds more natural but renders a full sentence in roughly twice the time, which only matters for lines that cannot be rendered ahead of time. Qwen presets: serena, vivian, uncle_fu, ryan, aiden, ono_anna, sohee, eric, dylan. The Narrator follows your default output device, so switching to headphones mid-session works from the next line.

#### Switching voices

`sh narrator/pick-voice.sh` shows a menu of every voice (Qwen presets, your cloned voices, the Kokoro voices; the current one is marked), writes your pick to `~/.narrator/config.env` (`NARRATOR_TTS` plus `NARRATOR_VOICE` or `NARRATOR_QWEN_VOICE`) and runs `restart.sh`. It uses `fzf` when installed and a numbered prompt otherwise. `sh narrator/pick-voice.sh rick` skips the menu, `--list` prints the voices, `--no-restart` and `--dry-run` do what they say.

#### Custom voices

Qwen3-TTS can clone a voice from a short recording. Record 5 to 10 seconds of one person talking, no music, and write down exactly what they say. Then:

```sh
sh narrator/add-voice.sh ben ~/Desktop/ben.m4a "The exact words in the recording." --use
```

That converts the clip to 24 kHz mono, stores it in `~/.narrator/voices/ben/` (`reference.wav` and `transcript.txt`), renders one line to check it works, and with `--use` sets `NARRATOR_TTS=qwen` and `NARRATOR_QWEN_VOICE=ben` in `~/.narrator/config.env`. Restart the Narrator afterwards. The first run downloads the Qwen3-TTS Base model. Any folder in `~/.narrator/voices/` can be selected by name with `NARRATOR_QWEN_VOICE`; a name with no folder is a preset. Cloned voices use the 0.6B Base model; `NARRATOR_QWEN_MODEL` overrides it (cloning only works on Base models). Running the script again for the same name replaces the voice and keeps the old one as `<name>.bak-before-narrator`.

## Using it

| Action | Effect |
| --- | --- |
| `narrator.replay` | Say the last line again, or the focused pane's summary if nothing has been said yet |
| `narrator.mute` | Toggle mute, with a chime |
| `narrator.start` / `narrator.quit` | Start it, or shut it down cleanly |
| `narrator.restart` | Stop it completely and start it again (runs `restart.sh`; not bound to a key by the installer). Also on `x` in the app overlay, where `d` runs `doctor.sh` and shows the result as a toast |

Run them from the keys the installer added (`prefix+a`, `prefix+m`, `prefix+u`, `prefix+y`), from the app overlay, or with `herdr plugin action invoke narrator.replay`.

The app overlay opens with `cmd-shift-n` (the installer binds it; add `"cmd-shift-n": "mod.open:narrator"` under `global` in `~/.config/herdr-app/keys.json` to do it yourself).

Scripts, run from the repo with `sh narrator/<name>`:

| Script | What it does |
| --- | --- |
| `pick-voice.sh [voice]` | Menu of voices; writes the pick to `config.env` and restarts. `--list`, `--no-restart`, `--dry-run` |
| `add-voice.sh <name> <audio> "<transcript>"` | Clone a voice from a short recording (`--use` selects it) |
| `restart.sh` | Stop the Narrator completely and start it again (`--dry-run`) |
| `doctor.sh` | Check the process, voice, socket, overlay, hooks and recent log (`--minutes N`) |
| `install.sh` | Set up the voice and wire the Narrator into Herdr and Claude Code |

## Privacy

The text of an agent's latest reply is sent to the summary provider you choose. With Ollama it stays on your machine. The Narrator never writes reply text or summaries to its log. Its settings file can hold an API key, so it is created readable by you only.

## Troubleshooting

Start with `sh narrator/doctor.sh`. It checks the process and voice sidecar, whether the socket answers and the Narrator reads it (the cause of most dead controls), mute, the voice, the Herdr app, the overlay and hooks, and the last 15 minutes of the log (`--minutes N` to change that). It prints counts and error names only, and ends with what to do about each problem. Then `sh narrator/restart.sh` stops everything cleanly (quit command, then signals, then leftover sidecars and a stale socket) and starts it the way Herdr does; `--dry-run` shows what it would do. Run it from a Herdr pane unless `NARRATOR_BACKEND=herdr-app` is set.

- **Nothing is said.** Read `~/.narrator/narrator.log`. Look for `summary provider` at startup (a missing key is reported there) and `summary failed` lines.
- **Silent, with `summary failed` and `err":"Error"` in the log (Bedrock).** The AWS SDK is loaded on first use, so a damaged `narrator/node_modules` (for example empty `@aws-sdk` folders) only shows up as a plain `Error`. Run `cd narrator && npm install`, then `sh narrator/restart.sh`. `doctor.sh` does not check for this yet, so it can report "ok" while nothing is spoken.
- **It is not running.** `sh narrator/plugin/start.sh`. It does nothing when it is already running.
- **No sound or the wrong device.** It switches device at the start of each line. Check the macOS output device.
- **Lines repeat or never repeat.** A line plays once per pane revision. Use replay to hear it again.
- **Run it visibly:** send `narrator.quit`, then `herdr plugin pane open --plugin narrator --entrypoint narrator --placement tab`.

## How it behaves

- **Latency.** Measured on an Apple Silicon Mac: a pre-rendered summary starts about 410 ms after focus settles (the debounce is most of that). A line that has to be rendered live is about 2 s with Anthropic or Bedrock, depending on the model's time to first token. Kokoro renders a sentence in about 430 ms, Qwen3-TTS in about 920 ms.
- **The Stop hook** is plain `sh` and exits in about 20 ms, so it never slows your agent.
- **Stays out of the way.** An alert never interrupts a line that is playing.

## Development

```sh
cd narrator && npm test        # a bare `node --test` hangs on measure/
```

Tests use a fake Herdr server, a fake voice sidecar and fake model providers, so they need no network and make no sound. `measure/` holds timing scripts that use the real voice and a fake Herdr (`node measure/sidecar-latency.mjs`, `focus-latency.mjs`, and others). Design decisions are in [`../docs/adr`](../docs/adr) and the vocabulary in [`../GLOSSARY.md`](../GLOSSARY.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
