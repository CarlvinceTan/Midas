#!/usr/bin/env node
// Streaming speech-to-text helper for `midas /voice`.
//
// Protocol: one JSON object per stdout line —
//   {"type":"partial","text":"..."}  in-progress transcript (replaces the tail)
//   {"type":"final","text":"..."}    finalized transcript (committed)
//   {"type":"error","message":"..."} stop and report to the user
//
// Default engine: whisper.cpp's `whisper-stream`, which needs VOICE_WHISPER_MODEL
// (a ggml model path). For anything else - Parakeet-TDT v3 via parakeet-mlx, or
// macOS on-device Speech - set the `voiceSttCommand` setting to a command that
// speaks this protocol on stdout.
import { spawn, spawnSync } from "node:child_process";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const model = process.env.VOICE_WHISPER_MODEL;
if (!model) {
  emit({ type: "error", message: "Voice STT needs VOICE_WHISPER_MODEL, or a custom voiceSttCommand." });
  process.exit(1);
}
if (spawnSync("which", ["whisper-stream"], { stdio: "ignore" }).status !== 0) {
  emit({ type: "error", message: "whisper-stream not found; set voiceSttCommand." });
  process.exit(1);
}

const child = spawn("whisper-stream", ["-m", model, "--step", "0", "--length", "3000", "--no-timestamps"], {
  stdio: ["ignore", "pipe", "inherit"],
});
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const text = line.trim();
    if (text) emit({ type: "partial", text });
  }
});
child.on("exit", () => {
  if (buffer.trim()) emit({ type: "final", text: buffer.trim() });
  process.exit(0);
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
