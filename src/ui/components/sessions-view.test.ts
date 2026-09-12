import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeLabel } from "./sessions-view.ts";

test("agent directories get friendly tab labels", () => {
  assert.equal(scopeLabel("/Users/x/.pi"), "Pi");
  assert.equal(scopeLabel("/Users/x/.midas"), "Midas");
  assert.equal(scopeLabel("/Users/x/.claude"), "Claude");
  assert.equal(scopeLabel("/Users/x/.codex"), "Codex");
  assert.equal(scopeLabel("/Users/x/.opencode"), "OpenCode");
  assert.equal(scopeLabel("/Users/x/.cursor"), "Cursor");
});

test("project directories keep a capitalized folder name", () => {
  assert.equal(scopeLabel("/Users/x/code/midas"), "Midas");
  assert.equal(scopeLabel("/Users/x/code/pi"), "Pi");
});
