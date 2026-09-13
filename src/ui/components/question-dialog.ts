import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { QuestionOption, QuestionView } from "../../state/transcript.ts";
import { CONTENT_END, CONTENT_START, DECORATION, markContent } from "../../lib/ansi.ts";
import { theme } from "../../theme/theme.ts";

interface Entry extends QuestionOption {
  isOther?: boolean;
}

const OTHER_LABEL = "Other";
/** The free-text answer wraps and scrolls within this many visible rows. */
const OTHER_MAX_LINES = 3;
/** Two-space indent that aligns the answer under the "Other" label's text. */
const OTHER_INDENT = 2;

/** One grapheme in the wrapped free-text answer, with its index in the source. */
interface InputCell {
  index: number;
  text: string;
  width: number;
}

/** One wrapped visual line of the answer. `start`/`end` index into the source. */
interface InputRow {
  cells: InputCell[];
  start: number;
  end: number;
}

interface InputHit {
  /** Screen column of the first character of the answer. */
  textX: number;
  /** Screen row of the first visible answer line. */
  firstY: number;
  /** Number of visible answer lines. */
  count: number;
  rows: InputRow[];
  scroll: number;
  /** Wrap width used to lay the rows out. */
  width: number;
}

const graphemes = (text: string): Array<{ segment: string; index: number }> => {
  const result: Array<{ segment: string; index: number }> = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const part of segmenter.segment(text)) result.push({ segment: part.segment, index: part.index });
  return result;
};

/** Wrap the answer on grapheme boundaries, honouring explicit newlines. */
function layoutInput(text: string, width: number): InputRow[] {
  const limit = Math.max(1, width);
  const rows: InputRow[] = [];
  let cells: InputCell[] = [];
  let rowStart = 0;
  let col = 0;
  const flush = (end: number, next: number): void => {
    rows.push({ cells, start: rowStart, end });
    cells = [];
    col = 0;
    rowStart = next;
  };
  for (const { segment, index } of graphemes(text)) {
    if (segment === "\n") {
      flush(index, index + segment.length);
      continue;
    }
    const w = Math.max(0, visibleWidth(segment));
    if (col > 0 && col + w > limit) flush(index, index);
    cells.push({ index, text: segment, width: w });
    col += w;
  }
  rows.push({ cells, start: rowStart, end: text.length });
  return rows;
}

function rowWidth(row: InputRow): number {
  return row.cells.reduce((sum, cell) => sum + cell.width, 0);
}

/** Row/column of a source cursor index within the wrapped layout. */
function locateCursor(rows: InputRow[], cursor: number): { row: number; col: number } {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (cursor < row.start || cursor > row.end) continue;
    let col = 0;
    for (const cell of row.cells) {
      if (cell.index >= cursor) break;
      col += cell.width;
    }
    return { row: i, col };
  }
  const last = Math.max(0, rows.length - 1);
  return { row: last, col: rowWidth(rows[last]!) };
}

/** Source index nearest to a visual column within one row. */
function indexAtCol(row: InputRow, col: number): number {
  let acc = 0;
  for (const cell of row.cells) {
    if (acc + cell.width > col) return cell.index;
    acc += cell.width;
  }
  return row.end;
}

/**
 * Modal prompt for opencode's `question` tool. Prompts are answered in order.
 * Options are selectable (Space toggles when multiple, Enter confirms), and an
 * inline "Other" entry takes a free-text answer that can be combined with the
 * other selections before confirming. The free-text answer is a small multi-line
 * editor: it wraps, scrolls within {@link OTHER_MAX_LINES} visible rows, and the
 * cursor can be moved with the arrow keys or by clicking.
 */
export class QuestionDialog implements Component {
  private index = 0;
  private selected = 0;
  private picked = new Set<string>();
  private custom = "";
  private customCursor = 0;
  private customScroll = 0;
  private editing = false;
  private readonly answers: string[][];
  /** Rendered geometry for routing clicks on option rows. */
  private entryHit: Array<{ y: number; index: number }> = [];
  /** Rendered geometry for routing clicks into the free-text answer. */
  private inputHit: InputHit | undefined;

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
    this.customCursor = 0;
    this.customScroll = 0;
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

  private clampCursor(): number {
    return Math.max(0, Math.min(this.custom.length, this.customCursor));
  }

  /** Move the option selection by `delta`, focusing the answer when it lands there. */
  private moveSelection(delta: number, entries: Entry[]): void {
    this.selected = (this.selected + delta + entries.length) % entries.length;
    this.editing = false;
    if (entries[this.selected]?.isOther) this.customCursor = this.custom.length;
  }

  private insertCustom(text: string): void {
    const normalized = text.replace(/\r\n?/g, "\n");
    const cursor = this.clampCursor();
    this.custom = this.custom.slice(0, cursor) + normalized + this.custom.slice(cursor);
    this.customCursor = cursor + normalized.length;
    this.editing = true;
  }

  /** Arrow/backspace/Enter handling for the free-text answer. */
  private handleOtherInput(data: string, entries: Entry[]): void {
    const cursor = this.clampCursor();
    const rows = layoutInput(this.custom, this.lastWrapWidth());
    const pos = locateCursor(rows, cursor);

    if (matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+j")) {
      this.insertCustom("\n");
      return;
    }
    if (matchesKey(data, "enter")) {
      // Workaround for terminals without Shift+Enter: a trailing `\` inserts a newline.
      if (cursor > 0 && this.custom[cursor - 1] === "\\") {
        this.custom = this.custom.slice(0, cursor - 1) + this.custom.slice(cursor);
        this.customCursor = cursor - 1;
        this.insertCustom("\n");
        return;
      }
      this.submit(entries);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const up = matchesKey(data, "up");
      if (up && pos.row === 0) return this.moveSelection(-1, entries);
      if (!up && pos.row === rows.length - 1) return this.moveSelection(1, entries);
      const target = rows[pos.row + (up ? -1 : 1)];
      if (target) this.customCursor = indexAtCol(target, Math.min(pos.col, rowWidth(target)));
      return;
    }
    if (matchesKey(data, "left")) {
      this.customCursor = cursor - 1;
      return;
    }
    if (matchesKey(data, "right")) {
      this.customCursor = cursor + 1;
      return;
    }
    if (matchesKey(data, "home")) {
      this.customCursor = rows[pos.row]?.start ?? 0;
      return;
    }
    if (matchesKey(data, "end")) {
      this.customCursor = rows[pos.row]?.end ?? this.custom.length;
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (cursor > 0) {
        this.custom = this.custom.slice(0, cursor - 1) + this.custom.slice(cursor);
        this.customCursor = cursor - 1;
        this.editing = true;
      }
      return;
    }
    if (matchesKey(data, "delete")) {
      if (cursor < this.custom.length) {
        this.custom = this.custom.slice(0, cursor) + this.custom.slice(cursor + 1);
        this.editing = true;
      }
      return;
    }
    // Printable input and pastes. Escape sequences and stray control keys are
    // stripped so they cannot corrupt the answer; pasted newlines are kept.
    if (data.length > 0 && !data.includes("\x1b")) {
      const cleaned = data.replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]/g, "");
      if (cleaned) this.insertCustom(cleaned);
    }
  }

  handleInput(data: string): void {
    const prompt = this.prompt;
    if (!prompt) return this.onAnswer(this.answers);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onReject();
    const entries = this.entries();

    if (matchesKey(data, "up")) {
      const entry = entries[this.selected];
      if (entry?.isOther) {
        // Inside the answer, Up moves between lines until it reaches the top.
        const rows = layoutInput(this.custom, this.lastWrapWidth());
        if (locateCursor(rows, this.clampCursor()).row > 0) return this.handleOtherInput(data, entries);
      }
      return this.moveSelection(-1, entries);
    }
    if (matchesKey(data, "down")) {
      const entry = entries[this.selected];
      if (entry?.isOther) {
        const rows = layoutInput(this.custom, this.lastWrapWidth());
        if (locateCursor(rows, this.clampCursor()).row < rows.length - 1) return this.handleOtherInput(data, entries);
      }
      return this.moveSelection(1, entries);
    }

    const entry = entries[this.selected];
    if (entry?.isOther) {
      return this.handleOtherInput(data, entries);
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const entryHit = this.entryHit.find((hit) => hit.y === event.y);
    if (entryHit) {
      this.selected = entryHit.index;
      this.editing = false;
      if (this.entries()[this.selected]?.isOther) this.customCursor = this.custom.length;
      return { handled: true, render: true, focus: true };
    }
    const input = this.inputHit;
    if (input && event.y >= input.firstY && event.y < input.firstY + input.count) {
      const row = input.rows[input.scroll + (event.y - input.firstY)];
      if (!row) return undefined;
      const col = Math.max(0, Math.min(input.width, event.x - input.textX));
      this.customCursor = indexAtCol(row, col);
      // Clicking the answer also focuses the "Other" entry so typing continues there.
      this.selected = Math.max(0, this.entries().length - 1);
      this.editing = true;
      return { handled: true, render: true, focus: true };
    }
    return undefined;
  }

  /** Wrap width from the last render; used for input handling before a repaint. */
  private lastWrapWidth(): number {
    return Math.max(1, this.inputHit?.width ?? 40);
  }

  /** Render one visible answer line, drawing the block cursor when it belongs here. */
  private renderInputLine(row: InputRow, showCursor: boolean, cursor: number): string {
    const t = theme();
    let line = "";
    let cursorDrawn = false;
    for (const cell of row.cells) {
      if (showCursor && !cursorDrawn && cell.index === cursor) {
        line += t.fg("accent", `\x1b[7m${cell.text}\x1b[0m`);
        cursorDrawn = true;
      } else {
        line += t.fg("muted", cell.text);
      }
    }
    if (showCursor && !cursorDrawn) line += t.fg("accent", "\x1b[7m \x1b[0m");
    return line;
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

    this.entryHit = [];
    this.inputHit = undefined;
    if (!prompt) return [top, row(t.fg("text", "Done")), bottom];

    // Just the question in the primary text colour, then the options directly
    // below it: no header or spacer line.
    const body: string[] = [];
    for (const line of wrap(prompt.question, contentWidth)) body.push(row(t.fg("text", line)));

    const entries = this.entries();
    entries.forEach((entry, idx) => {
      const active = idx === this.selected;
      this.entryHit.push({ y: body.length + 1, index: idx });
      const marker = active ? t.fg("accent", "→ ") : "  ";
      const check = prompt.multiple && !entry.isOther ? (this.picked.has(entry.label) ? "[x] " : "[ ] ") : "";
      const label = active ? t.fg("accent", entry.label) : t.fg("text", entry.label);
      body.push(row(`${marker}${check}${label}`));
      if (!entry.isOther && entry.description) {
        for (const line of wrap(entry.description, contentWidth - 4)) body.push(row("    " + t.fg("muted", line)));
      }
      // The typed answer sits directly under "Other", aligned with its label, as
      // a wrapped block that scrolls to keep the cursor visible.
      if (entry.isOther && (active || this.custom)) {
        const fieldWidth = Math.max(1, contentWidth - OTHER_INDENT);
        // Reserve a column so the block cursor never touches the right padding.
        const wrapWidth = Math.max(1, fieldWidth - 1);
        const rows = layoutInput(this.custom, wrapWidth);
        const cursor = Math.max(0, Math.min(this.custom.length, this.customCursor));
        const cursorPos = locateCursor(rows, cursor);
        if (active) {
          if (cursorPos.row < this.customScroll) this.customScroll = cursorPos.row;
          else if (cursorPos.row >= this.customScroll + OTHER_MAX_LINES) {
            this.customScroll = cursorPos.row - OTHER_MAX_LINES + 1;
          }
        }
        this.customScroll = Math.max(0, Math.min(this.customScroll, Math.max(0, rows.length - OTHER_MAX_LINES)));
        const visible = rows.slice(this.customScroll, this.customScroll + OTHER_MAX_LINES);
        const firstY = body.length + 1;
        visible.forEach((line, offset) => {
          const isCursorRow = active && this.customScroll + offset === cursorPos.row;
          body.push(row(" ".repeat(OTHER_INDENT) + this.renderInputLine(line, isCursorRow, cursor)));
        });
        this.inputHit = {
          textX: 1 + inset + OTHER_INDENT,
          firstY,
          count: visible.length,
          rows,
          scroll: this.customScroll,
          width: wrapWidth,
        };
      }
    });

    const otherActive = entries[this.selected]?.isOther === true;
    const hint = otherActive
      ? "Enter to confirm · Shift+Enter newline · Esc to reject"
      : prompt.multiple
        ? "Space to toggle · Enter to confirm · Esc to reject"
        : "Enter to select · Esc to reject";
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
