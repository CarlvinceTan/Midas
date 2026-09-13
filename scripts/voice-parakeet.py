#!/usr/bin/env python3
# Live microphone transcription with Parakeet-TDT via parakeet-mlx.
#
# Long-lived helper: the model is loaded once, then the process waits for
# commands on stdin so `/voice` can start listening without reloading it.
#
# Commands (stdin, JSONL):
#   {"type":"listen"}  start capturing and transcribing
#   {"type":"pause"}   stop capturing, keep the model warm
#   {"type":"stop"}    exit
#
# Events (stdout, JSONL):
#   {"type":"ready"}                 model loaded, not capturing yet
#   {"type":"listening"}             capture started
#   {"type":"paused"}                capture stopped
#   {"type":"partial","text":"..."}  in-progress transcript
#   {"type":"final","text":"..."}    transcript for the listening session
#   {"type":"error","message":"..."} stop and report to Midas
#
# Run through uv so the dependency is ephemeral:
#   uvx --from parakeet-mlx python scripts/voice-parakeet.py
#
# Env:
#   PARAKEET_MODEL       Hugging Face model id (default: Parakeet-TDT 0.6B v3)
#   VOICE_MIC_DEVICE     ffmpeg avfoundation input (default: :default, the system
#                        default mic; a fixed index like :0 can be a virtual
#                        device such as ZoomAudioDevice that is silent)
#   VOICE_CHUNK_SECONDS  audio chunk size fed to the streaming model (default: 1.0)
import json
import os
import queue
import signal
import subprocess
import sys
import threading

# Install interruption handling before the slow imports/model load: a terminal
# Ctrl+C or a parent SIGTERM must never surface as a KeyboardInterrupt traceback
# in the host terminal. The handlers only flip an event; the main loop notices it.
COMMANDS: "queue.Queue[str]" = queue.Queue()
STOP = threading.Event()


def _request_stop(_signum, _frame):
    STOP.set()


for _sig in ("SIGINT", "SIGTERM", "SIGHUP"):
    if hasattr(signal, _sig):
        signal.signal(getattr(signal, _sig), _request_stop)

import numpy as np  # noqa: E402 - must follow the signal setup above
import mlx.core as mx  # noqa: E402

from parakeet_mlx import from_pretrained  # noqa: E402

MODEL = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
DEVICE = os.environ.get("VOICE_MIC_DEVICE", ":default")
SAMPLE_RATE = 16000
CHUNK_FRAMES = max(1, int(SAMPLE_RATE * float(os.environ.get("VOICE_CHUNK_SECONDS", "1.0"))))
BYTES_PER_CHUNK = CHUNK_FRAMES * 4
# Read the mic in short slices so pause/stop are honoured promptly instead of
# waiting for a whole (possibly long) chunk to arrive.
READ_SLICE = max(4, (SAMPLE_RATE // 10) * 4)


def emit(event):
    try:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        # The host closed the pipe; there is nobody left to talk to.
        STOP.set()


def current_text(stream):
    result = getattr(stream, "result", None)
    return (getattr(result, "text", "") or "").strip()


def read_commands(commands):
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and isinstance(event.get("type"), str):
                commands.put(event["type"])
    except (OSError, ValueError):
        pass
    commands.put("stop")


def stop_capture(capture):
    capture.terminate()
    try:
        capture.wait(timeout=5)
    except Exception:  # noqa: BLE001
        capture.kill()


def main():
    try:
        model = from_pretrained(MODEL)
    except Exception as error:  # noqa: BLE001 - surface any load failure to Midas
        emit({"type": "error", "message": f"Could not load Parakeet model {MODEL}: {error}"})
        return 1

    if STOP.is_set():
        return 0

    threading.Thread(target=read_commands, args=(COMMANDS,), daemon=True).start()

    # The model is resident now: Midas can flip to Listening immediately and only
    # opens the microphone once it sends `listen`.
    emit({"type": "ready"})

    capture = None
    stream = None
    buffer = b""
    try:
        while not STOP.is_set():
            # Poll so pause/stop/interrupts stay responsive whether capturing or
            # idle; the queue only wakes us sooner when a command actually lands.
            try:
                command = COMMANDS.get(timeout=0.1 if capture is None else 0.02)
            except queue.Empty:
                command = None

            if command == "stop" or STOP.is_set():
                break
            if command == "listen":
                if capture is None:
                    stream = model.transcribe_stream()
                    capture = subprocess.Popen(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation",
                         "-i", DEVICE, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
                        stdout=subprocess.PIPE,
                        # Drop ffmpeg's teardown chatter ("Immediate exit requested").
                        stderr=subprocess.DEVNULL,
                    )
                    buffer = b""
                    emit({"type": "listening"})
                continue
            if command == "pause":
                if capture is not None:
                    stop_capture(capture)
                    capture = None
                    emit({"type": "final", "text": current_text(stream)})
                    buffer = b""
                    emit({"type": "paused"})
                continue
            if command is not None or capture is None:
                continue

            data = capture.stdout.read(min(READ_SLICE, BYTES_PER_CHUNK - len(buffer)))
            if not data:
                stop_capture(capture)
                capture = None
                emit({"type": "error", "message": "Microphone capture ended."})
                continue
            buffer += data
            if len(buffer) >= BYTES_PER_CHUNK:
                samples = np.frombuffer(buffer[:BYTES_PER_CHUNK], dtype=np.float32).copy()
                buffer = buffer[BYTES_PER_CHUNK:]
                stream.add_audio(mx.array(samples))
                emit({"type": "partial", "text": current_text(stream)})
    finally:
        if capture is not None:
            stop_capture(capture)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # signal raced the setup; exit quietly
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(0)
