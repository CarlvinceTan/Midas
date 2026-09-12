import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHeadingDepth } from "./markdown.ts";

const context = { messageType: "assistant", isStreaming: false, availableWidth: 80 } as never;

test("downgrades headings deeper than level two so no literals are drawn", () => {
  assert.equal(normalizeHeadingDepth("### Three", context), "## Three");
  assert.equal(normalizeHeadingDepth("#### Four", context), "## Four");
});

test("leaves level one/two headings and non-headings alone", () => {
  assert.equal(normalizeHeadingDepth("# One", context), "# One");
  assert.equal(normalizeHeadingDepth("## Two", context), "## Two");
  assert.equal(normalizeHeadingDepth("#hashtag", context), "#hashtag");
  assert.equal(normalizeHeadingDepth("####### seven", context), "####### seven");
});

test("does not rewrite headings inside fenced code blocks", () => {
  const markdown = "### Real\n\n```md\n### literal\n```\n\n### Real again";
  assert.equal(
    normalizeHeadingDepth(markdown, context),
    "## Real\n\n```md\n### literal\n```\n\n## Real again",
  );
});
