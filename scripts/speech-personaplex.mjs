#!/usr/bin/env node
// Long-lived PersonaPlex (8-bit MLX) speech helper for `midas /speech`.
//
// Midas keeps this process warm so `/speech` opens the microphone quickly.
// PersonaPlex itself (`speech respond`) is one-shot, so the helper owns the
// conversation loop: capture -> endpoint -> ASR -> surface the user's words ->
// wait for Midas to decide -> optionally run PersonaPlex and play the reply.
//
// Commands arrive on stdin, events leave on stdout, one JSON object per line:
//
//   stdin:  {"type":"listen"} | {"type":"pause"} | {"type":"respond"}
//           {"type":"skip"}   | {"type":"stop"}
//   stdout: {"type":"ready"}                    model warmed, ready to listen
//           {"type":"listening"}                capture started
//           {"type":"paused"}                   capture stopped
//           {"type":"utterance","text":"..."}   finalized user turn (ASR)
//           {"type":"assistant","text":"..."}   PersonaPlex's spoken reply text
//           {"type":"error","message":"..."}    stop and report to Midas
//
// Runtime: the `speech` CLI from github.com/soniqo/speech-swift
// (`brew install speech`) with the 8-bit PersonaPlex model. Set SPEECH_COMMAND
// to point at a local build, or SPEECH_FAKE=1 for a scripted dry run.
//
// Env:
//   SPEECH_COMMAND       `speech` binary (default: speech)
//   SPEECH_VOICE         PersonaPlex voice preset (default: NATM0)
//   SPEECH_PROMPT        system prompt; defaults to a concise assistant
//   SPEECH_MODEL_ID      PersonaPlex model (default: the 8-bit MLX build)
//   SPEECH_VOICE         PersonaPlex voice preset (default: NATM0)
//   SPEECH_PROMPT_PRESET bundled system prompt: focused|assistant|customer-service|teacher
//   SPEECH_PROMPT        custom system prompt text (overrides the preset)
//   SPEECH_MAX_STEPS     PersonaPlex generation steps (default: CLI default)
//   SPEECH_COMPILE       set "1" to pass --compile (faster steps, longer warmup)
//   SPEECH_JSON          set "0" to parse --transcript text instead of --json
//   SPEECH_TRANSCRIBE_ENGINE  optional `speech transcribe --engine` value
//   SPEECH_MIC_DEVICE    ffmpeg avfoundation input (default: :0)
//   SPEECH_RMS_THRESHOLD normalized RMS that counts as speech (default: 0.015)
//   SPEECH_SILENCE_MS    trailing silence that ends a turn (default: 800)
//   SPEECH_MIN_MS        shortest turn to accept (default: 350)
//   SPEECH_MAX_MS        longest turn before a forced cutoff (default: 30000)
//   SPEECH_TRANSCRIPT    set "0" to skip printing the reply transcript
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // s16le mono
const CHUNK_MS = 20;
const BYTES_PER_CHUNK = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

const COMMAND = process.env.SPEECH_COMMAND || "speech";
// The CLI defaults to the 4-bit build; midas asks for 8-bit explicitly.
const MODEL_ID = process.env.SPEECH_MODEL_ID || "aufklarer/PersonaPlex-7B-MLX-8bit";
const VOICE = process.env.SPEECH_VOICE || "NATM0";
const MAX_STEPS = process.env.SPEECH_MAX_STEPS || "";
// `focused` is the bundled "stays on topic, concise" preset; custom text wins.
const PROMPT_PRESET = process.env.SPEECH_PROMPT_PRESET || "focused";
const PROMPT = process.env.SPEECH_PROMPT || "";
const MIC_DEVICE = process.env.SPEECH_MIC_DEVICE || ":0";
const RMS_THRESHOLD = Number(process.env.SPEECH_RMS_THRESHOLD || "0.015");
const SILENCE_CHUNKS = Math.max(1, Math.round(Number(process.env.SPEECH_SILENCE_MS || "800") / CHUNK_MS));
const MIN_CHUNKS = Math.max(1, Math.round(Number(process.env.SPEECH_MIN_MS || "350") / CHUNK_MS));
const MAX_CHUNKS = Math.max(MIN_CHUNKS, Math.round(Number(process.env.SPEECH_MAX_MS || "30000") / CHUNK_MS));
const PREROLL_CHUNKS = 10; // ~200ms so the first syllable is not clipped
const TRANSCRIPT = process.env.SPEECH_TRANSCRIPT !== "0";
const JSON_OUT = process.env.SPEECH_JSON !== "0";
// Compiled inference fuses Metal kernels (~30% faster steps; ~15s one-time warmup).
const COMPILE = process.env.SPEECH_COMPILE === "1";
const FAKE = process.env.SPEECH_FAKE === "1";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const has = (bin) => spawnSync("which", [bin], { stdio: "ignore" }).status === 0;

/** The one in-flight turn decision, resolved by the next respond/skip/pause. */
let pendingDecision = null;

/** Resolve a waiting turn; returns false when there is no turn in flight. */
function resolveDecision(decision) {
  if (!pendingDecision) return false;
  const resolve = pendingDecision;
  pendingDecision = null;
  resolve(decision);
  return true;
}

/** Wait for Midas to decide what happens to the turn just surfaced. */
function awaitDecision() {
  return new Promise((resolve) => {
    pendingDecision = resolve;
  });
}

/** Route one command from Midas. */
function handleCommand(type) {
  if (type === "listen") {
    // A turn still awaiting a decision is stale once listening restarts.
    resolveDecision("skip");
    startListening();
    return;
  }
  if (type === "pause") {
    if (captureState.busy) pauseListening();
    resolveDecision("pause");
    return;
  }
  if (type === "respond" || type === "skip") {
    resolveDecision(type);
  }
}

/** Run a child, collecting stdout; rejects on a non-zero exit. */
function run(bin, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${bin} exited with code ${code}`));
    });
  });
}

const workDir = join(tmpdir(), `midas-speech-${process.pid}`);
mkdirSync(workDir, { recursive: true });
const wavPath = (name) => join(workDir, `${name}.wav`);

/** Write mono s16le PCM as a canonical 44-byte WAV. */
function writeWav(path, samples) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  writeFileSync(path, Buffer.concat([header, samples]));
}

/** A short silent WAV used to force the first PersonaPlex load. */
function silenceWav(seconds = 0.3) {
  const samples = Buffer.alloc(Math.round(SAMPLE_RATE * seconds) * BYTES_PER_SAMPLE);
  const path = wavPath("silence");
  writeWav(path, samples);
  return path;
}

/** Normalized RMS of an s16le chunk, in [0, 1]. */
function rms(chunk) {
  let sum = 0;
  const count = chunk.length / BYTES_PER_SAMPLE;
  for (let i = 0; i < count; i++) {
    const sample = chunk.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sum += sample * sample;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** True once `speech` is present and the PersonaPlex model has been loaded once. */
let respondLock = Promise.resolve();

function withRespondLock(fn) {
  const next = respondLock.then(fn, fn);
  respondLock = next.catch(() => {});
  return next;
}

/** PersonaPlex `respond` flags for one turn. */
function respondArgs(input, output, { maxSteps = MAX_STEPS, json = JSON_OUT } = {}) {
  const args = ["respond", "--input", input, "--output", output, "--voice", VOICE, "--model-id", MODEL_ID];
  if (PROMPT) args.push("--system-prompt-text", PROMPT);
  else if (PROMPT_PRESET) args.push("--system-prompt", PROMPT_PRESET);
  if (maxSteps) args.push("--max-steps", maxSteps);
  if (COMPILE) args.push("--compile");
  if (json) args.push("--json");
  else if (TRANSCRIPT) args.push("--transcript");
  return args;
}

/** Parse `--json` output (or fall back to raw `--transcript` text). */
function parseTranscript(stdout) {
  const text = stdout.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const value = parsed?.transcript ?? parsed?.text ?? "";
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return text;
  }
}

/** Load the model once so the first real turn is not also a cold download. */
async function warm() {
  if (FAKE) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  } else {
    if (!has(COMMAND)) {
      throw new Error(`'${COMMAND}' not found. Install it with: brew install speech`);
    }
    // One step is enough to pay the download/load/compile cost up front.
    await withRespondLock(async () => {
      await run(COMMAND, respondArgs(silenceWav(), wavPath("warmup"), { maxSteps: "1", json: false }));
    });
  }
  emit({ type: "ready" });
}

/** Pull the transcript out of `speech transcribe` output (it also prints timing). */
function parseTranscription(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result = [...lines].reverse().find((line) => /^Result:/i.test(line));
  if (result) return result.replace(/^Result:\s*/i, "").trim();
  const candidate = [...lines]
    .reverse()
    .find((line) => !/^(Time:|Found \d|Loading|Applied|\[)/i.test(line));
  return candidate ?? "";
}

/** Transcribe one captured turn with the speech CLI. */
async function transcribe(path) {
  const args = ["transcribe", path];
  const engine = process.env.SPEECH_TRANSCRIBE_ENGINE;
  if (engine) args.push("--engine", engine);
  const stdout = await run(COMMAND, args, { timeoutMs: 120_000 });
  return parseTranscription(stdout);
}

/** Run PersonaPlex on a turn, play the reply, and return its text transcript. */
async function personaplex(path) {
  return withRespondLock(async () => {
    const output = wavPath("reply");
    const stdout = await run(COMMAND, respondArgs(path, output), { timeoutMs: 300_000 });
    const transcript = TRANSCRIPT ? (JSON_OUT ? parseTranscript(stdout) : stdout.trim()) : "";
    if (has("afplay")) {
      try {
        await run("afplay", [output], { timeoutMs: 300_000 });
      } catch {
        // Playback is best-effort; the transcript still reaches Midas.
      }
    }
    return transcript;
  });
}

let capture;
let captureState = { busy: false };

/** Start ffmpeg capture and pump chunks through the endpointer. */
function startCapture() {
  if (capture) return;
  if (FAKE) {
    capture = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    emit({ type: "listening" });
    void fakeTurns();
    return;
  }
  capture = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", MIC_DEVICE, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  capture.on("exit", () => {
    capture = undefined;
  });
  emit({ type: "listening" });
  void pump(capture.stdout);
}

/** Stop capturing without emitting `paused` (used between capture restarts). */
function killCapture() {
  if (!capture) return;
  capture.kill("SIGKILL");
  capture = undefined;
}

function stopCapture() {
  if (!capture) return;
  killCapture();
  emit({ type: "paused" });
}

/** Read fixed-size chunks from the capture stream and detect turn boundaries. */
async function pump(stream) {
  let buffer = Buffer.alloc(0);
  let preroll = [];
  let speech = [];
  let inSpeech = false;
  let silence = 0;
  let running = true;
  stream.on("end", () => {
    running = false;
  });
  stream.on("error", () => {
    running = false;
  });
  while (running) {
    const chunk = stream.read(BYTES_PER_CHUNK);
    if (!chunk) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const level = rms(chunk);
    if (!inSpeech) {
      preroll.push(chunk);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
      if (level >= RMS_THRESHOLD) {
        inSpeech = true;
        silence = 0;
        speech = [...preroll];
        preroll = [];
      }
      continue;
    }
    speech.push(chunk);
    if (level >= RMS_THRESHOLD) silence = 0;
    else silence += 1;
    const done = silence >= SILENCE_CHUNKS || speech.length >= MAX_CHUNKS;
    if (done) {
      const turn = speech.length - silence;
      inSpeech = false;
      silence = 0;
      const captured = speech;
      speech = [];
      if (turn >= MIN_CHUNKS) await handleTurn(Buffer.concat(captured));
      // handleTurn restarts capture for the next turn.
    }
  }
}

/** ASR one captured turn, surface it, then wait for Midas's decision. */
async function handleTurn(pcm) {
  killCapture();
  const path = wavPath("turn");
  writeWav(path, pcm);
  let text = "";
  try {
    text = await transcribe(path);
  } catch (error) {
    emit({ type: "error", message: `Transcription failed: ${error.message}` });
    return;
  }
  if (!text) {
    if (captureState.busy) startCapture();
    return;
  }
  emit({ type: "utterance", text });
  const decision = await awaitDecision();
  if (decision === "pause") {
    // pauseListening already emitted `paused`.
    return;
  }
  if (decision === "respond") {
    try {
      const reply = await personaplex(path);
      if (reply) emit({ type: "assistant", text: reply });
    } catch (error) {
      emit({ type: "error", message: `PersonaPlex failed: ${error.message}` });
      cleanup();
      process.exit(1);
    }
  }
  if (captureState.busy) startCapture();
}

/** Scripted turns for `SPEECH_FAKE=1`, so the TUI can be exercised with no model. */
async function fakeTurns() {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (!captureState.busy) return;
  emit({ type: "utterance", text: "Add a unit test for the speech controller" });
  const decision = await awaitDecision();
  if (decision === "respond") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    emit({ type: "assistant", text: "Okay, handing that to the agent." });
  }
  if (captureState.busy) void fakeTurns();
}

function startListening() {
  captureState.busy = true;
  // Capture can begin before the model finishes warming; a turn that arrives
  // first simply pays the load cost.
  startCapture();
}

function pauseListening() {
  captureState.busy = false;
  stopCapture();
}

function cleanup() {
  killCapture();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function readCommands() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let type;
      try {
        type = JSON.parse(trimmed).type;
      } catch {
        continue;
      }
      if (typeof type !== "string") continue;
      if (type === "stop") {
        cleanup();
        process.exit(0);
      }
      handleCommand(type);
    }
  });
  process.stdin.on("end", () => {
    cleanup();
    process.exit(0);
  });
}

function main() {
  readCommands();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  void warm().catch((error) => {
    emit({ type: "error", message: error.message });
    cleanup();
    process.exit(1);
  });
}

main();
