import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard, git } from "./board.ts";
import { TaskDispatcher } from "./dispatcher.ts";
import { boardDrained } from "./cli.ts";

// Identity for disposable fixture commits only; never modifies Git configuration.
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Midas tests";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "tests@example.invalid";

function fixture(t: { after(fn: () => void): void }): { cwd: string; board: TaskBoard } {
  const cwd = mkdtempSync(join(tmpdir(), "midas-dispatcher-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  writeFileSync(join(cwd, "base.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "fixture");
  return { cwd, board: new TaskBoard(cwd) };
}

const contract = { title: "Stuck merge", instructions: "noop", checks: ["true"] };

/** Mark a task finished so the dispatcher considers it for integration. */
function complete(board: TaskBoard, id: string): void {
  board.update(id, (task) => { task.status = "completed"; task.detail = "Checks passed"; });
}

test("a stuck pending merge emits one event per reason, not once per tick", async (t) => {
  const { board } = fixture(t);
  const task = board.add(contract);
  complete(board, task.id);
  const events: string[] = [];
  let mergeCalls = 0;
  let now = 0;
  const dispatcher = new TaskDispatcher(board, {
    lease: false,
    cleanup: false,
    now: () => now,
    merge: async (b, id) => {
      mergeCalls += 1;
      b.update(id, (t) => { t.mergeBlocked = "target main is not checked out"; t.detail = "Waiting to merge"; });
    },
    onEvent: (message) => events.push(message),
  });
  // Several ticks with time advancing, so the backoff does retry but not every tick.
  for (let i = 0; i < 6; i++) { await dispatcher.tick(); now += 5000; }
  dispatcher.stop();

  const pending = events.filter((event) => event.includes("merge pending"));
  assert.equal(pending.length, 1, "the unchanged reason is surfaced exactly once");
  assert.equal(pending[0], `${task.id}: merge pending — target main is not checked out`);
  assert.ok(mergeCalls >= 2, "the deferral is retried eventually");
  assert.ok(mergeCalls < 6, "identical deferrals back off instead of retrying every tick");
});

test("a changed pending reason emits again and resets the backoff", async (t) => {
  const { board } = fixture(t);
  const task = board.add(contract);
  complete(board, task.id);
  const events: string[] = [];
  let mergeCalls = 0;
  let now = 0;
  const dispatcher = new TaskDispatcher(board, {
    lease: false,
    cleanup: false,
    now: () => now,
    merge: async (b, id) => {
      mergeCalls += 1;
      const reason = mergeCalls === 1 ? "target main is not checked out" : "local changes would be overwritten: base.txt";
      b.update(id, (t) => { t.mergeBlocked = reason; });
    },
    onEvent: (message) => events.push(message),
  });
  await dispatcher.tick();          // first reason
  now += 5000;
  await dispatcher.tick();          // changed reason -> emit again
  now += 5000;
  await dispatcher.tick();          // unchanged again -> no third event
  dispatcher.stop();

  const pending = events.filter((event) => event.includes("merge pending"));
  assert.equal(pending.length, 2);
  assert.match(pending[0]!, /target main is not checked out/);
  assert.match(pending[1]!, /local changes would be overwritten: base\.txt/);
});

test("a pending merge keeps the board undrained and merges without restarting", async (t) => {
  const { board } = fixture(t);
  const task = board.add(contract);
  complete(board, task.id);
  const events: string[] = [];
  let attempts = 0;
  let now = 0;
  const dispatcher = new TaskDispatcher(board, {
    lease: false,
    cleanup: false,
    now: () => now,
    merge: async (b, id) => {
      attempts += 1;
      if (attempts === 1) b.update(id, (t) => { t.mergeBlocked = "target main is not checked out"; });
      else b.update(id, (t) => { t.merge = "merged"; t.mergeBlocked = undefined; });
    },
    onEvent: (message) => events.push(message),
  });
  await dispatcher.tick();
  assert.equal(boardDrained(board), false, "a completed unmerged task keeps the daemon alive");
  assert.equal(board.get(task.id).merge, "not-merged");

  // Once the blocker clears (here the injected merge succeeds), the same
  // dispatcher instance integrates on its next attempt.
  now += 5000;
  await dispatcher.tick();
  dispatcher.stop();
  assert.equal(board.get(task.id).merge, "merged");
  assert.equal(boardDrained(board), true);
  assert.ok(events.some((event) => /merged into/.test(event)));
});
