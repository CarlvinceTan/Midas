import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme } from "../../theme/theme.ts";
import type { MessageView, PartView } from "../../state/transcript.ts";
import { computeRuns } from "../run-model.ts";
import { RunView } from "./run-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const tui = {
  terminal: { rows: 40, columns: 100 },
  requestRender() {},
  setFocus() {},
  addInputListener() {
    return () => {};
  },
} as never;

function message(
  id: string,
  role: "user" | "assistant",
  parts: PartView[],
  extra: Partial<MessageView> = {},
): MessageView {
  return {
    id,
    role,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    parts,
    ...extra,
  };
}

test("a settled run keeps `!` shell output visible while collapsing its tools", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "u1t", text: "do it" }]),
    message("a1", "assistant", [
      { kind: "tool", id: "t1", callID: "t1", tool: "read", status: "completed", input: {}, start: 0 },
      { kind: "text", id: "a1t", text: "done" },
    ]),
    message("bashmsg_1", "assistant", [
      { kind: "bash", id: "b1", command: "ls -la", output: "file-a\n", status: "complete", exitCode: 0, exclude: false },
    ]),
  ]);
  const view = new RunView(
    runs[0]!,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    () => (text) => text,
    tui,
  );
  view.setActive(false); // idle/settled: the turn collapses to "+ Worked"
  const plain = view.render(80).map(stripAnsi).join("\n");

  assert.match(plain, /Worked/);
  // The final answer stays, but the intermediate tool row is collapsed away.
  assert.match(plain, /done/);
  assert.doesNotMatch(plain, /Read/);
  // The user-initiated shell box is never folded into the summary.
  assert.match(plain, /\$ ls -la/);
  assert.match(plain, /file-a/);
});

test("a bash box keeps a single blank row after the prose above it", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "u1t", text: "go" }]),
    message("a1", "assistant", [{ kind: "text", id: "a1t", text: "done" }]),
    message("bashmsg_1", "assistant", [
      { kind: "bash", id: "b1", command: "cd", output: "", status: "complete", exitCode: 0, exclude: false },
    ]),
  ]);
  const view = new RunView(
    runs[0]!,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    () => (text) => text,
    tui,
  );
  view.setActive(false);
  const clean = (line: string): string => stripAnsi(line.replace(/\x1b\][^\x07]*\x07/g, ""));
  const lines = view.render(80).map(clean);
  const textIndex = lines.findIndex((line) => line.includes("done"));
  const borderIndex = lines.findIndex((line, index) => index > textIndex && /^─+$/.test(line.trim()));
  assert.ok(textIndex >= 0 && borderIndex > textIndex);
  const blanks = lines.slice(textIndex + 1, borderIndex).filter((line) => line.trim() === "").length;
  assert.equal(blanks, 1);
});

test("a pending steer renders as its own user card, not a Worked block", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "p", text: "first" }]),
    message("a1", "assistant", [
      { kind: "tool", id: "t1", callID: "t1", tool: "read", status: "running", input: {}, start: 0 },
    ]),
    message("u2", "user", [{ kind: "text", id: "s", text: "steer message" }], { steer: true }),
  ]);
  const steer = runs.find((run) => run.id === "u2")!;
  const view = new RunView(
    steer,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    () => (text) => text,
    tui,
  );
  view.setActive(false);
  const plain = view.render(60).map(stripAnsi).join("\n");
  assert.match(plain, /steer message/);
  assert.doesNotMatch(plain, /Worked/);
});

test("a settled run reuses its rendered lines until a message version changes", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "u1t", text: "go" }]),
    message("a1", "assistant", [{ kind: "text", id: "a1t", text: "done" }]),
  ]);
  const view = new RunView(
    runs[0]!,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    () => (text) => text,
    tui,
  );
  view.setActive(false);

  const first = view.render(80);
  assert.equal(view.render(80), first, "unchanged run returns the cached lines");

  // A bump from the transcript (any part mutation) invalidates the cache.
  runs[0]!.messages[1]!.version = 1;
  const second = view.render(80);
  assert.notEqual(second, first);

  // Explicit invalidation (theme/settings change) also drops the cache.
  view.invalidate();
  assert.notEqual(view.render(80), second);
});

test("an active run is never cached", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "u1t", text: "go" }]),
    message("a1", "assistant", [{ kind: "text", id: "a1t", text: "done" }]),
  ]);
  const view = new RunView(
    runs[0]!,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    () => (text) => text,
    tui,
  );
  view.setActive(true);
  assert.notEqual(view.render(80), view.render(80));
});

test("a prompt card keeps the border colour of the agent that sent it", () => {
  const runs = computeRuns([
    message("u1", "user", [{ kind: "text", id: "u1t", text: "sent in multitask" }], { agent: "orchestrator" }),
  ]);
  const seen: Array<string | undefined> = [];
  const view = new RunView(
    runs[0]!,
    () => 1,
    "/cwd",
    { hideThinking: true, expandedTools: false },
    (agent) => { seen.push(agent); return (text) => text; },
    tui,
  );
  view.setActive(false);
  view.render(80);
  // The resolver is asked for the message's own agent, not the current mode.
  assert.deepEqual(seen, ["orchestrator"]);
});
