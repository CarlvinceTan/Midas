import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Session } from "@opencode-ai/sdk";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme } from "../../theme/theme.ts";
import { SessionsView } from "./sessions-view.ts";
import { StatsView } from "./stats-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const session = (id: string, directory: string): Session =>
  ({ id, directory, title: `Session ${id}`, time: { created: 1, updated: 1 } }) as unknown as Session;

const mouse = (type: string, x: number, y: number): TuiMouseEvent =>
  ({ type, x, y, button: "left" }) as unknown as TuiMouseEvent;

const tabRanges = (view: object): Array<{ start: number; end: number; index: number }> =>
  (view as { tabRanges: Array<{ start: number; end: number; index: number }> }).tabRanges;

const makeSessions = (): SessionsView => {
  const view = new SessionsView({ cwd: "/cwd", onNew() {}, onResume() {}, onCancel() {} });
  const sessions = Array.from({ length: 20 }, (_, i) => session(`s${i}`, "/cwd"));
  view.setHere(sessions);
  view.setAll(sessions);
  return view;
};

test("SessionsView switches scope on click but not on hover", () => {
  const view = makeSessions();
  view.render(60);
  const tab = tabRanges(view)[0]!;
  assert.ok(tab);
  assert.equal(view.handleMouse(mouse("move", tab.start, 0)), undefined);
  assert.deepEqual(view.handleMouse(mouse("click", tab.start, 0)), { handled: true, render: true });
});

test("SessionsView aligns the scroll counter with the row labels", () => {
  const lines = makeSessions().render(60).map(stripAnsi);
  const counter = lines.find((line) => /^\s*\d+\/\d+$/.test(line));
  assert.ok(counter, "expected a scroll counter row");
  // Rows are `pad` (1) + marker (2) before the label; the counter matches.
  assert.equal(counter.match(/^\s*/)![0].length, 3);
});

test("StatsView switches scope on click but not on hover", () => {
  const view = new StatsView({ cwd: "/cwd", onCancel() {} });
  view.setData([]);
  view.render(60);
  const tab = tabRanges(view)[0]!;
  assert.ok(tab);
  assert.equal(view.handleMouse(mouse("move", tab.start, 0)), undefined);
  assert.deepEqual(view.handleMouse(mouse("click", tab.start, 0)), { handled: true, render: true });
});
