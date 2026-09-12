import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface Contract {
  title: string;
  group?: string;
  instructions: string;
  checks: string[];
  dependencies?: string[];
}
export interface Attempt {
  id: string;
  worktree: string;
  branch: string;
  base: string;
  session?: string;
  result?: string;
  checkedTree?: string;
  checkedAt?: string;
  cleaned?: boolean;
}
export interface Task extends Contract {
  id: string;
  status: "new" | "running" | "completed" | "blocked";
  merge: "not-merged" | "integrating" | "merged" | "failed";
  target: string;
  attempts: Attempt[];
  detail?: string;
  mergedCommit?: string;
}
export interface Board { version: 1; tasks: Task[] }

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Local-filesystem board shared by linked worktrees. Corrupt data is never reset. */
export class TaskBoard {
  readonly directory: string;
  constructor(readonly cwd: string) {
    this.directory = join(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"), "midas");
  }
  read(): Board {
    let raw: string;
    try { raw = readFileSync(join(this.directory, "board.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [] }; throw error; }
    const board = JSON.parse(raw) as Board;
    if (board.version !== 1 || !Array.isArray(board.tasks)) throw new Error("Unsupported or corrupt Midas task board");
    return board;
  }
  lock(name: string): () => void {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error("Invalid lock name");
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${name}.lock`);
    try { mkdirSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Operation locked: ${path}. If interrupted, stop its worker and check processes before manually removing this lock.`);
    }
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() }));
    return () => rmSync(path, { recursive: true });
  }
  /**
   * Dispatcher lease. Unlike the fail-closed operation locks, a stale lease is
   * taken over once its heartbeat expires, so a crashed dispatcher recovers.
   * Task-level locks stay fail-closed; this only elects a leader.
   */
  lease(name: string, ttlMs: number): () => void {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error("Invalid lease name");
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${name}.lock`);
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let heartbeat = 0;
      try { heartbeat = Number(JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).heartbeat) || 0; } catch { /* treat as stale */ }
      if (Date.now() - heartbeat < ttlMs) throw new Error(`Another dispatcher is already running (${path})`);
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path);
    }
    const write = (): void => writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), heartbeat: Date.now() }));
    write();
    const timer = setInterval(write, Math.max(500, Math.floor(ttlMs / 3)));
    timer.unref?.();
    return () => { clearInterval(timer); rmSync(path, { recursive: true, force: true }); };
  }

  mutate<T>(fn: (board: Board) => T): T {
    const unlock = this.lock("board");
    let temp: string | undefined;
    try {
      const board = this.read();
      const result = fn(board);
      temp = join(this.directory, `${randomUUID()}.tmp`);
      writeFileSync(temp, JSON.stringify(board, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, join(this.directory, "board.json"));
      return result;
    } finally { if (temp) rmSync(temp, { force: true }); unlock(); }
  }
  get(id: string): Task {
    const task = this.read().tasks.find((task) => task.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }
  update(id: string, fn: (task: Task) => void): void {
    this.mutate((board) => {
      const task = board.tasks.find((task) => task.id === id);
      if (!task) throw new Error(`Unknown task: ${id}`);
      fn(task);
    });
  }
  add(input: unknown): Task {
    const c = input as Contract;
    if (!c || typeof c.title !== "string" || !c.title.trim() || typeof c.instructions !== "string" || !c.instructions.trim()
      || !Array.isArray(c.checks) || !c.checks.length || c.checks.some((v) => typeof v !== "string" || !v.trim())
      || (c.group !== undefined && typeof c.group !== "string")
      || (c.dependencies !== undefined && (!Array.isArray(c.dependencies) || c.dependencies.some((v) => typeof v !== "string")))) {
      throw new Error("Contract requires title, instructions, nonempty checks[], and optional group/dependencies[]");
    }
    return this.mutate((board) => {
      for (const id of c.dependencies ?? []) if (!board.tasks.some((t) => t.id === id)) throw new Error(`Unknown dependency: ${id}`);
      const task: Task = { title: c.title, instructions: c.instructions, checks: [...c.checks], group: c.group,
        dependencies: [...(c.dependencies ?? [])], id: `T${board.tasks.length + 1}`, status: "new", merge: "not-merged",
        target: "midas/integration", attempts: [] };
      board.tasks.push(task);
      return task;
    });
  }
  prepare(id: string): Attempt {
    const task = this.get(id);
    if (task.status !== "new" && task.status !== "blocked") throw new Error(`Task is ${task.status}; cannot run`);
    for (const dep of task.dependencies ?? []) {
      const prerequisite = this.get(dep);
      if (prerequisite.merge !== "merged" || prerequisite.target !== task.target) throw new Error(`Waiting on ${dep} to merge`);
    }
    const unlock = this.lock("integration");
    try {
      let base: string;
      try { base = git(this.cwd, "rev-parse", "--verify", `refs/heads/${task.target}`); }
      catch { git(this.cwd, "branch", task.target, "HEAD"); base = git(this.cwd, "rev-parse", `refs/heads/${task.target}`); }
      for (const dep of task.dependencies ?? []) git(this.cwd, "merge-base", "--is-ancestor", this.get(dep).mergedCommit!, base);
      const attemptId = `${id}-${randomUUID().slice(0, 8)}`;
      const attempt: Attempt = { id: attemptId, base, branch: `midas/task-${attemptId}`, worktree: resolve(this.directory, "worktrees", attemptId) };
      this.update(id, (t) => { t.status = "running"; t.detail = "Provisioning worktree"; t.attempts.push(attempt); });
      mkdirSync(join(this.directory, "worktrees"), { recursive: true });
      git(this.cwd, "worktree", "add", "-b", attempt.branch, attempt.worktree, base);
      return attempt;
    } finally { unlock(); }
  }
}
