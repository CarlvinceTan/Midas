import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeChitChat, parseSpeechIntent, speechGatePrompt } from "./gate.ts";

test("parseSpeechIntent reads a TASK verdict and distils the request", () => {
  assert.deepEqual(parseSpeechIntent("TASK: Add a unit test for the parser"), {
    clear: true,
    request: "Add a unit test for the parser",
  });
  assert.deepEqual(parseSpeechIntent("task: fix the failing build"), {
    clear: true,
    request: "fix the failing build",
  });
  assert.deepEqual(parseSpeechIntent("```\nTASK: rename the command\n```"), {
    clear: true,
    request: "rename the command",
  });
});

test("parseSpeechIntent reads a CHAT verdict", () => {
  assert.deepEqual(parseSpeechIntent("CHAT"), { clear: false });
  assert.deepEqual(parseSpeechIntent("chat — just a greeting"), { clear: false });
});

test("parseSpeechIntent falls back to chat for anything unrecognised", () => {
  assert.deepEqual(parseSpeechIntent(""), { clear: false });
  assert.deepEqual(parseSpeechIntent("I think this might be a task?"), { clear: false });
  assert.deepEqual(parseSpeechIntent("Sure, I can help with that."), { clear: false });
});

test("a bare TASK verdict keeps the caller's request text", () => {
  assert.deepEqual(parseSpeechIntent("TASK", "deploy the branch"), {
    clear: true,
    request: "deploy the branch",
  });
});

test("looksLikeChitChat catches greetings and acknowledgements", () => {
  for (const line of ["hi", "Hey!", "good morning", "thanks", "thank you!", "ok", "cool", "got it", "yes", "nope", ""]) {
    assert.equal(looksLikeChitChat(line), true, `${JSON.stringify(line)} should be chit-chat`);
  }
});

test("looksLikeChitChat leaves real requests alone", () => {
  for (const line of [
    "add a speech mode",
    "fix the failing test in app.ts",
    "what does the dispatcher do",
    "rename runSlashCommand to handleSlashCommand",
  ]) {
    assert.equal(looksLikeChitChat(line), false, `${JSON.stringify(line)} should not be chit-chat`);
  }
});

test("speechGatePrompt embeds context and marks the transcript as untrusted", () => {
  const prompt = speechGatePrompt("add a test", ["hello", "hi there"]);
  assert.ok(prompt.includes("- hello"));
  assert.ok(prompt.includes("- hi there"));
  assert.ok(prompt.includes("add a test"));
  assert.ok(prompt.includes("untrusted data"));
  assert.ok(prompt.includes("Do not answer the request"));
});
