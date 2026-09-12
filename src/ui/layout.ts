import {
  ScrollView,
  VStack,
  type Component,
  type ScrollViewScrollbar,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** A single blank row; keeps transcript output off the input box's top edge. */
export class BlankLine implements Component {
  invalidate(): void {}
  render(): string[] {
    return [""];
  }
}

/**
 * Adds one blank row on the requested side of non-empty content, so a block
 * (e.g. the queue) sits with the same spacing above and below it. Empty
 * content contributes nothing, leaving the dock's own separator to do the work.
 */
export class PaddedBlock implements Component {
  constructor(
    private child: Component,
    private side: "top" | "bottom",
  ) {}

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    const lines = this.child.render(width);
    if (lines.length === 0) return lines;
    return this.side === "top" ? ["", ...lines] : [...lines, ""];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const y = this.side === "top" ? event.y - 1 : event.y;
    if (y < 0) return undefined;
    return this.child.handleMouse?.({ ...event, y });
  }
}

/** Shared fullscreen transcript + fixed input-dock layout (ported from pi). */
export function createChatViewport(options: {
  /** Fixed title/status bar pinned above the transcript. */
  header?: Component;
  document: Component;
  pendingMessages: Component;
  status: Component;
  editor: Component;
  footer: Component;
  scrollbar?: ScrollViewScrollbar;
  scrollbarTrackStyle?: (text: string) => string;
  scrollbarThumbStyle?: (text: string) => string;
}): { transcript: ScrollView; root: VStack } {
  const transcript = new ScrollView(options.document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: options.scrollbar ?? "auto",
    ...(options.scrollbarTrackStyle ? { scrollbarTrackStyle: options.scrollbarTrackStyle } : {}),
    ...(options.scrollbarThumbStyle ? { scrollbarThumbStyle: options.scrollbarThumbStyle } : {}),
  });

  const dock = new VStack([
    // Base separator so transcript output never butts against the input box.
    { component: new BlankLine(), basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 },
    { component: options.pendingMessages, shrink: 1, minSize: 0 },
    { component: options.status, shrink: 1, minSize: 0 },
    { component: options.editor, shrink: 1, minSize: 3 },
    { component: options.footer, shrink: 1, minSize: 1 },
  ]);

  const root = new VStack([
    ...(options.header ? [{ component: options.header, basis: "auto" as const, grow: 0, shrink: 0, minSize: 0 }] : []),
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);

  return { transcript, root };
}
