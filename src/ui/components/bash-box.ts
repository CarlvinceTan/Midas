import { BashExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { BashView } from "../../state/transcript.ts";

/**
 * Wraps pi's real BashExecutionComponent so `!` shell output looks identical to
 * pi (bashMode-bordered box, `$ command`, muted output, loader while running).
 */
export class BashBox implements Component {
  private impl: BashExecutionComponent;
  private lastOutputLength = 0;
  private lastStatus = "running";

  constructor(private part: BashView, ui: TUI, expanded: boolean) {
    this.impl = new BashExecutionComponent(part.command, ui, part.exclude);
    this.impl.setExpanded(expanded);
  }

  invalidate(): void {
    this.impl.invalidate();
  }

  render(width: number): string[] {
    this.sync();
    return this.impl.render(width);
  }

  private sync(): void {
    if (this.part.output.length > this.lastOutputLength) {
      this.impl.appendOutput(this.part.output.slice(this.lastOutputLength));
      this.lastOutputLength = this.part.output.length;
    }
    if (this.part.status !== "running" && this.part.status !== this.lastStatus) {
      this.impl.setComplete(this.part.exitCode, this.part.status === "cancelled");
      this.lastStatus = this.part.status;
    }
  }
}
