import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { theme } from "../../theme/theme.ts";

/** Atomic image chips, e.g. `[Image: screenshot.png]`, matching the editor. */
const IMAGE_MARKER_REGEX = /\[Image: [^\]\n]*\]/g;
const IMAGE_MARKER_COLOR = "\x1b[33m";

/**
 * Queued follow-ups, anchored above the input box. The queue itself is owned by
 * the app; this reads it at render time so enqueue/dequeue only need a render.
 * Clicking an entry hands it back to the app to edit in the input box.
 */
export class QueuedMessages implements Component {
  /** Local Y of each rendered entry, for click hit-testing. */
  private rows: number[] = [];

  constructor(
    private getQueue: () => readonly { text: string }[],
    private getPad: () => number = () => 0,
    private onPick: (index: number) => void = () => {},
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    this.rows = [];
    const queued = this.getQueue();
    if (queued.length === 0) return [];
    const t = theme();
    const pad = Math.max(0, this.getPad());
    const prefix = " ".repeat(pad);
    // Reserve the same gutter on the right as on the left (mirrors the footer),
    // so a truncated row stops short of the terminal edge instead of running to it.
    const available = Math.max(1, width - pad * 2);
    const ellipsis = "…";
    // `truncateToWidth` resets styling right before the ellipsis, so truncate
    // without one and append an explicitly dimmed ellipsis instead. Image chips
    // stay yellow even in the dim preview so they read as the same component.
    const colorize = (text: string): string => {
      let out = "";
      let last = 0;
      for (const match of text.matchAll(IMAGE_MARKER_REGEX)) {
        const at = match.index ?? 0;
        out += t.fg("dim", text.slice(last, at));
        out += `${IMAGE_MARKER_COLOR}${match[0]}\x1b[39m`;
        last = at + match[0].length;
      }
      return out + t.fg("dim", text.slice(last));
    };
    const row = (text: string): string => {
      const colored = colorize(text);
      if (visibleWidth(colored) <= available) return prefix + colored;
      const room = Math.max(0, available - visibleWidth(ellipsis));
      const clipped = truncateToWidth(colored, room, "");
      return prefix + clipped + t.fg("dim", ellipsis);
    };
    const label = "Queue:";
    // No leading blank: the input dock already separates the queue from the
    // transcript, so adding one here doubles the gap.
    const lines = [prefix + t.fg("muted", label)];
    queued.forEach((message, index) => {
      this.rows.push(lines.length);
      lines.push(row(`${index + 1}. ${message.text.replace(/\s+/g, " ").trim()}`));
    });
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    const index = this.rows.indexOf(event.y);
    if (index === -1) return undefined;
    this.onPick(index);
    return { handled: true, render: true };
  }
}
