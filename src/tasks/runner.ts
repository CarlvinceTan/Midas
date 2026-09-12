import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Session } from "@opencode-ai/sdk";
import { TaskBoard, git, type Task, type Attempt } from "./board.ts";
import { startServer } from "../opencode/server.ts";
import { midasConfigFile } from "../config/pi.ts";

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

export type Worker = (task: Task, attempt: Attempt, onSession: (id: string) => void) => Promise<void>;
const worker: Worker = async (task, attempt, onSession) => {
  const server = await startServer({ cwd: attempt.worktree, configFile: midasConfigFile(attempt.worktree) });
  let session: Session | undefined;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("Worker exceeded 60 minutes")), 60 * 60_000);
  try {
    session = await server.client.session.create({ query: { directory: attempt.worktree }, body: { title: `${task.id}: ${task.title}` } }) as unknown as Session;
    if (!session?.id) throw new Error("Backend did not create a worker session");
    onSession(session.id);
    const events = await server.client.event.subscribe({ signal: abort.signal });
    void (async () => {
      for await (const event of events.stream) {
        if (event.type === "permission.updated" || (event as { type: string }).type === "question.asked") abort.abort(new Error("Worker needs interactive input; inspect its session before retrying"));
      }
      if (!abort.signal.aborted) abort.abort(new Error("Worker event stream closed"));
    })().catch((error) => { if (!abort.signal.aborted) abort.abort(error); });
    const result = await server.client.session.prompt({ path: { id: session.id }, query: { directory: attempt.worktree }, signal: abort.signal,
      body: { agent: "task", parts: [{ type: "text", text: `Execute only this task in ${attempt.worktree}. Do not commit, change branches, merge, or edit the board. The controller owns Git and validation. Finish your final response with MIDAS_TASK_DONE only if the task is fully implemented; otherwise explain the blocker.\n\n${task.title}\n${task.instructions}\n\nRequired checks:\n${task.checks.join("\n")}` }] },
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

export async function runTask(board: TaskBoard, id: string, execute: Worker = worker): Promise<void> {
  board.get(id);
  const unlock = board.lock(`task-${id}`);
  const previousAttempts = board.get(id).attempts.length;
  try {
    const attempt = board.prepare(id);
    const task = board.get(id);
    board.update(id, (t) => { t.detail = "Worker running"; });
    await execute(task, attempt, (session) => board.update(id, (t) => { t.attempts.at(-1)!.session = session; }));
    assertHead(attempt);
    board.update(id, (t) => { t.detail = "Validating"; });
    const tree = snapshot(attempt.worktree);
    await checks(task, attempt.worktree);
    assertHead(attempt);
    if (snapshot(attempt.worktree) !== tree) throw new Error("Checks modified task files; refusing to checkpoint unvalidated changes");
    if (git(attempt.worktree, "diff", "--cached", "--name-only")) git(attempt.worktree, "commit", "-m", `${id}: ${task.title}`);
    if (git(attempt.worktree, "status", "--porcelain")) throw new Error("Worktree changed during commit; inspect before retrying");
    const result = git(attempt.worktree, "rev-parse", "HEAD");
    if (git(attempt.worktree, "rev-parse", "HEAD^{tree}") !== tree) throw new Error("Commit hooks changed validated content");
    board.update(id, (t) => {
      t.status = "completed"; t.detail = "Checks passed";
      Object.assign(t.attempts.at(-1)!, { result, checkedTree: tree, checkedAt: new Date().toISOString() });
    });
  } catch (error) {
    if (board.get(id).attempts.length > previousAttempts) board.update(id, (t) => { t.status = "blocked"; t.detail = String(error); });
    throw error;
  } finally { unlock(); }
}

function snapshot(cwd: string): string {
  git(cwd, "add", "--all");
  return git(cwd, "write-tree");
}

function assertHead(attempt: Attempt): void {
  if (git(attempt.worktree, "rev-parse", "HEAD") !== attempt.base || git(attempt.worktree, "branch", "--show-current") !== attempt.branch) {
    throw new Error("Worker changed HEAD or branch; refusing automatic checkpoint");
  }
}

export async function mergeTask(board: TaskBoard, id: string): Promise<void> {
  board.get(id);
  const releaseTask = board.lock(`task-${id}`);
  let releaseMerge: (() => void) | undefined;
  let integrating = false;
  try {
    releaseMerge = board.lock("integration");
    const task = board.get(id);
    const attempt = task.attempts.at(-1);
    if (task.status !== "completed" || !attempt?.result) throw new Error("Task has no validated result");
    if (task.merge === "merged") return;
    const ref = `refs/heads/${task.target}`;
    if (git(board.cwd, "worktree", "list", "--porcelain").split("\n").includes(`branch ${ref}`)) throw new Error("Integration branch is checked out; refusing to move it");
    const base = git(board.cwd, "rev-parse", ref);
    const path = join(board.directory, "integration", randomUUID());
    mkdirSync(join(board.directory, "integration"), { recursive: true });
    board.update(id, (t) => { t.merge = "integrating"; t.detail = `Integration worktree: ${path}`; });
    integrating = true;
    git(board.cwd, "worktree", "add", "--detach", path, base);
    // Failures preserve this tree for inspection; never resolve conflicts automatically.
    git(path, "merge", "--no-edit", "--no-ff", attempt.result);
    const candidate = git(path, "rev-parse", "HEAD");
    await checks(task, path);
    if (git(path, "status", "--porcelain")) throw new Error(`Integration checks changed files: ${path}`);
    const result = git(path, "rev-parse", "HEAD");
    if (result !== candidate) throw new Error("Integration checks changed HEAD");
    if (git(board.cwd, "worktree", "list", "--porcelain").split("\n").includes(`branch ${ref}`)) throw new Error("Integration branch became checked out; refusing to move it");
    git(board.cwd, "update-ref", ref, result, base);
    board.update(id, (t) => { t.merge = "merged"; t.mergedCommit = result; t.detail = `Merged into ${task.target}`; });
    git(board.cwd, "worktree", "remove", path);
  } catch (error) {
    if (integrating && board.get(id).merge !== "merged") board.update(id, (t) => { t.merge = "failed"; t.detail = `${t.detail}\n${String(error)}`; });
    throw error;
  } finally { releaseMerge?.(); releaseTask(); }
}

export function cleanupTask(board: TaskBoard, id: string): void {
  board.get(id);
  const unlock = board.lock(`task-${id}`);
  try {
    const task = board.get(id);
    if (task.merge !== "merged") throw new Error("Only merged task worktrees can be cleaned automatically");
    const attempt = task.attempts.at(-1)!;
    if (attempt.cleaned) return;
    if (git(attempt.worktree, "status", "--porcelain", "--ignored")) throw new Error("Worktree has local or ignored files; inspect before cleanup");
    if (git(attempt.worktree, "rev-parse", "HEAD") !== attempt.result) throw new Error("Worktree HEAD changed after validation");
    git(board.cwd, "worktree", "remove", attempt.worktree);
    board.update(id, (t) => { t.attempts.at(-1)!.cleaned = true; });
  } finally { unlock(); }
}
