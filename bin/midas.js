#!/usr/bin/env node
// Launcher that runs the package-local tsx against the TypeScript entry point,
// independent of the caller's working directory (so `midas` works anywhere).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
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
