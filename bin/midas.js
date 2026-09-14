#!/usr/bin/env node
// Launcher that runs the package-local tsx against the TypeScript entry point,
// independent of the caller's working directory (so `midas` works anywhere).
//
// Before starting it fast-forwards the checkout from its upstream, so a push is
// picked up by the next `midas` run (see ./update.js). Set MIDAS_NO_UPDATE=1 to
// skip the check.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoUpdate } from "./update.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

autoUpdate(root);

const tsx = join(root, "node_modules", ".bin", "tsx");
const entry = join(root, "src", "index.ts");

const child = spawn(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
