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

## Learn more

Settings, voices, privacy and troubleshooting are in [`narrator/README.md`](narrator/README.md).

- `narrator/`: the program, its Herdr plugin and app overlay, and its tests.
- `docs/adr/`: why it is built the way it is.
- `GLOSSARY.md`: the words the code and docs use.

MIT licensed. See [`narrator/LICENSE`](narrator/LICENSE).
