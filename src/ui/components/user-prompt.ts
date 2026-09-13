import { Box, Container, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * macOS screenshot names contain a narrow no-break space (U+202F) before am/pm,
 * which renders at a width that disagrees with the measured width and shifts the
 * following glyphs. Display it as a normal space (content sent to the agent is
 * unaffected — this only affects the transcript rendering).
 */
const UNICODE_SPACE_REGEX = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** Atomic image chips, e.g. `[Image: screenshot.png]`, as the editor emits them. */
const IMAGE_MARKER_REGEX = /\[Image: [^\]\n]*\]/g;

/** Yellow, matching the editor's `[Image: …]` chips. */
const IMAGE_MARKER_COLOR = "\x1b[33m";

/**
 * User prompt card: markdown text inside a rounded, coloured border. Ported from
 * pi's user-message component (the published build renders a borderless
 * background box), so midas keeps the bordered prompt styling.
 */
export class UserPromptCard extends Container {
  private readonly imageNames: Set<string>;

  constructor(
    private text: string,
    private outputPad: number,
    private borderColor: (content: string) => string,
    imageFilenames: string[] = [],
    /** Multitask renders the prompt body in the tomato accent too. */
    private multitask = false,
  ) {
    super();
    // Normalize exactly like the displayed text so macOS screenshot names match.
    this.imageNames = new Set(imageFilenames.map((name) => name.replace(UNICODE_SPACE_REGEX, " ")));
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const contentBox = new Box(this.outputPad, 0);
    const promptText = this.text.replace(UNICODE_SPACE_REGEX, " ");
    // Image chips are yellow in the editor; render them the same way here. Only
    // markers for real attachments are styled — typed `[Image: …]` text stays
    // plain. The chip is wrapped as inline code so markdown leaves it intact,
    // then the code style paints it yellow and restores the prompt text colour.
    const promptTextColor = this.multitask ? "multitask" : "userMessageText";
    const markdownTheme = {
      ...getMarkdownTheme(),
      code: (content: string) => `${IMAGE_MARKER_COLOR}${content}${theme().getFgAnsi(promptTextColor)}`,
    };
    contentBox.addChild(
      new Markdown(
        promptText.replace(IMAGE_MARKER_REGEX, (marker) => {
          const name = marker.slice("[Image: ".length, -1);
          return this.imageNames.has(name) ? `\`${marker}\`` : marker;
        }),
        0,
        0,
        markdownTheme,
        { color: (content: string) => theme().fg(promptTextColor, content) },
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
      // Trim trailing padding: writing into the terminal's final column can make
      // it auto-wrap and overwrite the next row (text appears "squashed"). The
      // TUI clears the rest of each row anyway.
      lines[i] = (" ".repeat(margin) + lines[i]! + " ".repeat(margin)).replace(/ +$/, "");
    }
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]!;
    return lines;
  }
}
