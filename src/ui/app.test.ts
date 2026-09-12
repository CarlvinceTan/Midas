import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../lib/ansi.ts";
import { initTheme } from "../theme/theme.ts";
import { WorkingIndicator } from "./app.ts";

initPiTheme(undefined, false);
initTheme(undefined);

/** Strip CSI colours and the zero-width OSC content markers. */
function plain(text: string): string {
  return stripAnsi(text).replace(/\x1b\][^\x07]*\x07/g, "");
}

function indicator(label: string, tone: "thinking" | "running", pad: number) {
  return new WorkingIndicator(
    () => ({ id: "a", label, tone }),
    () => "⠋",
    () => pad,
    () => undefined,
    () => {},
  );
}

test("a long running label is truncated inside the right padding", () => {
  const width = 40;
  const pad = 2;
  const lines = indicator(`Running \`${"x".repeat(200)}\``, "running", pad).render(width);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.ok(visibleWidth(line) <= width - pad, `width ${visibleWidth(line)} exceeds ${width - pad}`);
  assert.ok(plain(line).startsWith("  "), "keeps the left indent");
  assert.ok(plain(line).endsWith("…"), "ends with an ellipsis");
});

test("a short status line is left untouched", () => {
  const lines = indicator("Thinking", "thinking", 1).render(80);
  assert.equal(plain(lines[0]!), " ⠋ Thinking");
});
