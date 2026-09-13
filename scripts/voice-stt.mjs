#!/usr/bin/env node
// Streaming speech-to-text helper for `midas /voice`.
//
// Protocol: one JSON object per stdout line —
//   {"type":"partial","text":"..."}  in-progress transcript (replaces the tail)
//   {"type":"final","text":"..."}    finalized transcript (committed)
//   {"type":"error","message":"..."} stop and report to the user
//
// Engines (VOICE_STT_ENGINE=parakeet|whisper; default parakeet when `uvx` exists):
//   parakeet - Parakeet-TDT v3 via parakeet-mlx (downloads the model on first use)
//   whisper  - whisper.cpp `whisper-stream`, needs VOICE_WHISPER_MODEL (ggml path)
// Set the `voiceSttCommand` setting to use any other engine that speaks the
// protocol above.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const has = (bin) => spawnSync("which", [bin], { stdio: "ignore" }).status === 0;

const requested = (process.env.VOICE_STT_ENGINE || "").toLowerCase();
const engine = requested || (has("uvx") ? "parakeet" : "whisper");

if (engine === "parakeet") {
  if (!has("uvx")) {
    emit({ type: "error", message: "Parakeet needs `uvx`; install uv or set voiceSttCommand." });
    process.exit(1);
  }
  const script = fileURLToPath(new URL("./voice-parakeet.py", import.meta.url));
  const child = spawn("uvx", ["--from", "parakeet-mlx", "python", script], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (engine === "whisper") {
  const model = process.env.VOICE_WHISPER_MODEL;
  if (!model) {
    emit({ type: "error", message: "Whisper STT needs VOICE_WHISPER_MODEL, or set voiceSttCommand." });
    process.exit(1);
  }
  if (!has("whisper-stream")) {
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
} else {
  emit({ type: "error", message: `Unknown VOICE_STT_ENGINE '${engine}'; use parakeet or whisper.` });
  process.exit(1);
}
