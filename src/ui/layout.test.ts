import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { PaddedBlock } from "./layout.ts";

const block = (lines: string[]): Component => ({
  invalidate(): void {},
  render(): string[] {
    return lines;
  },
});

test("PaddedBlock adds a blank only on the requested side of non-empty content", () => {
  assert.deepEqual(new PaddedBlock(block([]), "bottom").render(10), []);
  assert.deepEqual(new PaddedBlock(block([]), "top").render(10), []);
  assert.deepEqual(new PaddedBlock(block(["a", "b"]), "bottom").render(10), ["a", "b", ""]);
  assert.deepEqual(new PaddedBlock(block(["a", "b"]), "top").render(10), ["", "a", "b"]);
});
