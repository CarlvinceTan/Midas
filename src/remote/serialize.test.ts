import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@opencode-ai/sdk";
import type { MessageView } from "../state/transcript.ts";
import { capText, mergeSessionSummaries, sessionSummary, storedSessionSummary, toClientMessage, toClientQuestion } from "./serialize.ts";

test("capText leaves short text and truncates long text", () => {
  assert.equal(capText("hello", 10), "hello");
  const capped = capText("x".repeat(100), 10)!;
  assert.match(capped, /^x{10}\n… \[90 more characters truncated\]$/);
  assert.equal(capText(undefined), undefined);
});

test("sessionSummary normalizes title, directory and times", () => {
  const summary = sessionSummary({
    id: "ses_1",
    title: "  ",
    directory: "/tmp/project",
    time: { created: 10, updated: 20 },
  } as unknown as Session);
  assert.deepEqual(summary, {
    id: "ses_1",
    title: "Untitled session",
    directory: "/tmp/project",
    updated: 20,
    created: 10,
  });
});

test("storedSessionSummary maps the midas registry shape", () => {
  assert.deepEqual(
    storedSessionSummary({ id: "ses_x", cwd: "/p", title: "  ", createdAt: 1, updatedAt: 5 }),
    { id: "ses_x", title: "Untitled session", directory: "/p", created: 1, updated: 5 },
  );
});

test("mergeSessionSummaries dedupes and prefers real titles", () => {
  const registry = [
    { id: "a", title: "Untitled session", directory: "/p", updated: 1, created: 1 },
    { id: "b", title: "Beta", directory: "/q", updated: 9, created: 1 },
  ];
  const scoped = [
    { id: "a", title: "Alpha", directory: "/p", updated: 2, created: 1 },
    { id: "c", title: "Gamma", directory: "/p", updated: 5, created: 1 },
  ];
  const merged = mergeSessionSummaries(registry, scoped);
  assert.deepEqual(merged.map((s) => s.id), ["b", "c", "a"], "newest first");
  assert.equal(merged.find((s) => s.id === "a")!.title, "Alpha", "registry wins but a real title fills a placeholder");
  assert.equal(merged.find((s) => s.id === "a")!.directory, "/p");
});

test("toClientMessage drops renderer-only version and caps tool output", () => {
  const message: MessageView = {
    id: "m1",
    role: "assistant",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    version: 7,
    parts: [
      { kind: "text", id: "p1", text: "hi" },
      { kind: "tool", id: "p2", callID: "c1", tool: "bash", status: "completed", input: { command: "ls" }, output: "x".repeat(50_000), start: 0 },
    ],
  };
  const client = toClientMessage(message) as Record<string, unknown>;
  assert.equal(client.version, undefined);
  const parts = client.parts as Array<Record<string, unknown>>;
  assert.equal(parts[0]!.kind, "text");
  assert.equal(parts[1]!.kind, "tool");
  assert.match(String(parts[1]!.output), /more characters truncated/);
  assert.match(String(parts[1]!.input), /"command": "ls"/);
});

test("toClientQuestion projects prompts and options", () => {
  const question = toClientQuestion({
    id: "q1",
    questions: [
      { header: "Pick", question: "Which?", multiple: false, options: [{ label: "A", description: "first" }] },
    ],
  }) as { id: string; questions: Array<Record<string, unknown>> };
  assert.equal(question.id, "q1");
  assert.equal(question.questions[0]!.question, "Which?");
  assert.deepEqual(question.questions[0]!.options, [{ label: "A", description: "first" }]);
});
