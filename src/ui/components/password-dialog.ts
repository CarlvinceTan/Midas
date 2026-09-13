import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Single-line secret prompt for PanelOverlay submenus. pi-tui's `Input` has no
 * masking, so this keeps a private value and renders it as dots; only the keys a
 * password field needs (printable, backspace, enter, escape, ctrl+u) are handled.
 */
export class PasswordDialog implements Component {
  private value = "";

  constructor(
    private readonly prompt: string,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      this.onSubmit(this.value);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.value = this.value.slice(0, -1);
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.value = "";
      return;
    }
    if (matchesKey(data, "delete")) return;
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable) this.value += printable;
  }

  render(width: number): string[] {
    const masked = "•".repeat(this.value.length);
    const hint = this.value.length === 0 ? "(empty to keep current)" : "";
    const line = `${this.prompt}${masked}${hint ? `  ${hint}` : ""}`;
    return [truncateToWidth(line, width, "")];
  }
}
