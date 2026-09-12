/**
 * Live context estimate, ported verbatim from pi
 * (`~/.pi/agent/customizations/live-context.ts`) so midas's footer `ctx (%)`
 * behaves identically: it grows with streamed text/thinking/tool arguments and
 * reconciles against provider usage, with display sampling capped at 1s.
 */

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

type PartialUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
const positive = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Display-only estimate. Never changes accounting or compaction decisions. */
export class LiveContext {
  private active = false;
  private base: number | null = null;
  private chars = 0;
  private input: number | null = null;
  private output = 0;

  start(usage: ContextUsage | undefined): void {
    this.clear();
    this.active = true;
    this.base = usage?.tokens ?? null;
  }

  update(event: { type?: string; delta?: unknown }, usage?: PartialUsage): void {
    if (!this.active) return;
    if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type ?? "") && typeof event.delta === "string") {
      this.chars += event.delta.length;
    }
    // Cached input is part of context, not additional generated output.
    const input = positive(usage?.input) + positive(usage?.cacheRead) + positive(usage?.cacheWrite);
    if (input > 0) this.input = input;
    this.output = Math.max(this.output, positive(usage?.output));
  }

  read(current: ContextUsage | undefined): (ContextUsage & { estimated?: boolean }) | undefined {
    if (!this.active || !current || current.contextWindow <= 0) return current;
    const base = this.input ?? this.base;
    if (base === null) return current; // Unknown after compaction until provider input usage arrives.
    // Use the baseline captured before streaming, never a moving total which
    // might already include the assistant. Deltas and provider output overlap.
    const tokens = base + Math.max(this.output, Math.ceil(this.chars / 4));
    return { tokens, contextWindow: current.contextWindow, percent: tokens / current.contextWindow * 100, estimated: true };
  }

  clear(): void {
    this.active = false;
    this.base = this.input = null;
    this.chars = this.output = 0;
  }
}

/** Sample live totals directly; never animate/interpolate intermediate values. */
export class ContextDisplay {
  private sampled: (ContextUsage & { estimated?: boolean }) | undefined;
  private sampledAt = 0;

  read(usage: (ContextUsage & { estimated?: boolean }) | undefined, now = Date.now()): (ContextUsage & { estimated?: boolean }) | undefined {
    if (!usage?.estimated || usage.tokens === null) {
      this.clear();
      return usage; // Final provider usage, tool results and unknown states apply immediately.
    }
    if (!this.sampled || now - this.sampledAt >= 1000 || now < this.sampledAt || usage.contextWindow !== this.sampled.contextWindow) {
      this.sampled = { ...usage };
      this.sampledAt = now;
    }
    return this.sampled;
  }

  clear(): void {
    this.sampled = undefined;
    this.sampledAt = 0;
  }
}
