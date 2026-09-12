import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme } from "../../theme/theme.ts";
import type { AgentStat } from "../../opencode/agent-stats.ts";
import { StatsView } from "./stats-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const claude: AgentStat = {
  key: "claude",
  label: "Claude",
  cost: 2,
  sessions: 2,
  calls: 60,
  tokens: { input: 140_000, output: 70_000, cacheRead: 280_000, cacheWrite: 5_000 },
};
const codex: AgentStat = {
  key: "codex",
  label: "Codex",
  cost: 0.25,
  sessions: 1,
  calls: 10,
  tokens: { input: 20_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
};

test("stats aggregate cost, tokens and averages globally", () => {
  const view = new StatsView({ cwd: "/Users/x", onCancel: () => {} });
  // Before data arrives, values render as placeholders.
  assert.ok(view.render(80).map(stripAnsi).some((line) => line.includes("Total cost") && line.includes("--")));
  view.setData([claude, codex]);
  const lines = view.render(80).map(stripAnsi);
  assert.ok(lines.some((line) => line.includes("Sessions") && line.includes("3")));
  assert.ok(lines.some((line) => line.includes("Calls") && line.includes("70")));
  assert.ok(lines.some((line) => line.includes("Total cost") && line.includes("$2.25")));
  assert.ok(lines.some((line) => line.includes("Avg/session") && line.includes("$0.75")));
  // Cache hit rate = cacheRead / (input + cacheRead).
  assert.ok(lines.some((line) => line.includes("Cache hit") && line.includes("63.6%")));
});

test("stats tabs are agents and switch with the right arrow", () => {
  const view = new StatsView({ cwd: "/Users/x", onCancel: () => {} });
  view.setData([claude, codex]);
  const tabs = stripAnsi(view.render(80)[0]!);
  assert.ok(tabs.includes("All"));
  assert.ok(tabs.includes("Claude"));
  assert.ok(tabs.includes("Codex"));
  view.handleInput("\x1b[C");
  const lines = view.render(80).map(stripAnsi);
  assert.ok(lines.some((line) => line.includes("Total cost") && line.includes("$2.00")));
});
