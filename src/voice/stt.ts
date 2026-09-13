import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One line of the streaming STT helper protocol. */
export interface SttEvent {
  type: "partial" | "final" | "error";
  text?: string;
  message?: string;
}

/** Parse a JSONL line emitted by the helper; junk lines are ignored. */
export function parseSttLine(line: string): SttEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { type, text, message } = parsed as { type?: unknown; text?: unknown; message?: unknown };
  if (type !== "partial" && type !== "final" && type !== "error") return undefined;
  return { type, text: typeof text === "string" ? text : undefined, message: typeof message === "string" ? message : undefined };
}

/** Full editor text: whatever was there before voice + finalized + in-progress. */
export function composeVoiceText(base: string, committed: string, partial: string): string {
  return `${base}${committed}${partial}`;
}

export interface SttProcess {
  stdout: NodeJS.ReadableStream;
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(): void;
}

export type SttSpawn = (command: string, args: string[]) => SttProcess;

export interface VoiceControllerOptions {
  command: string;
  args?: string[];
  spawn?: SttSpawn;
  /** Called with finalized + in-progress text as it arrives. */
  onText: (committed: string, partial: string) => void;
  /** Called once on a helper error; the controller stops itself. */
  onError: (message: string) => void;
  /** Called when the helper exits unexpectedly. */
  onStop?: () => void;
}

/**
 * Owns the streaming speech-to-text helper: spawns it, frames its JSONL stdout,
 * and reports finalized/in-progress text. Stopping is idempotent and kills the
 * helper so a deactivated /voice mode leaves no orphan.
 */
export class VoiceController {
  private child?: SttProcess;
  private committed = "";
  private partial = "";
  private stopping = false;

  constructor(private options: VoiceControllerOptions) {}

  start(): void {
    if (this.child) return;
    this.stopping = false;
    const spawnImpl: SttSpawn = this.options.spawn
      ?? ((command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] }) as unknown as SttProcess);
    let child: SttProcess;
    try {
      child = spawnImpl(this.options.command, this.options.args ?? []);
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseSttLine(line);
      if (!event) return;
      if (event.type === "partial") {
        this.partial = event.text ?? "";
        this.options.onText(this.committed, this.partial);
      } else if (event.type === "final") {
        this.committed += event.text ?? "";
        this.partial = "";
        this.options.onText(this.committed, this.partial);
      } else {
        this.options.onError(event.message ?? "Speech recognition failed");
        this.stop();
      }
    });
    child.on("exit", () => {
      if (this.stopping) return;
      this.child = undefined;
      if (this.partial) {
        this.committed += this.partial;
        this.partial = "";
        this.options.onText(this.committed, this.partial);
      }
      this.options.onStop?.();
    });
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    try { child?.kill(); } catch { /* already exited */ }
  }
}

/** Default helper: a bundled Node script wrapping a local STT engine. */
export function defaultVoiceCommand(): { command: string; args: string[] } {
  const script = fileURLToPath(new URL("../../scripts/voice-stt.mjs", import.meta.url));
  return { command: process.execPath, args: [script] };
}
