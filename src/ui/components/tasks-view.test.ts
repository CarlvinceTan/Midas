import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../../theme/theme.ts";
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
