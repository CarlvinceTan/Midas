import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "../../theme/theme.ts";
import { markContent } from "../../lib/ansi.ts";
import { formatMoney } from "../../lib/currency.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Two-row Codex-style footer, ported from ~/.pi/agent/extensions/simple-footer.ts:
 *
 *   ~/code/Pi (main)                            DeepSeek V4.1 Flash • xhigh
 *   12 skills • 5 mcps                          83 t/s • 42.3k (28%) • $0.045
 */

export interface FooterData {
  cwd: string;
  /** Human-readable model name from the catalog; preferred over the raw id. */
  modelName?: string;
  modelID: string;
  thinking: string;
  rate: number | null;
  contextTokens: number | null;
  contextPercent: number | null;
  cost: number;
  skillCount: number;
  mcpCount: number;
}

export function formatTokens(count: number): string {
  // Match pi's footer exactly: one decimal for both k and M (e.g. 129.0k).
  if (count < 1000) return count.toString();
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatModelName(name: string): string {
  if (!name) return "";
  // Only hyphen word separators are normalized; dots (version numbers like
  // "V4.1") are meaningful and must be preserved.
  return name.replace(/-/g, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * One decimal below 100 so the eased value visibly fills between readings, while
 * larger speeds round to whole numbers to stay readable.
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0";
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

export function formatCwdForFooter(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? `${resolvedHome}${sep}` : `~${sep}${rel}`;
}

function formatCost(total: number): string {
  return formatMoney(total);
}

export function alignSides(left: string, right: string, width: number, ellipsis: string): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  if (leftWidth + rightWidth + 1 <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }
  const availableLeft = Math.max(0, width - rightWidth - 1);
  const fittedLeft = availableLeft > 0 ? truncateToWidth(left, availableLeft, ellipsis) : "";
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return fittedLeft + " ".repeat(gap) + right;
}

export class FooterComponent implements Component {
  constructor(
    private getData: () => FooterData,
    private getPad: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const themeInstance = theme();
    const data = this.getData();
    const margin = Math.min(this.getPad(), Math.max(0, Math.floor((width - 1) / 2)));
    const inner = Math.max(1, width - margin * 2);
    const ellipsis = themeInstance.fg("dim", "…");

    const model = `${formatModelName(data.modelName || data.modelID)} • ${data.thinking || "off"}`;
    const rateText = data.rate !== null ? formatRate(data.rate) : "--";
    const tpsPlain = `${rateText.padStart(4, " ")} t/s`;
    const contextPlain =
      data.contextTokens !== null && data.contextTokens > 0 && data.contextPercent !== null
        ? `${formatTokens(data.contextTokens)} (${Math.round(data.contextPercent)}%)`
        : "-- (--%)";
    const costPlain = formatCost(data.cost);
    const stats = `${tpsPlain} • ${contextPlain} • ${costPlain}`;
    const right = themeInstance.fg("dim", stats);
    const line = alignSides(themeInstance.fg("dim", model), right, inner, ellipsis);

    return [" ".repeat(margin) + markContent(line) + " ".repeat(margin)];
  }
}
