import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { QuestionOption, QuestionView } from "../../state/transcript.ts";
import { theme } from "../../theme/theme.ts";

interface Entry extends QuestionOption {
  isOther?: boolean;
}

const OTHER_LABEL = "Other";

/**
 * Modal prompt for opencode's `question` tool. Prompts are answered in order.
 * Options are selectable (Space toggles when multiple, Enter confirms), and an
 * inline "Other" entry takes a free-text answer that can be combined with the
 * other selections before confirming.
 */
export class QuestionDialog implements Component {
  private index = 0;
  private selected = 0;
  private picked = new Set<string>();
  private custom = "";
  private editing = false;
  private readonly answers: string[][];

  constructor(
    private request: QuestionView,
    private onAnswer: (answers: string[][]) => void,
    private onReject: () => void,
  ) {
    this.answers = request.questions.map(() => []);
  }

  invalidate(): void {}

  private get prompt() {
    return this.request.questions[this.index];
  }

  private entries(): Entry[] {
    const options = this.prompt?.options ?? [];
    return [...options, { label: OTHER_LABEL, description: "Type your own answer", isOther: true }];
  }

  private advance(): void {
    this.index += 1;
    this.selected = 0;
    this.picked = new Set();
    this.custom = "";
    this.editing = false;
    if (this.index >= this.request.questions.length) this.onAnswer(this.answers);
  }

  private submit(entries: Entry[]): void {
    const prompt = this.prompt;
    if (!prompt) return this.onAnswer(this.answers);
    const entry = entries[this.selected];
    const text = this.custom.trim();
    if (prompt.multiple) {
      const answers = [...this.picked];
      if (text) answers.push(text);
      this.answers[this.index] = answers;
    } else if (entry?.isOther) {
      if (!text) return; // Nothing typed yet: keep editing instead of sending empty.
      this.answers[this.index] = [text];
    } else {
      this.answers[this.index] = [entry?.label ?? ""];
    }
    this.advance();
  }

  handleInput(data: string): void {
    const prompt = this.prompt;
    if (!prompt) return this.onAnswer(this.answers);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onReject();
    const entries = this.entries();

    if (matchesKey(data, "up")) {
      this.selected = (this.selected + entries.length - 1) % entries.length;
      this.editing = false;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % entries.length;
      this.editing = false;
      return;
    }

    const entry = entries[this.selected];
    if (entry?.isOther) {
      if (matchesKey(data, "enter")) return this.submit(entries);
      if (matchesKey(data, "backspace")) {
        this.custom = this.custom.slice(0, -1);
        this.editing = true;
        return;
      }
      if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.custom += data;
        this.editing = true;
      }
      return;
    }

    if (matchesKey(data, "space") && prompt.multiple) {
      const label = entry?.label;
      if (label) {
        if (this.picked.has(label)) this.picked.delete(label);
        else this.picked.add(label);
      }
      return;
    }
    if (matchesKey(data, "enter")) this.submit(entries);
  }

  render(width: number): string[] {
    const t = theme();
    const total = Math.max(3, width);
    const inner = total - 2;
    const contentWidth = inner - 1;
    const border = (text: string) => t.fg("borderAccent", text);
    const title = total >= 14 ? " Question " : "";
    const top =
      border("╭─") + t.fg("borderAccent", title) + border("─".repeat(Math.max(0, total - 3 - title.length)) + "╮");
    const row = (line: string): string =>
      border("│") + " " + pad(truncateToWidth(line, contentWidth, "…"), contentWidth) + border("│");

    const prompt = this.prompt;
    if (!prompt) return [top, row(t.fg("text", "Done")), border("╰" + "─".repeat(inner) + "╯")];

    const body: string[] = [];
    if (prompt.header) for (const line of wrap(prompt.header, contentWidth)) body.push(row(t.fg("accent", line)));
    for (const line of wrap(prompt.question, contentWidth)) body.push(row(t.fg("accent", line)));
    body.push(row(""));

    const entries = this.entries();
    entries.forEach((entry, idx) => {
      const active = idx === this.selected;
      const marker = active ? t.fg("accent", "→ ") : "  ";
      const check = prompt.multiple && !entry.isOther ? (this.picked.has(entry.label) ? "[x] " : "[ ] ") : "";
      const label = active ? t.fg("accent", entry.label) : t.fg("text", entry.label);
      body.push(row(`${marker}${check}${label}`));
      if (!entry.isOther && entry.description) {
        for (const line of wrap(entry.description, contentWidth - 4)) body.push(row("    " + t.fg("muted", line)));
      }
      // The typed answer sits directly under "Other", aligned with its label.
      if (entry.isOther && (active || this.custom)) {
        const cursor = active ? t.fg("accent", "█") : "";
        body.push(row("  " + t.fg("muted", this.custom) + cursor));
      }
    });

    const multi = this.request.questions.length > 1 ? `${this.index + 1}/${this.request.questions.length} · ` : "";
    const hint = prompt.multiple ? "Space to toggle · Enter to confirm · Esc to reject" : "Enter to select · Esc to reject";
    body.push(row(t.fg("dim", `${multi}${hint}`)));

    return [top, ...body, border("╰" + "─".repeat(inner) + "╯")];
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
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
