import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { midasConfigDir } from "../config/pi.ts";

/**
 * Midas's own index of the sessions it created or resumed, independent of the
 * opencode server's project-wide session list. The transcript itself still
 * lives in opencode's store (Midas is an opencode frontend); this file records
 * which sessions are Midas's, where they belong, and what to call them so
 * `/sessions` can list them without scraping every opencode session.
 */
export interface StoredMidasSession {
  id: string;
  cwd: string;
  title: string;
  /** Epoch ms the session was first seen by Midas. */
  createdAt: number;
  /** Epoch ms the session was last touched (prompt, resume, rename, shell). */
  updatedAt: number;
}

type Store = Record<string, StoredMidasSession>;

const MAX_SESSIONS = 500;

export function midasSessionsPath(): string {
  return join(midasConfigDir(), "sessions.json");
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(midasSessionsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Store = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = normalize(id, value);
      if (record) store[id] = record;
    }
    return store;
  } catch {
    return {};
  }
}

function normalize(id: string, value: unknown): StoredMidasSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<StoredMidasSession>;
  const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
  const title = typeof entry.title === "string" ? entry.title : "";
  const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : 0;
  const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
  return { id, cwd, title, createdAt, updatedAt };
}

function writeStore(store: Store): void {
  try {
    mkdirSync(midasConfigDir(), { recursive: true });
    writeFileSync(midasSessionsPath(), `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    // Best-effort: a failed write must never break the session picker.
  }
}

function prune(store: Store): void {
  const ids = Object.keys(store);
  if (ids.length <= MAX_SESSIONS) return;
  ids
    .sort((a, b) => (store[b]?.updatedAt ?? 0) - (store[a]?.updatedAt ?? 0))
    .slice(MAX_SESSIONS)
    .forEach((id) => delete store[id]);
}

/** Newest first. */
export function readMidasSessions(): StoredMidasSession[] {
  return Object.values(readStore()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Insert or refresh a session. Missing fields fall back to the stored record. */
export function upsertMidasSession(entry: {
  id: string;
  cwd?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}): void {
  if (!entry.id) return;
  const store = readStore();
  const previous = store[entry.id];
  const now = Date.now();
  const raw = entry.title?.trim();
  // An explicit empty title clears a stale one (e.g. a resumed session with no
  // title); opencode's "New session" placeholder is never worth storing.
  const title =
    raw === undefined || raw === "New session" ? (previous?.title ?? "") : raw;
  store[entry.id] = {
    id: entry.id,
    cwd: entry.cwd || previous?.cwd || "",
    title,
    createdAt: entry.createdAt ?? previous?.createdAt ?? now,
    updatedAt: Math.max(entry.updatedAt ?? now, previous?.updatedAt ?? 0, now),
  };
  prune(store);
  writeStore(store);
}
