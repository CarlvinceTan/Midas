import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../lib/ansi.ts";
import { initTheme, theme } from "../../theme/theme.ts";
import { StartupHeader, SessionHeader } from "./startup-header.ts";

initPiTheme(undefined, false);
initTheme(undefined);

test("session header shows the branch in parentheses after the path", () => {
  const header = new SessionHeader(() => ({ title: "Work", path: "~/code/midas", branch: "dev" }), () => 0);
  const line = stripAnsi(header.render(60)[0]!);
  assert.ok(line.includes("~/code/midas (dev)"), `path with branch, got: ${line}`);
  // Without a branch the path is unchanged.
  const plain = stripAnsi(new SessionHeader(() => ({ title: "Work", path: "~/code/midas" }), () => 0).render(60)[0]!);
  assert.ok(plain.includes("~/code/midas"));
  assert.ok(!plain.includes("("));
});

test("startup column headers use the purple startup heading color", () => {
  const header = new StartupHeader(
    () => ({ contextPaths: [], agentGroups: [["advisor"]], skills: ["notion"], mcpNames: ["exa"], version: "1" }),
    () => 0,
  );
  const lines = header.render(80);
  const headers = lines[0]!;
  const purple = theme().getFgAnsi("startupHeading");
  for (const title of ["[Context]", "[Agents]", "[Skills]", "[MCPs]"]) {
    assert.ok(headers.includes(title), `header row shows ${title}`);
  }
  assert.ok(headers.includes(purple), "header row uses the startupHeading color");
  assert.notEqual(purple, theme().getFgAnsi("mdHeading"), "startup headings are not the markdown heading color");
  // Column items stay dim, not purple.
  assert.ok(lines.slice(1).every((line) => !line.includes(purple)));
});

test("startup header separates agent groups with a blank row", () => {
  const header = new StartupHeader(
    () => ({
      contextPaths: [],
      agentGroups: [
        ["main", "orchestrator"],
        ["advisor", "explore", "task"],
        ["compaction", "title"],
      ],
      skills: [],
      mcpNames: [],
      version: "1",
    }),
    () => 0,
  );
  const rows = header.render(80).map((line) => stripAnsi(line).trimEnd());
  const [main, orchestrator, advisor, explore, task, compaction, title] = [
    "main",
    "orchestrator",
    "advisor",
    "explore",
    "task",
    "compaction",
    "title",
  ].map((name) => rows.findIndex((row) => row.includes(name)));
  // Group 1, blank, group 2, blank, group 3.
  assert.deepEqual([main, orchestrator], [1, 2]);
  assert.equal(rows[3], "");
  assert.deepEqual([advisor, explore, task], [4, 5, 6]);
  assert.equal(rows[7], "");
  assert.deepEqual([compaction, title], [8, 9]);
});
