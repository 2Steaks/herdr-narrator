"""Kokoro sidecar for the Narrator (ADR 0002).

Loads Kokoro once from the Kokoro venv and models, then serves newline-delimited JSON on stdin/stdout.

  in:  {"op":"speak","id":1,"key":"w1:p1:7","text":"..."}   render (or reuse cached audio) and play; cancels any current line
       {"op":"render","id":2,"key":"...","text":"..."}      render into the cache only
       {"op":"prerender","id":3,"key":"...","text":"..."}  background render into the cache; queued, never replaced
       {"op":"evict","key":"..."}                           drop a cached line (and a queued pre-render of it)
       {"op":"cancel"}                                      stop playback now
  A speak with key "_chime:muted" or "_chime:unmuted" plays a confirmation tone instead of speech (text is ignored).
       {"op":"quit"}
  out: {"event":"ready","load_ms":N}
       {"event":"started","id":1,"t_ms":epoch_ms,"render_ms":N,"cached":bool}   audio handed to the device
       {"event":"done","id":1} | {"event":"cancelled","id":1} | {"event":"error","id":1,"message":"..."}
       {"event":"log","level":"info","msg":"output device changed","from":"...","to":"..."}   device names only, never text

Run with ~/narrator-voice/.venv/bin/python. NARRATOR_SIDECAR_SILENT=1 skips the audio device (timing and tests).
NARRATOR_VOICE picks the Kokoro voice (default af_heart); b* voices switch to en-gb.
NARRATOR_TTS=qwen swaps Kokoro for Qwen3-TTS through mlx-audio (Apple Silicon only; full-sentence renders, not streamed).
NARRATOR_QWEN_VOICE picks its speaker (default ryan), NARRATOR_QWEN_MODEL the mlx-community repo (default the 0.6B CustomVoice 8-bit).
A folder named after the speaker in NARRATOR_QWEN_VOICES_DIR (default ~/.narrator/voices) is a cloned voice (reference.wav and
transcript.txt, see qwen_voice.py); it switches the default model to the 0.6B Base 8-bit.
The audio cache is keyed by `key`, LRU, capped at CACHE_MAX_BYTES. Text is never logged.
"""
import json
import os
import sys
import threading
import time
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HOME = os.path.expanduser("~")
VOICE_DIR = os.environ.get("NARRATOR_VOICE_DIR", os.path.join(HOME, "narrator-voice"))
VOICE = os.environ.get("NARRATOR_VOICE", "af_heart")
LANG = "en-gb" if VOICE.startswith("b") else "en-us"  # Kokoro ids start with accent (a/b), then gender (f/m)
TTS = os.environ.get("NARRATOR_TTS", "kokoro")
QWEN_VOICE = os.environ.get("NARRATOR_QWEN_VOICE", "ryan")
QWEN_MODEL = os.environ.get("NARRATOR_QWEN_MODEL", "")  # empty: qwen_voice picks the preset or the cloning model
QWEN_VOICES_DIR = os.environ.get("NARRATOR_QWEN_VOICES_DIR", os.path.join(HOME, ".narrator", "voices"))
CACHE_MAX_BYTES = 50 * 1024 * 1024
SILENT = os.environ.get("NARRATOR_SIDECAR_SILENT") == "1"

out_lock = threading.Lock()
PROTOCOL_OUT = sys.stdout  # main() points sys.stdout at stderr so a model library's prints cannot corrupt the JSON lines


def emit(obj: dict) -> None:
    with out_lock:
        PROTOCOL_OUT.write(json.dumps(obj) + "\n")
        PROTOCOL_OUT.flush()


class Cache:
    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self.items: "OrderedDict[str, tuple]" = OrderedDict()
        self.bytes = 0
        self.lock = threading.Lock()  # the pre-render thread and the speak worker share the cache

    def get(self, key):
        with self.lock:
            item = self.items.get(key)
            if item is not None:
                self.items.move_to_end(key)
            return item

    def put(self, key, item) -> None:
        with self.lock:
            old = self.items.pop(key, None)
            if old is not None:
                self.bytes -= old[0].nbytes
            self.items[key] = item
            self.bytes += item[0].nbytes
            while self.bytes > self.max_bytes and len(self.items) > 1:
                _, evicted = self.items.popitem(last=False)
                self.bytes -= evicted[0].nbytes

    def evict(self, key) -> None:
        with self.lock:
            old = self.items.pop(key, None)
            if old is not None:
                self.bytes -= old[0].nbytes


def chime(kind: str):
    """Two short notes: falling for muted, rising for unmuted. Returns (samples, sample_rate)."""
    import numpy as np

    sr = 24000
    notes = (880.0, 587.0) if kind == "muted" else (587.0, 880.0)
    parts = []
    for freq in notes:
        t = np.arange(int(sr * 0.11)) / sr
        env = np.minimum(1.0, np.minimum(t / 0.01, (t[-1] - t) / 0.04))  # short fade in and out, no clicks
        parts.append((0.22 * np.sin(2 * np.pi * freq * t) * env).astype("float32"))
    return np.concatenate(parts), sr


def main() -> None:
    t0 = time.time()
    sys.stdout = sys.stderr
    if TTS == "qwen":
        import numpy as np
        from mlx_audio.tts.utils import load_model
        from qwen_voice import resolve

        choice = resolve(QWEN_VOICE, QWEN_VOICES_DIR, QWEN_MODEL)
        qwen = load_model(choice["model"])

        def synth(text):
            chunks, sr = [], 24000
            for r in qwen.generate(text=text, lang_code="english", **choice["kwargs"]):
                chunks.append(np.array(r.audio, dtype="float32"))
                sr = r.sample_rate
            return np.concatenate(chunks), sr
    else:
        from kokoro_onnx import Kokoro

        kokoro = Kokoro(os.path.join(VOICE_DIR, "models/kokoro-v1.0.onnx"), os.path.join(VOICE_DIR, "models/voices-v1.0.bin"))

        def synth(text):
            return kokoro.create(text, voice=VOICE, speed=1.0, lang=LANG)

    sd = None
    if not SILENT:
        import sounddevice as sd  # noqa: F811
    cache = Cache(CACHE_MAX_BYTES)

    gen_lock = threading.Lock()
    gen = 0                      # bumped by every speak/cancel; a job whose gen is stale is dropped
    stop_event = threading.Event()
    jobs: "list[tuple]" = []     # at most one pending speak job (latest wins)
    cond = threading.Condition()

    kokoro_lock = threading.Lock()  # one synthesis at a time; cache hits never take it
    pre_jobs: "list[tuple]" = []    # background pre-renders, FIFO, never replaced or cancelled by speech
    pre_cond = threading.Condition()

    def render(key, text):
        if key and key.startswith("_chime:"):  # confirmation tones for mute and unmute, no speech and no cache
            return chime(key.split(":", 1)[1]), False, 0
        hit = cache.get(key) if key else None
        if hit is not None:
            return hit, True, 0
        t = time.time()
        with kokoro_lock:
            hit = cache.get(key) if key else None  # a pre-render may have finished while we waited
            if hit is not None:
                return hit, True, 0
            samples, sr = synth(text)
        cache.put(key or f"_anon{time.time_ns()}", (samples, sr))
        return (samples, sr), False, round((time.time() - t) * 1000)

    def pre_worker():
        while True:
            with pre_cond:
                while not pre_jobs:
                    pre_cond.wait()
                job_id, key, text = pre_jobs.pop(0)
            try:
                render(key, text)
                emit({"event": "prerendered", "id": job_id})
            except Exception as e:  # message only, never the text
                emit({"event": "error", "id": job_id, "message": type(e).__name__})

    # One output stream stays open so a line does not pay for opening the device. The router moves it to the new
    # default output when that changed since it was opened (checked at the start of a line, never mid-line).
    router = None
    if sd is not None:
        from audio_output import OutputRouter, coreaudio_default_output_probe

        def reinit():  # PortAudio caches its device list; private API, only called while nothing is playing
            sd._terminate()
            sd._initialize()

        def default_name():
            return sd.query_devices(kind="output")["name"]

        probe = coreaudio_default_output_probe()  # about 20 us per call
        if probe is None:  # not macOS: re-read the list each line instead (about 3 ms)
            def probe():
                reinit()
                return default_name()

        def open_stream(sr):
            s = sd.OutputStream(samplerate=sr, channels=1, dtype="float32")
            s.start()
            return s

        router = OutputRouter(probe, open_stream, reinit, default_name, emit)

    def get_stream(sr):
        return router.acquire(sr)

    CHUNK = 1200  # 50 ms at 24 kHz: the granularity of cancel

    def play(job_gen, job_id, samples, sr):
        stop_event.clear()
        if sd is None:  # silent mode: same timeline, no device
            emit({"event": "started", "id": job_id, "t_ms": round(time.time() * 1000)})
            end = time.time() + len(samples) / sr
            while time.time() < end:
                if stop_event.wait(0.01) or job_gen != gen:
                    emit({"event": "cancelled", "id": job_id})
                    return
            emit({"event": "done", "id": job_id})
            return
        stream = get_stream(sr)
        data = samples.astype("float32").reshape(-1, 1)
        emit({"event": "started", "id": job_id, "t_ms": round(time.time() * 1000)})
        for i in range(0, len(data), CHUNK):
            if stop_event.is_set() or job_gen != gen:
                stream.abort()   # drop what is buffered, then reopen lazily
                stream.start()
                emit({"event": "cancelled", "id": job_id})
                return
            stream.write(data[i:i + CHUNK])
        emit({"event": "done", "id": job_id})

    def worker():
        while True:
            with cond:
                while not jobs:
                    cond.wait()
                kind, job_gen, job_id, key, text = jobs.pop(0)
            try:
                if kind == "render":
                    render(key, text)
                    emit({"event": "rendered", "id": job_id})
                    continue
                if job_gen != gen:
                    emit({"event": "cancelled", "id": job_id})
                    continue
                (samples, sr), cached, render_ms = render(key, text)
                if job_gen != gen:
                    emit({"event": "cancelled", "id": job_id})
                    continue
                # started is emitted inside play with render info attached just before
                emit({"event": "render", "id": job_id, "render_ms": render_ms, "cached": cached})
                play(job_gen, job_id, samples, sr)
            except Exception as e:  # keep serving; message only, never the text
                emit({"event": "error", "id": job_id, "message": type(e).__name__})

    try:
        synth("Ready.")  # first render pays the model's warm-up; take it here
    except Exception:
        pass
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=pre_worker, daemon=True).start()
    emit({"event": "ready", "load_ms": round((time.time() - t0) * 1000)})

    for line in sys.stdin:
        try:
            msg = json.loads(line)
            op = msg.get("op")
        except (json.JSONDecodeError, AttributeError):
            emit({"event": "error", "message": "bad request line"})
            continue
        if op == "quit":
            break
        if op == "cancel":
            with gen_lock:
                gen += 1
            stop_event.set()
            with cond:
                for j in [j for j in jobs if j[0] == "speak"]:
                    jobs.remove(j)
                    emit({"event": "cancelled", "id": j[2]})
            continue
        if op == "prerender":
            text, key = msg.get("text"), msg.get("key")
            if not isinstance(text, str) or not text.strip() or not key:
                emit({"event": "error", "id": msg.get("id"), "message": "prerender needs key and text"})
                continue
            if cache.get(key) is None:
                with pre_cond:
                    if not any(j[1] == key for j in pre_jobs):
                        pre_jobs.append((msg.get("id"), key, text))
                        pre_cond.notify()
            continue
        if op == "evict":
            key = msg.get("key")
            cache.evict(key)
            with pre_cond:
                pre_jobs[:] = [j for j in pre_jobs if j[1] != key]
            continue
        if op in ("speak", "render"):
            text = msg.get("text")
            if not isinstance(text, str) or not text.strip():
                emit({"event": "error", "id": msg.get("id"), "message": "empty text"})
                continue
            with gen_lock:
                if op == "speak":
                    gen += 1
                job_gen = gen
            if op == "speak":
                stop_event.set()  # interrupt whatever is playing; worker clears it before the next play
            with cond:
                # latest wins: a newer speak replaces a pending speak, a newer render a pending render
                for j in [j for j in jobs if j[0] == op]:
                    jobs.remove(j)
                    emit({"event": "cancelled", "id": j[2]})
                jobs.append((op, job_gen, msg.get("id"), msg.get("key"), text))
                cond.notify()


if __name__ == "__main__":
    main()
