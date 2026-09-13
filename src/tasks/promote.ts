import { existsSync } from "node:fs";
import { INTEGRATION_BRANCH, gitAsync, type TaskBoard } from "./board.ts";

export type PromotionStatus = "promoted" | "current" | "dirty" | "conflict" | "blocked" | "skipped";

export interface PromotionResult {
  status: PromotionStatus;
  /** Branch checked out in the primary worktree when promotion ran. */
  branch?: string;
  /** HEAD before/after a successful merge (short-lived internal detail). */
  before?: string;
  after?: string;
  detail?: string;
}

/**
 * Best-effort: merge the integration tip into whatever branch is checked out in
 * the primary worktree (where the TUI runs). This is the step that makes finished
 * board work show up on the user's branch, like Cursor keeping the working branch
 * current.
 *
 * Safety: this never runs checks (integration already validated in its own clean
 * worktree), never stashes, and never resolves conflicts. It only operates when
 * the worktree has no tracked modifications and no merge/rebase is in progress;
 * a conflicted merge is aborted so the user's tree is restored.
 */
export async function promoteIntegration(board: TaskBoard): Promise<PromotionResult> {
  const cwd = board.cwd;
  let branch: string;
  try {
    branch = await gitAsync(cwd, "symbolic-ref", "-q", "--short", "HEAD");
  } catch {
    return { status: "skipped", detail: "detached HEAD" };
  }
  if (!branch) return { status: "skipped", detail: "detached HEAD" };
  // Integration is a staging ref, never promoted onto itself.
  if (branch === INTEGRATION_BRANCH || branch.startsWith(`${INTEGRATION_BRANCH}/`)) {
    return { status: "skipped", branch, detail: "integration branch is checked out" };
  }
  if (await operationInProgress(cwd)) {
    return { status: "blocked", branch, detail: "a merge or rebase is already in progress" };
  }
  // Tracked-only: a stray untracked artifact must not permanently disable
  // promotion, and Git itself still refuses if the merge would overwrite one.
  if (await gitAsync(cwd, "status", "--porcelain", "--untracked-files=no")) {
    return { status: "dirty", branch, detail: "uncommitted changes in the working tree" };
  }
  let integration: string;
  try {
    integration = await gitAsync(cwd, "rev-parse", "--verify", `refs/heads/${INTEGRATION_BRANCH}`);
  } catch {
    return { status: "skipped", branch, detail: "no integration branch yet" };
  }
  try {
    await gitAsync(cwd, "merge-base", "--is-ancestor", integration, "HEAD");
    return { status: "current", branch };
  } catch {
    // Integration has commits the checked-out branch does not.
  }
  const before = await gitAsync(cwd, "rev-parse", "HEAD");
  try {
    // A plain merge: fast-forwards when the branch has not diverged, otherwise
    // makes exactly one merge commit. `--ff-only` would silently stop updating
    // as soon as the user commits anything.
    await gitAsync(cwd, "merge", "--no-edit", integration);
  } catch (error) {
    return { status: await recover(cwd, error, before), branch, before, detail: failureMessage(error) };
  }
  const after = await gitAsync(cwd, "rev-parse", "HEAD");
  if (after === before) return { status: "current", branch };
  return { status: "promoted", branch, before, after };
}

/** A failed merge either conflicts (MERGE_HEAD, recoverable) or never started. */
async function recover(cwd: string, error: unknown, before: string): Promise<PromotionStatus> {
  let conflicted = false;
  try {
    conflicted = existsSync(await gitPath(cwd, "MERGE_HEAD"));
  } catch {
    // Fall through to the conservative check below.
  }
  if (conflicted) await gitAsync(cwd, "merge", "--abort").catch(() => undefined);
  const after = await gitAsync(cwd, "rev-parse", "HEAD").catch(() => before);
  if (conflicted || after !== before) return "conflict";
  return "blocked";
}

async function operationInProgress(cwd: string): Promise<boolean> {
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    try {
      if (existsSync(await gitPath(cwd, name))) return true;
    } catch {
      // A missing git path never blocks promotion.
    }
  }
  return false;
}

function gitPath(cwd: string, name: string): Promise<string> {
  return gitAsync(cwd, "rev-parse", "--path-format=absolute", "--git-path", name);
}

function failureMessage(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr;
  const text = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
  return (text.trim() || (error instanceof Error ? error.message : String(error))).split("\n")[0]!;
}
