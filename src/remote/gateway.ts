import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2";
import { SessionController } from "../opencode/session.ts";
import { readMidasSessions } from "../lib/session-store.ts";
import { LoginThrottle, newSessionToken, verifyPassword } from "./auth.ts";
import { mergeSessionSummaries, sessionSummary, storedSessionSummary, toClientMessage, toClientQuestion, type RemoteSessionSummary } from "./serialize.ts";
import { CLIENT_CSS, CLIENT_JS, INDEX_HTML } from "./web.ts";

const COOKIE = "midas_remote";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days: the link stays useful.

export interface RemoteGatewayOptions {
  client: OpencodeClient;
  clientV2?: OpencodeV2Client;
  cwd: string;
  /** Current password hash; read per login so /settings edits take effect live. */
  getPasswordHash: () => string | undefined;
}

interface Connection {
  ws: WebSocket;
  controller?: SessionController;
  unsubscribe?: () => void;
  snapshotSent: boolean;
  sentVersions: Map<string, number>;
  phase: string;
  permissionsJson: string;
  questionsJson: string;
  sessionJson: string;
  pushTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The remote surface: a loopback-only HTTP + WebSocket server guarded by the
 * password from /settings. It is a thin client of the same opencode server the
 * TUI uses, so sessions, prompts and events are shared. Only an allow-listed
 * set of operations is exposed; opencode's own API is never reachable here.
 */
export class RemoteGateway {
  private server?: Server;
  private wss?: WebSocketServer;
  private port = 0;
  private readonly tokens = new Set<string>();
  private readonly throttle = new LoginThrottle();
  private readonly connections = new Set<Connection>();
  private sessionsCache?: { at: number; data: RemoteSessionSummary[] };
  private lister?: SessionController;

  constructor(private readonly options: RemoteGatewayOptions) {}

  get address(): number {
    return this.port;
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => void this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.server.on("upgrade", (req, socket, head) => {
      const path = safePath(req);
      if (path !== "/ws" || !this.isAuthed(req)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections]) connection.ws.close();
    this.connections.clear();
    this.lister?.dispose();
    this.lister = undefined;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
    this.wss?.close();
    this.wss = undefined;
  }

  // ---- HTTP ----

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.securityHeaders(res);
    const path = safePath(req);
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && (path === "/" || path === "/index.html")) return this.send(res, 200, "text/html; charset=utf-8", INDEX_HTML);
      if (method === "GET" && path === "/client.css") return this.send(res, 200, "text/css; charset=utf-8", CLIENT_CSS);
      if (method === "GET" && path === "/client.js") return this.send(res, 200, "text/javascript; charset=utf-8", CLIENT_JS);
      if (method === "GET" && path === "/healthz") return this.send(res, 200, "text/plain; charset=utf-8", "ok");
      if (method === "POST" && path === "/api/login") return await this.handleLogin(req, res);
      if (method === "POST" && path === "/api/logout") {
        const token = cookieValue(req, COOKIE);
        if (token) this.tokens.delete(token);
        res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict`);
        return this.send(res, 200, "application/json", JSON.stringify({ ok: true }));
      }
      if (method === "GET" && path === "/api/sessions") {
        if (!this.isAuthed(req)) return this.send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
        const sessions = await this.listSessions();
        return this.send(res, 200, "application/json", JSON.stringify({ sessions }));
      }
      return this.send(res, 404, "text/plain; charset=utf-8", "not found");
    } catch (error) {
      return this.send(res, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
    }
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = req.socket.remoteAddress ?? "unknown";
    if (this.throttle.isLocked(key)) {
      return this.send(res, 429, "application/json", JSON.stringify({ error: "Too many attempts. Try again later." }));
    }
    let body: { password?: unknown };
    try {
      body = (await readJson(req)) as { password?: unknown };
    } catch {
      return this.send(res, 400, "application/json", JSON.stringify({ error: "bad request" }));
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!verifyPassword(password, this.options.getPasswordHash())) {
      this.throttle.fail(key);
      return this.send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
    }
    this.throttle.succeed(key);
    const token = newSessionToken();
    this.tokens.add(token);
    const secure = forwardedProto(req) === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${COOKIE_MAX_AGE}; SameSite=Strict${secure}`);
    return this.send(res, 200, "application/json", JSON.stringify({ ok: true }));
  }

  private async listSessions(): Promise<RemoteSessionSummary[]> {
    const now = Date.now();
    if (this.sessionsCache && now - this.sessionsCache.at < 3_000) return this.sessionsCache.data;
    // Midas's registry spans every project it has used, which is what "all
    // sessions" means; the opencode list is scoped to one directory.
    const registry = readMidasSessions().map(storedSessionSummary);
    let scoped: RemoteSessionSummary[] = [];
    try {
      this.lister ??= new SessionController({ client: this.options.client, clientV2: this.options.clientV2, cwd: this.options.cwd });
      scoped = (await this.lister.listSessions(this.options.cwd)).map(sessionSummary);
    } catch {
      // Registry-only if the opencode listing fails.
    }
    const data = mergeSessionSummaries(registry, scoped);
    this.sessionsCache = { at: now, data };
    return data;
  }

  private securityHeaders(res: ServerResponse): void {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
  }

  private send(res: ServerResponse, status: number, type: string, body: string): void {
    res.statusCode = status;
    res.setHeader("Content-Type", type);
    res.end(body);
  }

  private isAuthed(req: IncomingMessage): boolean {
    const token = cookieValue(req, COOKIE);
    return Boolean(token && this.tokens.has(token));
  }

  // ---- WebSocket ----

  private handleConnection(ws: WebSocket): void {
    const connection: Connection = {
      ws,
      snapshotSent: false,
      sentVersions: new Map(),
      phase: "idle",
      permissionsJson: "[]",
      questionsJson: "[]",
      sessionJson: "",
    };
    this.connections.add(connection);
    ws.on("message", (raw) => void this.handleClientMessage(connection, raw.toString()));
    ws.on("close", () => {
      this.connections.delete(connection);
      connection.unsubscribe?.();
      connection.controller?.dispose();
      if (connection.pushTimer) clearTimeout(connection.pushTimer);
    });
    ws.on("error", () => ws.close());
  }

  private async handleClientMessage(connection: Connection, raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message.type;
    if (type === "open") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const directory = typeof message.directory === "string" && message.directory ? message.directory : this.options.cwd;
      await this.openSession(connection, sessionId, directory);
      return;
    }
    const controller = connection.controller;
    if (!controller) return;
    try {
      if (type === "prompt" && typeof message.text === "string" && message.text.trim()) {
        await controller.prompt(message.text);
      } else if (type === "abort") {
        await controller.abort();
      } else if (type === "permission" && typeof message.id === "string") {
        const response = message.response;
        if (response === "once" || response === "always" || response === "reject") {
          await controller.respondPermission(message.id, response);
        }
      } else if (type === "question" && typeof message.id === "string" && Array.isArray(message.answers)) {
        await controller.answerQuestion(message.id, message.answers as string[][]);
      } else if (type === "questionReject" && typeof message.id === "string") {
        await controller.rejectQuestion(message.id);
      }
    } catch (error) {
      this.sendTo(connection, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async openSession(connection: Connection, sessionId: string, directory: string): Promise<void> {
    connection.unsubscribe?.();
    connection.controller?.dispose();
    connection.snapshotSent = false;
    connection.sentVersions = new Map();
    connection.phase = "idle";
    connection.permissionsJson = "[]";
    connection.questionsJson = "[]";
    connection.sessionJson = "";
    if (!sessionId) return;

    const controller = new SessionController({
      client: this.options.client,
      clientV2: this.options.clientV2,
      cwd: directory,
    });
    connection.controller = controller;
    try {
      await controller.resume(sessionId);
    } catch (error) {
      this.sendTo(connection, { type: "error", message: `Could not open session: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (connection.controller !== controller) return; // superseded while loading
    connection.unsubscribe = controller.transcript.subscribe(() => this.schedulePush(connection));
    this.push(connection);
  }

  private schedulePush(connection: Connection): void {
    if (connection.pushTimer) return;
    connection.pushTimer = setTimeout(() => {
      connection.pushTimer = undefined;
      this.push(connection);
    }, 50);
  }

  private push(connection: Connection): void {
    const controller = connection.controller;
    if (!controller || connection.ws.readyState !== 1) return;
    const transcript = controller.transcript;
    if (!connection.snapshotSent) {
      connection.snapshotSent = true;
      for (const message of transcript.messages) connection.sentVersions.set(message.id, message.version ?? 0);
      connection.permissionsJson = JSON.stringify(transcript.permissions);
      connection.questionsJson = JSON.stringify(transcript.questions.map(toClientQuestion));
      connection.sessionJson = JSON.stringify(transcript.session ?? null);
      this.sendTo(connection, {
        type: "snapshot",
        session: transcript.session ?? { id: controller.id, title: controller.title },
        phase: transcript.phase,
        messages: transcript.messages.filter((message) => !message.hidden).map(toClientMessage),
        permissions: transcript.permissions,
        questions: transcript.questions.map(toClientQuestion),
      });
      connection.phase = transcript.phase;
      return;
    }

    const seen = new Set<string>();
    for (const message of transcript.messages) {
      seen.add(message.id);
      const version = message.version ?? 0;
      if (connection.sentVersions.get(message.id) === version) continue;
      connection.sentVersions.set(message.id, version);
      if (!message.hidden) this.sendTo(connection, { type: "message", message: toClientMessage(message) });
    }
    for (const id of [...connection.sentVersions.keys()]) {
      if (seen.has(id)) continue;
      connection.sentVersions.delete(id);
      this.sendTo(connection, { type: "remove", id });
    }
    if (transcript.phase !== connection.phase) {
      connection.phase = transcript.phase;
      this.sendTo(connection, { type: "phase", phase: transcript.phase });
    }
    const permissionsJson = JSON.stringify(transcript.permissions);
    if (permissionsJson !== connection.permissionsJson) {
      connection.permissionsJson = permissionsJson;
      this.sendTo(connection, { type: "permissions", permissions: transcript.permissions });
    }
    const questionsJson = JSON.stringify(transcript.questions.map(toClientQuestion));
    if (questionsJson !== connection.questionsJson) {
      connection.questionsJson = questionsJson;
      this.sendTo(connection, { type: "questions", questions: transcript.questions.map(toClientQuestion) });
    }
    const sessionJson = JSON.stringify(transcript.session ?? null);
    if (sessionJson !== connection.sessionJson) {
      connection.sessionJson = sessionJson;
      if (transcript.session) this.sendTo(connection, { type: "session", session: transcript.session });
    }
  }

  private sendTo(connection: Connection, payload: unknown): void {
    if (connection.ws.readyState !== 1) return;
    connection.ws.send(JSON.stringify(payload));
  }
}

function safePath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function forwardedProto(req: IncomingMessage): string {
  const value = req.headers["x-forwarded-proto"];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}
