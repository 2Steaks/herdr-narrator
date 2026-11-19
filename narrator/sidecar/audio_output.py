"""Keeps one output stream open and moves it when the system default output device changes.

A PortAudio stream stays on the device that was default when it opened, and PortAudio caches its device list,
so following a change takes two things: notice it, then reinitialise PortAudio before opening again.

The router is plain logic over injected callables, so tests simulate "default changed between lines" with no audio:
  probe()            -> a cheap, hashable id of the current default output device (may raise)
  open_stream(sr)    -> an opened and started stream on whatever PortAudio now sees as default
  reinit()           -> make PortAudio re-read the device list (sd._terminate(); sd._initialize())
  device_name()      -> the name PortAudio reports for the default output (read after reinit)
  emit(obj)          -> receives one {"event":"log",...} dict when the output followed a change

acquire() must only be called at the start of a line, from the one thread that plays. Nothing here touches a
stream at any other time, so a stream is never closed while a line is playing.
"""


class OutputRouter:
    def __init__(self, probe, open_stream, reinit, device_name, emit):
        self.probe = probe
        self.open_stream = open_stream
        self.reinit = reinit
        self.device_name = device_name
        self.emit = emit
        self.stream = None
        self.sr = None
        self.dev_id = None
        self.dev_name = None

    def _name(self):
        try:
            return self.device_name()
        except Exception:
            return "unknown"

    def acquire(self, sr):
        try:
            current = self.probe()
        except Exception:  # cannot tell: keep what we have rather than guess
            current = self.dev_id
        changed = self.dev_id is not None and current != self.dev_id
        if self.stream is not None and self.sr == sr and not changed:
            return self.stream
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        if changed or self.dev_id is None:  # the first open too: PortAudio's list is from sidecar startup, maybe before the headphones connected
            self.reinit()
        stream = self.open_stream(sr)  # on failure the stream stays None and dev_id stays old, so the next line retries
        name = self._name()
        if changed:
            self.emit({"event": "log", "level": "info", "msg": "output device changed", "from": self.dev_name, "to": name})
        self.stream, self.sr, self.dev_id, self.dev_name = stream, sr, current, name
        return stream


def coreaudio_default_output_probe():
    """Returns a function giving the id of the macOS default output device (a CoreAudio property read, about 20 us),
    or None when CoreAudio is not reachable (not macOS)."""
    import ctypes
    import struct

    try:
        ca = ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
    except OSError:
        return None

    class Address(ctypes.Structure):
        _fields_ = [("selector", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("element", ctypes.c_uint32)]

    def code(s):
        return struct.unpack(">I", s.encode())[0]

    addr = Address(code("dOut"), code("glob"), 0)  # kAudioHardwarePropertyDefaultOutputDevice, global scope
    ca.AudioObjectGetPropertyData.argtypes = [ctypes.c_uint32, ctypes.POINTER(Address), ctypes.c_uint32, ctypes.c_void_p,
                                              ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]

    def probe():
        dev, size = ctypes.c_uint32(0), ctypes.c_uint32(4)
        status = ca.AudioObjectGetPropertyData(1, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(dev))  # 1 = system object
        if status != 0:
            raise OSError(f"CoreAudio status {status}")
        return dev.value

    return probe
