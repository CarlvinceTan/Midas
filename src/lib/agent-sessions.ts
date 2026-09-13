import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { homePath, piConfigDir } from "../config/pi.ts";
import { readMidasSessions } from "./session-store.ts";

/** Coding agents Midas can browse and hand off to. */
export type SessionAgent = "midas" | "claude" | "codex" | "pi" | "cursor" | "gemini" | "hermes" | "dsh";

/**
 * One session discovered from an agent's own store. Midas sessions come from
 * Midas's registry; the rest are read out of each CLI's on-disk session files.
 */
export interface AgentSession {
  id: string;
  agent: SessionAgent;
  /** Absolute project directory the session belongs to. Used as the resume cwd. */
  projectDir: string;
  /** Optional grouping key when several directories should share one project. */
  groupKey?: string;
  /** Display name for that shared group (e.g. "Other"). */
  groupLabel?: string;
  title: string;
  /** Epoch ms of the last known activity. */
  updatedAt: number;
  /** File the session was read from, when its transcript can be re-read. */
  sourcePath?: string;
}

/** Display order in the picker (Midas first, then the other CLIs). */
export const AGENT_ORDER: SessionAgent[] = ["midas", "claude", "codex", "cursor", "pi", "gemini", "hermes", "dsh"];

export const AGENT_LABELS: Record<SessionAgent, string> = {
  midas: "Midas",
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  cursor: "Cursor",
  gemini: "Gemini",
  hermes: "Hermes",
  dsh: "DSH",
};

const MAX_PER_AGENT = 2000;
const FS_CONCURRENCY = 16;

/** Folder name for a project path, e.g. `/Users/x/code/Polymux` -> `Polymux`. */
export function projectLabel(directory: string): string {
  const base = basename(directory.replace(/[/\\]+$/, ""));
  const stripped = base.replace(/^\.+/, "");
  if (!stripped) return homePath(directory);
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function cleanSessionTitle(text: string | undefined, fallback = ""): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;
  return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

interface FileHit {
  path: string;
  mtimeMs: number;
}

function headText(path: string, bytes = 16_384): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore a close race; the read already returned.
      }
    }
  }
}

/** Parse the leading complete JSON lines of a JSONL head. */
function leadingObjects(text: string, max: number): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (objects.length >= max) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed as Record<string, unknown>);
    } catch {
      break; // A truncated final line; stop at the last complete object.
    }
  }
  return objects;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as { type?: string; text?: string };
    if (typeof part.text === "string" && (part.type === "text" || part.type === "input_text" || part.type === "output_text")) {
      parts.push(part.text);
    }
  }
  return parts.join(" ");
}

/** Whether the text looks like an injected wrapper rather than a real prompt. */
function isWrapperText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context") || trimmed.startsWith("<permissions") || trimmed.startsWith("<skills_instructions");
}

async function listFiles(
  root: string,
  maxDepth: number,
  accept: (name: string) => boolean,
  depth = 0,
): Promise<FileHit[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: FileHit[] = [];
  const nextDepth = depth + 1;
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (nextDepth <= maxDepth) hits.push(...(await listFiles(full, maxDepth, accept, nextDepth)));
    } else if (nextDepth <= maxDepth && accept(entry.name)) {
      try {
        const info = await stat(full);
        hits.push({ path: full, mtimeMs: info.mtimeMs });
      } catch {
        // A vanished file is simply skipped.
      }
    }
  }
  return hits;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

function directoryExists(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ── Claude ─────────────────────────────────────────────────────────────
// <config>/projects/<slug>/<sessionId>.jsonl; the first user/queue entry
// carries `cwd`, and its text is the session's opening prompt.

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function parseClaudeFile(file: FileHit): AgentSession | undefined {
  const objects = leadingObjects(headText(file.path), 24);
  let cwd: string | undefined;
  let title = "";
  for (const object of objects) {
    if (!cwd && typeof object.cwd === "string" && object.cwd.startsWith("/")) cwd = object.cwd;
    if (!title && object.type === "summary" && typeof object.summary === "string") title = cleanSessionTitle(object.summary);
    if (!title && object.type === "queue-operation" && typeof object.content === "string") title = cleanSessionTitle(object.content);
    if (!title && object.type === "user" && object.message) {
      title = cleanSessionTitle(messageText((object.message as { content?: unknown }).content));
    }
  }
  if (!cwd) return undefined;
  const id = basename(file.path).replace(/\.jsonl$/, "");
  return { id, agent: "claude", projectDir: cwd, title: title || id, updatedAt: file.mtimeMs, sourcePath: file.path };
}

async function scanClaude(): Promise<AgentSession[]> {
  const files = await listFiles(join(claudeConfigDir(), "projects"), 2, (name) => name.endsWith(".jsonl"));
  const parsed = (await mapLimit(files, FS_CONCURRENCY, async (file) => parseClaudeFile(file))).filter(
    (session): session is AgentSession => Boolean(session),
  );
  return parsed.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Codex ──────────────────────────────────────────────────────────────
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl; the first line is a
// session_meta record with `cwd` and the session id. Titles come from the
// session_index.jsonl the Codex CLI maintains beside the session tree.

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Where Codex drops sessions that had no project directory of their own. */
function codexProjectlessRoot(): string {
  return process.env.CODEX_PROJECTLESS_DIR ?? join(homedir(), "Documents", "Codex");
}

interface CodexIndexEntry {
  title: string;
  updatedAt: number;
}

async function readCodexIndex(path: string): Promise<Map<string, CodexIndexEntry>> {
  const index = new Map<string, CodexIndexEntry>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return index;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id !== "string") continue;
      index.set(parsed.id, {
        title: typeof parsed.thread_name === "string" ? parsed.thread_name : "",
        updatedAt: typeof parsed.updated_at === "string" ? Date.parse(parsed.updated_at) || 0 : 0,
      });
    } catch {
      // A malformed index line is skipped.
    }
  }
  return index;
}

function parseCodexFile(file: FileHit, index: Map<string, CodexIndexEntry>): AgentSession | undefined {
  const head = headText(file.path);
  const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  const id = /"session_id":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  if (!cwd || !id) return undefined;
  const known = index.get(id);
  // Archived rollouts get a fresh mtime when moved, so prefer the index's
  // last-activity time (or the rollout's own timestamp) over file mtime.
  const rolloutTs = /"timestamp":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  const fallbackTs = rolloutTs ? Date.parse(rolloutTs) || 0 : 0;
  // Codex run without a real project lands in ~/Documents/Codex/<date>/<name>;
  // those aren't projects, so they share one "Other" group.
  const projectless = cwd === codexProjectlessRoot() || cwd.startsWith(`${codexProjectlessRoot()}/`);
  return {
    id,
    agent: "codex",
    projectDir: cwd,
    ...(projectless ? { groupKey: codexProjectlessRoot(), groupLabel: "Other" } : {}),
    title: cleanSessionTitle(known?.title, id),
    updatedAt: known?.updatedAt || fallbackTs || file.mtimeMs,
    sourcePath: file.path,
  };
}

async function scanCodex(): Promise<AgentSession[]> {
  const home = codexHome();
  const index = await readCodexIndex(join(home, "session_index.jsonl"));
  const isRollout = (name: string): boolean => name.startsWith("rollout-") && name.endsWith(".jsonl");
  // Codex moves older rollouts into archived_sessions/, which holds the bulk of
  // its history, so both trees have to be scanned.
  const [active, archived] = await Promise.all([
    listFiles(join(home, "sessions"), 4, isRollout),
    listFiles(join(home, "archived_sessions"), 1, isRollout),
  ]);
  const parsed = (await mapLimit([...active, ...archived], FS_CONCURRENCY, async (file) => parseCodexFile(file, index))).filter(
    (session): session is AgentSession => Boolean(session),
  );
  // A session id can have several rollout files (resumes/snapshots); keep the
  // newest copy of each.
  const byId = new Map<string, AgentSession>();
  for (const session of parsed) {
    const existing = byId.get(session.id);
    if (!existing || session.updatedAt > existing.updatedAt) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Pi ─────────────────────────────────────────────────────────────────
// <PI_CONFIG_DIR>/agent/sessions/<slug>/<file>.jsonl; the first line is the
// session header with `id`, `cwd` and `timestamp`.

function parsePiFile(file: FileHit): AgentSession | undefined {
  const objects = leadingObjects(headText(file.path), 24);
  const header = objects.find((object) => object.type === "session");
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  if (!cwd) return undefined;
  const id = typeof header?.id === "string" ? header.id : basename(file.path).replace(/\.jsonl$/, "");
  let title = "";
  for (const object of objects) {
    if (object.type !== "message" || !object.message) continue;
    const message = object.message as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const text = messageText(message.content);
    if (text && !isWrapperText(text)) {
      title = cleanSessionTitle(text);
      break;
    }
  }
  return { id, agent: "pi", projectDir: cwd, title: title || id, updatedAt: file.mtimeMs, sourcePath: file.path };
}

async function scanPi(): Promise<AgentSession[]> {
  const files = await listFiles(join(piConfigDir(), "agent", "sessions"), 2, (name) => name.endsWith(".jsonl"));
  const parsed = (await mapLimit(files, FS_CONCURRENCY, async (file) => parsePiFile(file))).filter(
    (session): session is AgentSession => Boolean(session),
  );
  return parsed.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Cursor ─────────────────────────────────────────────────────────────
// <config>/acp-sessions/<sessionId>/meta.json records the session's cwd.

function cursorHome(): string {
  return process.env.CURSOR_HOME ?? join(homedir(), ".cursor");
}

async function scanCursor(): Promise<AgentSession[]> {
  const root = join(cursorHome(), "acp-sessions");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(root, entry.name, "meta.json");
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { cwd?: unknown };
      const cwd = typeof meta.cwd === "string" ? meta.cwd : "";
      if (!cwd) continue;
      const info = await stat(metaPath);
      sessions.push({
        id: entry.name,
        agent: "cursor",
        projectDir: cwd,
        title: `Cursor ${entry.name.slice(0, 8)}`,
        updatedAt: info.mtimeMs,
      });
    } catch {
      // A session directory without usable metadata is skipped.
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Gemini ─────────────────────────────────────────────────────────────
// ~/.gemini/tmp/<slug>/chats/session-*.jsonl, with the real project path in the
// sibling .project_root and the session header on line 1.

function geminiHome(): string {
  return process.env.GEMINI_HOME ?? join(homedir(), ".gemini");
}

function geminiTitle(text: string): string {
  const match = /"type":"user"[\s\S]{0,4000}?"text":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return "";
  let value = match[1]!
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const contextEnd = value.lastIndexOf("</session_context>");
  if (contextEnd >= 0) value = value.slice(contextEnd + "</session_context>".length);
  return cleanSessionTitle(value);
}

function parseGeminiFile(file: FileHit, projectDir: string): AgentSession | undefined {
  const head = headText(file.path, 65_536);
  const header = leadingObjects(head, 1)[0];
  const id = typeof header?.sessionId === "string" ? header.sessionId : basename(file.path).replace(/\.jsonl$/, "");
  const updatedAt =
    Date.parse(typeof header?.lastUpdated === "string" ? header.lastUpdated : "") ||
    Date.parse(typeof header?.startTime === "string" ? header.startTime : "") ||
    file.mtimeMs;
  return { id, agent: "gemini", projectDir, title: geminiTitle(head) || id, updatedAt, sourcePath: file.path };
}

async function scanGemini(): Promise<AgentSession[]> {
  const root = join(geminiHome(), "tmp");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let projectDir = "";
    try {
      projectDir = (await readFile(join(root, entry.name, ".project_root"), "utf8")).trim();
    } catch {
      continue;
    }
    if (!projectDir) continue;
    const files = await listFiles(join(root, entry.name, "chats"), 1, (name) => name.startsWith("session-") && name.endsWith(".jsonl"));
    const parsed = (await mapLimit(files, FS_CONCURRENCY, async (file) => parseGeminiFile(file, projectDir))).filter(
      (session): session is AgentSession => Boolean(session),
    );
    sessions.push(...parsed);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Hermes ─────────────────────────────────────────────────────────────
// ~/.hermes/state.db (plus per-profile databases) has a sessions table with
// id/cwd/started_at; the first user message makes a reasonable title.

function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | undefined;
let sqliteLoadAttempted = false;

async function loadSqlite(): Promise<SqliteModule | undefined> {
  if (sqliteLoadAttempted) return sqliteModule;
  sqliteLoadAttempted = true;
  const original = process.emitWarning;
  process.emitWarning = () => {};
  try {
    sqliteModule = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    sqliteModule = undefined;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

async function readHermesDb(path: string): Promise<AgentSession[]> {
  const sqlite = await loadSqlite();
  if (!sqlite) return [];
  const original = process.emitWarning;
  process.emitWarning = () => {};
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("select id, cwd, started_at from sessions where cwd is not null and cwd <> ''").all() as Array<{
      id: string;
      cwd: string;
      started_at: number;
    }>;
    return rows.map((row) => {
      let title = row.id;
      try {
        const message = db!
          .prepare("select content from messages where session_id = ? and role = 'user' order by timestamp limit 1")
          .all(row.id) as Array<{ content?: string }>;
        title = cleanSessionTitle(message[0]?.content, row.id) || row.id;
      } catch {
        // A database without the messages table still lists the session.
      }
      return { id: row.id, agent: "hermes" as const, projectDir: row.cwd, title, updatedAt: row.started_at * 1000, sourcePath: path };
    });
  } catch {
    return [];
  } finally {
    process.emitWarning = original;
    try {
      db?.close();
    } catch {
      // Closing a read-only database is best-effort.
    }
  }
}

async function scanHermes(): Promise<AgentSession[]> {
  const home = hermesHome();
  const dbs = [join(home, "state.db")];
  try {
    for (const entry of await readdir(join(home, "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory()) dbs.push(join(home, "profiles", entry.name, "state.db"));
    }
  } catch {
    // No profiles directory.
  }
  const sessions: AgentSession[] = [];
  for (const dbPath of dbs) {
    try {
      if (!statSync(dbPath).isFile()) continue;
    } catch {
      continue;
    }
    sessions.push(...(await readHermesDb(dbPath)));
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── DSH (DeepSeek Harness) ─────────────────────────────────────────────
// ~/.dsh/sessions/<encoded-cwd>/<sessionId>/session*.jsonl(.zstd); the first
// JSON line is the session header with id, cwd and createdAt.

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function parseDshFile(file: FileHit): AgentSession | undefined {
  let text: string;
  if (file.path.endsWith(".zstd")) {
    try {
      text = zstdDecompressSync(readFileSync(file.path)).toString("utf8");
    } catch {
      return undefined;
    }
  } else {
    text = headText(file.path, 65_536);
  }
  const header = leadingObjects(text, 1)[0];
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  const id = typeof header?.id === "string" ? header.id : undefined;
  if (!cwd || !id) return undefined;
  const createdAt = typeof header?.createdAt === "number" ? header.createdAt : file.mtimeMs;
  return { id, agent: "dsh", projectDir: cwd, title: id, updatedAt: createdAt, sourcePath: file.path };
}

async function scanDsh(): Promise<AgentSession[]> {
  const files = await listFiles(join(dshHome(), "sessions"), 3, (name) => /^session.*\.jsonl(\.zstd)?$/.test(name));
  const parsed = files.map(parseDshFile).filter((session): session is AgentSession => Boolean(session));
  return parsed.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT);
}

// ── Midas ──────────────────────────────────────────────────────────────

function midasSessions(): AgentSession[] {
  return readMidasSessions()
    .filter((session) => session.cwd)
    .map((session) => ({
      id: session.id,
      agent: "midas" as const,
      projectDir: session.cwd,
      // Midas owns the registry, so an untitled session shows a friendly
      // placeholder rather than the raw opencode session id.
      title: cleanSessionTitle(session.title, "New session"),
      updatedAt: session.updatedAt,
    }));
}

/**
 * Every session Midas knows how to resume, across its own registry and each
 * known agent store, filtered to projects that still exist on disk.
 */
export async function loadAgentSessions(): Promise<AgentSession[]> {
  const [claude, codex, pi, cursor, gemini, hermes, dsh] = await Promise.all([
    scanClaude(),
    scanCodex(),
    scanPi(),
    scanCursor(),
    scanGemini(),
    scanHermes(),
    scanDsh(),
  ]);
  const seen = new Set<string>();
  const projectExists = new Map<string, boolean>();
  const sessions: AgentSession[] = [];
  for (const session of [...midasSessions(), ...claude, ...codex, ...pi, ...cursor, ...gemini, ...hermes, ...dsh]) {
    const key = `${session.agent}\u0000${session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Grouped sessions are kept when their shared group directory exists.
    const directory = session.groupKey ?? session.projectDir;
    let exists = projectExists.get(directory);
    if (exists === undefined) {
      exists = directoryExists(directory);
      projectExists.set(directory, exists);
    }
    if (exists) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Transcript import ──────────────────────────────────────────────────
// Reading a foreign session's recent messages so a Midas session can continue
// it in place. Each agent stores its transcript differently.

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

const TRANSCRIPT_TAIL_BYTES = 1_048_576;

/** Parse complete JSON lines from the tail of a (possibly large) JSONL file. */
async function tailObjects(path: string, maxObjects = 2000): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    const info = await stat(path);
    if (info.size <= TRANSCRIPT_TAIL_BYTES) {
      text = await readFile(path, "utf8");
    } else {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(TRANSCRIPT_TAIL_BYTES);
        const read = await handle.read(buffer, 0, TRANSCRIPT_TAIL_BYTES, info.size - TRANSCRIPT_TAIL_BYTES);
        text = buffer.subarray(0, read.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }
  // When sliced mid-file, the first line is usually partial; drop it.
  const newline = text.indexOf("\n");
  if (newline >= 0) text = text.slice(newline + 1);
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (objects.length >= maxObjects) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed as Record<string, unknown>);
    } catch {
      // A malformed or truncated line is skipped.
    }
  }
  return objects;
}

function collectTranscriptLines(
  objects: Array<Record<string, unknown>>,
  extract: (object: Record<string, unknown>) => TranscriptLine | undefined,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const object of objects) {
    const line = extract(object);
    if (line) lines.push(line);
  }
  return lines;
}

function claudeTranscriptLine(object: Record<string, unknown>): TranscriptLine | undefined {
  if (object.type !== "user" && object.type !== "assistant") return undefined;
  const message = object.message as { content?: unknown } | undefined;
  const text = messageText(message?.content);
  if (!text || isWrapperText(text)) return undefined;
  return { role: object.type, text };
}

function codexTranscriptLine(object: Record<string, unknown>): TranscriptLine | undefined {
  if (object.type !== "response_item") return undefined;
  const payload = object.payload as { type?: string; role?: string; content?: unknown } | undefined;
  if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) return undefined;
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const text = parts
    .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""))
    .join(" ");
  if (!text || isWrapperText(text)) return undefined;
  return { role: payload.role, text };
}

function piTranscriptLine(object: Record<string, unknown>): TranscriptLine | undefined {
  if (object.type !== "message") return undefined;
  const message = object.message as { role?: string; content?: unknown } | undefined;
  if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const text = messageText(message.content);
  if (!text || isWrapperText(text)) return undefined;
  return { role: message.role, text };
}

/** Gemini stores content as `[{ text }]` without a `type` discriminator. */
function geminiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""))
    .join(" ");
}

function geminiTranscriptLines(object: Record<string, unknown>): TranscriptLine[] {
  const messages = (object.$set as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return [];
  const lines: TranscriptLine[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { type?: string; role?: string; content?: unknown };
    const kind = message.type ?? message.role;
    const role = kind === "user" ? "user" : kind === "model" || kind === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    let text = geminiText(message.content);
    const contextEnd = text.lastIndexOf("</session_context>");
    if (contextEnd >= 0) text = text.slice(contextEnd + "</session_context>".length);
    if (!text) continue;
    lines.push({ role, text });
  }
  return lines;
}

/** Keep the most recent messages that fit the character budget. */
function formatTranscript(lines: TranscriptLine[], maxChars: number): string {
  const kept: TranscriptLine[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const text = line.text.replace(/\s+\n/g, "\n").trim().slice(0, 4000);
    if (!text) continue;
    if (kept.length > 0 && used + text.length > maxChars) break;
    kept.push({ role: line.role, text });
    used += text.length;
  }
  kept.reverse();
  const body = kept.map((line) => `${line.role === "user" ? "User" : "Assistant"}: ${line.text}`).join("\n\n");
  return lines.length > kept.length ? `…earlier messages omitted…\n\n${body}` : body;
}

async function readHermesTranscript(session: AgentSession, maxChars: number): Promise<string> {
  const sqlite = await loadSqlite();
  if (!sqlite || !session.sourcePath) return "";
  const original = process.emitWarning;
  process.emitWarning = () => {};
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(session.sourcePath, { readOnly: true });
    const rows = db
      .prepare("select role, content from messages where session_id = ? and role in ('user','assistant') order by timestamp desc limit 60")
      .all(session.id) as Array<{ role: string; content?: string }>;
    const lines: TranscriptLine[] = [];
    for (const row of rows.reverse()) {
      const text = (row.content ?? "").trim();
      if (text) lines.push({ role: row.role === "user" ? "user" : "assistant", text });
    }
    return formatTranscript(lines, maxChars);
  } catch {
    return "";
  } finally {
    process.emitWarning = original;
    try {
      db?.close();
    } catch {
      // Best-effort close.
    }
  }
}

/** Recent transcript text for a foreign session, or "" when unavailable. */
export async function readAgentTranscript(session: AgentSession, maxChars = 16_000): Promise<string> {
  if (!session.sourcePath) return "";
  try {
    switch (session.agent) {
      case "claude":
        return formatTranscript(collectTranscriptLines(await tailObjects(session.sourcePath), claudeTranscriptLine), maxChars);
      case "codex":
        return formatTranscript(collectTranscriptLines(await tailObjects(session.sourcePath), codexTranscriptLine), maxChars);
      case "pi":
        return formatTranscript(collectTranscriptLines(await tailObjects(session.sourcePath), piTranscriptLine), maxChars);
      case "gemini": {
        const lines: TranscriptLine[] = [];
        for (const object of await tailObjects(session.sourcePath)) lines.push(...geminiTranscriptLines(object));
        return formatTranscript(lines, maxChars);
      }
      case "hermes":
        return readHermesTranscript(session, maxChars);
      case "dsh":
      case "cursor":
      case "midas":
        return "";
    }
  } catch {
    return "";
  }
}
