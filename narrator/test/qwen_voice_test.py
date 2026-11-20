"""Tests for sidecar/qwen_voice.py with a temp voices folder: no mlx, no audio."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
from qwen_voice import CLONE_MODEL, PRESET_MODEL, resolve  # noqa: E402


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def make(self, name, wav=True, transcript="Hello there."):
        folder = os.path.join(self.dir.name, name)
        os.makedirs(folder)
        if wav:
            open(os.path.join(folder, "reference.wav"), "wb").close()
        if transcript is not None:
            with open(os.path.join(folder, "transcript.txt"), "w", encoding="utf-8") as f:
                f.write(transcript)
        return folder

    def test_preset_without_folder(self):
        r = resolve("aiden", self.dir.name)
        self.assertEqual(r, {"model": PRESET_MODEL, "kwargs": {"voice": "aiden"}, "custom": False})

    def test_custom_voice_uses_base_model_and_reference(self):
        folder = self.make("ben", transcript="  Hello there.\n")
        r = resolve("ben", self.dir.name)
        self.assertEqual(r["model"], CLONE_MODEL)
        self.assertEqual(r["kwargs"], {"ref_audio": os.path.join(folder, "reference.wav"), "ref_text": "Hello there."})
        self.assertTrue(r["custom"])

    def test_model_override_wins_in_both_modes(self):
        self.make("ben")
        self.assertEqual(resolve("ben", self.dir.name, "x/base")["model"], "x/base")
        self.assertEqual(resolve("aiden", self.dir.name, "x/custom")["model"], "x/custom")

    def test_missing_pieces_raise(self):
        self.make("nowav", wav=False)
        self.make("notxt", transcript=None)
        self.make("empty", transcript="  \n")
        for name in ("nowav", "notxt", "empty"):
            with self.assertRaises(ValueError, msg=name):
                resolve(name, self.dir.name)

    def test_error_never_includes_transcript_text(self):
        self.make("empty", transcript="  ")
        try:
            resolve("empty", self.dir.name)
        except ValueError as e:
            self.assertNotIn("Hello", str(e))


if __name__ == "__main__":
    unittest.main()
