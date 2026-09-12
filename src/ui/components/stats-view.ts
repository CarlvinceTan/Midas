import { matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { theme } from "../../theme/theme.ts";
import type { AgentStat } from "../../opencode/agent-stats.ts";
import { formatMoney } from "../../lib/currency.ts";
import { renderTabStrip } from "./tab-strip.ts";

interface Totals {
  cost: number;
  sessions: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO: Totals = { cost: 0, sessions: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function add(a: Totals, b: AgentStat): Totals {
  return {
    cost: a.cost + b.cost,
    sessions: a.sessions + b.sessions,
    calls: a.calls + b.calls,
    input: a.input + b.tokens.input,
    output: a.output + b.tokens.output,
    cacheRead: a.cacheRead + b.tokens.cacheRead,
    cacheWrite: a.cacheWrite + b.tokens.cacheWrite,
  };
}

/**
 * `/stats` overlay: global spend and token usage per agent/tool (Pi, Claude,
 * Codex, Cursor, OpenCode, …) with an "All" tab plus one per agent. Left/Right
 * or clicking a tab switches scope; values show `--` until loaded.
 */
export class StatsView implements Component {
  private data: AgentStat[] | undefined;
  private error: string | undefined;
  private scopeIndex = 0;
  private tabRanges: Array<{ start: number; end: number; index: number }> = [];

  constructor(private options: { cwd: string; onCancel: () => void }) {}

  setData(data: AgentStat[]): void {
    this.data = data;
    this.error = undefined;
  }

  setError(message: string): void {
    this.error = message;
  }

  invalidate(): void {}

  private total(): Totals {
    let totals = ZERO;
    for (const agent of this.data ?? []) totals = add(totals, agent);
    return totals;
  }

  private totals(scopeIndex: number): Totals {
    if (scopeIndex <= 0) return this.total();
    const agent = this.data?.[scopeIndex - 1];
    return agent ? add(ZERO, agent) : ZERO;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.onCancel();
    const count = 1 + (this.data?.length ?? 0);
    if (count === 0) return;
    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.scopeIndex = (this.scopeIndex + 1) % count;
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      this.scopeIndex = (this.scopeIndex - 1 + count) % count;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Only an explicit click switches scope; moving over a tab must not.
    if (event.type !== "click") return undefined;
    if (event.y !== 0) return undefined;
    const tab = this.tabRanges.find((range) => event.x >= range.start && event.x < range.end);
    if (!tab) return undefined;
    this.scopeIndex = tab.index;
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const t = theme();
    const labels = ["All", ...(this.data ?? []).map((agent) => agent.label)];
    this.scopeIndex = Math.min(this.scopeIndex, Math.max(0, labels.length - 1));
    const pad = " ";

    this.tabRanges = [];
    // Reserve equal padding on both edges so the strip never touches the frame.
    const strip = renderTabStrip(labels, this.scopeIndex, width - pad.length * 2);
    for (const range of strip.ranges) {
      this.tabRanges.push({ start: range.start + pad.length, end: range.end + pad.length, index: range.index });
    }
    const lines: string[] = [pad + strip.text, ""];

    if (this.error) {
      lines.push(pad + t.fg("error", this.error));
      return lines;
    }

    const loading = this.data === undefined;
    const usage = this.totals(this.scopeIndex);
    const row = (label: string, value: string): string => pad + t.fg("muted", label.padEnd(14)) + value;
    const plain = (value: string): string => (loading ? t.fg("muted", "--") : t.fg("text", value));
    const money = (value: number): string => (loading ? t.fg("muted", "--") : t.fg("success", formatMoney(value)));
    const tokens = (value: number): string => (loading ? t.fg("muted", "--") : t.fg("text", formatTokens(value)));

    lines.push(row("Sessions", plain(String(usage.sessions))));
    lines.push(row("Calls", plain(String(usage.calls))));
    lines.push(row("Total cost", money(usage.cost)));
    lines.push(row("Tokens", tokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)));
    lines.push(row("  input", tokens(usage.input)));
    lines.push(row("  output", tokens(usage.output)));
    lines.push(row("  cache r/w", plain(`${formatTokens(usage.cacheRead)} / ${formatTokens(usage.cacheWrite)}`)));
    const cacheDenominator = usage.input + usage.cacheRead;
    const cacheHit = cacheDenominator > 0 ? (usage.cacheRead / cacheDenominator) * 100 : 0;
    lines.push(row("Cache hit", plain(`${cacheHit.toFixed(1)}%`)));
    lines.push("");
    lines.push(row("Avg/session", loading ? t.fg("muted", "--") : t.fg("text", formatMoney(usage.sessions ? usage.cost / usage.sessions : 0))));
    lines.push(row("Avg/call", loading ? t.fg("muted", "--") : t.fg("text", formatMoney(usage.calls ? usage.cost / usage.calls : 0))));
    return lines;
  }
}
