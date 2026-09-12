import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ChainItem } from "../run-model.ts";
import { countFailures, summarizeChain } from "../run-model.ts";
import { theme } from "../../theme/theme.ts";
import { markContent } from "../../lib/ansi.ts";
import { ThoughtRow } from "./thought-row.ts";
import { ToolItemRow } from "./tool-item-row.ts";

/** Nested rows indent by two columns so their glyph aligns with the parent text. */
export const CHILD_INDENT = 2;

/**
 * One collapsible chain of tool/thinking parts:
 *
 *   + Ran commands, read files          (collapsed)
 *   - Ran commands, read files          (expanded)
 *       ✓ Ran `npm test`
 *       + Thought for 4s
 *
 * The chain that is currently running (headerless) shows its items directly so
 * the live tool stays a plain `✓ Ran ...` row; the summary only appears once the
 * chain is finished. Clicking the header toggles the chain; clicks on individual
 * rows flow through to the tool/thinking row so each stays expandable.
 */
export class ActivityRow implements Component {
  private expanded = false;
  /** Set once the user toggles, so live auto-expand stops overriding them. */
  private touched = false;
  /** Render items with no summary header (the chain is the current one). */
  private headerless = false;
  private items: ChainItem[];
  private children = new Map<string, Component>();
  private ranges: Array<{ component: Component; start: number; end: number }> = [];

  constructor(
    items: ChainItem[],
    private getPad: () => number,
    private cwd: string,
    private expandAll: () => boolean,
  ) {
    this.items = items;
  }

  invalidate(): void {
    for (const child of this.children.values()) child.invalidate?.();
  }

  setItems(items: ChainItem[]): void {
    this.items = items;
  }

  setHeaderless(value: boolean): void {
    this.headerless = value;
  }

  /** Live runs keep their active (last) chain open without stealing manual toggles. */
  autoExpand(value: boolean): void {
    if (!this.touched) this.expanded = value;
  }

  private child(item: ChainItem): Component {
    let child = this.children.get(item.part.id);
    if (!child) {
      // Headerless (live) and single-item chains have no header row, so their
      // item sits at the base pad like the surrounding transcript text.
      const flat = (): boolean => this.headerless || this.items.length === 1;
      const childPad = (): number => this.getPad() + (flat() ? 0 : CHILD_INDENT);
      child =
        item.kind === "reasoning"
          ? new ThoughtRow(item.part, childPad, this.expandAll)
          : new ToolItemRow(item.part, childPad, this.cwd, this.expandAll);
      this.children.set(item.part.id, child);
    }
    return child;
  }

  render(width: number): string[] {
    const t = theme();
    const pad = this.getPad();
    const lines: string[] = [];
    const ranges: Array<{ component: Component; start: number; end: number }> = [];

    // The live chain shows only its current action as one animated row; finished
    // steps stay hidden until the chain settles into the summary header.
    if (this.headerless) {
      const current = this.items[this.items.length - 1];
      if (current) {
        const child = this.child(current);
        const start = lines.length;
        for (const line of child.render(width)) lines.push(line);
        ranges.push({ component: child, start, end: lines.length });
      }
      this.ranges = ranges;
      return lines;
    }

    // A chain with a single step needs no summary wrapper: show the row itself.
    if (this.items.length === 1) {
      const child = this.child(this.items[0]!);
      const start = lines.length;
      for (const line of child.render(width)) lines.push(line);
      ranges.push({ component: child, start, end: lines.length });
      this.ranges = ranges;
      return lines;
    }

    const expanded = this.expanded || this.expandAll();
    const marker = expanded ? "-" : "+";
    const failures = countFailures(this.items);
    const failureSuffix = failures > 0 ? `${t.fg("muted", " · ")}${t.fg("error", `${failures} failed`)}` : "";
    const header = markContent(`${t.fg("accent", marker)} ${t.fg("muted", summarizeChain(this.items))}${failureSuffix}`);
    lines.push(" ".repeat(pad) + header);
    if (expanded) {
      for (const item of this.items) {
        const child = this.child(item);
        const start = lines.length;
        for (const line of child.render(width)) lines.push(line);
        ranges.push({ component: child, start, end: lines.length });
      }
    }
    this.ranges = ranges;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event?.type !== "click" || event?.button !== "left") return undefined;
    if (!this.headerless && this.items.length > 1 && event.y === 0) {
      this.expanded = !this.expanded;
      this.touched = true;
      return { handled: true };
    }
    for (const range of this.ranges) {
      if (event.y < range.start || event.y >= range.end) continue;
      return range.component.handleMouse?.({ ...event, y: event.y - range.start, height: range.end - range.start });
    }
    return undefined;
  }
}
