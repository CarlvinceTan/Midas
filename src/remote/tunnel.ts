import { spawn, type ChildProcess } from "node:child_process";

/**
 * Public reachability for the remote gateway, with no account and no config:
 * a Cloudflare Quick Tunnel. It is deliberately ephemeral (a new random
 * hostname per launch, no SLA), which matches a temporary link.
 *
 * Note: Quick Tunnels do not support Server-Sent Events, so the gateway's live
 * channel is a WebSocket rather than SSE.
 */
export interface RunningTunnel {
  url: string;
  proc: ChildProcess;
  close(): void;
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** Pull the first `https://<name>.trycloudflare.com` URL out of cloudflared's logs. */
export function parseTunnelUrl(output: string): string | undefined {
  return output.match(TUNNEL_URL_RE)?.[0];
}

/** Overridable path to the cloudflared binary. */
export function cloudflaredBin(): string {
  return process.env.MIDAS_CLOUDFLARED_BIN ?? "cloudflared";
}

/**
 * Start `cloudflared tunnel --url http://127.0.0.1:<port>` and resolve once it
 * prints the public URL. Mirrors `startServer`'s stdout parsing and shutdown.
 */
export async function startQuickTunnel(port: number, timeoutMs = 30_000): Promise<RunningTunnel> {
  const bin = cloudflaredBin();
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(new Error(`cloudflared did not return a public URL within ${timeoutMs}ms.\n${output}`)));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = parseTunnelUrl(output);
      if (found) finish(() => resolve(found));
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (error) => {
      const hint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? ` Is '${bin}' installed and on PATH? (brew install cloudflared)`
          : "";
      finish(() => reject(new Error(`Failed to launch '${bin}': ${error.message}.${hint}`)));
    });
    proc.on("exit", (code) => {
      finish(() => reject(new Error(`cloudflared exited with code ${code}\n${output}`)));
    });
  });

  return {
    url,
    proc,
    close() {
      if (!proc.killed) proc.kill();
    },
  };
}
