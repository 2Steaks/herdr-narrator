"""Cost of following the default output device, 10 runs each. Read-only: opens and closes a silent stream on the
current default, writes no samples, changes no device.

  ~/narrator-voice/.venv/bin/python narrator/measure/output-device-cost.py
"""
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
import sounddevice as sd  # noqa: E402
from audio_output import coreaudio_default_output_probe  # noqa: E402

probe = coreaudio_default_output_probe()


def reinit():
    sd._terminate()
    sd._initialize()


def open_close():
    s = sd.OutputStream(samplerate=24000, channels=1, dtype="float32")
    s.start()
    s.close()


def runs(fn, n=10):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1000)
    return out


def report(label, ms):
    print(f"{label}: median {statistics.median(ms):.3f} ms, max {max(ms):.3f} ms, runs {[round(x, 3) for x in ms]}")


print("default output:", sd.query_devices(kind="output")["name"])
report("per-line check, CoreAudio probe", runs(probe))
report("per-line check, fallback (reinit + query name)", runs(lambda: (reinit(), sd.query_devices(kind="output"))))
report("reopen, reinit PortAudio", runs(reinit))
report("reopen, open + start + close stream", runs(open_close))
report("reopen total (close, reinit, open + start)", runs(lambda: (reinit(), open_close())))
