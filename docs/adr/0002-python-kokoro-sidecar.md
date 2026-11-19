# The voice runs as a warm Python sidecar, not in Node

Kokoro runs through Python `kokoro-onnx`, and a cold model load on every line is slow. The Narrator starts one long-lived Python sidecar from a dedicated virtualenv (`~/narrator-voice`) and talks to it over newline-delimited JSON on stdio. This removes the cold load, at the cost of a second process.

The same sidecar also hosts the Qwen3-TTS engine (`NARRATOR_TTS=qwen`, through mlx-audio). Both engines sit behind one `synth(text)` function, so the protocol, the audio cache and the output-device handling are shared.

## Considered options

- **A Node Kokoro library in-process.** One process, but a different runtime may change how the voice sounds, and the existing voice settings were worth keeping.
- **Spawning Python per line.** Rejected: pays the model load every time.

## Consequences

- The sidecar owns audio playback, so it can cancel a line mid-sentence (50 ms granularity) and follow the system's default output device between lines.
- Model libraries print to stdout, which would corrupt the JSON protocol. The sidecar sends its protocol on the original stdout and points `sys.stdout` at stderr.
- A dead sidecar is logged and respawned on the next line, never thrown at the caller.
