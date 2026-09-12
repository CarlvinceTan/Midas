import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolView } from "../../state/transcript.ts";
import { markContent } from "../../lib/ansi.ts";
import { renderTool } from "./tool-call.ts";

/**
 * A single tool call inside an activity chain. Clicking toggles its preview,
 * which is indented so it lines up with the tool's label text rather than its
 * status glyph.
 */
export class ToolItemRow implements Component {
  private expanded = false;

  constructor(
    private part: ToolView,
    private getPad: () => number,
    private cwd: string,
    private expandAll: () => boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const pad = this.getPad();
    const padStr = " ".repeat(pad);
    const expanded = this.expanded || this.expandAll();
    const rendered = renderTool(this.part, Math.max(1, width - pad), expanded, this.cwd);
    return rendered.map((line, index) => (index === 0 ? padStr + markContent(line) : padStr + "  " + markContent(line)));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    this.expanded = !this.expanded;
    return { handled: true };
  }
}
