import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { theme } from "../../theme/theme.ts";

export interface Option {
  label: string;
  description?: string;
  value: string;
}

/** Simple selectable list used inside a PanelOverlay (e.g. /copy choices). */
export class OptionPicker implements Component {
  private selected = 0;

  constructor(
    private options: Option[],
    private onSelect: (value: string) => void,
    private onCancel: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onCancel();
    if (matchesKey(data, "up")) {
      this.selected = (this.selected + this.options.length - 1) % this.options.length;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % this.options.length;
      return;
    }
    if (matchesKey(data, "enter")) {
      const option = this.options[this.selected];
      if (option) this.onSelect(option.value);
    }
  }

  render(_width: number): string[] {
    const t = theme();
    const maxVisible = 12;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.options.length - maxVisible));
    const window = this.options.slice(Math.max(0, start), Math.max(0, start) + maxVisible);
    const lines = window.map((option, index) => {
      const absolute = Math.max(0, start) + index;
      const isSelected = absolute === this.selected;
      const marker = isSelected ? t.fg("accent", "→ ") : "  ";
      const label = isSelected ? t.fg("accent", option.label) : t.fg("text", option.label);
      const description = option.description ? t.fg("muted", `  ${option.description}`) : "";
      return marker + label + description;
    });
    if (this.options.length > maxVisible) {
      lines.push(t.fg("dim", `${this.selected + 1}/${this.options.length}`));
    }
    return lines;
  }
}
