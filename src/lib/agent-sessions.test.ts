import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadAgentSessions, readAgentTranscript } from "./agent-sessions.ts";
import { readMidasSessions, upsertMidasSession } from "./session-store.ts";

function writeJsonl(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

interface SavedEnv {
  CLAUDE_CONFIG_DIR: string | undefined;
  CODEX_HOME: string | undefined;
  PI_CONFIG_DIR: string | undefined;
  MIDAS_CONFIG_DIR: string | undefined;
  CURSOR_HOME: string | undefined;
  GEMINI_HOME: string | undefined;
  HERMES_HOME: string | undefined;
  DSH_HOME: string | undefined;
  CODEX_PROJECTLESS_DIR: string | undefined;
}

function saveEnv(): SavedEnv {
  return {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    MIDAS_CONFIG_DIR: process.env.MIDAS_CONFIG_DIR,
    CURSOR_HOME: process.env.CURSOR_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    DSH_HOME: process.env.DSH_HOME,
    CODEX_PROJECTLESS_DIR: process.env.CODEX_PROJECTLESS_DIR,
  };
}

function restoreEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("loadAgentSessions merges the Claude, Codex, Pi and Midas stores", async () => {
  const root = mkdtempSync(join(tmpdir(), "midas-sessions-"));
  const saved = saveEnv();
  try {
    const claudeProject = join(root, "projects", "Polymux");
    const codexProject = join(root, "projects", "FlareAI");
    const codexArchivedProject = join(root, "projects", "OldCodex");
    const piProject = join(root, "projects", "PiProject");
    const midasProject = join(root, "projects", "MidasProject");
    const cursorProject = join(root, "projects", "CursorProject");
    const geminiProject = join(root, "projects", "GeminiProject");
    const dshProject = join(root, "projects", "DshProject");
    const hermesProject = join(root, "projects", "HermesProject");
    for (const directory of [claudeProject, codexProject, codexArchivedProject, piProject, midasProject, cursorProject, geminiProject, dshProject, hermesProject]) {
      mkdirSync(directory, { recursive: true });
    }

    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    writeJsonl(join(root, "claude", "projects", "-tmp-Polymux", "claude-1.jsonl"), [
      { type: "queue-operation", operation: "enqueue", sessionId: "claude-1", content: "Claude session title" },
      { type: "user", sessionId: "claude-1", cwd: claudeProject, message: { role: "user", content: "Claude session title" } },
    ]);

    process.env.CODEX_HOME = join(root, "codex");
    writeJsonl(join(root, "codex", "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-codex-1.jsonl"), [
      { type: "session_meta", payload: { session_id: "codex-1", cwd: codexProject, timestamp: "2026-01-02T00:00:00Z" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex transcript line" }] } },
    ]);
    // Older rollouts live flat in archived_sessions/ and must still be found.
    writeJsonl(join(root, "codex", "archived_sessions", "rollout-2025-12-01T00-00-00-codex-2.jsonl"), [
      { type: "session_meta", payload: { session_id: "codex-2", cwd: codexArchivedProject, timestamp: "2025-12-01T00:00:00Z" } },
    ]);
    writeJsonl(join(root, "codex", "session_index.jsonl"), [
      { id: "codex-1", thread_name: "Codex session title", updated_at: "2026-01-02T01:00:00Z" },
      { id: "codex-2", thread_name: "Archived codex title", updated_at: "2025-12-01T01:00:00Z" },
    ]);
    // Sessions without a real project live under the projectless root.
    const projectlessRoot = join(root, "Documents", "Codex");
    mkdirSync(projectlessRoot, { recursive: true });
    process.env.CODEX_PROJECTLESS_DIR = projectlessRoot;
    writeJsonl(join(root, "codex", "archived_sessions", "rollout-2026-01-05T00-00-00-codex-3.jsonl"), [
      { type: "session_meta", payload: { session_id: "codex-3", cwd: join(projectlessRoot, "2026-01-05", "one-off"), timestamp: "2026-01-05T00:00:00Z" } },
    ]);

    process.env.PI_CONFIG_DIR = join(root, "pi");
    writeJsonl(join(root, "pi", "agent", "sessions", "-tmp-PiProject", "2026-01-02T00-00-00_pi-1.jsonl"), [
      { type: "session", version: 3, id: "pi-1", timestamp: "2026-01-02T00:00:00Z", cwd: piProject },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Pi session title" }] } },
    ]);

    process.env.MIDAS_CONFIG_DIR = join(root, "midas");
    mkdirSync(join(root, "midas"), { recursive: true });
    writeFileSync(
      join(root, "midas", "sessions.json"),
      JSON.stringify({ "midas-1": { id: "midas-1", cwd: midasProject, title: "Midas session title", createdAt: 1, updatedAt: 2 } }),
    );

    process.env.CURSOR_HOME = join(root, "cursor");
    const cursorMeta = join(root, "cursor", "acp-sessions", "cursor-1", "meta.json");
    mkdirSync(dirname(cursorMeta), { recursive: true });
    writeFileSync(cursorMeta, JSON.stringify({ schemaVersion: 1, cwd: cursorProject }));

    process.env.GEMINI_HOME = join(root, "gemini");
    const geminiSlug = join(root, "gemini", "tmp", "gemini-slug");
    mkdirSync(join(geminiSlug, "chats"), { recursive: true });
    writeFileSync(join(geminiSlug, ".project_root"), geminiProject);
    writeJsonl(join(geminiSlug, "chats", "session-2026-01-04T00-00-gemini-1.jsonl"), [
      { sessionId: "gemini-1", startTime: "2026-01-04T00:00:00Z", lastUpdated: "2026-01-04T01:00:00Z" },
      { $set: { messages: [{ type: "user", content: [{ text: "<session_context>\nctx\n</session_context>Gemini session title" }] }] } },
    ]);

    process.env.DSH_HOME = join(root, "dsh");
    writeJsonl(join(root, "dsh", "sessions", "--tmp-DSHProject--", "dsh-1", "session.v3.jsonl"), [
      { type: "session", version: 3, id: "dsh-1", createdAt: 1_767_225_600_000, cwd: dshProject },
    ]);

    process.env.HERMES_HOME = join(root, "hermes");
    mkdirSync(join(root, "hermes"), { recursive: true });
    const warning = process.emitWarning;
    process.emitWarning = () => {};
    try {
      const sqlite = await import("node:sqlite");
      const db = new sqlite.DatabaseSync(join(root, "hermes", "state.db"));
      db.exec("create table sessions (id text primary key, cwd text, started_at real)");
      db.exec("create table messages (session_id text, role text, content text, timestamp real)");
      db.prepare("insert into sessions values (?, ?, ?)").run("hermes-1", hermesProject, 1_767_225_600);
      db.prepare("insert into messages values (?, ?, ?, ?)").run("hermes-1", "user", "Hermes session title", 1_767_225_600);
      db.close();
    } finally {
      process.emitWarning = warning;
    }

    const sessions = await loadAgentSessions();
    const byAgent = new Map(sessions.map((session) => [session.agent, session]));
    assert.equal(byAgent.get("claude")?.projectDir, claudeProject);
    assert.equal(byAgent.get("claude")?.title, "Claude session title");
    const codexSessions = sessions.filter((session) => session.agent === "codex");
    assert.deepEqual(
      codexSessions.map((session) => session.id).sort(),
      ["codex-1", "codex-2", "codex-3"],
    );
    assert.equal(codexSessions.find((session) => session.id === "codex-1")?.title, "Codex session title");
    assert.equal(codexSessions.find((session) => session.id === "codex-1")?.projectDir, codexProject);
    assert.equal(codexSessions.find((session) => session.id === "codex-2")?.title, "Archived codex title");
    assert.equal(codexSessions.find((session) => session.id === "codex-2")?.projectDir, codexArchivedProject);
    const projectless = codexSessions.find((session) => session.id === "codex-3");
    assert.equal(projectless?.groupKey, projectlessRoot);
    assert.equal(projectless?.groupLabel, "Other");
    // The real cwd is retained so resuming still runs in the right directory.
    assert.equal(projectless?.projectDir, join(projectlessRoot, "2026-01-05", "one-off"));
    assert.equal(byAgent.get("pi")?.projectDir, piProject);
    assert.equal(byAgent.get("pi")?.title, "Pi session title");
    assert.equal(byAgent.get("midas")?.projectDir, midasProject);
    assert.equal(byAgent.get("midas")?.title, "Midas session title");

    const cursorSessions = sessions.filter((session) => session.agent === "cursor");
    assert.equal(cursorSessions[0]?.id, "cursor-1");
    assert.equal(cursorSessions[0]?.projectDir, cursorProject);

    const geminiSessions = sessions.filter((session) => session.agent === "gemini");
    assert.equal(geminiSessions[0]?.id, "gemini-1");
    assert.equal(geminiSessions[0]?.projectDir, geminiProject);
    assert.equal(geminiSessions[0]?.title, "Gemini session title");

    const dshSessions = sessions.filter((session) => session.agent === "dsh");
    assert.equal(dshSessions[0]?.id, "dsh-1");
    assert.equal(dshSessions[0]?.projectDir, dshProject);

    const hermesSessions = sessions.filter((session) => session.agent === "hermes");
    assert.equal(hermesSessions[0]?.id, "hermes-1");
    assert.equal(hermesSessions[0]?.projectDir, hermesProject);
    assert.equal(hermesSessions[0]?.title, "Hermes session title");

    // Transcripts can be re-read so Midas can continue a foreign session.
    assert.match(await readAgentTranscript(byAgent.get("claude")!), /Claude session title/);
    assert.match(await readAgentTranscript(byAgent.get("pi")!), /Pi session title/);
    assert.match(await readAgentTranscript(codexSessions.find((session) => session.id === "codex-1")!), /Codex transcript line/);
    assert.match(await readAgentTranscript(geminiSessions[0]!), /Gemini session title/);
    assert.match(await readAgentTranscript(hermesSessions[0]!), /Hermes session title/);

    // Sessions whose project directory has been deleted are dropped.
    rmSync(piProject, { recursive: true, force: true });
    const afterDelete = await loadAgentSessions();
    assert.equal(afterDelete.some((session) => session.agent === "pi"), false);
  } finally {
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertMidasSession owns its registry and keeps a real title", () => {
  const root = mkdtempSync(join(tmpdir(), "midas-store-"));
  const saved = saveEnv();
  try {
    process.env.MIDAS_CONFIG_DIR = join(root, "midas");
    upsertMidasSession({ id: "s1", cwd: "/tmp/project", title: "Real title" });
    upsertMidasSession({ id: "s1", cwd: "/tmp/project", title: "New session" });
    const sessions = readMidasSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, "Real title");
    assert.equal(sessions[0]?.cwd, "/tmp/project");

    // An explicit empty title clears the stale one (untitled resumed session).
    upsertMidasSession({ id: "s1", cwd: "/tmp/project", title: "" });
    assert.equal(readMidasSessions()[0]?.title, "");
  } finally {
    restoreEnv(saved);
    rmSync(root, { recursive: true, force: true });
  }
});
