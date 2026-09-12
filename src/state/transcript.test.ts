import test from "node:test";
import assert from "node:assert/strict";
import type { Message, Part } from "@opencode-ai/sdk";
import { Transcript, type MessageView } from "./transcript.ts";

const assistant = (id: string): Message =>
  ({ id, role: "assistant", sessionID: "ses", mode: "task", time: { created: 1 }, tokens: {}, cost: 0 }) as unknown as Message;
const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, sessionID: "ses", messageID, type: "text", text }) as unknown as Part;
const textOf = (transcript: Transcript): string => {
  const part = transcript.messages[0]!.parts[0]!;
  return part.kind === "text" ? part.text : "";
};

const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
const msg = (id: string, created: number): MessageView => ({
  id,
  role: "assistant",
  cost: 0,
  tokens,
  created,
  parts: [],
});

test("addBash records the supplied timestamp and a running part", () => {
  const transcript = new Transcript();
  transcript.addBash("ls -la", false, 42);
  const message = transcript.messages[0]!;
  assert.equal(message.created, 42);
  const part = message.parts[0]!;
  assert.equal(part.kind, "bash");
  assert.equal(part.kind === "bash" ? part.status : "", "running");
});

test("restoreBash replays `!` output at its original position", () => {
  const transcript = new Transcript();
  transcript.messages.push(msg("a1", 100), msg("a2", 300));
  transcript.restoreBash({ command: "ls", output: "file-a\n", exclude: false, status: "complete", exitCode: 0, at: 200 });

  assert.equal(transcript.messages.length, 3);
  assert.equal(transcript.messages[1]!.created, 200);
  const part = transcript.messages[1]!.parts[0]!;
  assert.equal(part.kind, "bash");
  assert.equal(part.kind === "bash" ? part.output : "", "file-a\n");
  assert.equal(transcript.messages[2]!.id, "a2");
});

test("streamed deltas grow text and stale snapshots never truncate it", () => {
  const transcript = new Transcript();
  transcript.upsertMessage(assistant("a1"));
  transcript.upsertPart(textPart("p1", "a1", "Hello"));
  transcript.appendPartDelta("p1", "text", " world");
  assert.equal(textOf(transcript), "Hello world");

  // A snapshot that lags the deltas must not wipe them.
  transcript.upsertPart(textPart("p1", "a1", ""));
  assert.equal(textOf(transcript), "Hello world");

  // A fuller snapshot is authoritative.
  transcript.upsertPart(textPart("p1", "a1", "Hello world!"));
  assert.equal(textOf(transcript), "Hello world!");

  // A `delta` carried on the update event is appended too.
  transcript.upsertPart(textPart("p1", "a1", "Hello world!"), "?");
  assert.equal(textOf(transcript), "Hello world!?");
});

test("appendPartDelta ignores mismatched fields and unknown parts", () => {
  const transcript = new Transcript();
  transcript.upsertMessage(assistant("a1"));
  transcript.upsertPart(textPart("p1", "a1", "Hi"));
  transcript.appendPartDelta("p1", "reasoning", "nope");
  transcript.appendPartDelta("missing", "text", "nope");
  assert.equal(textOf(transcript), "Hi");
});

test("restoreBash appends when it is newer than every message", () => {
  const transcript = new Transcript();
  transcript.messages.push(msg("a1", 100));
  transcript.restoreBash({ command: "pwd", output: "/x\n", exclude: false, status: "complete", exitCode: 0, at: 500 });
  assert.equal(transcript.messages[1]!.created, 500);
});

test("message versions bump on every mutation, for cheap render caching", () => {
  const transcript = new Transcript();
  transcript.upsertMessage(assistant("a1"));
  const afterCreate = transcript.messages[0]!.version!;
  assert.ok(afterCreate >= 1, "creation assigns a version");

  transcript.upsertPart(textPart("p1", "a1", "Hello"));
  const afterPart = transcript.messages[0]!.version!;
  assert.ok(afterPart > afterCreate, "adding a part bumps the message");

  transcript.appendPartDelta("p1", "text", " world");
  const afterDelta = transcript.messages[0]!.version!;
  assert.ok(afterDelta > afterPart, "a streamed delta bumps the message");

  transcript.removePart("a1", "p1");
  assert.ok(transcript.messages[0]!.version! > afterDelta, "removing a part bumps the message");

  // A different message's mutations don't touch this one.
  transcript.upsertMessage(assistant("a2"));
  const a1 = transcript.messages.find((m) => m.id === "a1")!.version;
  transcript.upsertPart(textPart("p2", "a2", "other"));
  assert.equal(transcript.messages.find((m) => m.id === "a1")!.version, a1);
});
