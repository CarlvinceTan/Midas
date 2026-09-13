import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme } from "../../theme/theme.ts";
import { SessionHeader } from "./startup-header.ts";

initPiTheme(undefined, false);
initTheme(undefined);

function click(x: number, y = 1): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 3, shift: false, alt: false, ctrl: false };
}

test("remote indicator renders left of the skills summary with a dot separator", () => {
  const header = new SessionHeader(
    () => ({ title: "Work", status: "Idle", resources: "3 skills • 1 mcps", remoteActive: true }),
    () => 0,
  );
  const line = stripAnsi(header.render(60)[1]!);
  assert.match(line, /remote active • 3 skills • 1 mcps/);
});

test("remote indicator is absent when remote is off", () => {
  const header = new SessionHeader(() => ({ title: "Work", status: "Idle", resources: "3 skills • 1 mcps" }), () => 0);
  const line = stripAnsi(header.render(60)[1]!);
  assert.ok(!line.includes("remote active"), `no indicator, got: ${line}`);
});

test("clicking the remote label copies the link; clicks elsewhere do not", () => {
  let clicks = 0;
  const header = new SessionHeader(
    () => ({ title: "Work", status: "Idle", resources: "3 skills • 1 mcps", remoteActive: true, onRemoteClick: () => clicks++ }),
    () => 0,
  );
  const raw = header.render(60)[1]!;
  // Count visible columns before the label: the render carries zero-width
  // content markers, so a raw indexOf would be off.
  const start = visibleWidth(raw.slice(0, raw.indexOf("remote active")));
  assert.ok(start > 0, `indicator present, got: ${stripAnsi(raw)}`);

  assert.equal(header.handleMouse(click(start))?.handled, true);
  assert.equal(clicks, 1, "click on the label copies");
  header.handleMouse(click(start - 2));
  assert.equal(clicks, 1, "click left of the label does nothing");
  header.handleMouse(click(0));
  assert.equal(clicks, 1, "click on the status area does nothing");
  assert.equal(header.handleMouse(click(start, 0)), undefined, "only the status row is clickable");
});

test("remote label is not clickable when the header is hidden", () => {
  let clicks = 0;
  const header = new SessionHeader(
    () => ({ title: "Work", resources: "3 skills", remoteActive: true, hidden: true, onRemoteClick: () => clicks++ }),
    () => 0,
  );
  assert.deepEqual(header.render(60), []);
  header.handleMouse(click(0));
  assert.equal(clicks, 0);
});
