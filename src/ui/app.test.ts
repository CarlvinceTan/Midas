import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../lib/ansi.ts";
import { initTheme } from "../theme/theme.ts";
import { submitAction, ensureDispatcherOnSubmit, WorkingIndicator, voiceToggle, voiceFrameTitle, exitVoiceOnEscape, pickAgentModelRef } from "./app.ts";

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

test("multitask queues a busy prompt like every other mode", () => {
  assert.equal(submitAction({ multitask: true, runActive: true, isCommand: false, editing: false }), "queue");
});

test("multitask sends a prompt when no run is active", () => {
  assert.equal(submitAction({ multitask: true, runActive: false, isCommand: false, editing: false }), "send");
});

test("busy input queues when multitask is off", () => {
  assert.equal(submitAction({ multitask: false, runActive: true, isCommand: false, editing: false }), "queue");
});

test("an edited follow-up goes back to its slot in every mode", () => {
  assert.equal(submitAction({ multitask: true, runActive: true, isCommand: false, editing: true }), "requeue");
  assert.equal(submitAction({ multitask: false, runActive: true, isCommand: false, editing: true }), "requeue");
});

test("commands keep their existing routing in every mode", () => {
  for (const multitask of [true, false]) {
    for (const runActive of [true, false]) {
      assert.equal(
        submitAction({ multitask, runActive, isCommand: true, editing: false }),
        "command",
        `multitask=${multitask} runActive=${runActive}`,
      );
    }
  }
});

test("a multitask submission ensures the dispatcher is running", () => {
  let calls = 0;
  ensureDispatcherOnSubmit(true, () => { calls += 1; });
  assert.equal(calls, 1);
});

test("a normal submission never touches the dispatcher", () => {
  let calls = 0;
  ensureDispatcherOnSubmit(false, () => { calls += 1; });
  assert.equal(calls, 0);
});

test("repeated multitask submissions keep exactly one dispatcher leader", () => {
  // The real sync is idempotent; this models it so the submission path cannot
  // start a duplicate loop when a leader already holds the lease.
  let leading = false;
  let starts = 0;
  const ensure = (): void => {
    if (leading) return;
    leading = true;
    starts += 1;
  };
  ensureDispatcherOnSubmit(true, ensure);
  ensureDispatcherOnSubmit(true, ensure);
  ensureDispatcherOnSubmit(true, ensure);
  assert.equal(starts, 1);
});

test("voice toggles on and off explicitly and flips with no argument", () => {
  assert.equal(voiceToggle("on", false), true);
  assert.equal(voiceToggle("off", true), false);
  assert.equal(voiceToggle("", false), true);
  assert.equal(voiceToggle("", true), false);
  assert.equal(voiceToggle("bogus", false), undefined);
});

test("the Listening title shows only while voice is active", () => {
  assert.equal(voiceFrameTitle({ voice: true, orchestrator: true }), "Listening");
  assert.equal(voiceFrameTitle({ voice: true, orchestrator: false }), "Listening");
  assert.equal(voiceFrameTitle({ voice: false, orchestrator: true }), undefined);
  assert.equal(voiceFrameTitle({ voice: false, orchestrator: false }), undefined);
});

test("agent model precedence: session, override, config, last used", () => {
  assert.equal(pickAgentModelRef({ session: "s", override: "o", configured: "c", lastUsed: "l" }), "s");
  assert.equal(pickAgentModelRef({ override: "o", configured: "c", lastUsed: "l" }), "o");
  assert.equal(pickAgentModelRef({ configured: "c", lastUsed: "l" }), "c");
  assert.equal(pickAgentModelRef({ lastUsed: "l" }), "l");
  assert.equal(pickAgentModelRef({}), undefined);
});

test("escape exits voice only while listening and not in autocomplete", () => {
  assert.equal(exitVoiceOnEscape({ voiceActive: true, escape: true, autocomplete: false }), true);
  assert.equal(exitVoiceOnEscape({ voiceActive: true, escape: true, autocomplete: true }), false);
  assert.equal(exitVoiceOnEscape({ voiceActive: false, escape: true, autocomplete: false }), false);
  assert.equal(exitVoiceOnEscape({ voiceActive: true, escape: false, autocomplete: false }), false);
});
