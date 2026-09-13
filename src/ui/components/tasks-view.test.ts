import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../../theme/theme.ts";
import { stripAnsi } from "../../lib/ansi.ts";
import type { Task } from "../../tasks/board.ts";
import { TasksView, taskIcon, taskIconColor } from "./tasks-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "Implement feature",
    group: "Feature",
    instructions: "Add result.txt",
    checks: [],
    status: "new",
    merge: "not-merged",
    target: "main",
    attempts: [],
    ...overrides,
  };
}

function renderRow(overrides: Partial<Task>): string {
  const view = new TasksView(() => {});
  view.tasks = [task(overrides)];
  return view.render(160).join("\n");
}

/** Last SGR code before `index` that sets a colour/attribute, ignoring resets. */
function activeColor(text: string, index: number): string {
  const codes = [...text.slice(0, index).matchAll(/\x1b\[[0-9;]*m/g)].map((match) => match[0]);
  return codes.reverse().find((code) => code !== "\x1b[0m" && code !== "\x1b[39m" && code !== "\x1b[22m" && code !== "\x1b[49m") ?? "";
}

/** 12 tasks spread across 5 groups plus one distinct worktree branch each. */
function multiGroupTasks(): Task[] {
  const groups = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  return Array.from({ length: 12 }, (_, i) => task({
    id: `T${i + 1}`,
    title: `Task ${i + 1}`,
    group: groups[i % groups.length]!,
    attempts: [{ id: `a${i}`, worktree: `/tmp/worktree-${i}`, branch: `midas/t${i + 1}`, base: "main" }],
  }));
}

/** Move the pointer to `index` through the public input path. */
function selectRow(view: TasksView, index: number): void {
  for (let i = 0; i < index; i += 1) view.handleInput("\x1b[B");
}

test("taskIcon keeps raw glyphs and colored status reflects task state", () => {
  assert.equal(taskIcon(task(), 0), "○");
  assert.equal(taskIcon(task({ status: "completed" }), 0), "✓");
  assert.equal(taskIcon(task({ status: "blocked" }), 0), "✗");
  const running = task({ status: "running" });
  assert.notEqual(taskIcon(running, 0), taskIcon(running, 1));
  assert.equal(taskIconColor(task()), undefined);
  assert.equal(taskIconColor(running), "accent");
  assert.equal(taskIconColor(task({ status: "completed" })), "success");
  assert.equal(taskIconColor(task({ status: "blocked" })), "error");
});

test("completed rows paint the tick green", () => {
  const line = renderRow({ status: "completed" });
  assert.ok(line.includes(theme().fg("success", "✓")), `missing green tick: ${line}`);
});

test("running rows paint a spinner frame blue", () => {
  const running = task({ status: "running" });
  const line = renderRow({ status: "running" });
  const coloredFrames = Array.from({ length: 10 }, (_, i) => theme().fg("accent", taskIcon(running, i)));
  assert.ok(coloredFrames.some((frame) => line.includes(frame)), `missing blue spinner: ${line}`);
});

test("blocked rows paint the cross red", () => {
  const line = renderRow({ status: "blocked" });
  assert.ok(line.includes(theme().fg("error", "✗")), `missing red cross: ${line}`);
});

test("merge-failed rows paint only the leading bang red", () => {
  const line = renderRow({ merge: "failed" });
  const errorAnsi = theme().getFgAnsi("error");
  const mutedAnsi = theme().getFgAnsi("muted");

  assert.ok(stripAnsi(line).includes("! merge failed"), `status text changed: ${line}`);
  assert.ok(
    line.includes(theme().fg("error", "!") + theme().fg("muted", " merge failed")),
    `bang is not red or the remainder is not muted: ${line}`,
  );
  assert.equal(activeColor(line, line.indexOf("!")), errorAnsi, `bang is not error-coloured: ${line}`);
  assert.equal(activeColor(line, line.indexOf("merge failed")), mutedAnsi, `remainder is not muted: ${line}`);
});

test("merged rows keep the muted full status", () => {
  const line = renderRow({ status: "completed", merge: "merged", target: "main" });
  assert.ok(line.includes(theme().fg("muted", "⤵ merged → main")), `merged status changed: ${line}`);
  assert.ok(!line.includes(theme().fg("error", "!")), `merged row gained a red bang: ${line}`);
});

test("merge-failed bang stays red when the status is truncated", () => {
  const view = new TasksView(() => {});
  view.tasks = [task({ merge: "failed" })];
  const line = view.render(13).find((candidate) => candidate.includes("T1"))!;
  const bangAt = line.indexOf("!");
  assert.ok(bangAt >= 0, `bang was clipped away: ${line}`);
  assert.equal(activeColor(line, bangAt), theme().getFgAnsi("error"), `bang lost its colour: ${line}`);
});

test("keeps the full status and ellipsises the title in its own colour", () => {
  const title = "Implement a very long feature that will not fit in a narrow panel";
  const view = new TasksView(() => {});
  view.tasks = [task({ title, status: "completed", merge: "merged", target: "midas/integration" })];
  const status = theme().fg("muted", "⤵ merged → midas/integration");
  const titleColor = theme().getFgAnsi("text");

  const narrow = view.render(48).find((line) => line.includes("T1"))!;
  assert.ok(narrow.includes(status), `status was clipped: ${narrow}`);
  const ellipsis = narrow.indexOf("…");
  assert.ok(ellipsis > 0, `title was not ellipsised: ${narrow}`);
  const colorAt = narrow.indexOf(titleColor);
  assert.ok(colorAt >= 0, `title was not styled: ${narrow}`);
  assert.equal(activeColor(narrow, colorAt + titleColor.length), titleColor, `visible title lost its colour: ${narrow}`);
  assert.equal(activeColor(narrow, ellipsis), titleColor, `ellipsis is not in the title colour: ${narrow}`);
  assert.notEqual(activeColor(narrow, ellipsis), theme().getFgAnsi("muted"), `status colour bled onto the ellipsis: ${narrow}`);

  const wide = view.render(160).find((line) => line.includes("T1"))!;
  assert.ok(wide.includes(title), `full title missing at a wide width: ${wide}`);
});

/** Visible column where a row's styled title begins. */
function titleColumn(line: string): number {
  const at = line.indexOf(theme().getFgAnsi("text"));
  assert.ok(at >= 0, `row has no styled title: ${line}`);
  return stripAnsi(line.slice(0, at)).length;
}

test("id column aligns single and double digit ids and stays fixed across selections", () => {
  const board = [
    task({ id: "T2", title: "Two", group: "Feature" }),
    task({ id: "T13", title: "Thirteen", group: "Feature" }),
  ];
  const view = new TasksView(() => {});
  view.tasks = board;
  const lines = view.render(160);
  const two = titleColumn(lines.find((line) => stripAnsi(line).includes("T2"))!);
  const thirteen = titleColumn(lines.find((line) => stripAnsi(line).includes("T13"))!);
  assert.equal(two, thirteen, "single and double digit titles start at different columns");

  // The column must not shrink when the pointer moves onto the shorter id.
  const columns = new Set<number>([two]);
  for (let selected = 0; selected < board.length; selected += 1) {
    const moving = new TasksView(() => {});
    moving.tasks = board;
    selectRow(moving, selected);
    const selectedLine = moving.render(160).find((line) => line.startsWith("→"))!;
    columns.add(titleColumn(selectedLine));
  }
  // A board left with only the shorter id must reserve the same column.
  const alone = new TasksView(() => {});
  alone.tasks = [task({ id: "T2", title: "Two" })];
  columns.add(titleColumn(alone.render(160).find((line) => line.startsWith("→"))!));
  assert.equal(columns.size, 1, `id column shifted: ${[...columns].join(", ")}`);
});

test("panel height is stable while the selection moves in both modes", () => {
  const tasks = multiGroupTasks();
  for (const mode of ["groups", "worktrees"] as const) {
    const heights = new Set<number>();
    for (const selected of [0, Math.floor(tasks.length / 2), tasks.length - 1]) {
      const view = new TasksView(() => {});
      view.tasks = tasks;
      if (mode === "worktrees") view.handleInput("\t");
      selectRow(view, selected);
      const lines = view.render(160);
      heights.add(lines.length);
      const marker = lines.find((line) => line.startsWith("→"));
      assert.ok(marker, `${mode}: no selected row for index ${selected}`);
      assert.ok(tasks.some((t) => marker!.includes(t.id)), `${mode}: selected row lost its task id: ${marker}`);
    }
    assert.equal(heights.size, 1, `${mode}: height varied with selection: ${[...heights].join(", ")}`);
  }
});

test("details toggle keeps a stable height across selections", () => {
  const tasks = multiGroupTasks();
  const heights = new Set<number>();
  for (const selected of [0, Math.floor(tasks.length / 2), tasks.length - 1]) {
    const view = new TasksView(() => {});
    view.tasks = tasks;
    selectRow(view, selected);
    view.handleInput("\r");
    const lines = view.render(160);
    assert.ok(lines.some((line) => line.includes("Worktree:")), `details missing for index ${selected}`);
    heights.add(lines.length);
  }
  assert.equal(heights.size, 1, `details height varied with selection: ${[...heights].join(", ")}`);
});

test("empty and error renders keep a stable height for the same input", () => {
  const plain = new TasksView(() => {});
  const multitask = new TasksView(() => {}, true);
  assert.equal(plain.render(160).length, multitask.render(160).length);

  const tasks = multiGroupTasks();
  const heights = new Set<number>();
  for (const selected of [0, Math.floor(tasks.length / 2), tasks.length - 1]) {
    const view = new TasksView(() => {});
    view.tasks = tasks;
    view.error = "board unavailable";
    selectRow(view, selected);
    heights.add(view.render(160).length);
  }
  assert.equal(heights.size, 1, `error height varied with selection: ${[...heights].join(", ")}`);
});
