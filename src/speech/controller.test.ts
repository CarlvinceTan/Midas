import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SpeechController, parseSpeechLine } from "./controller.ts";

test("parseSpeechLine accepts protocol events and ignores junk", () => {
  assert.deepEqual(parseSpeechLine('{"type":"utterance","text":"hi"}'), { type: "utterance", text: "hi", message: undefined });
  assert.deepEqual(parseSpeechLine('{"type":"assistant","text":"ok"}'), { type: "assistant", text: "ok", message: undefined });
  assert.deepEqual(parseSpeechLine('{"type":"ready"}'), { type: "ready", text: undefined, message: undefined });
  assert.deepEqual(parseSpeechLine('{"type":"listening"}'), { type: "listening", text: undefined, message: undefined });
  assert.deepEqual(parseSpeechLine('{"type":"error","message":"boom"}'), { type: "error", text: undefined, message: "boom" });
  assert.equal(parseSpeechLine("not json"), undefined);
  assert.equal(parseSpeechLine('{"type":"partial"}'), undefined);
  assert.equal(parseSpeechLine(""), undefined);
});

/** A fake helper with an stdin that records every command Midas sends. */
function fakeChild(): {
  child: EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill(): void };
  stdout: PassThrough;
  written: string[];
  state: { kills: number };
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk) => {
    written.push(chunk.toString());
  });
  const state = { kills: 0 };
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    kill: () => {
      state.kills += 1;
    },
  });
  return { child, stdout, written, state };
}

const sentCommands = (written: string[]): string[] =>
  written
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);

test("SpeechController preloads, then listens and pauses with the process warm", () => {
  const { child, stdout, written } = fakeChild();
  const utterances: string[] = [];
  const assistants: string[] = [];
  let ready = 0;
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: (text) => utterances.push(text),
    onAssistant: (text) => assistants.push(text),
    onError: () => {},
    onReady: () => {
      ready += 1;
    },
  });

  controller.preload();
  assert.deepEqual(sentCommands(written), [], "preload must not open the microphone");
  assert.equal(controller.ready, false);

  stdout.write('{"type":"ready"}\n');
  assert.equal(controller.ready, true);
  assert.equal(ready, 1);

  controller.listen();
  assert.deepEqual(sentCommands(written), ["listen"]);

  stdout.write('{"type":"utterance","text":"add a test"}\n');
  assert.deepEqual(utterances, ["add a test"]);
  controller.respond();
  assert.deepEqual(sentCommands(written), ["listen", "respond"]);

  stdout.write('{"type":"assistant","text":"on it"}\n');
  assert.deepEqual(assistants, ["on it"]);

  controller.pause();
  assert.deepEqual(sentCommands(written), ["listen", "respond", "pause"]);
});

test("SpeechController ignores turns while paused", () => {
  const { child, stdout, written } = fakeChild();
  const utterances: string[] = [];
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: (text) => utterances.push(text),
    onAssistant: () => {},
    onError: () => {},
  });

  controller.listen();
  controller.pause();
  stdout.write('{"type":"utterance","text":"stray"}\n');
  stdout.write('{"type":"assistant","text":"stray reply"}\n');
  assert.deepEqual(utterances, []);
  assert.deepEqual(sentCommands(written), ["listen", "pause"]);
});

test("SpeechController sends skip without opening a reply", () => {
  const { child, written } = fakeChild();
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: () => {},
    onAssistant: () => {},
    onError: () => {},
  });
  controller.listen();
  controller.skip();
  assert.deepEqual(sentCommands(written), ["listen", "skip"]);
});

test("SpeechController reports an error and stops itself", () => {
  const { child, state } = fakeChild();
  const errors: string[] = [];
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: () => {},
    onAssistant: () => {},
    onError: (message) => errors.push(message),
  });
  controller.listen();
  child.stdout.write('{"type":"error","message":"no model"}\n');
  assert.deepEqual(errors, ["no model"]);
  assert.equal(state.kills, 1);
});

test("SpeechController reports an unexpected exit but not a teardown", () => {
  const { child } = fakeChild();
  let stops = 0;
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: () => {},
    onAssistant: () => {},
    onError: () => {},
    onStop: () => {
      stops += 1;
    },
  });
  controller.listen();
  child.emit("exit", 1);
  assert.equal(stops, 1);

  controller.stop();
  child.emit("exit", 0);
  assert.equal(stops, 1, "a deliberate stop must not report an unexpected exit");
});

test("markReady fires once even across many events", () => {
  const { child, stdout } = fakeChild();
  let ready = 0;
  const controller = new SpeechController({
    command: "fake",
    spawn: () => child as never,
    onUtterance: () => {},
    onAssistant: () => {},
    onError: () => {},
    onReady: () => {
      ready += 1;
    },
  });
  controller.listen();
  stdout.write('{"type":"utterance","text":"a"}\n');
  stdout.write('{"type":"assistant","text":"b"}\n');
  assert.equal(ready, 1);
});
