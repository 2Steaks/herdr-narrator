"""Tests for sidecar/audio_output.py with a fake probe and fake streams: no real audio, no PortAudio."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
from audio_output import OutputRouter  # noqa: E402


class FakeStream:
    def __init__(self, device, sr):
        self.device, self.sr, self.closed = device, sr, False

    def close(self):
        self.closed = True


class FakeWorld:
    """A machine with a default output device that can change, and streams that remember where they opened."""

    def __init__(self):
        self.default = ("id-speakers", "MacBook Speakers")
        self.cache = self.default  # what PortAudio reports until it is reinitialised
        self.opened = []
        self.reinits = 0
        self.events = []
        self.fail_open = False

    def probe(self):
        return self.default[0]

    def reinit(self):
        self.reinits += 1
        self.cache = self.default

    def name(self):
        return self.cache[1]

    def open_stream(self, sr):
        if self.fail_open:
            raise RuntimeError("device busy")
        s = FakeStream(self.cache[1], sr)
        self.opened.append(s)
        return s

    def router(self):
        return OutputRouter(self.probe, self.open_stream, self.reinit, self.name, self.events.append)


class OutputRouterTest(unittest.TestCase):
    def test_follows_default_change_between_lines(self):
        w = FakeWorld()
        r = w.router()
        first = r.acquire(24000)
        self.assertEqual(first.device, "MacBook Speakers")

        w.default = ("id-headphones", "Headphones")  # headphones connected between lines
        second = r.acquire(24000)

        self.assertIsNot(first, second)
        self.assertTrue(first.closed)
        self.assertEqual(second.device, "Headphones")  # PortAudio was reinitialised, so the new default was visible
        self.assertEqual(w.reinits, 2)  # first open, then the change

    def test_first_open_sees_a_device_connected_after_startup(self):
        w = FakeWorld()  # PortAudio's list was taken while only the speakers existed
        w.default = ("id-headphones", "Headphones")  # headphones connected before the first line, no change ever probed
        r = w.router()
        self.assertEqual(r.acquire(24000).device, "Headphones")
        self.assertEqual(w.events, [])  # still not reported as a change

    def test_unchanged_default_reuses_stream_without_reinit(self):
        w = FakeWorld()
        r = w.router()
        a = r.acquire(24000)
        b = r.acquire(24000)
        self.assertIs(a, b)
        self.assertFalse(a.closed)
        self.assertEqual(w.reinits, 1)  # the first open only
        self.assertEqual(len(w.opened), 1)

    def test_change_is_never_applied_while_a_line_plays(self):
        w = FakeWorld()
        r = w.router()
        playing = r.acquire(24000)
        w.default = ("id-headphones", "Headphones")  # changes mid-line; nobody calls acquire until the next line
        self.assertFalse(playing.closed)
        self.assertEqual(w.reinits, 1)  # the first open only
        nxt = r.acquire(24000)
        self.assertTrue(playing.closed)
        self.assertEqual(nxt.device, "Headphones")

    def test_logs_one_info_event_with_device_names_only(self):
        w = FakeWorld()
        r = w.router()
        r.acquire(24000)
        self.assertEqual(w.events, [])  # the first open is not a change
        w.default = ("id-headphones", "Headphones")
        r.acquire(24000)
        r.acquire(24000)
        self.assertEqual(w.events, [{"event": "log", "level": "info", "msg": "output device changed",
                                     "from": "MacBook Speakers", "to": "Headphones"}])

    def test_sample_rate_change_reopens_without_reinit(self):
        w = FakeWorld()
        r = w.router()
        a = r.acquire(24000)
        b = r.acquire(22050)
        self.assertTrue(a.closed)
        self.assertEqual(b.sr, 22050)
        self.assertEqual(w.reinits, 1)  # the first open only
        self.assertEqual(w.events, [])

    def test_probe_failure_keeps_current_stream(self):
        w = FakeWorld()
        r = w.router()
        a = r.acquire(24000)

        def boom():
            raise OSError("no coreaudio")

        r.probe = boom
        self.assertIs(r.acquire(24000), a)

    def test_failed_reopen_is_retried_on_the_next_line(self):
        w = FakeWorld()
        r = w.router()
        r.acquire(24000)
        w.default = ("id-headphones", "Headphones")
        w.fail_open = True
        with self.assertRaises(RuntimeError):
            r.acquire(24000)
        w.fail_open = False
        self.assertEqual(r.acquire(24000).device, "Headphones")


if __name__ == "__main__":
    unittest.main()
