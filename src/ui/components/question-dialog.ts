import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { QuestionOption, QuestionView } from "../../state/transcript.ts";
import { CONTENT_END, CONTENT_START, DECORATION, markContent } from "../../lib/ansi.ts";
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
    // Match the other `/` panels: a one-column gutter that collapses on a narrow
    // terminal so the border still fits.
    const inset = total >= 9 ? 1 : 0;
    const contentWidth = Math.max(1, inner - inset * 2);
    const gutter = " ".repeat(inset);
    const border = (text: string) => t.fg("borderAccent", text);
    // Content bounds keep drag-selection to the text only, excluding the gutter,
    // fill and borders (same markers `PanelOverlay` uses).
    const edge = (text: string): string => DECORATION + CONTENT_START + CONTENT_END + text;
    const row = (line: string): string => {
      const fitted = truncateToWidth(line, contentWidth, "…");
      const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
      return border("│") + gutter + markContent(fitted) + fill + gutter + border("│");
    };
    // The prompt's header and the question counter share the border
    // (`╭─ Remove UX: Question 1/2 ─╮`) rather than taking body rows, so the
    // panel stays compact. The header is truncated to whatever fits the border.
    const prompt = this.prompt;
    const count = this.request.questions.length;
    const header = prompt?.header?.trim();
    const counter = count > 1 ? `Question ${this.index + 1}/${count}` : "";
    const labelText = header && counter ? `${header}: ${counter}` : header || counter || "Question";
    const available = total - 5;
    const shown = available > 0 ? truncateToWidth(labelText, available, "…") : "";
    const title = shown ? ` ${shown} ` : "";
    const top =
      edge(border("╭─") + t.fg("borderAccent", title) + border("─".repeat(Math.max(0, total - 3 - title.length)) + "╮"));
    const bottom = edge(border("╰" + "─".repeat(inner) + "╯"));

    if (!prompt) return [top, row(t.fg("text", "Done")), bottom];

    // Just the question in the primary text colour, then the options directly
    // below it: no header or spacer line.
    const body: string[] = [];
    for (const line of wrap(prompt.question, contentWidth)) body.push(row(t.fg("text", line)));

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

    const hint = prompt.multiple ? "Space to toggle · Enter to confirm · Esc to reject" : "Enter to select · Esc to reject";
    body.push(row(t.fg("dim", hint)));

    return [top, ...body, bottom];
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
