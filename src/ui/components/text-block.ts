import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TextView } from "../../state/transcript.ts";
import { normalizeHeadingDepth } from "../../lib/markdown.ts";
import { getMarkdownTheme } from "../../theme/theme.ts";

/**
 * One assistant text segment, rendered with pi's own AssistantMessageComponent
 * so markdown/spacing match `pi` exactly. Unlike pi-ai thinking blocks, midas
 * renders reasoning separately, so only text parts are passed here.
 */
export class TextBlock implements Component {
  private cacheKey = "";
  private cache: string[] = [];

  constructor(
    private parts: TextView[],
    private error: string | undefined,
    private options: { hideThinking: boolean },
    private pad: number,
  ) {}

  invalidate(): void {
    this.cacheKey = "";
    this.cache = [];
  }

  setSegment(parts: TextView[], error: string | undefined): void {
    this.parts = parts;
    this.error = error;
  }

  setPad(pad: number): void {
    this.pad = pad;
  }

  render(width: number): string[] {
    const key = `${this.options.hideThinking}|${this.pad}|${width}|${this.error ?? ""}|${this.parts.map((p) => p.text).join("\u0000")}`;
    if (key === this.cacheKey) return this.cache;
    const content = this.parts.map((part) => ({ type: "text", text: part.text }));
    const message = {
      role: "assistant",
      content,
      stopReason: this.error ? "error" : "stop",
      errorMessage: this.error,
    };
    const component = new AssistantMessageComponent(
      message as never,
      this.options.hideThinking,
      getMarkdownTheme(),
      "Thinking...",
      this.pad,
      [normalizeHeadingDepth],
    );
    this.cache = component.render(width);
    this.cacheKey = key;
    return this.cache;
  }
}
