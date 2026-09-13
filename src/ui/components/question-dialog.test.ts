import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { CONTENT_END, CONTENT_START, DECORATION, stripAnsi } from "../../lib/ansi.ts";
import type { QuestionView } from "../../state/transcript.ts";
import { initTheme, theme } from "../../theme/theme.ts";
import { QuestionDialog } from "./question-dialog.ts";

initPiTheme(undefined, false);
initTheme(undefined);

function request(questions: QuestionView["questions"]): QuestionView {
  return { id: "q1", questions };
}

test("multi-question prompts put the counter on the border, not in the body", () => {
  const dialog = new QuestionDialog(
    request([
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      { question: "Pick two", options: [{ label: "C" }] },
    ]),
    () => {},
    () => {},
  );
  const first = dialog.render(60);
  assert.match(stripAnsi(first[0]!), /╭─ Question 1\/2 /, `counter missing from the border: ${stripAnsi(first[0]!)}`);
  const body = first.slice(1, -1).map(stripAnsi).join("\n");
  assert.ok(!body.includes("1/2"), `counter leaked into the body: ${body}`);

  // Answering the first prompt advances the border counter.
  dialog.handleInput("\r");
  assert.match(stripAnsi(dialog.render(60)[0]!), /╭─ Question 2\/2 /);
});

test("the header joins the border title rather than taking a body line", () => {
  const dialog = new QuestionDialog(
    request([{ header: "Choose wisely", question: "What next?", options: [{ label: "A" }] }]),
    () => {},
    () => {},
  );
  const raw = dialog.render(60);
  const plain = raw.map(stripAnsi);
  assert.ok(plain[0]!.includes("╭─ Choose wisely "), `header missing from the border: ${plain[0]}`);
  assert.ok(!plain.slice(1, -1).some((line) => line.includes("Choose wisely")), "header leaked into the body");
  const question = raw.find((line) => line.includes("What next?"))!;
  assert.ok(question.includes(theme().fg("text", "What next?")), `question is not primary text: ${JSON.stringify(question)}`);
});

test("a header and a multi-question counter share the border", () => {
  const dialog = new QuestionDialog(
    request([
      { header: "Remove UX", question: "How should remove appear?", options: [{ label: "A" }] },
      { header: "Running tasks", question: "Allow removing a running task?", options: [{ label: "B" }] },
    ]),
    () => {},
    () => {},
  );
  assert.ok(stripAnsi(dialog.render(60)[0]!).includes("╭─ Remove UX: Question 1/2 "), stripAnsi(dialog.render(60)[0]!));
  dialog.handleInput("\r");
  assert.ok(stripAnsi(dialog.render(60)[0]!).includes("╭─ Running tasks: Question 2/2 "), stripAnsi(dialog.render(60)[0]!));
});

test("content bounds exclude the border and padding from selection", () => {
  const dialog = new QuestionDialog(
    request([{ question: "What next?", options: [{ label: "Alpha" }] }]),
    () => {},
    () => {},
  );
  const lines = dialog.render(40);
  // Border rows are decoration with empty content bounds, so they never select.
  for (const edge of [lines[0]!, lines.at(-1)!]) {
    assert.ok(edge.includes(DECORATION), "border row is not marked as decoration");
    assert.ok(edge.includes(CONTENT_START + CONTENT_END), "border row content bounds are not empty");
  }
  // Body rows bound only their text; the gutter, fill and border stay outside.
  for (const line of lines.slice(1, -1)) {
    const start = line.indexOf(CONTENT_START);
    const end = line.indexOf(CONTENT_END);
    assert.ok(start > 0 && end > start, `body row lacks content bounds: ${JSON.stringify(stripAnsi(line))}`);
    assert.equal(stripAnsi(line.slice(0, start)).trim(), "│", "gutter is inside the selection");
    assert.equal(stripAnsi(line.slice(end + CONTENT_END.length)).trim(), "│", "fill/border is inside the selection");
  }
});

test("the question is immediately followed by the options, with panel gutters", () => {
  const dialog = new QuestionDialog(
    request([{ question: "What next?", options: [{ label: "Alpha" }, { label: "Beta" }] }]),
    () => {},
    () => {},
  );
  const plain = dialog.render(40).map(stripAnsi);
  const questionAt = plain.findIndex((line) => line.includes("What next?"));
  assert.ok(questionAt >= 1, `question row missing: ${plain.join("\n")}`);
  assert.ok(plain[questionAt + 1]!.includes("Alpha"), `option not directly below the question: ${plain.join("\n")}`);
  for (const line of plain.slice(1, -1)) {
    assert.ok(line.startsWith("│ "), `missing left gutter: ${line}`);
    assert.ok(line.endsWith(" │"), `missing right gutter: ${line}`);
  }
});
