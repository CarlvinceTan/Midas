import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { homePath } from "../../config/pi.ts";
import { AGENT_LABELS, AGENT_ORDER, projectLabel, type AgentSession, type SessionAgent } from "../../lib/agent-sessions.ts";
import { theme } from "../../theme/theme.ts";
import { renderTabStrip } from "./tab-strip.ts";

export interface SessionsViewOptions {
  /** Directory Midas is running in; its project is listed first. */
  cwd: string;
  onNew: (directory: string) => void;
  onResume: (session: AgentSession) => void;
  onCancel: () => void;
}

interface ProjectGroup {
  directory: string;
  label: string;
  sessions: AgentSession[];
}

type Scope = { agent: SessionAgent | "all"; label: string };

type Entry =
  | { kind: "project"; project: ProjectGroup }
  | { kind: "new"; directory: string }
  | { kind: "session"; session: AgentSession };

function relativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Session picker laid out like `/stats`: a row of agent tabs across the top
 * ("All" plus each agent that has sessions), then the projects for that agent,
 * then the sessions for the selected project and agent. Left/Right (or a click)
 * switch agents, Enter opens a project or resumes a session, Esc steps back.
 */
export class SessionsView implements Component {
  private sessions: AgentSession[] = [];
  private loaded = false;
  private scopeIndex = 0;
  private level: "projects" | "sessions" = "projects";
  private projectDir: string | undefined;
  private selected = 0;
  private readonly maxVisible = 10;
  /** Tab hit ranges from the last render, for click-to-switch. */
  private tabRanges: Array<{ start: number; end: number; index: number }> = [];
  /** Selectable-row hit ranges from the last render, for click-to-activate. */
  private rowTargets: Array<{ y: number; index: number }> = [];

  constructor(private options: SessionsViewOptions) {}

  setSessions(sessions: AgentSession[]): void {
    this.sessions = sessions;
    this.loaded = true;
    if (this.level === "sessions" && !this.currentProject()) this.level = "projects";
  }

  /** Show a "Scanning…" placeholder until the first setSessions() lands. */
  setLoading(): void {
    this.loaded = false;
  }

  invalidate(): void {}

  /** Panel title, e.g. `Sessions` or `Sessions > Polymux` inside a project. */
  currentTitle(): string {
    if (this.level === "sessions") {
      const project = this.currentProject();
      if (project) return `Sessions > ${project.label}`;
    }
    return "Sessions";
  }

  /** "All" plus each agent that actually has sessions, in display order. */
  private scopes(): Scope[] {
    const present = new Set(this.sessions.map((session) => session.agent));
    const scopes: Scope[] = [{ agent: "all", label: "All" }];
    for (const agent of AGENT_ORDER) {
      if (present.has(agent)) scopes.push({ agent, label: AGENT_LABELS[agent] });
    }
    return scopes;
  }

  private currentScope(): Scope {
    return this.scopes()[this.scopeIndex] ?? { agent: "all", label: "All" };
  }

  private scopedSessions(): AgentSession[] {
    const scope = this.currentScope();
    if (scope.agent === "all") return this.sessions;
    return this.sessions.filter((session) => session.agent === scope.agent);
  }

  /** Projects owning at least one scoped session, current directory first. */
  private projects(): ProjectGroup[] {
    const groups = new Map<string, AgentSession[]>();
    if (this.options.cwd) groups.set(this.options.cwd, []);
    for (const session of this.scopedSessions()) {
      const key = session.groupKey ?? session.projectDir;
      const existing = groups.get(key);
      if (existing) existing.push(session);
      else groups.set(key, [session]);
    }
    const projects = [...groups.entries()].map(([directory, sessions]) => ({
      directory,
      label: sessions.find((session) => session.groupLabel)?.groupLabel ?? projectLabel(directory),
      sessions,
    }));
    return projects.sort((a, b) => {
      if (a.directory === this.options.cwd) return -1;
      if (b.directory === this.options.cwd) return 1;
      const aLatest = a.sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0);
      const bLatest = b.sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0);
      return bLatest - aLatest || a.label.localeCompare(b.label);
    });
  }

  private currentProject(): ProjectGroup | undefined {
    return this.projects().find((project) => project.directory === this.projectDir);
  }

  private entries(): Entry[] {
    if (this.level === "projects") {
      return this.projects().map((project) => ({ kind: "project", project }));
    }
    const project = this.currentProject();
    if (!project) return [];
    const scope = this.currentScope();
    const entries: Entry[] = [];
    // New sessions are Midas sessions, so only offer them for All or Midas.
    if (scope.agent === "all" || scope.agent === "midas") entries.push({ kind: "new", directory: project.directory });
    for (const session of project.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      entries.push({ kind: "session", session });
    }
    return entries;
  }

  private normalizeSelection(entries: Entry[]): void {
    if (entries.length === 0) {
      this.selected = 0;
      return;
    }
    this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
  }

  private move(delta: number): void {
    const count = this.entries().length;
    if (count === 0) return;
    this.selected = (this.selected + delta + count) % count;
  }

  private switchScope(delta: number): void {
    const count = this.scopes().length;
    if (count === 0) return;
    this.scopeIndex = (this.scopeIndex + delta + count) % count;
    this.level = "projects";
    this.projectDir = undefined;
    this.selected = 0;
  }

  private activate(): void {
    const entry = this.entries()[this.selected];
    if (!entry) return;
    if (entry.kind === "project") {
      this.level = "sessions";
      this.projectDir = entry.project.directory;
      this.selected = 0;
      return;
    }
    if (entry.kind === "new") return this.options.onNew(entry.directory);
    if (entry.kind === "session") return this.options.onResume(entry.session);
  }

  /** Step out of a project back to the list. Returns false at the top. */
  private back(): boolean {
    if (this.level !== "sessions") return false;
    this.level = "projects";
    const index = this.projects().findIndex((project) => project.directory === this.projectDir);
    this.selected = index >= 0 ? index : 0;
    return true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.back()) return;
      return this.options.onCancel();
    }
    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.switchScope(1);
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      this.switchScope(-1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.activate();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Only an explicit click switches scope; moving over a tab must not.
    if (event.type !== "click") return undefined;
    if (event.y === 0) {
      const tab = this.tabRanges.find((range) => event.x >= range.start && event.x < range.end);
      if (!tab) return undefined;
      this.switchScope(tab.index - this.scopeIndex);
      return { handled: true, render: true };
    }
    const target = this.rowTargets.find((row) => row.y === event.y);
    if (!target) return undefined;
    const entry = this.entries()[target.index];
    if (!entry) return undefined;
    this.selected = target.index;
    this.activate();
    return { handled: true, render: true };
  }

  private renderEntry(entry: Entry, selected: boolean, width: number): string {
    const t = theme();
    // The cursor sits in its own marker column under the tab labels; every row
    // keeps that column (blank when unselected) so labels never shift.
    const marker = selected ? t.fg("accent", "→ ") : "  ";
    const labelStyle = (text: string): string => (selected ? t.fg("accent", text) : t.fg("text", text));
    const available = Math.max(1, width - 2);
    // Truncate the head so the trailing metadata (agent, time, count) survives.
    const withTail = (head: string, tail: string): string => {
      if (!tail) return truncateToWidth(head, available, "…");
      const headWidth = Math.max(0, available - visibleWidth(tail));
      const headPart = headWidth > 0 ? truncateToWidth(head, headWidth, "…") : "";
      return headPart + truncateToWidth(tail, available, "…");
    };
    if (entry.kind === "project") {
      const label = labelStyle(entry.project.label);
      const path = t.fg("dim", "  " + homePath(entry.project.directory));
      const count = entry.project.sessions.length;
      const summary = t.fg("muted", `  ${count} session${count === 1 ? "" : "s"}`);
      return marker + withTail(label + path, summary);
    }
    if (entry.kind === "new") {
      return marker + withTail(labelStyle("New session"), t.fg("muted", "  Midas"));
    }
    const meta = [relativeTime(entry.session.updatedAt)];
    // In "All" the agent is the only way to tell two rows apart.
    if (this.currentScope().agent === "all") meta.unshift(AGENT_LABELS[entry.session.agent]);
    const description = meta.filter(Boolean).length ? "  " + t.fg("muted", meta.filter(Boolean).join(" · ")) : "";
    return marker + withTail(labelStyle(entry.session.title), description);
  }

  render(width: number): string[] {
    const t = theme();
    const scopes = this.scopes();
    this.scopeIndex = Math.min(this.scopeIndex, Math.max(0, scopes.length - 1));

    this.tabRanges = [];
    // The tab row is indented one space so it lines up under the panel title;
    // the list rows stay flush left.
    const strip = renderTabStrip(scopes.map((scope) => scope.label), this.scopeIndex, width - 1);
    for (const range of strip.ranges) {
      this.tabRanges.push({ start: range.start + 1, end: range.end + 1, index: range.index });
    }
    this.rowTargets = [];

    const scanning = !this.loaded && this.sessions.length === 0;
    const entries = scanning ? [] : this.entries();
    if (!scanning) this.normalizeSelection(entries);

    // The second row is a fixed spacer, so switching tabs or drilling in via
    // the panel title never changes the height.
    const lines: string[] = [" " + strip.text, ""];

    // A fixed number of body rows keeps the panel the same height across agent
    // tabs (and levels); short scopes are padded rather than shrinking it.
    const body: string[] = [];
    if (scanning) {
      body.push("  " + t.fg("dim", "Scanning…"));
    } else if (entries.length === 0) {
      body.push("  " + t.fg("dim", "No sessions"));
    } else {
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), entries.length - this.maxVisible));
      const visible = entries.slice(Math.max(0, start), Math.max(0, start) + this.maxVisible);
      visible.forEach((entry, offset) => {
        const index = Math.max(0, start) + offset;
        this.rowTargets.push({ y: lines.length + body.length, index });
        body.push(this.renderEntry(entry, index === this.selected, width));
      });
    }
    while (body.length < this.maxVisible) body.push("");
    lines.push(...body.slice(0, this.maxVisible));

    // Reserve the counter row too, so overflow never changes the height. Indent
    // it under the marker column so it lines up with the row labels.
    lines.push(entries.length > this.maxVisible ? "  " + t.fg("dim", `${this.selected + 1}/${entries.length}`) : "");
    return lines;
  }
}
