"""Pick the Qwen3-TTS model and generate() arguments for a speaker name or an installed custom voice.

A custom voice is a folder `<voices_dir>/<name>/` holding `reference.wav` and `transcript.txt`. Cloning needs the Base
model and no `voice=` argument; the CustomVoice presets need the CustomVoice model and `voice=`. No mlx import here.
"""
import os

PRESETS = ("serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan")
PRESET_MODEL ="mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
CLONE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"


def resolve(voice: str, voices_dir: str, model_override: str = "") -> dict:
    """Returns {"model": repo id, "kwargs": extra generate() arguments, "custom": bool}."""
    folder = os.path.join(voices_dir, voice)
    if not os.path.isdir(folder):
        return {"model": model_override or PRESET_MODEL, "kwargs": {"voice": voice}, "custom": False}
    wav = os.path.join(folder, "reference.wav")
    txt = os.path.join(folder, "transcript.txt")
    if not os.path.isfile(wav):
        raise ValueError(f"custom voice {voice!r} has no reference.wav in {folder}")
    if not os.path.isfile(txt):
        raise ValueError(f"custom voice {voice!r} has no transcript.txt in {folder}")
    with open(txt, encoding="utf-8") as f:
        transcript = f.read().strip()
    if not transcript:
        raise ValueError(f"custom voice {voice!r} has an empty transcript.txt")
    return {"model": model_override or CLONE_MODEL, "kwargs": {"ref_audio": wav, "ref_text": transcript}, "custom": True}
