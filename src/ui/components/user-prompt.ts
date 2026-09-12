import { Box, Container, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * User prompt card: markdown text inside a rounded, coloured border. Ported from
 * pi's user-message component (the published build renders a borderless
 * background box), so midas keeps the bordered prompt styling.
 */
export class UserPromptCard extends Container {
  constructor(
    private text: string,
    private outputPad: number,
    private borderColor: (content: string) => string,
  ) {
    super();
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const contentBox = new Box(this.outputPad, 0);
    contentBox.addChild(
      new Markdown(
        this.text,
        0,
        0,
        getMarkdownTheme(),
        { color: (content: string) => theme().fg("userMessageText", content) },
        { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
      ),
    );
    this.addChild(contentBox);
  }

  render(width: number): string[] {
    // Offset the prompt gutter by one border column, never below zero.
    const margin = Math.min(Math.max(0, this.outputPad - 1), Math.max(0, Math.floor((width - 3) / 2)));
    const cardWidth = Math.max(0, width - margin * 2);
    const innerWidth = Math.max(1, cardWidth - 2);
    const contentLines = super.render(innerWidth).map((line) => {
      const fitted = visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth, "") : line;
      return fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
    });
    if (contentLines.length === 0) return contentLines;

    const horizontal = "─".repeat(innerWidth);
    const lines =
      cardWidth >= 3
        ? [
            "\x1b]777;pi-decoration\x07\x1b]777;pi-content-start\x07\x1b]777;pi-content-end\x07" +
              this.borderColor(`╭${horizontal}╮`),
            ...contentLines.map((line) => `${this.borderColor("│")}${line}${this.borderColor("│")}`),
            "\x1b]777;pi-decoration\x07\x1b]777;pi-content-start\x07\x1b]777;pi-content-end\x07" +
              this.borderColor(`╰${horizontal}╯`),
          ]
        : contentLines.map((line) => truncateToWidth(line, cardWidth, ""));

    for (let i = 0; i < lines.length; i++) {
      lines[i] = " ".repeat(margin) + lines[i]! + " ".repeat(margin);
    }
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]!;
    return lines;
  }
}
