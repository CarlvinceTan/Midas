import { UserPromptCard } from "./user-prompt.ts";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { PartView } from "../../state/transcript.ts";
import type { Run, RunSegment } from "../run-model.ts";
import { buildRunSegments, countFailures, finalTextIndex, formatRunDuration, runDurationMs } from "../run-model.ts";
import { getMarkdownTheme, theme } from "../../theme/theme.ts";
import { markContent } from "../../lib/ansi.ts";
import { TextBlock } from "./text-block.ts";
import { ActivityRow, CHILD_INDENT } from "./activity-row.ts";
import { BashBox } from "./bash-box.ts";

export interface RunViewOptions {
  hideThinking: boolean;
  /** Global expand-all (ctrl+o): expands every run, chain and detail row. */
  expandedTools: boolean;
  /** Multitask renders prompt cards in the tomato accent. */
  multitask?: boolean;
}

type Range = { component: Component; start: number; end: number };

/**
 * One chat run (user prompt + everything the agent did before the next prompt).
 *
 * Live: output text and the current activity chain are shown in place; finished
 * chains stay collapsed as summary rows.
 * Settled: collapses to a "+ Worked for 12s" header with the final answer
 * underneath; expanding the header reveals the intermediate text and chains.
 */
export class RunView implements Component {
  expanded = false;
  private run: Run;
  private active = false;
  private bodyPad = 0;
  private textBlocks = new Map<string, TextBlock>();
  private activityRows = new Map<string, ActivityRow>();
  private bashBoxes = new Map<string, BashBox>();
  private ranges: Range[] = [];
  private headerStart: number | undefined;
  private headerEnd: number | undefined;
  /**
   * Rendered output for this run, reused across frames. The transcript bumps a
   * message's `version` on every mutation, so the summed version is a cheap,
   * exact change signal; only the run being streamed (active) is re-rendered
   * every frame because its elapsed-time rows change with the clock.
   */
  private cache?: { key: string; lines: string[] };

  constructor(
    run: Run,
    private getPad: () => number,
    private cwd: string,
    private options: RunViewOptions,
    private borderColor: (text: string) => string,
    private ui: TUI,
  ) {
    this.run = run;
  }

  invalidate(): void {
    this.cache = undefined;
    for (const child of this.textBlocks.values()) child.invalidate();
    for (const child of this.activityRows.values()) child.invalidate();
    for (const child of this.bashBoxes.values()) child.invalidate();
  }

  setRun(run: Run): void {
    this.run = run;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /** Stable key covering every input that changes this run's rendered lines. */
  private renderKey(width: number): string {
    let versions = 0;
    for (const message of this.run.messages) versions += message.version ?? 0;
    return [
      this.run.id,
      width,
      this.getPad(),
      this.run.messages.length,
      versions,
      this.active ? 1 : 0,
      this.expanded ? 1 : 0,
      this.options.expandedTools ? 1 : 0,
      this.options.hideThinking ? 1 : 0,
    ].join("|");
  }

  render(width: number): string[] {
    // A live run animates (spinner, "Thinking for Xs"), so its key never settles.
    if (this.active) this.cache = undefined;
    const key = this.renderKey(width);
    if (!this.active && this.cache?.key === key) return this.cache.lines;
    const lines = this.renderUncached(width);
    if (!this.active) this.cache = { key, lines };
    return lines;
  }

  private renderUncached(width: number): string[] {
    const pad = this.getPad();
    const lines: string[] = [];
    const ranges: Range[] = [];
    this.headerStart = undefined;
    this.headerEnd = undefined;

    const prompt = this.run.prompt;
    let promptRendered = false;
    if (prompt) {
      const text = prompt.parts
        .filter((part): part is Extract<PartView, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) {
        const component = new UserPromptCard(text, pad, this.borderColor, prompt.imageFilenames ?? [], this.options.multitask === true);
        lines.push(...component.render(width));
        promptRendered = true;
      }
    }

    for (const message of this.run.messages) {
      if (message === prompt || !message.notice) continue;
      for (const part of message.parts) {
        if (part.kind !== "text") continue;
        for (const line of part.text.split("\n")) {
          lines.push(" ".repeat(pad) + markContent(theme().fg("dim", line)));
        }
      }
    }

    const segments = buildRunSegments(this.run);
    const finalIndex = finalTextIndex(segments);
    // Tool/thinking runs always compact into a "Worked for" block; text-only and
    // `!` bash-only runs render inline. Failures stay visible when collapsed.
    const hasActivity = segments.some((segment) => segment.kind === "activity");
    const failures = segments.reduce(
      (count, segment) => (segment.kind === "activity" ? count + countFailures(segment.items) : count),
      0,
    );
    const expandAll = this.options.expandedTools;

    // While live, the status line carries the current action, so the transcript
    // shows only prose (chains appear once the run settles and can be expanded).

    // While live, the status line carries the current action, so the trailing
    // (in-flight) chain is hidden; finished chains and text still render.
    const trailing = segments[segments.length - 1];
    const currentChainId = this.active && trailing?.kind === "activity" ? trailing.id : undefined;

    // The prompt is followed by a blank row so the response doesn't butt against
    // the input box. Text blocks bring their own leading blank, so skip it when
    // the first thing actually rendered is text (a Worked-for header counts).
    const firstRendered = this.active
      ? segments.find((segment) => !(segment.kind === "activity" && segment.id === currentChainId))
      : hasActivity
        ? undefined
        : segments[0];
    if (promptRendered && segments.length > 0 && firstRendered?.kind !== "text") lines.push("");

    const renderOrder: Array<{ segment: RunSegment; pad: number }> = [];
    if (this.active) {
      for (const segment of segments) {
        if (segment.kind === "activity" && segment.id === currentChainId) continue;
        renderOrder.push({ segment, pad });
      }
    } else if (!hasActivity) {
      for (const segment of segments) renderOrder.push({ segment, pad });
    } else {
      const label = runDurationMs(this.run);
      const title = label !== undefined ? `Worked for ${formatRunDuration(label)}` : "Worked";
      const failureSuffix =
        failures > 0 ? `${theme().fg("muted", " · ")}${theme().fg("error", `${failures} failed`)}` : "";
      const expanded = this.expanded || expandAll;
      const marker = expanded ? "-" : "+";
      this.headerStart = lines.length;
      lines.push(
        " ".repeat(pad) + markContent(`${theme().fg("accent", marker)} ${theme().fg("muted", title)}${failureSuffix}`),
      );
      this.headerEnd = lines.length;
      if (expanded) {
        for (let index = 0; index < segments.length; index++) {
          if (index === finalIndex) continue;
          renderOrder.push({ segment: segments[index]!, pad: pad + CHILD_INDENT });
        }
        if (finalIndex !== undefined) renderOrder.push({ segment: segments[finalIndex]!, pad });
      } else {
        // Collapsed: show the final answer plus any user-initiated `!` shell
        // output, in order, so a command's box is never hidden by the summary.
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index]!;
          if (index !== finalIndex && segment.kind !== "bash") continue;
          renderOrder.push({ segment, pad });
        }
      }
    }

    // Space the expanded body from its header. Text blocks lead with a blank
    // row and bash boxes carry their own leading spacer, so only add one for
    // segments that start flush (activity rows).
    const first = renderOrder[0]?.segment;
    if (this.headerStart !== undefined && first && first.kind !== "text" && first.kind !== "bash") {
      lines.push("");
    }

    for (let index = 0; index < renderOrder.length; index++) {
      const { segment, pad: segmentPad } = renderOrder[index]!;
      this.bodyPad = segmentPad;
      this.renderSegment(segment, width, lines, ranges);
      // Text blocks carry a leading blank row; add a trailing one too so a
      // following tool chain is clearly separated. Bash boxes already lead with
      // their own spacer, so adding one here would double the gap.
      const next = renderOrder[index + 1];
      if (segment.kind === "text" && next && next.segment.kind !== "text" && next.segment.kind !== "bash") {
        lines.push("");
      }
    }

    this.ranges = ranges;
    return lines;
  }

  private renderSegment(segment: RunSegment, width: number, lines: string[], ranges: Range[]): void {
    if (segment.kind === "text") {
      const block = this.textBlock(segment);
      block.setPad(this.bodyPad);
      lines.push(...block.render(width));
      return;
    }
    if (segment.kind === "activity") {
      const row = this.activityRow(segment);
      row.setItems(segment.items);
      row.autoExpand(false);
      const start = lines.length;
      lines.push(...row.render(width));
      if (lines.length > start) ranges.push({ component: row, start, end: lines.length });
      return;
    }
    const box = this.bashBox(segment);
    lines.push(...box.render(width));
  }

  private textBlock(segment: Extract<RunSegment, { kind: "text" }>): TextBlock {
    let block = this.textBlocks.get(segment.id);
    if (!block) {
      block = new TextBlock(segment.parts, segment.error, this.options, this.bodyPad);
      this.textBlocks.set(segment.id, block);
    } else {
      block.setSegment(segment.parts, segment.error);
    }
    return block;
  }

  private activityRow(segment: Extract<RunSegment, { kind: "activity" }>): ActivityRow {
    let row = this.activityRows.get(segment.id);
    if (!row) {
      row = new ActivityRow(segment.items, () => this.bodyPad, this.cwd, () => this.options.expandedTools);
      this.activityRows.set(segment.id, row);
    } else {
      row.setItems(segment.items);
    }
    return row;
  }

  private bashBox(segment: Extract<RunSegment, { kind: "bash" }>): BashBox {
    let box = this.bashBoxes.get(segment.id);
    if (!box) {
      box = new BashBox(segment.part, this.ui, this.options.expandedTools);
      this.bashBoxes.set(segment.id, box);
    }
    return box;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    if (this.headerStart !== undefined && event.y >= this.headerStart && event.y < (this.headerEnd ?? this.headerStart + 1)) {
      this.expanded = !this.expanded;
      this.cache = undefined;
      return { handled: true };
    }
    for (const range of this.ranges) {
      if (event.y < range.start || event.y >= range.end) continue;
      const result = range.component.handleMouse?.({ ...event, y: event.y - range.start, height: range.end - range.start });
      // Nested rows keep their own expand state, which the cache key can't see.
      if (result?.handled) this.cache = undefined;
      return result;
    }
    return undefined;
  }
}
