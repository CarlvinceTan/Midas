import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Permission } from "@opencode-ai/sdk";
import { theme } from "../../theme/theme.ts";
import { capitalize } from "../../lib/text.ts";

export type PermissionResponse = "once" | "always" | "reject";

interface Option {
  key: string;
  label: string;
  response: PermissionResponse;
  hint: string;
}

const OPTIONS: Option[] = [
  { key: "o", label: "Allow once", response: "once", hint: "o" },
  { key: "a", label: "Always allow", response: "always", hint: "a" },
  { key: "r", label: "Reject", response: "reject", hint: "r" },
];

/** Modal prompt for an opencode permission request, styled like pi's dialogs. */
export class PermissionDialog implements Component {
  private selected = 0;

  constructor(
    private permission: Permission,
    private onRespond: (response: PermissionResponse) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.selected = (this.selected + OPTIONS.length - 1) % OPTIONS.length;
    else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % OPTIONS.length;
    else if (matchesKey(data, "enter")) this.onRespond(OPTIONS[this.selected]!.response);
    else if (matchesKey(data, "escape")) this.onRespond("reject");
    else {
      const option = OPTIONS.find((o) => o.key === data.toLowerCase());
      if (option) this.onRespond(option.response);
    }
  }

  render(width: number): string[] {
    const t = theme();
    const total = Math.max(3, width);
    const inner = total - 2;
    const border = (text: string) => t.fg("borderAccent", text);
    const type = this.permission.type || "permission";
    const title = total >= 14 ? ` ${capitalize(type)} ` : "";
    const top =
      border("╭─") + t.fg("borderAccent", title) + border("─".repeat(Math.max(0, total - 3 - title.length)) + "╮");

    const body: string[] = [];
    for (const line of wrap(this.permission.title || "(no title)", inner - 1)) body.push(t.fg("text", line));
    if (this.permission.pattern) {
      const pattern = Array.isArray(this.permission.pattern) ? this.permission.pattern.join(", ") : this.permission.pattern;
      for (const line of wrap(pattern, inner - 1)) body.push(t.fg("muted", line));
    }
    body.push("");
    OPTIONS.forEach((option, index) => {
      const marker = index === this.selected ? t.fg("accent", "→ ") : "  ";
      const label = index === this.selected ? t.fg("accent", option.label) : t.fg("text", option.label);
      body.push(`${marker}${label} ${t.fg("dim", `(${option.hint})`)}`);
    });

    const rows = body.map((line) => border("│") + " " + pad(truncateToWidth(line, inner - 1, "…"), inner - 1) + border("│"));
    const bottom = border("╰" + "─".repeat(inner) + "╯");
    return [top, ...rows, bottom];
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += " " + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function pad(text: string, width: number): string {
  const visible = [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
  return text + " ".repeat(Math.max(0, width - visible));
}
