# Herdr Narrator

Speaks one sentence aloud when an AI coding agent in a Herdr pane finishes, gets blocked, or needs a decision. Focus a pane and it tells you what that agent is doing. Focus a tab and it gives you the count of who is working, done or blocked.

## Requirements

- Herdr (the terminal UI, the Herdr app, or both).
- macOS. Linux is untested. The optional Qwen voice needs Apple Silicon.
- Node 24 or newer, and [uv](https://docs.astral.sh/uv/).
- One way to write the summaries: an Anthropic API key, a local model through Ollama or LM Studio, or an AWS account with Bedrock access.

## Install

```sh
git clone https://github.com/2Steaks/herdr-narrator.git
cd herdr-narrator
sh narrator/install.sh
```

The installer checks your machine, creates the voice environment in `~/narrator-voice`, downloads the Kokoro models (about 350 MB), writes `~/.narrator/config.env`, and proves the voice renders. Then it offers to wire the Narrator into Herdr and Claude Code. It asks before editing anything and saves a `.bak-before-narrator` copy of each file first. Running it again is safe.

| Flag | Effect |
| --- | --- |
| `--yes` | wire in without asking |
| `--no-integrate` | never touch Herdr or Claude Code settings |
| `--qwen` | also install the Qwen3-TTS voice (Apple Silicon) |
| `--bedrock` | also install the AWS SDK |
| `--dry-run` | show what would happen |

Pick a summary model by adding it to `~/.narrator/config.env`:

```sh
NARRATOR_LLM=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

For a free local model, use `NARRATOR_LLM=openai` with `NARRATOR_LLM_MODEL=llama3.2` and run `ollama pull llama3.2`.

Restart Herdr and any open Claude Code sessions, then start the Narrator with `sh narrator/plugin/start.sh`. The Claude Code Stop hook also starts it when it is not running.

If you told the installer not to edit your settings, the four manual steps are in [`narrator/README.md`](narrator/README.md#wiring-it-in-by-hand).

## Using it

In the Herdr app, press `cmd-shift-n` to open the Narrator menu: replay the last line, mute, start, quit, restart, or run the doctor. The installer binds the key. To do it yourself, add `"cmd-shift-n": "mod.open:narrator"` under `global` in `~/.config/herdr-app/keys.json`.

Change or add a voice from the repo folder:

```sh
sh narrator/pick-voice.sh        # menu of every voice; saves your pick and restarts the Narrator
sh narrator/add-voice.sh ben ~/Desktop/ben.m4a "The exact words in the recording." --use   # clone a voice (needs --qwen)
```

`pick-voice.sh` lists the Kokoro voices, the Qwen presets and any voice you cloned. `add-voice.sh` takes 5 to 10 seconds of one person talking and a word-for-word transcript. If something sounds wrong, run `sh narrator/doctor.sh`; `sh narrator/restart.sh` restarts the Narrator. All the scripts and their flags are in [`narrator/README.md`](narrator/README.md#using-it).

## Learn more

Settings, voices, privacy and troubleshooting are in [`narrator/README.md`](narrator/README.md).

- `narrator/`: the program, its Herdr plugin and app overlay, and its tests.
- `docs/adr/`: why it is built the way it is.
- `GLOSSARY.md`: the words the code and docs use.

MIT licensed. See [`narrator/LICENSE`](narrator/LICENSE).
