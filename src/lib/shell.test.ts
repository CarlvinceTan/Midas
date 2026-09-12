import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCdTarget } from "./shell.ts";

const yes = (): boolean => true;
const no = (): boolean => false;

test("resolveCdTarget resolves plain cd targets that exist", () => {
  assert.equal(resolveCdTarget("cd", "/w", yes), homedir());
  assert.equal(resolveCdTarget("cd ~", "/w", yes), homedir());
  assert.equal(resolveCdTarget("cd ~/code", "/w", yes), join(homedir(), "code"));
  assert.equal(resolveCdTarget("cd /tmp/x", "/w", yes), "/tmp/x");
  assert.equal(resolveCdTarget("cd rel/dir", "/w", yes), resolve("/w", "rel/dir"));
  assert.equal(resolveCdTarget('cd "two words"', "/w", yes), resolve("/w", "two words"));
});

test("resolveCdTarget leaves non-plain or missing cd targets to the shell", () => {
  assert.equal(resolveCdTarget("cd missing", "/w", no), undefined);
  assert.equal(resolveCdTarget("cd -", "/w", no), undefined);
  assert.equal(resolveCdTarget("cd a && ls", "/w", yes), undefined);
  assert.equal(resolveCdTarget("ls", "/w", yes), undefined);
  assert.equal(resolveCdTarget("echo cd x", "/w", yes), undefined);
});
