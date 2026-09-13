import { readFileSync } from "node:fs";
import { TaskBoard } from "./board.ts";
import { runTask, mergeTask, cleanupTask } from "./runner.ts";
import { TaskDispatcher } from "./dispatcher.ts";

export async function taskCli(args: string[]): Promise<void> {
  const cwdIndex = args.indexOf("--cwd");
  let cwd = process.cwd();
  if (cwdIndex >= 0) {
    if (!args[cwdIndex + 1]) throw new Error("--cwd requires a directory");
    cwd = args[cwdIndex + 1]!;
    args.splice(cwdIndex, 2);
  }
  const [command, value, extra] = args;
  if (!command || command === "--help") {
    process.stdout.write(
      "midas task [--cwd DIR] add CONTRACT.json | update ID CONTRACT.json | list | run ID | merge ID | cleanup ID\n" +
        "midas task [--cwd DIR] dispatch [--once] [--concurrency N]   run the board autonomously\n",
    );
    return;
  }
  const board = new TaskBoard(cwd);
  if (command === "dispatch") {
    const concurrencyIndex = args.indexOf("--concurrency");
    let concurrency: number | undefined;
    if (concurrencyIndex >= 0) {
      concurrency = Number(args[concurrencyIndex + 1]);
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency requires a positive integer");
    }
    const dispatcher = new TaskDispatcher(board, { concurrency, onEvent: (message) => process.stdout.write(`${message}\n`) });
    await dispatcher.start();
    process.stdout.write("Dispatcher running. Press Ctrl+C to stop.\n");
    if (args.includes("--once")) {
      await dispatcher.drain();
      dispatcher.stop();
      return;
    }
    await new Promise<void>((resolve) => {
      const stop = (): void => { dispatcher.stop(); resolve(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await dispatcher.drain();
    return;
  }
  const arity = command === "list" ? 1 : command === "update" ? 3 : 2;
  if (!["add", "update", "list", "run", "merge", "cleanup"].includes(command) || args.length !== arity) {
    throw new Error("Invalid task command; use midas task --help");
  }
  if (command === "add") {
    // Only an active orchestrator may author tasks; otherwise a plain agent
    // could queue work that no dispatcher will ever run.
    if (!board.hasActiveDispatcher()) throw new Error("No active orchestrator: enable /multitask before adding tasks.");
    process.stdout.write(JSON.stringify(board.add(JSON.parse(readFileSync(value!, "utf8"))), null, 2) + "\n");
  }
  if (command === "update") {
    if (!board.hasActiveDispatcher()) throw new Error("No active orchestrator: enable /multitask before updating tasks.");
    process.stdout.write(JSON.stringify(board.edit(value!, JSON.parse(readFileSync(extra!, "utf8"))), null, 2) + "\n");
  }
  if (command === "list") process.stdout.write(JSON.stringify(board.read(), null, 2) + "\n");
  if (command === "run") await runTask(board, value!);
  if (command === "merge") await mergeTask(board, value!);
  if (command === "cleanup") await cleanupTask(board, value!);
}
