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
    revision: 1,
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

interface ContentRow {
  arrow: boolean;
  id: string;
}

/** Content rows (task rows, not group headers or the counter) in render order. */
function contentRows(lines: string[]): ContentRow[] {
  return lines.map(stripAnsi).flatMap((line) => {
    const match = /^([→ ]) \S (T\d+)\b/.exec(line);
    return match ? [{ arrow: match[1] === "→", id: match[2]! }] : [];
  });
}

/** Render `tasks` with the pointer moved to `selected`. */
function renderSelected(tasks: Task[], selected: number): string[] {
  const view = new TasksView(() => {});
  view.tasks = tasks;
  selectRow(view, selected);
  return view.render(160);
}

test("taskIcon keeps raw glyphs and colored status reflects task state", () => {
  assert.equal(taskIcon(task(), 0), "○");
  assert.equal(taskIcon(task({ status: "completed" }), 0), "✓");
  assert.equal(taskIcon(task({ status: "blocked" }), 0), "!");
  assert.equal(taskIcon(task({ status: "cancelled" }), 0), "✗");
  const running = task({ status: "running" });
  assert.notEqual(taskIcon(running, 0), taskIcon(running, 1));
  assert.equal(taskIconColor(task()), undefined);
  assert.equal(taskIconColor(running), "accent");
  assert.equal(taskIconColor(task({ status: "completed" })), "success");
  assert.equal(taskIconColor(task({ status: "blocked" })), "error");
  assert.equal(taskIconColor(task({ status: "cancelled" })), "error");
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

test("blocked rows paint the bang red", () => {
  const line = renderRow({ status: "blocked" });
  assert.ok(line.includes(theme().fg("error", "!")), `missing red bang: ${line}`);
});

test("cancelled rows paint the cross red", () => {
  const line = renderRow({ status: "cancelled" });
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
    view.handleInput("\r"); // open the actions menu
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B"); // Pause -> Cancel -> Remove -> Show details
    view.handleInput("\r"); // invoke Show details
    const lines = view.render(160);
    assert.ok(lines.some((line) => line.includes("Worktree:")), `details missing for index ${selected}`);
    heights.add(lines.length);
  }
  assert.equal(heights.size, 1, `details height varied with selection: ${[...heights].join(", ")}`);
});

test("Enter opens an actions menu scoped to the task status", () => {
  const view = new TasksView(() => {}, false, { pause: () => {}, resume: () => {}, cancel: () => {}, remove: () => {} });
  view.tasks = [task({ id: "T1", status: "running" }), task({ id: "T2", status: "paused" })];
  view.handleInput("\r");
  let text = stripAnsi(view.render(160).join("\n"));
  assert.match(text, /Actions/);
  assert.match(text, /Pause/);
  assert.match(text, /Cancel/);
  assert.doesNotMatch(text, /Resume/);
  assert.doesNotMatch(text, /Remove/, "a running task cannot be removed");
  view.handleInput("\x1b"); // close the menu
  selectRow(view, 1);
  view.handleInput("\r");
  text = stripAnsi(view.render(160).join("\n"));
  assert.match(text, /Resume/);
  assert.match(text, /Remove/);
  assert.doesNotMatch(text, /Pause/);
});

test("menu navigation stays in the menu and Esc closes only the menu", () => {
  const paused: string[] = [];
  const view = new TasksView(() => { throw new Error("overlay closed"); }, false, { pause: (id) => paused.push(id), resume: () => {}, cancel: () => {}, remove: () => {} });
  view.tasks = [task({ id: "T1", status: "running" }), task({ id: "T2", status: "running" })];
  view.handleInput("\r"); // menu on T1
  view.handleInput("\x1b[B"); // Pause -> Cancel
  view.handleInput("\x1b"); // Esc closes the menu, not the overlay
  assert.doesNotMatch(stripAnsi(view.render(160).join("\n")), /Actions/);
  assert.equal(paused.length, 0);
  view.handleInput("\r"); // reopen
  view.handleInput("\r"); // invoke the highlighted action (Pause)
  assert.deepEqual(paused, ["T1"]);
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

test("selection stays on the bottom row while the window scrolls up", () => {
  const tasks = multiGroupTasks();

  // The first task is on the first content row, with the window starting at the top.
  const first = contentRows(renderSelected(tasks, 0));
  assert.ok(first[0]?.arrow, `first content row is not selected: ${JSON.stringify(first)}`);
  assert.equal(first[0]?.id, "T1", `first content row is not the first task: ${JSON.stringify(first)}`);

  // The last task lands on the last content row with a full window above it and
  // no content row below the arrow.
  const last = contentRows(renderSelected(tasks, tasks.length - 1));
  const lastRow = last.at(-1);
  assert.ok(lastRow?.arrow, `arrow is not on the last content row: ${JSON.stringify(last)}`);
  assert.equal(lastRow?.id, "T8", `last content row is not the last task: ${JSON.stringify(last)}`);
  assert.equal(last.length, 7, `window was not full at the end: ${last.length}`);
  assert.equal(last.filter((row) => row.arrow).length, 1, `arrow appeared more than once: ${JSON.stringify(last)}`);

  // Crossing the scroll threshold drops the top task and pulls in the next one,
  // so the content shifts up rather than leaving a gap below the arrow.
  const before = contentRows(renderSelected(tasks, 6)).map((row) => row.id);
  const after = contentRows(renderSelected(tasks, 7)).map((row) => row.id);
  assert.equal(after.length, 7, `window under-filled while scrolling: ${after.join(", ")}`);
  assert.equal(after[0], before[1], `rows did not scroll up: ${before.join(", ")} -> ${after.join(", ")}`);
});

test("bottom pinning keeps T12's fixed panel height", () => {
  const tasks = multiGroupTasks();
  const heights = [0, Math.floor(tasks.length / 2), tasks.length - 1].map((selected) => renderSelected(tasks, selected).length);
  assert.equal(new Set(heights).size, 1, `height varied with selection: ${heights.join(", ")}`);
});

test("many group headers in a window still fit the fixed height", () => {
  // One group per task maximises the headers a window can span, so this is the
  // worst case for the reserved height.
  const tasks = Array.from({ length: 9 }, (_, i) => task({ id: `T${i + 1}`, title: `Task ${i + 1}`, group: `Group ${i + 1}` }));
  const heights = new Set<number>();
  for (let selected = 0; selected < tasks.length; selected += 1) {
    const lines = renderSelected(tasks, selected);
    heights.add(lines.length);
    const rows = contentRows(lines);
    assert.equal(rows.length, Math.min(7, tasks.length), `window under-filled at ${selected}: ${rows.map((row) => row.id).join(", ")}`);
    assert.equal(rows.filter((row) => row.arrow).length, 1, `arrow missing at ${selected}`);
  }
  assert.equal(heights.size, 1, `height varied with selection: ${[...heights].join(", ")}`);
});

test("group headers at the clamped tail are reserved in the fixed height", () => {
  // A large leading group followed by many singleton groups: the final window
  // spans more headers than any pre-clamp window, so the reserved height must be
  // derived from the same clamped windows the renderer produces.
  const tasks = [
    ...Array.from({ length: 3 }, (_, i) => task({ id: `T${i + 1}`, title: `Alpha ${i + 1}`, group: "Alpha" })),
    task({ id: "T4", title: "Beta", group: "Beta" }),
    task({ id: "T5", title: "Gamma", group: "Gamma" }),
    task({ id: "T6", title: "Delta", group: "Delta" }),
    task({ id: "T7", title: "Epsilon", group: "Epsilon" }),
    task({ id: "T8", title: "Zeta", group: "Zeta" }),
  ];
  const first = renderSelected(tasks, 0);
  const last = renderSelected(tasks, tasks.length - 1);
  assert.equal(first.length, last.length, `tail window overflowed the fixed height: ${first.length} vs ${last.length}`);
  const rows = contentRows(last);
  assert.equal(rows.length, 7, `tail window not full: ${rows.map((row) => row.id).join(", ")}`);
  assert.ok(rows.at(-1)?.arrow && rows.at(-1)?.id === "T8", `arrow is not on the last content row: ${JSON.stringify(rows)}`);
});

test("a small board renders at its own stable height with no empty window rows", () => {
  const small = [
    task({ id: "T1", title: "One", group: "Alpha" }),
    task({ id: "T2", title: "Two", group: "Beta" }),
    task({ id: "T3", title: "Three", group: "Beta" }),
  ];
  const heights = new Set<number>();
  for (let selected = 0; selected < small.length; selected += 1) {
    const lines = renderSelected(small, selected);
    heights.add(lines.length);
    // Every task is shown and the board is not padded out to a full window.
    assert.equal(contentRows(lines).length, small.length, `small board dropped a task at ${selected}`);
    assert.equal(lines.filter((line) => line === "").length, 0, `small board gained padding at ${selected}`);
  }
  // Two group headers (Alpha, Beta) plus three task rows.
  assert.equal(heights.size, 1, `small board height varied: ${[...heights].join(", ")}`);
  assert.equal([...heights][0], 5, `small board height is wrong: ${[...heights].join(", ")}`);
});
