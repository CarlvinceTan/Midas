import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShellCommand, usableSessionTitle } from "./text.ts";

test("usableSessionTitle keeps real titles and drops placeholders", () => {
  assert.equal(usableSessionTitle("  Fix the parser bug  "), "Fix the parser bug");
  assert.equal(usableSessionTitle("Preparation for deployment"), "Preparation for deployment");
  assert.equal(usableSessionTitle(""), "");
  assert.equal(usableSessionTitle(undefined), "");
  assert.equal(usableSessionTitle("   "), "");
  assert.equal(usableSessionTitle("New session"), "");
  assert.equal(usableSessionTitle("new SESSION"), "");
  assert.equal(usableSessionTitle("New chat"), "");
  assert.equal(usableSessionTitle("Untitled"), "");
  // opencode's generated placeholder for an untouched session.
  assert.equal(usableSessionTitle("New session - 2026-09-12T15:56:15.910Z"), "");
  assert.equal(usableSessionTitle("new session – 2026-09-12T15:56:15Z"), "");
  assert.equal(usableSessionTitle("New session - Fix the parser"), "New session - Fix the parser");
});

test("parseShellCommand reads `!`/`!!` commands and leaves prompts alone", () => {
  assert.deepEqual(parseShellCommand("! ls -la"), { command: "ls -la", exclude: false });
  assert.deepEqual(parseShellCommand("!! rm -rf build"), { command: "rm -rf build", exclude: true });
  // Only a bang at the very start activates shell mode; leading whitespace does not.
  assert.equal(parseShellCommand("  !   git status  "), undefined);
  assert.equal(parseShellCommand(" ! ls"), undefined);
  assert.equal(parseShellCommand("\t! ls"), undefined);
  // A bare bang is a shell command with nothing to run.
  assert.deepEqual(parseShellCommand("! "), { command: "", exclude: false });
  assert.equal(parseShellCommand("!not-a-command"), undefined);
  assert.equal(parseShellCommand("hello ! world"), undefined);
  assert.equal(parseShellCommand(""), undefined);
});
