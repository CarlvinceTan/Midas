import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { theme, type ThemeColor } from "../../theme/theme.ts";
import type { Task } from "../../tasks/board.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/**
 * Pure glyph rendering. Legend: `○` ready (no agent working), the spinner while
 * a worker is running, `✓` completed, `!` blocked, `✗` cancelled. Color is
 * applied at the call site via `taskIconColor`.
 */
export function taskIcon(task: Task, frame: number): string {
  switch (task.status) {
    case "running": return frames[frame % frames.length]!;
    case "completed": return "✓";
    case "new": return "○";
    case "cancelled": return "✗";
    default: return "!"; // blocked, and any future failure state
  }
}
/**
 * Theme color for the status glyph; `undefined` leaves the default foreground
 * (ready). Mirrors `taskIcon`: the spinner is blue, the tick green, and every
 * failure marker (blocked `!`, cancelled `✗`) red.
 */
export function taskIconColor(task: Task): ThemeColor | undefined {
  switch (task.status) {
    case "running": return "accent";
    case "completed": return "success";
    case "new": return undefined;
    default: return "error";
  }
}
const safe = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
/** Number of task rows in the scroll window; group headers are extra and reserved separately. */
const windowRows = 7;

/** Board control hooks the actions menu invokes for the selected task. */
export interface TaskControls {
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): void;
  remove(id: string): void;
}

interface MenuAction {
  label: string;
  run: () => void;
}

/** Read-only board browser: never changes the foreground session or directory. */
export class TasksView implements Component {
  tasks: Task[] = [];
  error?: string;
  private mode: "groups" | "worktrees" = "groups";
  private selected = 0;
  private details = false;
  private menu?: { taskId: string; actions: MenuAction[]; index: number };
  /**
   * `multitask` selects the empty-state copy: multitask creates tasks from
   * submitted requests, so it must not point the user at a shell command.
   */
  constructor(
    private onCancel: () => void,
    private multitask = false,
    private controls: TaskControls = { pause: () => {}, resume: () => {}, cancel: () => {}, remove: () => {} },
  ) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (this.menu) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.menu = undefined; return; }
      if (matchesKey(data, "up")) { this.menu.index = Math.max(0, this.menu.index - 1); return; }
      if (matchesKey(data, "down")) { this.menu.index = Math.min(this.menu.actions.length - 1, this.menu.index + 1); return; }
      if (matchesKey(data, "enter")) {
        const action = this.menu.actions[this.menu.index];
        this.menu = undefined;
        action?.run();
        return;
      }
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onCancel();
    if (matchesKey(data, "tab")) { this.mode = this.mode === "groups" ? "worktrees" : "groups"; this.selected = 0; }
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    if (matchesKey(data, "down")) this.selected = Math.min(this.tasks.length - 1, this.selected + 1);
    if (matchesKey(data, "enter")) this.openMenu();
  }
  /** Actions valid for the selected task; Enter invokes, Esc closes the menu. */
  private openMenu(): void {
    const group = (task: Task): string => this.mode === "groups" ? task.group || "Ungrouped" : task.attempts.at(-1)?.branch ?? "Not allocated";
    const sorted = [...this.tasks].sort((a, b) => group(a).localeCompare(group(b)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const task = sorted[Math.max(0, Math.min(this.selected, sorted.length - 1))];
    if (!task) return;
    const actions: MenuAction[] = [];
    if (task.status === "running" || task.status === "new") actions.push({ label: "Pause", run: () => this.controls.pause(task.id) });
    if (task.status === "paused" || task.status === "blocked") actions.push({ label: "Resume", run: () => this.controls.resume(task.id) });
    if (task.merge !== "merged" && task.status !== "completed" && task.status !== "cancelled") actions.push({ label: "Cancel", run: () => this.controls.cancel(task.id) });
    if (task.status !== "running") actions.push({ label: "Remove", run: () => this.controls.remove(task.id) });
    actions.push({ label: "Show details", run: () => { this.details = !this.details; } });
    actions.push({ label: "Close", run: () => {} });
    this.menu = { taskId: task.id, actions, index: 0 };
  }
  render(width: number): string[] {
    const t = theme();
    const group = (task: Task): string => this.mode === "groups" ? task.group || "Ungrouped" : task.attempts.at(-1)?.branch ?? "Not allocated";
    const sorted = [...this.tasks].sort((a, b) => group(a).localeCompare(group(b)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    this.selected = Math.max(0, Math.min(this.selected, sorted.length - 1));
    // A scroll window can gain or lose group headers and rows near either end,
    // so reserve the worst case up front and pad the bottom. This keeps the
    // overlay frame a fixed height while the pointer moves (see `maxListHeight`).
    const listHeight = this.error || !sorted.length ? 1 : this.maxListHeight(sorted, group);
    const lines: string[] = [];
    if (this.error) lines.push(t.fg("error", safe(this.error)));
    else if (!sorted.length) {
      lines.push(
        this.multitask
          ? "No tasks yet. Tasks are created automatically as requests are sent."
          : "No tasks yet.",
      );
    } else {
      // One id column for the whole board, computed from the full task set so it
      // does not shift as the scroll window or the selection changes. The floor
      // keeps the common T1–T99 ids from collapsing to a narrower column.
      const idWidth = Math.max(3, ...this.tasks.map((task) => safe(task.id).length));
      const start = this.scrollStart(sorted.length, this.selected);
      let lastGroup: string | undefined;
      sorted.slice(start, start + windowRows).forEach((task, i) => {
        const label = group(task);
        if (label !== lastGroup) { lines.push(t.fg("accent", safe(label))); lastGroup = label; }
        const waiting = (task.dependencies ?? []).filter((id) => this.tasks.find((v) => v.id === id)?.merge !== "merged");
        const status = task.merge === "merged" ? `⤵ merged → ${task.target}` : task.merge === "failed" ? "! merge failed" : task.merge === "integrating" ? "integrating…" : task.status === "completed" ? "not merged" : task.status === "blocked" ? "blocked" : task.status === "cancelled" ? "cancelled" : waiting.length ? `waiting on ${waiting.join(", ")}` : task.status === "new" ? "ready" : task.attempts.at(-1)?.branch ?? "provisioning";
        const icon = taskIcon(task, Math.floor(Date.now() / 100));
        const color = taskIconColor(task);
        // Build the row from a fixed prefix, a flexible title and a fixed status.
        // The status keeps its full width, so a narrow panel ellipsises the title
        // instead of clipping the state the row exists to show.
        const prefix = `${start + i === this.selected ? "→" : " "} ${color ? t.fg(color, icon) : icon} ${safe(task.id).padEnd(idWidth)}  `;
        const gap = "  ";
        const statusStyle = (text: string): string => t.fg("muted", text);
        const titleStyle = (text: string): string => t.fg("text", text);
        // The merge-failed `!` is a failure marker, so paint just that glyph red
        // while the remainder keeps the muted status colour.
        const statusText = task.merge === "failed"
          ? `${t.fg("error", "!")}${statusStyle(" merge failed")}`
          : statusStyle(safe(status));
        const title = titleStyle(safe(task.title));
        const room = width - visibleWidth(prefix) - visibleWidth(gap) - visibleWidth(statusText);
        if (room >= 0) {
          // `truncateToWidth` resets styling right before its ellipsis, so pass a
          // pre-styled ellipsis to keep it in the title's own colour.
          lines.push(prefix + truncateToWidth(title, room, titleStyle("…")) + gap + statusText);
        } else {
          // Not even the status fits: give up the title entirely, then clip the
          // status as a last resort with its own colour on the ellipsis.
          const statusRoom = width - visibleWidth(prefix) - visibleWidth(gap);
          const clippedStatus = statusRoom > 0 ? truncateToWidth(statusText, statusRoom, statusStyle("…")) : "";
          lines.push(prefix + gap + clippedStatus);
        }
      });
      if (sorted.length > windowRows) lines.push(t.fg("dim", `${this.selected + 1}/${sorted.length}`));
    }
    if (this.menu) {
      lines.push(t.fg("accent", "Actions"));
      for (const [index, action] of this.menu.actions.entries()) {
        const cursor = index === this.menu.index ? "→" : " ";
        lines.push(`${cursor} ${index === this.menu.index ? t.fg("accent", action.label) : action.label}`);
      }
    }
    const selected = sorted[this.selected];
    const details: string[] = [];
    if (selected && this.details) {
      const attempt = selected.attempts.at(-1);
      details.push("", safe(selected.instructions), safe(selected.detail ?? ""),
        `Worktree: ${safe(attempt?.worktree ?? "not allocated")}${attempt?.cleaned ? " (removed)" : ""}`,
        `Session: ${safe(attempt?.session ?? "none")} · attempts: ${selected.attempts.length}`,
        `Checks: ${safe(selected.checks.join("; "))}`,
        `Result: ${attempt?.result ?? "none"} · merge: ${selected.mergedCommit ?? "none"}`);
    }
    lines.push(...details);
    // The details block has a constant line count for a given set, so padding the
    // whole output to `listHeight + details` is stable for every selection.
    while (lines.length < listHeight + details.length) lines.push("");
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }

  /**
   * First task index of the scroll window. Centred on the selection, then
   * clamped so the window never runs past the last task: near the bottom the
   * selection lands on the last content row while the earlier rows scroll up.
   */
  private scrollStart(total: number, selected: number): number {
    const maxStart = Math.max(0, total - windowRows);
    return Math.min(Math.max(0, selected - 3), maxStart);
  }

  /**
   * Worst-case number of list lines across every possible scroll position for the
   * current task set/mode. It scans the same clamped windows `render` produces so
   * the reserved height accounts for the group headers each window can gain or
   * lose; the board is small, so scanning every position is cheap.
   */
  private maxListHeight(sorted: Task[], group: (task: Task) => string): number {
    let max = 1;
    for (let selected = 0; selected < sorted.length; selected += 1) {
      const start = this.scrollStart(sorted.length, selected);
      let count = 0;
      let lastGroup: string | undefined;
      for (const task of sorted.slice(start, start + windowRows)) {
        const label = group(task);
        if (label !== lastGroup) { count += 1; lastGroup = label; }
        count += 1;
      }
      if (sorted.length > windowRows) count += 1;
      max = Math.max(max, count);
    }
    return max;
  }
}
