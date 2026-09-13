import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { theme, type ThemeColor } from "../../theme/theme.ts";
import type { Task } from "../../tasks/board.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pure glyph rendering; color is applied at the call site via `taskIconColor`. */
export function taskIcon(task: Task, frame: number): string {
  return task.status === "new" ? "○" : task.status === "running" ? frames[frame % frames.length]! : task.status === "completed" ? "✓" : "✗";
}
/** Theme color for the status glyph; `undefined` leaves the default foreground (new/ready). */
export function taskIconColor(task: Task): ThemeColor | undefined {
  return task.status === "running" ? "accent" : task.status === "completed" ? "success" : task.status === "blocked" ? "error" : undefined;
}
const safe = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Read-only board browser: never changes the foreground session or directory. */
export class TasksView implements Component {
  tasks: Task[] = [];
  error?: string;
  private mode: "groups" | "worktrees" = "groups";
  private selected = 0;
  private details = false;
  /**
   * `multitask` selects the empty-state copy: multitask creates tasks from
   * submitted requests, so it must not point the user at a shell command.
   */
  constructor(
    private onCancel: () => void,
    private multitask = false,
  ) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onCancel();
    if (matchesKey(data, "tab")) { this.mode = this.mode === "groups" ? "worktrees" : "groups"; this.selected = 0; }
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    if (matchesKey(data, "down")) this.selected = Math.min(this.tasks.length - 1, this.selected + 1);
    if (matchesKey(data, "enter")) this.details = !this.details;
  }
  render(width: number): string[] {
    const t = theme();
    const group = (task: Task): string => this.mode === "groups" ? task.group || "Ungrouped" : task.attempts.at(-1)?.branch ?? "Not allocated";
    const sorted = [...this.tasks].sort((a, b) => group(a).localeCompare(group(b)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    this.selected = Math.max(0, Math.min(this.selected, sorted.length - 1));
    const lines: string[] = [];
    if (this.error) lines.push(t.fg("error", safe(this.error)));
    else if (!sorted.length) {
      lines.push(
        this.multitask
          ? "No tasks yet. Tasks are created automatically as requests are sent."
          : "No tasks yet.",
      );
    }
    const start = Math.max(0, this.selected - 3);
    let lastGroup: string | undefined;
    sorted.slice(start, start + 7).forEach((task, i) => {
      const label = group(task);
      if (label !== lastGroup) { lines.push(t.fg("accent", safe(label))); lastGroup = label; }
      const waiting = (task.dependencies ?? []).filter((id) => this.tasks.find((v) => v.id === id)?.merge !== "merged");
      const status = task.merge === "merged" ? `⤵ merged → ${task.target}` : task.merge === "failed" ? "! merge failed" : task.merge === "integrating" ? "integrating…" : task.status === "completed" ? "not merged" : task.status === "blocked" ? "blocked" : waiting.length ? `waiting on ${waiting.join(", ")}` : task.status === "new" ? "ready" : task.attempts.at(-1)?.branch ?? "provisioning";
      const icon = taskIcon(task, Math.floor(Date.now() / 100));
      const color = taskIconColor(task);
      lines.push(`${start + i === this.selected ? "→" : " "} ${color ? t.fg(color, icon) : icon} ${safe(task.id)}  ${safe(task.title)}  ${t.fg("muted", safe(status))}`);
    });
    if (sorted.length > 7) lines.push(t.fg("dim", `${this.selected + 1}/${sorted.length}`));
    const selected = sorted[this.selected];
    if (selected && this.details) {
      const attempt = selected.attempts.at(-1);
      lines.push("", safe(selected.instructions), safe(selected.detail ?? ""),
        `Worktree: ${safe(attempt?.worktree ?? "not allocated")}${attempt?.cleaned ? " (removed)" : ""}`,
        `Session: ${safe(attempt?.session ?? "none")} · attempts: ${selected.attempts.length}`,
        `Checks: ${safe(selected.checks.join("; "))}`,
        `Result: ${attempt?.result ?? "none"} · merge: ${selected.mergedCommit ?? "none"}`);
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
}
