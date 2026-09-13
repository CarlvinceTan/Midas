import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../../lib/ansi.ts";
import { PasswordDialog } from "./password-dialog.ts";

test("password dialog masks typed characters", () => {
  const dialog = new PasswordDialog("Remote password: ", () => {}, () => {});
  dialog.handleInput("h");
  dialog.handleInput("i");
  const line = stripAnsi(dialog.render(60)[0]!);
  assert.ok(line.includes("••"), `masked value, got: ${line}`);
  assert.ok(!line.includes("hi"), "the raw value never renders");
});

test("password dialog submits on enter and cancels on escape", () => {
  const submitted: string[] = [];
  let cancelled = 0;
  const dialog = new PasswordDialog("Remote password: ", (value) => submitted.push(value), () => cancelled++);
  dialog.handleInput("s");
  dialog.handleInput("e");
  dialog.handleInput("c");
  dialog.handleInput("\r");
  assert.deepEqual(submitted, ["sec"]);
  dialog.handleInput("\x1b");
  assert.equal(cancelled, 1);
});

test("password dialog backspace deletes and ctrl+u clears", () => {
  const submitted: string[] = [];
  const dialog = new PasswordDialog("P: ", (value) => submitted.push(value), () => {});
  dialog.handleInput("a");
  dialog.handleInput("b");
  dialog.handleInput("\x7f");
  dialog.handleInput("c");
  dialog.handleInput("\r");
  assert.deepEqual(submitted, ["ac"]);
  dialog.handleInput("x");
  dialog.handleInput("\x15");
  dialog.handleInput("\r");
  assert.deepEqual(submitted, ["ac", ""]);
});
