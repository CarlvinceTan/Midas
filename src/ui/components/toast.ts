import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** One-line transient message, rendered as a top-right overlay. */
export class Toast implements Component {
  constructor(
    private text: string,
    private style: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const inner = truncateToWidth(this.text, Math.max(0, width - 2), "…");
    const fill = " ".repeat(Math.max(0, width - 2 - visibleWidth(inner)));
    return [`${this.style} ${inner}${fill} \x1b[0m`];
  }
}
