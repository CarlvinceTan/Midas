import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard, git } from "./board.ts";

function fixture(t: { after(fn: () => void): void }): { board: TaskBoard } {
  const cwd = mkdtempSync(join(tmpdir(), "midas-board-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  return { board: new TaskBoard(cwd) };
}

/** True when `pid` names a live process (EPERM still means it exists). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A pid we know is dead: a child that already exited and was reaped. */
function deadPid(): number {
  for (let i = 0; i < 5; i++) {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    if (pid && !alive(pid)) return pid;
  }
  throw new Error("could not obtain a dead pid");
}

/** Write a lock directory by hand, as a crashed owner would leave it. */
function plantLock(board: TaskBoard, name: string, owner: unknown): string {
  const path = join(board.directory, `${name}.lock`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
  return path;
}

test("lock recovers a stale lock whose owner died on this host", (t) => {
  const { board } = fixture(t);
  const path = plantLock(board, "board", { pid: deadPid(), host: hostname(), started: "2020-01-01T00:00:00.000Z" });

  const release = board.lock("board");
  const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number };
  assert.equal(owner.pid, process.pid, "the recovering process takes ownership");
  release();
  assert.equal(existsSync(path), false);
});

test("lock stays fail-closed while its owner is alive", (t) => {
  const { board } = fixture(t);
  const path = plantLock(board, "board", { pid: process.pid, host: hostname() });
  assert.throws(() => board.lock("board"), /Operation locked/);
  assert.ok(existsSync(path), "a live owner's lock is left untouched");
  rmSync(path, { recursive: true, force: true });
});

test("lock never recovers a lock owned by a different host", (t) => {
  const { board } = fixture(t);
  const path = plantLock(board, "board", { pid: deadPid(), host: "some-other-host" });
  assert.throws(() => board.lock("board"), /Operation locked/);
  assert.ok(existsSync(path), "a foreign lock is never removed");
  rmSync(path, { recursive: true, force: true });
});

test("lock stays fail-closed when the owner record is missing or malformed", (t) => {
  const { board } = fixture(t);
  const path = join(board.directory, "board.lock");
  mkdirSync(path, { recursive: true });
  assert.throws(() => board.lock("board"), /Operation locked/, "an unprovable owner is not recovered");
  writeFileSync(join(path, "owner.json"), "not json");
  assert.throws(() => board.lock("board"), /Operation locked/);
  rmSync(path, { recursive: true, force: true });
});
