import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createOpencodeClient as createV2Client, type OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";

export interface ServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
  /** Override the opencode binary (default: `opencode` on PATH). */
  bin?: string;
  /** Extra opencode config file (merged via OPENCODE_CONFIG). */
  configFile?: string;
  timeoutMs?: number;
}

export interface RunningServer {
  client: OpencodeClient;
  /**
   * v2 API client. opencode 1.18.30 exposes its durable `session_input` queue
   * (`delivery: "steer" | "queue"`) only under `/api/...`; the v1 client above
   * runs the legacy prompt path and has no `delivery` field. Used to admit
   * steered follow-ups into a running turn.
   */
  clientV2: OpencodeV2Client;
  url: string;
  proc: ChildProcess;
  close(): void;
}

const LISTEN_RE = /on\s+(https?:\/\/[^\s]+)/;

/**
 * Start a headless `opencode serve` and return a ready SDK client.
 * We spawn it ourselves rather than using the SDK helper so we can honor a
 * custom binary path, stream startup errors, and shut down cleanly.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const {
    cwd,
    hostname = "127.0.0.1",
    port = 0,
    bin = process.env.MIDAS_OPENCODE_BIN ?? "opencode",
    configFile,
    timeoutMs = 30_000,
  } = options;

  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  // midas supplies its own context; never inherit Claude Code's global
  // `~/.claude/CLAUDE.md` (or per-project CLAUDE.md) into midas sessions.
  const env = {
    ...process.env,
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    ...(configFile ? { OPENCODE_CONFIG: configFile } : {}),
  };

  const proc = spawn(bin, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`opencode server did not start within ${timeoutMs}ms.\n${output}`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.includes("opencode server listening")) {
          const match = line.match(LISTEN_RE);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
            return;
          }
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch '${bin}': ${error.message}`));
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode server exited with code ${code}\n${output}`));
    });
  });

  const client = createOpencodeClient({ baseUrl: url, directory: cwd, responseStyle: "data" });
  // Version-sensitive: steer delivery depends on the v2 `/api/session/{id}/prompt`
  // route, which requires opencode 1.18.30+. The v2 client's durable prompt lives
  // under `.v2.session.prompt`; `.session.prompt` is the legacy v1 message API.
  const clientV2 = createV2Client({ baseUrl: url, directory: cwd, responseStyle: "data" });
  return {
    client,
    clientV2,
    url,
    proc,
    close() {
      if (!proc.killed) proc.kill();
    },
  };
}
