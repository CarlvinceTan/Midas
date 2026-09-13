import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard, git } from "./board.ts";
import { runTask, mergeTask } from "./runner.ts";
import { promoteIntegration } from "./promote.ts";

// Identity for disposable fixture commits only; never modifies Git configuration.
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Midas tests";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "tests@example.invalid";

function fixture(t: { after(fn: () => void): void }): { cwd: string; board: TaskBoard } {
  const cwd = mkdtempSync(join(tmpdir(), "midas-promote-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  writeFileSync(join(cwd, "base.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "fixture");
  return { cwd, board: new TaskBoard(cwd) };
}

const contract = { title: "Implement feature", instructions: "Add result.txt", checks: ["test -f result.txt"] };

async function complete(board: TaskBoard, id: string, file: string, content: string): Promise<void> {
  await runTask(board, id, async (_, attempt) => writeFileSync(join(attempt.worktree, file), content));
  await mergeTask(board, id);
}

test("promotion fast-forwards the checked-out branch onto integrated work", async (t) => {
  const { cwd, board } = fixture(t);
  const task = board.add(contract);
  await complete(board, task.id, "result.txt", "done\n");
  const result = await promoteIntegration(board);
  assert.equal(result.status, "promoted");
  assert.equal(result.branch, "main");
  assert.equal(git(cwd, "show", "main:result.txt"), "done");
  // Nothing left to promote on the next pass.
  assert.equal((await promoteIntegration(board)).status, "current");
});

test("promotion defers on a dirty working tree and leaves HEAD untouched", async (t) => {
  const { cwd, board } = fixture(t);
  const task = board.add(contract);
  await complete(board, task.id, "result.txt", "done\n");
  const head = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "base.txt"), "user wip\n");
  const result = await promoteIntegration(board);
  assert.equal(result.status, "dirty");
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "show", "midas/integration:result.txt"), "done");
  assert.equal(readFileSync(join(cwd, "base.txt"), "utf8"), "user wip\n");
});

test("a conflicted promotion is aborted and leaves the branch unchanged", async (t) => {
  const { cwd, board } = fixture(t);
  const task = board.add({ ...contract, checks: ["true"] });
  await runTask(board, task.id, async (_, attempt) => writeFileSync(join(attempt.worktree, "base.txt"), "task\n"));
  await mergeTask(board, task.id);
  // The user commits a competing edit on the checked-out branch.
  writeFileSync(join(cwd, "base.txt"), "user\n");
  git(cwd, "commit", "-am", "user change");
  const head = git(cwd, "rev-parse", "HEAD");
  const result = await promoteIntegration(board);
  assert.equal(result.status, "conflict");
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(cwd, "base.txt"), "utf8"), "user\n");
});

test("promotion is blocked while a merge is already in progress", async (t) => {
  const { cwd, board } = fixture(t);
  const task = board.add(contract);
  await complete(board, task.id, "result.txt", "done\n");
  writeFileSync(join(cwd, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
  assert.equal((await promoteIntegration(board)).status, "blocked");
});

test("promotion is skipped on a detached HEAD or without an integration branch", async (t) => {
  const { cwd, board } = fixture(t);
  assert.equal((await promoteIntegration(board)).status, "skipped");
  git(cwd, "checkout", "--detach");
  assert.equal((await promoteIntegration(board)).status, "skipped");
});
