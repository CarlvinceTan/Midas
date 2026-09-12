import { fuzzyFilter, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "../../theme/theme.ts";

export interface SearchItem {
  id: string;
  label: string;
  description?: string;
}

/**
 * Generic filterable list picker (search + Up/Down + Enter), like the model
 * picker. Content only: callers frame it with a PanelOverlay.
 */
export class SearchPicker implements Component {
  private filter = "";
  private selected = 0;
  private filtered: SearchItem[];

  constructor(
    private items: SearchItem[],
    private onSelect: (id: string) => void,
    private onCancel: () => void,
    initialId?: string,
  ) {
    this.filtered = items;
    const index = initialId ? items.findIndex((item) => item.id === initialId) : -1;
    this.selected = index >= 0 ? index : 0;
  }

  invalidate(): void {}

  private refilter(): void {
    this.filtered = this.filter.trim()
      ? fuzzyFilter(this.items, this.filter, (item) => `${item.label} ${item.id}`)
      : this.items;
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onCancel();
    if (matchesKey(data, "enter")) {
      const item = this.filtered[this.selected];
      if (item) this.onSelect(item.id);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = this.filtered.length === 0 ? 0 : (this.selected + this.filtered.length - 1) % this.filtered.length;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = this.filtered.length === 0 ? 0 : (this.selected + 1) % this.filtered.length;
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.filter = this.filter.slice(0, -1);
      this.refilter();
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.filter += data;
      this.refilter();
    }
  }

  render(width: number): string[] {
    const t = theme();
    const rows: string[] = [`> ${t.fg("text", this.filter)}${t.fg("accent", "█")}`];

    const visibleCount = 10;
    const start = Math.max(0, Math.min(this.selected - Math.floor(visibleCount / 2), this.filtered.length - visibleCount));
    if (this.filtered.length === 0) {
      rows.push(t.fg("muted", "  no matches"));
      return rows;
    }
    for (let i = 0; i < visibleCount; i++) {
      const index = Math.max(0, start) + i;
      const item = this.filtered[index];
      if (!item) break;
      const isSelected = index === this.selected;
      const marker = isSelected ? t.fg("accent", "→ ") : "  ";
      const label = isSelected ? t.fg("accent", item.label) : t.fg("text", item.label);
      const description = item.description ? t.fg("muted", `  ${item.description}`) : "";
      rows.push(truncateToWidth(marker + label + description, Math.max(1, width), "…"));
    }
    return rows;
  }
}
