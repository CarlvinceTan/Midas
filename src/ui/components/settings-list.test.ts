import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";

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
