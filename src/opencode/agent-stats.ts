import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPricing } from "../usage/codeburn/models.ts";
import { buildMenubarPayloadForRange } from "../usage/codeburn/usage-aggregator.ts";
import { midasConfigDir } from "../config/pi.ts";

/** One agent/tool's global usage (cost, sessions, calls, tokens). */
export interface AgentStat {
  key: string;
  label: string;
  cost: number;
  sessions: number;
  calls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const LABELS: Record<string, string> = {
  opencode: "OpenCode",
  "cursor-agent": "Cursor Agent",
  cursor: "Cursor",
  zed: "Zed",
  cline: "Cline",
  "cline-cli": "Cline CLI",
  omp: "OMP",
  dsh: "DeepSeek Harness",
  zcode: "ZCode",
};

let cache: { at: number; data: AgentStat[] } | undefined;
let inFlight: Promise<AgentStat[]> | undefined;
/** How long a computed snapshot stays "fresh" before a re-scan is warranted. */
const CACHE_TTL_MS = 10 * 60_000;

function statsCachePath(): string {
  return join(midasConfigDir(), "stats-cache.json");
}

/** Instantly load the last computed snapshot (memory first, then disk). */
export function loadCachedAgentStats(): AgentStat[] | undefined {
  if (cache) return cache.data;
  try {
    const raw = JSON.parse(readFileSync(statsCachePath(), "utf8")) as { at?: number; data?: AgentStat[] };
    if (Array.isArray(raw.data)) {
      cache = { at: Number(raw.at ?? 0), data: raw.data };
      return raw.data;
    }
  } catch {
    // No cache yet.
  }
  return undefined;
}

export function agentStatsAreFresh(): boolean {
  return Boolean(cache && Date.now() - cache.at < CACHE_TTL_MS);
}

/**
 * Cached global usage per agent. Returns the last snapshot when it is still
 * fresh (instant), otherwise re-scans. See `refreshAgentStats` for a forced
 * update.
 */
export async function readAgentStats(onProgress?: (stats: AgentStat[]) => void): Promise<AgentStat[]> {
  const cached = loadCachedAgentStats();
  if (cached && agentStatsAreFresh()) {
    onProgress?.(cached);
    return cached;
  }
  return refreshAgentStats(onProgress);
}

/**
 * Re-scan every agent/tool and update the memory + on-disk cache. Parsing and
 * pricing are codeburn's own code (MIT), vendored into `src/usage/codeburn`, so
 * the numbers match `codeburn report` without running its binary. Concurrent
 * calls share one scan.
 */
export async function refreshAgentStats(onProgress?: (stats: AgentStat[]) => void): Promise<AgentStat[]> {
  inFlight ??= scanInBackground().finally(() => {
    inFlight = undefined;
  });
  const data = await inFlight;
  onProgress?.(data);
  return data;
}

/**
 * Run the scan in a worker thread so the heavy parse can't stall the UI event
 * loop (arrow keys etc.). Falls back to in-process when the worker can't start.
 */
async function scanInBackground(): Promise<AgentStat[]> {
  const data = (await runScanInWorker().catch(() => computeAgentStats()));
  cache = { at: Date.now(), data };
  try {
    mkdirSync(midasConfigDir(), { recursive: true });
    writeFileSync(statsCachePath(), JSON.stringify(cache));
  } catch {
    // Persisting is best-effort; the in-memory cache still serves this session.
  }
  return data;
}

function runScanInWorker(): Promise<AgentStat[]> {
  return new Promise<AgentStat[]>((resolve, reject) => {
    const worker = new Worker(new URL("./agent-stats-worker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once("message", (message) => finish(() => resolve(message as AgentStat[])));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`stats worker exited with code ${code}`)));
    });
  });
}

/** The raw scan (no caching), also run inside the worker thread. */
export async function computeAgentStats(): Promise<AgentStat[]> {
  // The vendored parser logs progress/notices to stderr, which would corrupt the
  // alt-screen TUI. Swallow stderr for the duration of the scan.
  const stderr = process.stderr as unknown as { write: (...args: unknown[]) => boolean };
  const originalWrite = stderr.write;
  stderr.write = () => true;
  let details: Array<Record<string, unknown>> = [];
  try {
    await loadPricing();
    const payload = await buildMenubarPayloadForRange(
      { range: { start: new Date(0), end: new Date() }, label: "all" },
      { provider: "all" },
    );
    details = (payload.current.providerDetails ?? []) as unknown as Array<Record<string, unknown>>;
  } finally {
    stderr.write = originalWrite;
  }

  const data = details
    .map((entry): AgentStat => {
      const key = String(entry.id ?? "");
      return {
        key,
        label: LABELS[key] ?? String(entry.label ?? key),
        cost: Number(entry.cost ?? 0),
        sessions: Number(entry.sessions ?? 0),
        calls: Number(entry.calls ?? 0),
        tokens: {
          input: Number(entry.inputTokens ?? 0),
          output: Number(entry.outputTokens ?? 0),
          cacheRead: Number(entry.cacheReadTokens ?? 0),
          cacheWrite: Number(entry.cacheWriteTokens ?? 0),
        },
      };
    })
    .filter((stat) => stat.cost > 0 || stat.calls > 0)
    .sort((a, b) => b.cost - a.cost);

  return data;
}
