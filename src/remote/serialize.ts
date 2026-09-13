import type { Session } from "@opencode-ai/sdk";
import type { StoredMidasSession } from "../lib/session-store.ts";
import type { MessageView, PartView, QuestionView } from "../state/transcript.ts";

/** A session row on the remote's "all sessions" screen. */
export interface RemoteSessionSummary {
  id: string;
  title: string;
  directory: string;
  updated: number;
  created: number;
}

/** Trim one string to a sane size before sending it to a phone. */
export function capText(value: string | undefined, limit = 40_000): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [${value.length - limit} more characters truncated]`;
}

export function sessionSummary(session: Session): RemoteSessionSummary {
  return {
    id: session.id,
    title: session.title?.trim() || "Untitled session",
    directory: session.directory ?? "",
    updated: session.time?.updated ?? session.time?.created ?? 0,
    created: session.time?.created ?? 0,
  };
}

export function storedSessionSummary(session: StoredMidasSession): RemoteSessionSummary {
  return {
    id: session.id,
    title: session.title?.trim() || "Untitled session",
    directory: session.cwd ?? "",
    updated: session.updatedAt ?? 0,
    created: session.createdAt ?? 0,
  };
}

/**
 * Merge session lists, first group wins on identity. Midas's own registry is
 * authoritative (its `cwd` is where the session was last used), while the
 * scoped opencode list adds sessions not yet recorded and fills in titles.
 */
export function mergeSessionSummaries(...groups: RemoteSessionSummary[][]): RemoteSessionSummary[] {
  const byId = new Map<string, RemoteSessionSummary>();
  for (const group of groups) {
    for (const session of group) {
      const existing = byId.get(session.id);
      if (!existing) {
        byId.set(session.id, { ...session });
        continue;
      }
      if (existing.title === "Untitled session" && session.title !== "Untitled session") {
        existing.title = session.title;
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.updated - a.updated);
}

/** Plain, phone-sized projection of a transcript part. */
function clientPart(part: PartView): Record<string, unknown> {
  switch (part.kind) {
    case "text":
      return { kind: "text", id: part.id, text: capText(part.text) };
    case "reasoning":
      return {
        kind: "reasoning",
        id: part.id,
        text: capText(part.text),
        ended: part.ended,
        startedAt: part.startedAt,
        endedAt: part.endedAt,
      };
    case "tool":
      return {
        kind: "tool",
        id: part.id,
        tool: part.tool,
        status: part.status,
        title: part.title,
        input: capText(safeJson(part.input), 8_000),
        output: capText(part.output),
        error: capText(part.error, 8_000),
      };
    case "bash":
      return {
        kind: "bash",
        id: part.id,
        command: capText(part.command, 8_000),
        output: capText(part.output),
        status: part.status,
        exitCode: part.exitCode,
      };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

/** Strip renderer-only fields and cap payloads before a message crosses the wire. */
export function toClientMessage(message: MessageView): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    agent: message.agent,
    providerID: message.providerID,
    modelID: message.modelID,
    cost: message.cost,
    created: message.created,
    completed: message.completed,
    error: message.error,
    notice: message.notice,
    hidden: message.hidden,
    steer: message.steer,
    imageFilenames: message.imageFilenames,
    parts: message.parts.map(clientPart),
  };
}

export function toClientQuestion(question: QuestionView): Record<string, unknown> {
  return {
    id: question.id,
    questions: question.questions.map((prompt) => ({
      header: prompt.header,
      question: prompt.question,
      multiple: prompt.multiple,
      options: prompt.options.map((option) => ({ label: option.label, description: option.description })),
    })),
  };
}
