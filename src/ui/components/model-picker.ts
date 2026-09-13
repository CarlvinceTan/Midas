import { fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ModelChoice } from "../../opencode/session.ts";
import { theme } from "../../theme/theme.ts";

/** Readable catalog names shared by the model picker and `/agents`. */
export function modelDisplayParts(choice: ModelChoice): { name: string; provider: string } {
  return {
    // Catalog display names are authoritative. A raw identifier fallback (used
    // before/without a catalog match) needs its separators made readable.
    name: choice.name && choice.name !== choice.modelID ? choice.name : humanizeIdentifier(choice.modelID),
    provider: humanizeIdentifier(choice.providerName || choice.providerID),
  };
}

export function modelDisplayLabel(choice: ModelChoice): string {
  const { name, provider } = modelDisplayParts(choice);
  return provider ? `${name}  ${provider}` : name;
}

/** Filterable model picker overlay backed by opencode's provider catalog. */
export class ModelPicker implements Component {
  private filter = "";
  private selected = 0;
  private filtered: ModelChoice[];

  constructor(
    private models: ModelChoice[],
    private onSelect: (model: ModelChoice) => void,
    private onCancel: () => void,
    /** Render content only, for embedding inside another frame (e.g. agents). */
    private borderless = false,
  ) {
    this.filtered = models;
  }

  invalidate(): void {}

  private refilter(): void {
    // pi-style fuzzy search: characters match in order and space/slash-separated
    // tokens are all required, so "opencod g" still matches opencode-go models.
    this.filtered = this.filter.trim()
      ? fuzzyFilter(this.models, this.filter, (m) => `${m.providerName} ${m.providerID} ${m.name} ${m.modelID}`)
      : this.models;
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onCancel();
    if (matchesKey(data, "enter")) {
      const choice = this.filtered[this.selected];
      if (choice) this.onSelect(choice);
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
    const framed = !this.borderless;
    const total = framed ? Math.max(3, width) : Math.max(1, width);
    const inner = framed ? total - 2 : total;
    const contentWidth = framed ? inner - 1 : inner;
    const border = (text: string) => t.fg("borderAccent", text);
    const row = (line: string): string => {
      const content = pad(truncateToWidth(line, contentWidth, "…"), contentWidth);
      return framed ? border("│") + " " + content + border("│") : content;
    };
    const rows: string[] = [];

    // No "Search:" label: ">" mirrors the selection arrow so the query text
    // lines up in the same column as the model names below it. It stays
    // unstyled (white) like the settings-list search prompt.
    rows.push(row("> " + t.fg("text", this.filter) + t.fg("accent", "█")));

    const visibleCount = 12;
    const start = Math.max(0, Math.min(this.selected - Math.floor(visibleCount / 2), this.filtered.length - visibleCount));
    for (let i = 0; i < visibleCount; i++) {
      const index = Math.max(0, start) + i;
      const choice = this.filtered[index];
      if (!choice) {
        rows.push(row(""));
        continue;
      }
      const isSelected = index === this.selected;
      const marker = isSelected ? t.fg("accent", "→ ") : "  ";
      const display = modelDisplayParts(choice);
      const name = isSelected ? t.fg("accent", display.name) : t.fg("text", display.name);
      const provider = t.fg("muted", display.provider ? `  ${display.provider}` : "");
      rows.push(row(marker + name + provider));
    }

    if (!framed) return rows;
    const title = total >= 12 ? " Models " : "";
    const top =
      border("╭─") + t.fg("borderAccent", title) + border("─".repeat(Math.max(0, total - 3 - title.length)) + "╮");
    const bottom = border("╰" + "─".repeat(inner) + "╯");
    return [top, ...rows, bottom];
  }
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function humanizeIdentifier(value: string): string {
  const words = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "opencode") return "OpenCode";
      if (lower === "openai") return "OpenAI";
      if (lower === "github") return "GitHub";
      if (lower === "gpt") return "GPT";
      if (lower === "ai") return "AI";
      return word === lower ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
