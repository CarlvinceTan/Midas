import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Session } from "@opencode-ai/sdk";
import { TaskBoard, gitAsync, type Task, type Attempt } from "./board.ts";
import { startServer } from "../opencode/server.ts";
import { midasConfigFile } from "../config/pi.ts";
import { BOARD_WORKER_AGENT } from "../lib/agents.ts";

async function checks(task: Task, cwd: string): Promise<void> {
  for (const command of task.checks) {
    process.stdout.write(`Check: ${command}\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", command], { cwd, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Check failed (${code ?? signal}): ${command}`)));
    });
  }
}

/** Steer text sent to a running worker when its task contract changes. */
export function revisionNotice(task: Task): string {
  return `Task ${task.id} was updated while you were working. Re-read its contract from the board (\`midas task list\`) and adjust your work to match.\n\nUpdated title: ${task.title}\nUpdated instructions:\n${task.instructions}`;
}

export type Worker = (task: Task, attempt: Attempt, onSession: (id: string) => void, signal?: AbortSignal, onRevision?: (cb: (task: Task) => void) => void) => Promise<void>;
const worker: Worker = async (task, attempt, onSession, signal, onRevision) => {
  const server = await startServer({ cwd: attempt.worktree, configFile: midasConfigFile(attempt.worktree) });
  let session: Session | undefined;
  const abort = new AbortController();
  if (signal) {
    if (signal.aborted) abort.abort(signal.reason);
    else signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
  }
  const timeout = setTimeout(() => abort.abort(new Error("Worker exceeded 60 minutes")), 60 * 60_000);
  try {
    session = await server.client.session.create({ query: { directory: attempt.worktree }, body: { title: `${task.id}: ${task.title}` } }) as unknown as Session;
    if (!session?.id) throw new Error("Backend did not create a worker session");
    onSession(session.id);
    // An edited contract is steered into the live worker so it can re-review and
    // adapt instead of finishing against a stale brief.
    onRevision?.((updated) => {
      if (!session || abort.signal.aborted) return;
      void server.client.session.prompt({
        path: { id: session.id }, query: { directory: attempt.worktree }, signal: abort.signal,
        body: { agent: BOARD_WORKER_AGENT, parts: [{ type: "text", text: revisionNotice(updated) }] },
      }).catch(() => undefined);
    });
    const events = await server.client.event.subscribe({ signal: abort.signal });
    void (async () => {
      for await (const event of events.stream) {
        if (event.type === "permission.updated" || (event as { type: string }).type === "question.asked") abort.abort(new Error("Worker needs interactive input; inspect its session before retrying"));
      }
      if (!abort.signal.aborted) abort.abort(new Error("Worker event stream closed"));
    })().catch((error) => { if (!abort.signal.aborted) abort.abort(error); });
    const result = await server.client.session.prompt({ path: { id: session.id }, query: { directory: attempt.worktree }, signal: abort.signal,
      body: { agent: BOARD_WORKER_AGENT, parts: [{ type: "text", text: `Execute only this task in ${attempt.worktree}. Do not commit, change branches, merge, or edit the board. The controller owns Git and validation. Finish your final response with MIDAS_TASK_DONE only if the task is fully implemented; otherwise explain the blocker.\n\n${task.title}\n${task.instructions}\n\nRequired checks:\n${task.checks.join("\n")}` }] },
    }) as unknown as { info?: { error?: unknown }; parts?: Array<{ type: string; text?: string }> };
    if (result.info?.error) throw new Error(`Worker failed: ${JSON.stringify(result.info.error)}`);
    const text = (result.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    process.stdout.write(text + "\n");
    if (!text.trim().endsWith("MIDAS_TASK_DONE")) throw new Error("Worker did not report completion");
  } finally {
    clearTimeout(timeout);
    abort.abort();
    if (session) await server.client.session.abort({ path: { id: session.id }, query: { directory: attempt.worktree }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    if (server.proc.exitCode === null && server.proc.signalCode === null) {
      const exited = once(server.proc, "exit");
      server.close();
      const kill = setTimeout(() => server.proc.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(kill); }
    }
  }
};

export interface RunOptions {
  /** How often to poll for contract edits to steer into the worker. Default 2s. */
  revisionPollMs?: number;
}

export async function runTask(board: TaskBoard, id: string, execute: Worker = worker, signal?: AbortSignal, options: RunOptions = {}): Promise<void> {
  board.get(id);
  const unlock = board.lock(`task-${id}`);
  const previousAttempts = board.get(id).attempts.length;
  let lastRevision = board.get(id).revision ?? 1;
  let notifyRevision: ((task: Task) => void) | undefined;
  const watcher = setInterval(() => {
    if (!notifyRevision) return;
    try {
      const latest = board.get(id);
      const revision = latest.revision ?? 1;
      if (revision !== lastRevision) { lastRevision = revision; notifyRevision(latest); }
    } catch { /* task removed; ignore */ }
  }, options.revisionPollMs ?? 2000);
  watcher.unref?.();
  try {
    const attempt = await board.prepare(id);
    const task = board.get(id);
    board.update(id, (t) => { t.detail = "Worker running"; });
    await execute(task, attempt, (session) => board.update(id, (t) => { t.attempts.at(-1)!.session = session; }), signal, (cb) => { notifyRevision = cb; });
    await assertHead(attempt);
    board.update(id, (t) => { t.detail = "Validating"; });
    const tree = await snapshot(attempt.worktree);
    await checks(task, attempt.worktree);
    await assertHead(attempt);
    if (await snapshot(attempt.worktree) !== tree) throw new Error("Checks modified task files; refusing to checkpoint unvalidated changes");
    if (await gitAsync(attempt.worktree, "diff", "--cached", "--name-only")) {
      await gitAsync(attempt.worktree, "commit", "-m", `${id}: ${task.title}`);
    }
    if (await gitAsync(attempt.worktree, "status", "--porcelain")) throw new Error("Worktree changed during commit; inspect before retrying");
    const result = await gitAsync(attempt.worktree, "rev-parse", "HEAD");
    if (await gitAsync(attempt.worktree, "rev-parse", "HEAD^{tree}") !== tree) throw new Error("Commit hooks changed validated content");
    board.update(id, (t) => {
      t.status = "completed"; t.detail = "Checks passed";
      Object.assign(t.attempts.at(-1)!, { result, checkedTree: tree, checkedAt: new Date().toISOString() });
    });
  } catch (error) {
    const current = board.get(id);
    // A pause/cancel request is not a failure: record the intended state.
    if (current.requestedAction === "pause") {
      board.update(id, (t) => { t.status = "paused"; t.requestedAction = undefined; t.detail = "Paused"; });
      return;
    }
    if (current.requestedAction === "cancel") {
      board.update(id, (t) => { t.status = "cancelled"; t.requestedAction = undefined; t.detail = "Cancelled"; });
      return;
    }
    if (current.attempts.length > previousAttempts) board.update(id, (t) => { t.status = "blocked"; t.detail = String(error); });
    throw error;
  } finally { clearInterval(watcher); unlock(); }
}

async function snapshot(cwd: string): Promise<string> {
  await gitAsync(cwd, "add", "--all");
  return gitAsync(cwd, "write-tree");
}

async function assertHead(attempt: Attempt): Promise<void> {
  if (await gitAsync(attempt.worktree, "rev-parse", "HEAD") !== attempt.base || await gitAsync(attempt.worktree, "branch", "--show-current") !== attempt.branch) {
    throw new Error("Worker changed HEAD or branch; refusing automatic checkpoint");
  }
}

export async function mergeTask(board: TaskBoard, id: string): Promise<void> {
  board.get(id);
  const releaseTask = board.lock(`task-${id}`);
  let integrating = false;
  try {
    const task = board.get(id);
    const attempt = task.attempts.at(-1);
    if (task.status !== "completed" || !attempt?.result) throw new Error("Task has no validated result");
    if (task.merge === "merged") return;
    const mergedCommit = attempt.result;
    await board.withIntegration(async () => {
      // Direct merge: the task's branch lands on the branch the user has checked
      // out right now. Defer (do not fail) when that branch isn't checked out or
      // the checkout is busy, so the dispatcher retries on a later tick.
      const current = await gitAsync(board.cwd, "symbolic-ref", "--short", "HEAD");
      if (current !== task.target) return;
      if (await gitAsync(board.cwd, "status", "--porcelain")) return;
      const base = await gitAsync(board.cwd, "rev-parse", "HEAD");
      board.update(id, (t) => { t.merge = "integrating"; t.detail = `Merging into ${task.target}`; });
      integrating = true;
      // Conflicts are never resolved automatically; abort and surface them.
      try {
        await gitAsync(board.cwd, "merge", "--no-edit", "--no-ff", mergedCommit);
      } catch (error) {
        await gitAsync(board.cwd, "merge", "--abort").catch(() => undefined);
        throw new Error(`Merge conflict into ${task.target}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await checks(task, board.cwd);
        if (await gitAsync(board.cwd, "status", "--porcelain")) throw new Error("Integration checks changed files");
        const result = await gitAsync(board.cwd, "rev-parse", "HEAD");
        board.update(id, (t) => { t.merge = "merged"; t.mergedCommit = result; t.detail = `Merged into ${task.target}`; });
      } catch (error) {
        // Checks failed or dirtied the tree: restore the pre-merge state.
        await gitAsync(board.cwd, "reset", "--hard", base).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (integrating && board.get(id).merge !== "merged") board.update(id, (t) => { t.merge = "failed"; t.detail = `${t.detail}\n${String(error)}`; });
    throw error;
  } finally { releaseTask(); }
}

export async function cleanupTask(board: TaskBoard, id: string): Promise<void> {
  board.get(id);
  const unlock = board.lock(`task-${id}`);
  try {
    const task = board.get(id);
    if (task.merge !== "merged") throw new Error("Only merged task worktrees can be cleaned automatically");
    const attempt = task.attempts.at(-1)!;
    if (attempt.cleaned) return;
    if (await gitAsync(attempt.worktree, "status", "--porcelain", "--ignored")) throw new Error("Worktree has local or ignored files; inspect before cleanup");
    if (await gitAsync(attempt.worktree, "rev-parse", "HEAD") !== attempt.result) throw new Error("Worktree HEAD changed after validation");
    await gitAsync(board.cwd, "worktree", "remove", attempt.worktree);
    board.update(id, (t) => { t.attempts.at(-1)!.cleaned = true; });
  } finally { unlock(); }
}
