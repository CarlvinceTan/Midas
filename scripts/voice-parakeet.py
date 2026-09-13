#!/usr/bin/env python3
# Live microphone transcription with Parakeet-TDT via parakeet-mlx.
#
# Emits the same JSONL protocol as the whisper helper:
#   {"type":"partial","text":"..."} / {"type":"final","text":"..."} / {"type":"error","message":"..."}
#
# Run through uv so the dependency is ephemeral:
#   uvx --from parakeet-mlx python scripts/voice-parakeet.py
#
# Env:
#   PARAKEET_MODEL       Hugging Face model id (default: Parakeet-TDT 0.6B v3)
#   VOICE_MIC_DEVICE     ffmpeg avfoundation input (default: :0, the default mic)
#   VOICE_CHUNK_SECONDS  audio chunk size fed to the streaming model (default: 1.0)
import json
import os
import subprocess
import sys

import numpy as np
import mlx.core as mx

from parakeet_mlx import from_pretrained

MODEL = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
DEVICE = os.environ.get("VOICE_MIC_DEVICE", ":0")
SAMPLE_RATE = 16000
CHUNK_FRAMES = max(1, int(SAMPLE_RATE * float(os.environ.get("VOICE_CHUNK_SECONDS", "1.0"))))


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def current_text(stream):
    result = getattr(stream, "result", None)
    return (getattr(result, "text", "") or "").strip()


def main():
    try:
        model = from_pretrained(MODEL)
    except Exception as error:  # noqa: BLE001 - surface any load failure to Midas
        emit({"type": "error", "message": f"Could not load Parakeet model {MODEL}: {error}"})
        return 1
    stream = model.transcribe_stream()
    capture = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation",
         "-i", DEVICE, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        stdout=subprocess.PIPE,
    )
    bytes_per_chunk = CHUNK_FRAMES * 4
    buffer = b""
    try:
        while True:
            data = capture.stdout.read(bytes_per_chunk - len(buffer))
            if not data:
                break
            buffer += data
            if len(buffer) >= bytes_per_chunk:
                samples = np.frombuffer(buffer[:bytes_per_chunk], dtype=np.float32).copy()
                buffer = buffer[bytes_per_chunk:]
                stream.add_audio(mx.array(samples))
                emit({"type": "partial", "text": current_text(stream)})
    finally:
        capture.terminate()
        try:
            capture.wait(timeout=5)
        except Exception:  # noqa: BLE001
            capture.kill()
    if buffer:
        samples = np.frombuffer(buffer, dtype=np.float32).copy()
        if samples.size:
            stream.add_audio(mx.array(samples))
    emit({"type": "final", "text": current_text(stream)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
