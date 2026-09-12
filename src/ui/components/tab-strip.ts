import { theme } from "../../theme/theme.ts";

export interface TabStripResult {
  text: string;
  /** Visible-column ranges of each rendered tab, for click hit-testing. */
  ranges: Array<{ start: number; end: number; index: number }>;
}

/** `7 more →` / `← 7 more` overflow markers; 0 means nothing hidden. */
function leftIndicator(count: number): string {
  return `← ${count} more`;
}

function rightIndicator(count: number): string {
  return `${count} more →`;
}

function indicatorWidth(count: number): number {
  return count > 0 ? String(count).length + " more →".length : 0;
}

/** Largest window of tabs (containing `active`) that fits `width`, with markers. */
function windowFor(lengths: number[], active: number, width: number, gap: number): { start: number; end: number } {
  const count = lengths.length;
  const total = lengths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, count - 1);
  if (total <= width) return { start: 0, end: count };

  const rowWidth = (start: number, end: number): number => {
    let used = gap * Math.max(0, end - start - 1);
    for (let index = start; index < end; index++) used += lengths[index]!;
    if (start > 0) used += indicatorWidth(start) + gap;
    if (end < count) used += gap + indicatorWidth(count - end);
    return used;
  };

  let start = active;
  let end = active + 1;
  for (;;) {
    const canRight = end < count;
    const canLeft = start > 0;
    if (!canRight && !canLeft) break;
    const preferRight = canRight && (!canLeft || count - end >= start);
    let expanded = false;
    if (preferRight) {
      if (canRight && rowWidth(start, end + 1) <= width) {
        end += 1;
        expanded = true;
      } else if (canLeft && rowWidth(start - 1, end) <= width) {
        start -= 1;
        expanded = true;
      }
    } else {
      if (canLeft && rowWidth(start - 1, end) <= width) {
        start -= 1;
        expanded = true;
      } else if (canRight && rowWidth(start, end + 1) <= width) {
        end += 1;
        expanded = true;
      }
    }
    if (!expanded) break;
  }
  return { start, end };
}

/**
 * Render a horizontal tab strip that fits `width`. When tabs overflow, shows
 * `← N more` on the left and `N more →` on the right for the hidden counts,
 * always keeping the active tab visible.
 */
export function renderTabStrip(labels: string[], active: number, width: number, gap = 2): TabStripResult {
  const t = theme();
  if (labels.length === 0 || width <= 0) return { text: "", ranges: [] };
  const { start, end } = windowFor(
    labels.map((label) => label.length),
    Math.max(0, Math.min(active, labels.length - 1)),
    width,
    gap,
  );

  const parts: string[] = [];
  const ranges: TabStripResult["ranges"] = [];
  let column = 0;
  const add = (visible: string, styled: string, index?: number): void => {
    if (index !== undefined) ranges.push({ start: column, end: column + visible.length, index });
    parts.push(styled);
    column += visible.length + gap;
  };

  if (start > 0) add(leftIndicator(start), t.fg("dim", leftIndicator(start)));
  for (let index = start; index < end; index++) {
    const label = labels[index]!;
    add(label, index === active ? t.bold(t.fg("accent", label)) : t.fg("muted", label), index);
  }
  const hiddenRight = labels.length - end;
  if (hiddenRight > 0) add(rightIndicator(hiddenRight), t.fg("dim", rightIndicator(hiddenRight)));

  return { text: parts.join(" ".repeat(gap)), ranges };
}
