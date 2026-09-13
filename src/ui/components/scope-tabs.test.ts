import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "../../theme/theme.ts";
import { StatsView } from "./stats-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const mouse = (type: string, x: number, y: number): TuiMouseEvent =>
  ({ type, x, y, button: "left" }) as unknown as TuiMouseEvent;

const tabRanges = (view: object): Array<{ start: number; end: number; index: number }> =>
  (view as { tabRanges: Array<{ start: number; end: number; index: number }> }).tabRanges;

test("StatsView switches scope on click but not on hover", () => {
  const view = new StatsView({ cwd: "/cwd", onCancel() {} });
  view.setData([]);
  view.render(60);
  const tab = tabRanges(view)[0]!;
  assert.ok(tab);
  assert.equal(view.handleMouse(mouse("move", tab.start, 0)), undefined);
  assert.deepEqual(view.handleMouse(mouse("click", tab.start, 0)), { handled: true, render: true });
});
