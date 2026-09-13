import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ModelPicker, modelDisplayLabel, modelDisplayParts } from "./model-picker.ts";

test("model labels use catalog names and humanize OpenCode Go identifiers", () => {
  assert.deepEqual(
    modelDisplayParts({
      providerID: "anthropic",
      providerName: "Anthropic",
      modelID: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    }),
    { name: "Claude Sonnet 4.5", provider: "Anthropic" },
  );
  assert.equal(
    modelDisplayLabel({
      providerID: "opencode-go",
      providerName: "opencode-go",
      modelID: "kimi-k2.5",
      name: "kimi-k2.5",
    }),
    "Kimi K2.5  OpenCode Go",
  );
  // An authoritative catalog name keeps meaningful punctuation.
  assert.equal(
    modelDisplayLabel({ providerID: "openai", providerName: "OpenAI", modelID: "gpt-5.2", name: "GPT-5.2" }),
    "GPT-5.2  OpenAI",
  );
});

test("the model selector uses the shared readable model label", () => {
  const picker = new ModelPicker(
    [{ providerID: "opencode-go", providerName: "opencode-go", modelID: "kimi-k2.5", name: "kimi-k2.5" }],
    () => {},
    () => {},
  );
  assert.match(picker.render(50).map(stripTerminalSequences).join("\n"), /Kimi K2\.5  OpenCode Go/);
});
