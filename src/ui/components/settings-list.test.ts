import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import { agentSettingsRows } from "../../lib/agents.ts";
import { stripAnsi } from "../../lib/ansi.ts";

const listTheme: SettingsListTheme = {
  label: (text) => text,
  value: (text) => text,
  description: (text) => text,
  cursor: "> ",
  hint: (text) => text,
};

test("settings lists visually separate groups without adding selectable rows", () => {
  const changes: string[] = [];
  const list = new SettingsList(
    [
      { id: "main", label: "Main", currentValue: "default", group: "entry" },
      { id: "orchestrator", label: "Orchestrator", currentValue: "default", group: "entry" },
      { id: "advisor", label: "Advisor", currentValue: "a", values: ["a", "b"], group: "subagents" },
      { id: "task", label: "Task", currentValue: "a", values: ["a", "b"], group: "subagents" },
      { id: "title", label: "Title", currentValue: "default", group: "internal" },
    ],
    14,
    listTheme,
    (id) => changes.push(id),
    () => {},
  );
  const lines = list.render(60);
  assert.match(lines[0]!, /Main/);
  assert.match(lines[1]!, /Orchestrator/);
  assert.equal(lines[2], "");
  assert.match(lines[3]!, /Advisor/);
  assert.match(lines[4]!, /Task/);
  assert.equal(lines[5], "");
  assert.match(lines[6]!, /Title/);

  // The separator is not clickable; the item below it still maps correctly.
  list.handleMouse?.({ type: "click", button: "left", x: 0, y: 2 } as never);
  assert.deepEqual(changes, []);
  list.handleMouse?.({ type: "press", button: "left", x: 0, y: 3 } as never);
  list.handleMouse?.({ type: "click", button: "left", x: 0, y: 3 } as never);
  assert.deepEqual(changes, ["advisor"]);
});

test("agents overlay renders internals as ordinary rows with no separator or dim label", () => {
  const rows = agentSettingsRows([
    { name: "main", mode: "primary" },
    { name: "advisor", mode: "subagent" },
    { name: "task", mode: "primary" },
    { name: "compaction", mode: "primary" },
    { name: "summary", mode: "primary" },
    { name: "title", mode: "primary" },
  ]);
  const list = new SettingsList(
    rows.map((row) => ({ id: `agent:${row.name}`, label: row.label, currentValue: "default", group: row.group })),
    14,
    listTheme,
    () => {},
    () => {},
  );
  const itemLines = list.render(60).slice(0, rows.length);
  // The rows are contiguous: no blank separator isolates compaction/summary/title.
  assert.ok(
    itemLines.every((line) => line !== ""),
    `agent rows must be one section, got:\n${JSON.stringify(itemLines)}`,
  );
  for (const name of ["Compaction", "Summary", "Title"]) {
    // Each internal is present among the agents, in the same run of rows.
    const line = itemLines.find((candidate) => stripAnsi(candidate).includes(name));
    assert.ok(line, `${name} is rendered as a /agents row`);
    // Ordinary label styling: no muted/dim ANSI wrapper on internal labels.
    assert.ok(!line!.includes("[2m"), `${name} label is not dimmed`);
  }
});
