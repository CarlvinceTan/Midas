import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { cleanSessionTitle, projectLabel, type AgentSession } from "../../lib/agent-sessions.ts";
import { initTheme } from "../../theme/theme.ts";
import { SessionsView } from "./sessions-view.ts";

initPiTheme(undefined, false);
initTheme(undefined);

const CWD = "/Users/x/code/Polymux";

const session = (over: Partial<AgentSession> & Pick<AgentSession, "id" | "agent" | "projectDir">): AgentSession => ({
  title: `Session ${over.id}`,
  updatedAt: 1_700_000_000_000,
  ...over,
});

const mouse = (type: string, x: number, y: number): TuiMouseEvent =>
  ({ type, x, y, button: "left" }) as unknown as TuiMouseEvent;

const makeView = (
  handlers: { onNew?: (directory: string) => void; onResume?: (session: AgentSession) => void; onCancel?: () => void } = {},
): SessionsView =>
  new SessionsView({
    cwd: CWD,
    onNew: handlers.onNew ?? (() => {}),
    onResume: handlers.onResume ?? (() => {}),
    onCancel: handlers.onCancel ?? (() => {}),
  });

const text = (view: SessionsView, width = 100): string => view.render(width).map(stripAnsi).join("\n");

const tabs = (view: SessionsView): Array<{ start: number; end: number; index: number }> =>
  (view as unknown as { tabRanges: Array<{ start: number; end: number; index: number }> }).tabRanges;

const withSessions = (handlers: Parameters<typeof makeView>[0] = {}): SessionsView => {
  const view = makeView(handlers);
  view.setSessions([
    session({ id: "m1", agent: "midas", projectDir: CWD, title: "Midas work", updatedAt: 1_700_000_030_000 }),
    session({ id: "c1", agent: "claude", projectDir: CWD, title: "Claude work", updatedAt: 1_700_000_020_000 }),
    session({ id: "c2", agent: "claude", projectDir: "/Users/x/code/FlareAI", title: "Claude elsewhere", updatedAt: 1_700_000_010_000 }),
  ]);
  return view;
};

test("project folders keep a capitalized folder name", () => {
  assert.equal(projectLabel("/Users/x/code/Polymux"), "Polymux");
  assert.equal(projectLabel("/Users/x/code/midas"), "Midas");
  assert.equal(projectLabel("/Users/x/.pi"), "Pi");
});

test("session titles are collapsed and trimmed", () => {
  assert.equal(cleanSessionTitle("  Fix   the\nparser  "), "Fix the parser");
  assert.equal(cleanSessionTitle(""), "");
});

test("SessionsView tabs the agents and lists their projects", () => {
  const view = withSessions();
  const rendered = text(view);
  assert.match(rendered, /All/);
  assert.match(rendered, /Midas/);
  assert.match(rendered, /Claude/);
  assert.match(rendered, /→ Polymux/);
  assert.match(rendered, /2 sessions/);
  assert.match(rendered, /FlareAI/);
  assert.doesNotMatch(rendered, /All projects/);

  // The tab row is indented under the panel title; list rows stay flush left.
  const lines = view.render(100).map(stripAnsi);
  assert.equal((lines[0] ?? "").search(/\S/), 1);
  const selectedRow = lines.find((line) => line.includes("→")) ?? "";
  assert.equal(selectedRow.indexOf("→"), 0);
});

test("SessionsView groups sessions that share a project key under one label", () => {
  const view = makeView();
  const groupKey = "/Users/x/Documents/Codex";
  view.setSessions([
    session({ id: "x1", agent: "codex", projectDir: `${groupKey}/a`, groupKey, groupLabel: "Other", title: "One" }),
    session({ id: "x2", agent: "codex", projectDir: `${groupKey}/b`, groupKey, groupLabel: "Other", title: "Two" }),
  ]);
  const rendered = text(view);
  assert.match(rendered, /Other/);
  assert.match(rendered, /2 sessions/);
});

test("SessionsView switches agent scope with Left/Right", () => {
  const view = withSessions();
  view.handleInput("\x1b[C"); // right -> Midas
  let rendered = text(view);
  assert.doesNotMatch(rendered, /FlareAI/, "Midas has no FlareAI sessions");
  view.handleInput("\x1b[C"); // right -> Claude
  rendered = text(view);
  assert.match(rendered, /FlareAI/);
  view.handleInput("\x1b[D"); // left -> Midas
  assert.doesNotMatch(text(view), /FlareAI/);
});

test("SessionsView steps back with Esc and cancels from the project list", () => {
  let cancelled = 0;
  const view = withSessions({ onCancel: () => (cancelled += 1) });
  view.handleInput("\r"); // open Polymux
  assert.equal(view.currentTitle(), "Sessions > Polymux");
  view.handleInput("\x1b");
  assert.equal(view.currentTitle(), "Sessions");
  view.handleInput("\x1b");
  assert.equal(cancelled, 1);
});

test("SessionsView shows a project's sessions for the chosen agent", () => {
  const view = withSessions();
  view.handleInput("\r"); // open Polymux under All
  const rendered = text(view);
  assert.equal(view.currentTitle(), "Sessions > Polymux");
  assert.match(rendered, /New session/);
  assert.match(rendered, /Midas work/);
  assert.match(rendered, /Claude work/);
  assert.match(rendered, /Midas · /, "All rows are labelled with their agent");

  view.handleInput("\x1b[C"); // switch to Midas => back to projects
  view.handleInput("\r"); // open Polymux under Midas
  const midas = text(view);
  assert.equal(view.currentTitle(), "Sessions > Polymux");
  assert.match(midas, /New session/);
  assert.match(midas, /Midas work/);
  assert.doesNotMatch(midas, /Claude work/);

  view.handleInput("\x1b[C"); // switch to Claude
  view.handleInput("\r"); // open Polymux under Claude
  const claude = text(view);
  assert.equal(view.currentTitle(), "Sessions > Polymux");
  assert.doesNotMatch(claude, /New session/, "new sessions belong to Midas");
  assert.match(claude, /Claude work/);
});

test("SessionsView resumes the selected session", () => {
  const resumed: AgentSession[] = [];
  const view = withSessions({ onResume: (value) => resumed.push(value) });
  view.handleInput("\r"); // open Polymux (entries: new, m1, c1)
  view.handleInput("\x1b[B"); // m1
  view.handleInput("\r");
  view.handleInput("\x1b[B"); // c1
  view.handleInput("\r");
  assert.deepEqual(
    resumed.map((entry) => entry.id),
    ["m1", "c1"],
  );
});

test("SessionsView starts a new session in the selected project", () => {
  const started: string[] = [];
  const view = withSessions({ onNew: (directory) => started.push(directory) });
  view.handleInput("\r"); // open Polymux; first row is New session
  view.handleInput("\r");
  assert.deepEqual(started, [CWD]);
});

test("SessionsView switches agent on click but ignores hover", () => {
  const view = withSessions();
  view.render(100);
  const claudeTab = tabs(view).find((tab) => tab.index === 2)!;
  assert.equal(view.handleMouse(mouse("move", claudeTab.start, 0)), undefined);
  assert.deepEqual(view.handleMouse(mouse("click", claudeTab.start, 0)), { handled: true, render: true });
  view.handleInput("\r");
  assert.equal(view.currentTitle(), "Sessions > Polymux");
});

test("SessionsView keeps session metadata visible when the title is long", () => {
  const view = makeView();
  view.setSessions([
    session({ id: "c1", agent: "claude", projectDir: CWD, title: "T".repeat(200), updatedAt: Date.now() - 120_000 }),
  ]);
  view.handleInput("\r"); // open Polymux -> entries: New session, c1
  const row = text(view, 40)
    .split("\n")
    .find((line) => line.includes("2m ago"));
  assert.ok(row, "expected the session row");
  assert.match(row, /Claude · 2m ago$/);
  assert.match(row, /…/, "the long title is truncated");
});

test("SessionsView aligns the scroll counter with the row labels", () => {
  const view = makeView();
  view.setSessions(
    Array.from({ length: 15 }, (_, index) =>
      session({ id: `m${index}`, agent: "midas", projectDir: CWD, title: `Session ${index}` }),
    ),
  );
  view.handleInput("\r"); // open Polymux; New session + 15 sessions overflows
  const lines = view.render(100).map(stripAnsi);
  const counter = lines.find((line) => /^\s*\d+\/\d+$/.test(line));
  assert.ok(counter, "expected a scroll counter row");
  const row = lines.find((line) => line.includes("Session 0"));
  assert.ok(row, "expected a session row");
  assert.equal(counter.search(/\S/), row.search(/\S/));
});

test("SessionsView keeps a constant height across agents and levels", () => {
  const view = withSessions();
  const all = view.render(100).length;
  view.handleInput("\x1b[C"); // Midas: one project, fewer rows
  assert.equal(view.render(100).length, all);
  view.handleInput("\x1b[C"); // Claude: two projects
  assert.equal(view.render(100).length, all);
  view.handleInput("\r"); // drill into a project (shorter still)
  assert.equal(view.render(100).length, all);
});

test("SessionsView shows a scanning placeholder before sessions load", () => {
  const view = makeView();
  view.setLoading();
  assert.match(text(view), /Scanning…/);
});
