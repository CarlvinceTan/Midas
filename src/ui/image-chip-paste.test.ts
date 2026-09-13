import test from "node:test";
import assert from "node:assert/strict";
// Import the worktree copy directly: `@earendil-works/pi-tui` resolves through
// node_modules to the ROOT checkout's vendor tree, so a package import would
// not see edits made here.
import { Editor } from "../../vendor/pi-tui/dist/components/editor.js";

const tui = {
  terminal: { rows: 40, columns: 80 },
  requestRender(): void {},
  setFocus(): void {},
  addInputListener(): () => void {
    return () => {};
  },
} as never;
const theme = {
  borderColor: (text: string): string => text,
  selectList: {
    selectedText: (text: string): string => text,
    text: (text: string): string => text,
    muted: (text: string): string => text,
    selectedBg: (text: string): string => text,
  },
} as never;

const yellow = (lines: string[]): boolean => lines.some((line) => line.includes("\x1b[33m"));

/** Deliver `text` as a bracketed paste, the path used by terminal paste. */
const paste = (editor: Editor, text: string): void => {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
};

test("a chip copied from the transcript and pasted back re-attaches its file", () => {
  const editor = new Editor(tui, theme, { paddingX: 0 });
  editor.insertImageAttachment("/tmp/copied shot.png");
  // The host clears the input after submit; session memory must survive it.
  editor.setText("");
  assert.deepEqual(editor.getImageAttachments(), []);

  paste(editor, "[Image: copied shot.png]");
  assert.equal(editor.getText(), "[Image: copied shot.png]");
  assert.deepEqual(editor.getImageAttachments(), [
    { marker: "[Image: copied shot.png]", path: "/tmp/copied shot.png" },
  ]);
  assert.ok(yellow(editor.render(80)), "pasted chip renders yellow");

  let attachments: Array<{ marker: string; path: string }> = [];
  editor.onSubmit = (_text, images) => {
    attachments = images;
  };
  editor.handleInput("\r");
  assert.deepEqual(attachments, [
    { marker: "[Image: copied shot.png]", path: "/tmp/copied shot.png" },
  ]);
});

test("typed lookalikes and unknown pasted markers stay plain", () => {
  // Typing marker text never creates a chip, even for a name we remember.
  const typed = new Editor(tui, theme, { paddingX: 0 });
  typed.insertImageAttachment("/tmp/known.png");
  typed.setText("");
  for (const char of "[Image: known.png]") typed.handleInput(char);
  assert.deepEqual(typed.getImageAttachments(), []);
  assert.ok(!yellow(typed.render(80)), "typed marker is not highlighted");

  // A pasted marker with no remembered source path stays plain too.
  const unknown = new Editor(tui, theme, { paddingX: 0 });
  unknown.insertImageAttachment("/tmp/known.png");
  unknown.setText("");
  paste(unknown, "[Image: unknown.png]");
  assert.equal(unknown.getText(), "[Image: unknown.png]");
  assert.deepEqual(unknown.getImageAttachments(), []);
  assert.ok(!yellow(unknown.render(80)), "unknown marker is not highlighted");
});

test("chips restored from a saved draft are re-attachable when pasted", () => {
  const editor = new Editor(tui, theme, { paddingX: 0 });
  editor.setImageAttachments([{ marker: "[Image: draft.png]", path: "/tmp/draft.png" }]);
  // A wholesale replace drops the active chip mapping but not session memory.
  editor.setText("");
  assert.deepEqual(editor.getImageAttachments(), []);

  paste(editor, "[Image: draft.png]");
  assert.deepEqual(editor.getImageAttachments(), [
    { marker: "[Image: draft.png]", path: "/tmp/draft.png" },
  ]);
});

test("a known chip embedded in pasted prose is registered and re-attached", () => {
  const editor = new Editor(tui, theme, { paddingX: 0 });
  editor.insertImageAttachment("/tmp/embedded.png");
  editor.setText("");

  paste(editor, "see [Image: embedded.png] here");
  assert.equal(editor.getText(), "see [Image: embedded.png] here");
  assert.deepEqual(editor.getImageAttachments(), [
    { marker: "[Image: embedded.png]", path: "/tmp/embedded.png" },
  ]);
});
