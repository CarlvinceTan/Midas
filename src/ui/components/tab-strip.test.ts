import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme } from "../../theme/theme.ts";
import { renderTabStrip } from "./tab-strip.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const labels = ["All", "Pi", "Midas", "Claude", "Codex", "Cursor", "Gemini", "Aider"];

test("tab strip shows everything when it fits", () => {
  const strip = renderTabStrip(labels, 0, 200);
  const plain = stripAnsi(strip.text);
  assert.ok(plain.includes("All") && plain.includes("Aider"));
  assert.ok(!plain.includes("→") && !plain.includes("←"));
  assert.equal(strip.ranges.length, labels.length);
});

test("tab strip marks hidden tabs on the right", () => {
  const strip = renderTabStrip(labels, 0, 40);
  const plain = stripAnsi(strip.text);
  assert.ok(plain.includes("All"));
  assert.match(plain, /\d+ more →/);
  assert.ok(!plain.includes("←"));
  // Ranges only cover the visible tabs and stay in bounds.
  assert.ok(strip.ranges.length < labels.length);
  for (const range of strip.ranges) assert.ok(range.end <= 40);
});

test("tab strip marks hidden tabs on the left once scrolled right", () => {
  const strip = renderTabStrip(labels, labels.length - 1, 40);
  const plain = stripAnsi(strip.text);
  assert.ok(plain.includes("Aider"));
  assert.match(plain, /← \d+ more/);
});
