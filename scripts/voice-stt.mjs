#!/usr/bin/env node
// Long-lived speech-to-text helper for `midas /voice`.
//
// Midas keeps this process warm so `/voice` can start listening instantly.
// Commands arrive on stdin, events leave on stdout, one JSON object per line:
//
//   stdin:  {"type":"listen"} | {"type":"pause"} | {"type":"stop"}
//   stdout: {"type":"ready"}                 model loaded, not capturing
//           {"type":"listening"}             capture started
//           {"type":"paused"}                capture stopped
//           {"type":"partial","text":"..."}  in-progress transcript
//           {"type":"final","text":"..."}    finalized transcript
//           {"type":"error","message":"..."} stop and report to the user
//
// Engines (VOICE_STT_ENGINE=parakeet|whisper; default parakeet when `uvx` exists):
//   parakeet - Parakeet-TDT v3 via parakeet-mlx (loads/caches the model once)
//   whisper  - whisper.cpp `whisper-stream`, needs VOICE_WHISPER_MODEL (ggml path)
// Set the `voiceSttCommand` setting to use any other engine that speaks the
// protocol above.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const has = (bin) => spawnSync("which", [bin], { stdio: "ignore" }).status === 0;

const requested = (process.env.VOICE_STT_ENGINE || "").toLowerCase();
const engine = requested || (has("uvx") ? "parakeet" : "whisper");

/** Parse one stdin line into a protocol command, ignoring junk. */
const parseCommand = (line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
};

/** Call `onCommand` for each complete command line on stdin. */
const readCommands = (onCommand) => {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const command = parseCommand(part.trim());
      if (command) onCommand(command);
    }
  });
  process.stdin.on("end", () => onCommand("stop"));
};

if (engine === "parakeet") {
  if (!has("uvx")) {
    emit({ type: "error", message: "Parakeet needs `uvx`; install uv or set voiceSttCommand." });
    process.exit(1);
  }
  const script = fileURLToPath(new URL("./voice-parakeet.py", import.meta.url));
  // stderr is dropped: uv/parakeet print model-download progress there, which
  // would otherwise leak into the TUI. The helper reports failures as events.
  const child = spawn("uvx", ["--from", "parakeet-mlx", "python", script], { stdio: ["pipe", "inherit", "ignore"] });
  child.on("error", (error) => {
    emit({ type: "error", message: `Could not start Parakeet: ${error.message}` });
    process.exit(1);
  });
  // Forward commands straight through; the Python helper owns listen/pause.
  process.stdin.pipe(child.stdin);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      try { child.kill(signal); } catch { /* already gone */ }
      process.exit(0);
    });
  }
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
  // whisper-stream has no warm state, so `listen` starts it and `pause` ends it;
  // Midas still receives the same protocol.
  emit({ type: "ready" });
  let child = null;
  let buffer = "";
  const stopChild = () => {
    if (!child) return;
    child.kill("SIGTERM");
    child = null;
    emit({ type: "paused" });
  };
  const startChild = () => {
    if (child) return;
    buffer = "";
    emit({ type: "listening" });
    child = spawn("whisper-stream", ["-m", model, "--step", "0", "--length", "3000", "--no-timestamps"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const text = part.trim();
        if (text) emit({ type: "partial", text });
      }
    });
    child.on("exit", () => {
      if (buffer.trim()) emit({ type: "final", text: buffer.trim() });
      buffer = "";
      if (child) { child = null; emit({ type: "paused" }); }
    });
  };
  readCommands((command) => {
    if (command === "listen") startChild();
    else if (command === "pause") stopChild();
    else if (command === "stop") { stopChild(); process.exit(0); }
  });
  process.on("SIGTERM", () => { stopChild(); process.exit(0); });
} else {
  emit({ type: "error", message: `Unknown VOICE_STT_ENGINE '${engine}'; use parakeet or whisper.` });
  process.exit(1);
}
