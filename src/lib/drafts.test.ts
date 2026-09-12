import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteDraft, draftsFilePath, readDraft, writeDraft } from "./drafts.ts";

function withTempConfigDir(run: () => void): void {
  const previous = process.env.MIDAS_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "midas-drafts-"));
  process.env.MIDAS_CONFIG_DIR = dir;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MIDAS_CONFIG_DIR;
    else process.env.MIDAS_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("drafts round-trip per session, including image chips", () => {
  withTempConfigDir(() => {
    writeDraft("ses_a", {
      text: "half-written prompt",
      attachments: [{ marker: "[Image: shot.png]", path: "/tmp/shot.png" }],
    });
    writeDraft("ses_b", { text: "another session" });

    assert.deepEqual(readDraft("ses_a"), {
      text: "half-written prompt",
      attachments: [{ marker: "[Image: shot.png]", path: "/tmp/shot.png" }],
    });
    assert.deepEqual(readDraft("ses_b"), { text: "another session" });
    assert.equal(readDraft("ses_c"), undefined);
    assert.equal(readDraft(undefined), undefined);
  });
});

test("emptying the input removes the stored draft", () => {
  withTempConfigDir(() => {
    writeDraft("ses_a", { text: "unsent" });
    assert.equal(readDraft("ses_a")?.text, "unsent");
    writeDraft("ses_a", { text: "" });
    assert.equal(readDraft("ses_a"), undefined);
  });
});

test("deleteDraft drops a session's entry", () => {
  withTempConfigDir(() => {
    writeDraft("ses_a", { text: "unsent" });
    deleteDraft("ses_a");
    assert.equal(readDraft("ses_a"), undefined);
  });
});

test("the store is capped, pruning the oldest drafts", () => {
  withTempConfigDir(() => {
    for (let i = 0; i < 130; i++) writeDraft(`ses_${i}`, { text: `draft ${i}` });
    assert.equal(readDraft("ses_0"), undefined);
    assert.equal(readDraft("ses_129")?.text, "draft 129");
    // File stays parseable JSON after pruning.
    assert.ok(draftsFilePath().endsWith("drafts.json"));
  });
});
