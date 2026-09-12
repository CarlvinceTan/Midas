import test from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { RoundedDialogFrame } from "./rounded-frame.ts";

const plain = (lines: string[]): string[] => lines.map(stripTerminalSequences);

// Minimal stand-in for the editor: a box rule above/below the input plus an
// autocomplete menu row below the bottom rule, which is what pi-tui emits.
const editor = {
  invalidate() {},
  render: (): string[] => ["──────", "/m", "──────", "→ model", "  mcps"],
};

test("autocomplete rows align the command under the first typed character", () => {
  const frame = new RoundedDialogFrame(() => 1);
  frame.addChild(editor);
  const lines = plain(frame.render(40));

  const body = lines.find((line) => line.includes("/m"))!;
  const selected = lines.find((line) => line.includes("model"))!;
  const other = lines.find((line) => line.includes("mcps"))!;

  // `/m` sits two columns in (border + gutter); the menu names line up on the
  // `m` the user typed, not on the slash.
  assert.equal(body.indexOf("/m") + 1, selected.indexOf("model"));
  assert.equal(body.indexOf("/m") + 1, other.indexOf("mcps"));
});

test("autocomplete rows still fill the full frame width", () => {
  const frame = new RoundedDialogFrame(() => 1);
  frame.addChild(editor);
  for (const line of plain(frame.render(40))) assert.equal(line.length, 40);
});
