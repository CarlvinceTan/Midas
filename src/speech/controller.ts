import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One line of the streaming PersonaPlex helper protocol. */
export interface SpeechEvent {
  type: "ready" | "listening" | "paused" | "utterance" | "assistant" | "error";
  text?: string;
  message?: string;
}

const SPEECH_EVENT_TYPES = new Set(["ready", "listening", "paused", "utterance", "assistant", "error"]);

/** Parse a JSONL line emitted by the helper; junk lines are ignored. */
export function parseSpeechLine(line: string): SpeechEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { type, text, message } = parsed as { type?: unknown; text?: unknown; message?: unknown };
  if (typeof type !== "string" || !SPEECH_EVENT_TYPES.has(type)) return undefined;
  return {
    type: type as SpeechEvent["type"],
    text: typeof text === "string" ? text : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

export interface SpeechProcess {
  stdout: NodeJS.ReadableStream;
  /** Commands are written here (`listen`/`pause`/`respond`/`skip`/`stop`). */
  stdin?: NodeJS.WritableStream;
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(): void;
}

export type SpeechSpawn = (command: string, args: string[]) => SpeechProcess;

export interface SpeechControllerOptions {
  command: string;
  args?: string[];
  spawn?: SpeechSpawn;
  /** Extra environment for the helper (e.g. SPEECH_VOICE); merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Finalized words for one spoken turn, after the helper's ASR. */
  onUtterance: (text: string) => void;
  /** PersonaPlex's spoken reply (its inner-monologue transcript). */
  onAssistant: (text: string) => void;
  /** Called once on a helper error; the controller stops itself. */
  onError: (message: string) => void;
  /** Called once when the helper has warmed the model and can listen. */
  onReady?: () => void;
  /** Called when the helper exits unexpectedly. */
  onStop?: () => void;
}

/**
 * Owns the long-lived PersonaPlex helper. The helper process is spawned once and
 * kept alive: `listen` opens the microphone, `pause` closes it but keeps the
 * process (and its caches) warm, and `stop` tears it down.
 *
 * PersonaPlex itself is one-shot (`speech respond` reloads the model each call),
 * so the controller cannot promise an always-resident model. What it owns is the
 * conversation loop: it surfaces each finalized user utterance, then waits for
 * Midas to decide `respond` (PersonaPlex speaks) or `skip` (delegated to the
 * coding agent, no spoken reply).
 */
export class SpeechController {
  private child?: SpeechProcess;
  private teardown = false;
  private processReady = false;
  private listening = false;

  constructor(private options: SpeechControllerOptions) {}

  /** True once the helper has warmed up and can listen at once. */
  get ready(): boolean {
    return this.processReady;
  }

  /** Spawn and warm the helper without opening the microphone. */
  preload(): void {
    this.ensureStarted();
  }

  /** Start capturing; the helper opens the microphone and reports back. */
  listen(): void {
    this.ensureStarted();
    if (this.listening) return;
    this.listening = true;
    this.send("listen");
  }

  /** Stop capturing but keep the helper process warm for the next `/speech`. */
  pause(): void {
    if (!this.listening) return;
    this.listening = false;
    this.send("pause");
  }

  /** Ask PersonaPlex to answer the turn the helper just surfaced. */
  respond(): void {
    if (!this.listening) return;
    this.send("respond");
  }

  /** Decline the spoken reply (a clear task was delegated instead). */
  skip(): void {
    if (!this.listening) return;
    this.send("skip");
  }

  /** Tear the helper down for good (app exit or a fatal error). */
  stop(): void {
    this.teardown = true;
    this.listening = false;
    const child = this.child;
    this.child = undefined;
    this.processReady = false;
    if (child) this.sendTo(child, "stop");
    try {
      child?.kill();
    } catch {
      /* already exited */
    }
  }

  private ensureStarted(): void {
    if (this.child) return;
    this.teardown = false;
    this.processReady = false;
    const spawnImpl: SpeechSpawn =
      this.options.spawn ??
      ((command, args) =>
        spawn(command, args, {
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, ...this.options.env },
        }) as unknown as SpeechProcess);
    let child: SpeechProcess;
    try {
      child = spawnImpl(this.options.command, this.options.args ?? []);
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.on("exit", () => this.handleExit());
  }

  private handleLine(line: string): void {
    const event = parseSpeechLine(line);
    if (!event) return;
    switch (event.type) {
      case "ready":
        this.markReady();
        break;
      case "utterance":
        // A turn only matters while the microphone is open.
        this.markReady();
        if (this.listening) this.options.onUtterance(event.text ?? "");
        break;
      case "assistant":
        this.markReady();
        if (this.listening) this.options.onAssistant(event.text ?? "");
        break;
      case "error":
        this.options.onError(event.message ?? "Speech failed");
        this.stop();
        break;
      default:
        // "listening"/"paused" are informational acknowledgements.
        break;
    }
  }

  private markReady(): void {
    if (this.processReady) return;
    this.processReady = true;
    this.options.onReady?.();
  }

  private handleExit(): void {
    this.child = undefined;
    this.processReady = false;
    this.listening = false;
    if (this.teardown) return;
    this.options.onStop?.();
  }

  private send(command: "listen" | "pause" | "respond" | "skip" | "stop"): void {
    if (this.child) this.sendTo(this.child, command);
  }

  private sendTo(child: SpeechProcess, command: "listen" | "pause" | "respond" | "skip" | "stop"): void {
    const stdin = child.stdin;
    if (!stdin) return;
    try {
      stdin.write(`${JSON.stringify({ type: command })}\n`);
    } catch {
      /* process gone */
    }
  }
}

/** Default helper: a bundled Node script driving PersonaPlex via the `speech` CLI. */
export function defaultSpeechCommand(): { command: string; args: string[] } {
  const script = fileURLToPath(new URL("../../scripts/speech-personaplex.mjs", import.meta.url));
  return { command: process.execPath, args: [script] };
}
