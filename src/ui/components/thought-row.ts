import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ReasoningView } from "../../state/transcript.ts";
import { theme } from "../../theme/theme.ts";
import { SPINNER_FRAMES } from "./tool-call.ts";

/**
 * Per-episode thinking row, ported from pi's `thinking-status` extension:
 *
 *   ⠋ Thinking for 8s     (live, upright, no marker)
 *   + Thought for 8s      (settled, collapsed)
 *   - Thought for 8s      (settled, expanded: thinking shown underneath)
 *
 * A thought with no body shows its label only: no +/- marker, upright, and
 * clicks are ignored. Clicking an expandable row toggles it.
 */

const SPINNER_FRAME_MS = 80;
/** One Dark orange, matching pi's thought labels. */
const THOUGHT_ORANGE = (value: string): string => `\x1b[38;2;209;154;102m${value}\x1b[39m`;

function formatLong(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** Streaming label: whole seconds so it ticks calmly while thinking. */
function formatStreaming(ms: number): string {
  return formatLong(Math.max(0, Math.floor(ms / 1000)));
}

/** Settled label: millisecond precision below one second. */
function formatDone(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return formatLong(Math.round(ms / 1000));
}

export class ThoughtRow implements Component {
  expanded = false;
  private firstSeenAt = Date.now();

  constructor(
    private part: ReasoningView,
    private getPad: () => number,
    private expandAll: () => boolean = () => false,
  ) {}

  invalidate(): void {}

  /** A row can only be expanded while it has thinking text to reveal. */
  private expandable(): boolean {
    return this.part.text.trim().length > 0;
  }

  render(width: number): string[] {
    const t = theme();
    const live = !this.part.ended;
    const body = this.part.text;
    const startedAt = this.part.startedAt ?? this.firstSeenAt;
    const endedAt = this.part.endedAt ?? Date.now();

    // Only settled rows expose the +/- marker; live rows show a spinner.
    const open = this.expanded || this.expandAll();
    const marker = !live && this.expandable() ? (open ? "-" : "+") : "";
    const spinner = live
      ? SPINNER_FRAMES[Math.floor(Math.max(0, Date.now() - startedAt) / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]!
      : "";
    const label = live
      ? `Thinking for ${formatStreaming(Date.now() - startedAt)}`
      : `Thought for ${formatDone(endedAt - startedAt)}`;

    const parts: string[] = [];
    if (marker) parts.push(THOUGHT_ORANGE(marker));
    if (spinner) parts.push(t.fg("accent", spinner));
    parts.push(THOUGHT_ORANGE(label));
    // Reserve the marker/spinner gutter so labels line up in every state.
    const header = (!marker && !spinner ? "  " : "") + parts.join(" ");

    const pad = this.getPad();
    const container = new Container();
    container.addChild(new Text(header, pad, 0));
    if (open) {
      // The host owns spacing between rows; drop model-supplied boundary
      // newlines but keep interior paragraphs and indentation.
      const trimmed = body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
      if (trimmed) container.addChild(new Text(t.fg("thinkingText", trimmed), pad + 2, 0));
    }
    return container.render(width);
  }

  handleMouse(event: { type?: string; button?: string }): { handled: boolean } | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    // Nothing to reveal: leave the click unhandled instead of toggling.
    if (!this.expandable()) return undefined;
    this.expanded = !this.expanded;
    return { handled: true };
  }
}
