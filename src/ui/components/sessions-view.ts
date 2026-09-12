import {
  matchesKey,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Session } from "@opencode-ai/sdk";
import { basename } from "node:path";
import { theme } from "../../theme/theme.ts";
import { homePath } from "../../config/pi.ts";
import { capitalize } from "../../lib/text.ts";
import { renderTabStrip } from "./tab-strip.ts";

export interface SessionsViewOptions {
  /** Directory midas is running in; its scope is shown first. */
  cwd: string;
  onNew: () => void;
  onResume: (session: Session) => void;
  onCancel: () => void;
}

/**
 * Known agent config directories under $HOME, mapped to a friendly tab name and
 * listed in display order (Pi first, then other CLIs).
 */
const AGENT_DIRS: Array<{ dir: string; label: string }> = [
  { dir: ".pi", label: "Pi" },
  { dir: ".cursor", label: "Cursor" },
  { dir: ".codex", label: "Codex" },
  { dir: ".claude", label: "Claude" },
  { dir: ".midas", label: "Midas" },
  { dir: ".opencode", label: "OpenCode" },
  { dir: ".gemini", label: "Gemini" },
  { dir: ".aider", label: "Aider" },
  { dir: ".continue", label: "Continue" },
  { dir: ".windsurf", label: "Windsurf" },
];
const AGENT_BY_DIR = new Map(AGENT_DIRS.map((entry, index) => [entry.dir, { label: entry.label, index }]));

/** Friendly tab label: `.pi` -> Pi, `~/code/midas` -> Midas. */
export function scopeLabel(directory: string): string {
  const base = basename(directory);
  const known = AGENT_BY_DIR.get(base.toLowerCase());
  if (known) return known.label;
  const stripped = base.replace(/^\.+/, "");
  return capitalize(stripped) || homePath(directory);
}

export function sortKey(directory: string): [number, string] {
  const known = AGENT_BY_DIR.get(basename(directory).toLowerCase());
  return known ? [known.index, ""] : [AGENT_DIRS.length, scopeLabel(directory).toLowerCase()];
}

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

interface Scope {
  label: string;
  directory: string;
}

/**
 * Session picker: each agent/project directory is a tab at the top; Left/Right
 * arrows (or a click) switch scope, Up/Down moves through that scope's sessions
 * and the first row starts a new session.
 */
export class SessionsView implements Component {
  private here: Session[] | undefined;
  private all: Session[] | undefined;
  private selected = 0;
  private scopeIndex = 0;
  private scopeChosen = false;
  private readonly maxVisible = 12;
  /** Tab hit ranges from the last render, for click-to-switch. */
  private tabRanges: Array<{ start: number; end: number; index: number }> = [];

  constructor(private options: SessionsViewOptions) {}

  setHere(sessions: Session[]): void {
    this.here = sessions;
  }

  setAll(sessions: Session[]): void {
    this.all = sessions;
  }

  invalidate(): void {}

  /** Unique agent/project directories, labelled and ordered for the tabs. */
  private scopes(): Scope[] {
    const dirs = new Map<string, string>();
    const add = (directory: string | undefined): void => {
      if (!directory || dirs.has(directory)) return;
      dirs.set(directory, scopeLabel(directory));
    };
    add(this.options.cwd);
    // Surface sessions from every agent/project directory opencode knows about
    // (including other agents' homes when they hold sessions).
    for (const session of this.all ?? []) add(session.directory);
    return [...dirs.entries()]
      .map(([directory, label]) => ({ directory, label }))
      .sort((a, b) => {
        const [groupA, nameA] = sortKey(a.directory);
        const [groupB, nameB] = sortKey(b.directory);
        return groupA - groupB || nameA.localeCompare(nameB);
      });
  }

  private normalizeScope(scopes: Scope[]): void {
    if (scopes.length === 0) {
      this.scopeIndex = 0;
      return;
    }
    if (!this.scopeChosen) {
      const index = scopes.findIndex((scope) => scope.directory === this.options.cwd);
      this.scopeIndex = index >= 0 ? index : 0;
    }
    this.scopeIndex = Math.min(this.scopeIndex, scopes.length - 1);
  }

  private current(): Session[] {
    const scope = this.scopes()[this.scopeIndex];
    if (!scope) return [];
    if (scope.directory === this.options.cwd) return this.here ?? [];
    return (this.all ?? []).filter((session) => session.directory === scope.directory);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.onCancel();
    const scopes = this.scopes();
    this.normalizeScope(scopes);
    // Left/Right arrows switch between agent scopes (Tab kept as an alias).
    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      if (scopes.length > 0) {
        this.scopeIndex = (this.scopeIndex + 1) % scopes.length;
        this.scopeChosen = true;
        this.selected = 0;
      }
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      if (scopes.length > 0) {
        this.scopeIndex = (this.scopeIndex + scopes.length - 1) % scopes.length;
        this.scopeChosen = true;
        this.selected = 0;
      }
      return;
    }
    const count = this.current().length + 1;
    if (matchesKey(data, "up")) {
      this.selected = (this.selected + count - 1) % count;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % count;
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.selected === 0) return this.options.onNew();
      const session = this.current()[this.selected - 1];
      if (session) this.options.onResume(session);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Only an explicit click switches scope; moving over a tab must not.
    if (event.type !== "click") return undefined;
    if (event.y !== 0) return undefined;
    const tab = this.tabRanges.find((range) => event.x >= range.start && event.x < range.end);
    if (!tab) return undefined;
    this.scopeIndex = tab.index;
    this.scopeChosen = true;
    this.selected = 0;
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const t = theme();
    const scopes = this.scopes();
    this.normalizeScope(scopes);
    const scope = scopes[this.scopeIndex];
    const sessions = this.current();
    const loaded = scope?.directory === this.options.cwd ? this.here : this.all;
    const loading = loaded === undefined ? "  loading…" : "";
    const pad = " ";

    // Project tabs: active one in accent, the rest muted; overflow gets arrows.
    this.tabRanges = [];
    const reserved = pad.length * 2 + loading.length;
    const strip = renderTabStrip(scopes.map((entry) => entry.label), this.scopeIndex, width - reserved);
    for (const range of strip.ranges) {
      this.tabRanges.push({ start: range.start + pad.length, end: range.end + pad.length, index: range.index });
    }
    const lines: string[] = [pad + strip.text + t.fg("dim", loading), ""];

    const rows: Array<{ label: string; description: string; isNew: boolean }> = [
      { label: "New session", description: "", isNew: true },
      ...sessions.map((session) => ({
        label: session.title || session.id,
        description: relativeTime(session.time?.updated ?? session.time?.created),
        isNew: false,
      })),
    ];

    const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), rows.length - this.maxVisible));
    const visible = rows.slice(Math.max(0, start), Math.max(0, start) + this.maxVisible);
    visible.forEach((row, index) => {
      const absolute = Math.max(0, start) + index;
      const isSelected = absolute === this.selected;
      const marker = isSelected ? t.fg("accent", "→ ") : "  ";
      const label = isSelected ? t.fg("accent", row.label) : t.fg("text", row.label);
      const description = row.description ? "  " + t.fg("muted", row.description) : "";
      lines.push(pad + marker + truncateToWidth(label + description, Math.max(1, width - 3), "…"));
    });
    // Align the scroll counter with the row labels (past the `pad` + marker).
    if (rows.length > this.maxVisible) lines.push(pad + "  " + t.fg("dim", `${this.selected + 1}/${rows.length}`));
    return lines;
  }
}
