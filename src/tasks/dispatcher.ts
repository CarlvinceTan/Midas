import { existsSync } from "node:fs";
import { join } from "node:path";
import { TaskBoard, type Task } from "./board.ts";
import { runTask, mergeTask, cleanupTask, type Worker } from "./runner.ts";

export interface DispatcherOptions {
  /** Maximum tasks running at once. Default 2. */
  concurrency?: number;
  /** Poll interval. Default 5s. */
  intervalMs?: number;
  /** Worker override (tests only). */
  worker?: Worker;
  /** Remove worktrees once merged. Default true. */
  cleanup?: boolean;
  /** Take the cross-process dispatcher lease. Default true. */
  lease?: boolean;
  onEvent?: (message: string) => void;
}

/**
 * Autonomous board runner: picks ready tasks, runs them in isolated worktrees,
 * integrates completed work, and cleans up — one pass per tick. A task runs only
 * when it is `new` and every dependency is merged; failed/blocked tasks are left
 * for a human so the loop cannot retry forever.
 */
export class TaskDispatcher {
  private active = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private release?: () => void;
  private ticking?: Promise<void>;
  private stopped = false;

  constructor(
    private board: TaskBoard,
    private options: DispatcherOptions = {},
  ) {}

  get running(): number {
    return this.active.size;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const interval = this.options.intervalMs ?? 5000;
    if (this.options.lease !== false) this.release = this.board.lease("dispatch", interval * 3);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.release?.();
    this.release = undefined;
  }

  /** Await in-flight runs (used by tests and `--once`). */
  async drain(): Promise<void> {
    // A tick may still be integrating; wait for it before sampling the board.
    await this.ticking;
    await Promise.allSettled([...this.active.values()]);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        this.reconcile();
        await this.integrate();
        this.requestControls();
        this.dispatchReady();
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  /** A `running` task with no live lock was left behind by a crashed process. */
  private reconcile(): void {
    for (const task of this.board.read().tasks) {
      if (task.status !== "running") continue;
      if (existsSync(join(this.board.directory, `task-${task.id}.lock`))) continue;
      this.board.update(task.id, (t) => { t.status = "blocked"; t.detail = "Interrupted before completion. Re-run to retry."; });
      this.options.onEvent?.(`${task.id}: interrupted; marked blocked`);
    }
  }

  private async integrate(): Promise<void> {
    for (const task of this.board.read().tasks) {
      try {
        const latest = this.board.get(task.id);
        if (latest.status === "completed" && latest.merge === "not-merged") {
          await mergeTask(this.board, task.id);
          const after = this.board.get(task.id);
          if (after.merge === "merged") this.options.onEvent?.(`${task.id}: merged into ${after.target}`);
        }
        if (this.options.cleanup !== false) {
          const after = this.board.get(task.id);
          if (after.merge === "merged" && !after.attempts.at(-1)?.cleaned) {
            await cleanupTask(this.board, task.id);
            this.options.onEvent?.(`${task.id}: worktree cleaned`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.onEvent?.(`${task.id}: autonomous step failed — ${message}`);
      }
    }
  }

  private dispatchReady(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.options.concurrency ?? 2);
    const snapshot = this.board.read();
    const merged = (id: string): boolean => snapshot.tasks.find((t) => t.id === id)?.merge === "merged";
    for (const task of snapshot.tasks) {
      if (this.active.size >= limit) break;
      if (task.status !== "new" || this.active.has(task.id)) continue;
      if (!this.ready(task, merged)) continue;
      this.options.onEvent?.(`${task.id}: started`);
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      const promise = runTask(this.board, task.id, this.options.worker, controller.signal)
        .then(() => this.options.onEvent?.(`${task.id}: completed`))
        .catch((error) => this.options.onEvent?.(`${task.id}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.active.delete(task.id);
          this.controllers.delete(task.id);
          void this.tick();
        });
      this.active.set(task.id, promise);
    }
  }

  /** Abort a running worker when its task was asked to pause or cancel. */
  private requestControls(): void {
    for (const [id, controller] of this.controllers) {
      const task = this.board.get(id);
      if (task.requestedAction && !controller.signal.aborted) {
        controller.abort(new Error(`Task ${id} ${task.requestedAction} requested`));
        this.options.onEvent?.(`${id}: ${task.requestedAction} requested`);
      }
    }
  }

  private ready(task: Task, merged: (id: string) => boolean): boolean {
    return (task.dependencies ?? []).every(merged);
  }
}
