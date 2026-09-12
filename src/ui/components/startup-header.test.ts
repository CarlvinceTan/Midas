import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme as initPiTheme } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../../theme/theme.ts";
import { StartupHeader } from "./startup-header.ts";

initPiTheme(undefined, false);
initTheme(undefined);

test("startup column headers use the purple startup heading color", () => {
  const header = new StartupHeader(
    () => ({ contextPaths: [], agents: ["advisor"], skills: ["notion"], mcpNames: ["exa"], version: "1" }),
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
