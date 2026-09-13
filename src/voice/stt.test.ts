import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { VoiceController, composeVoiceText, parseSttLine } from "./stt.ts";

test("parseSttLine accepts protocol events and ignores junk", () => {
  assert.deepEqual(parseSttLine('{"type":"partial","text":"hi"}'), { type: "partial", text: "hi", message: undefined });
  assert.deepEqual(parseSttLine('{"type":"error","message":"boom"}'), { type: "error", text: undefined, message: "boom" });
  assert.equal(parseSttLine("not json"), undefined);
  assert.equal(parseSttLine('{"type":"other"}'), undefined);
  assert.equal(parseSttLine(""), undefined);
});

test("composeVoiceText joins base, committed and partial", () => {
  assert.equal(composeVoiceText("base ", "hello ", "wor"), "base hello wor");
});

test("VoiceController commits finals, replaces partials and stops on error", () => {
  const stdout = new PassThrough();
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { stdout, kill: () => { kills += 1; } });
  const texts: Array<[string, string]> = [];
  const errors: string[] = [];
  const controller = new VoiceController({
    command: "fake",
    spawn: () => child as never,
    onText: (committed, partial) => texts.push([committed, partial]),
    onError: (message) => errors.push(message),
  });
  controller.start();
  stdout.write('{"type":"partial","text":"hel"}\n{"type":"final","text":"hello "}\n{"type":"partial","text":"wor"}\n');
  stdout.write('{"type":"error","message":"mic denied"}\n');
  assert.deepEqual(texts, [["", "hel"], ["hello ", ""], ["hello ", "wor"]]);
  assert.deepEqual(errors, ["mic denied"]);
  assert.equal(kills, 1);
  controller.stop();
  assert.equal(kills, 1, "stop is idempotent");
});
