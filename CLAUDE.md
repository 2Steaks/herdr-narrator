# Herdr Narrator

A Node program that watches Herdr and speaks one-sentence summaries of what agents in panes are doing. Read `narrator/README.md` first, then `GLOSSARY.md` for the vocabulary and `docs/adr/` for the decisions.

## Layout

- `narrator/narrator.mjs`: the entry point. It wires Herdr events to the summariser, the voice and the plugin commands.
- `narrator/lib/`: one file per concern (`summariser`, `voice`, `rollup`, `state`, the `llm-*` providers, the Herdr clients).
- `narrator/sidecar/`: the Python voice process (`kokoro_sidecar.py`, `audio_output.py`).
- `narrator/plugin/`, `narrator/hook/`, `narrator/herdr-app-mod/`: the Herdr plugin, the Claude Code Stop hook, and the app overlay.
- `narrator/install.sh` and `narrator/integrate.mjs`: setup and wiring into Herdr and Claude Code.
- `narrator/measure/`: timing scripts that use the real voice and a fake Herdr.

## Working rules

- Run the tests with `cd narrator && npm test`. A bare `node --test` hangs on `measure/`.
- The tests use fakes for Herdr, the sidecar and the model providers. Keep it that way: no network, no audio.
- Never log a reply's text or a summary. Log ids, timings and error names.
- A new summary provider implements `summarise` and `isAuthError` (see `narrator/lib/llm.mjs`) and gets a test against a local HTTP server.
- Changes to what the install script edits (Herdr config, Claude Code settings) must stay idempotent and save a `.bak-before-narrator` copy first.
