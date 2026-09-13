import { capitalize } from "./text.ts";

/** One ordered permission rule from opencode's agent config. */
export interface AgentPermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

/** Minimal agent shape needed to derive the task-call graph. */
export interface AgentLike {
  name: string;
  mode: string;
  hidden?: boolean;
  permission?: AgentPermissionRule[];
}

/** Agents internal to opencode that never appear as selectable primaries. */
export const INTERNAL_AGENT_NAMES = new Set(["compaction", "summary", "title"]);

/** The normal user-facing agent for every new Midas session. */
export const DEFAULT_INTERACTIVE_AGENT = "main";

/** Enabled only through `/multitask`. */
export const ORCHESTRATOR_AGENT = "orchestrator";

/** Internal board worker; users never select this agent directly. */
export const BOARD_WORKER_AGENT = "task";

/** Internal conflict resolver invoked only by the merge pipeline. */
export const MERGE_AGENT = "merge";

/** User-facing entry points, listed at the top of the startup header. */
const ENTRY_AGENTS = new Set([DEFAULT_INTERACTIVE_AGENT, ORCHESTRATOR_AGENT]);

/** Agents shown under the entry points even though they are `mode: primary`. */
const SUBAGENT_AGENTS = new Set([BOARD_WORKER_AGENT]);

/** Primary agents the user may enter directly; the task worker is board-only. */
export function selectableAgentNames(agents: AgentLike[]): string[] {
  return agents
    .filter(
      (agent) =>
        agent.mode === "primary" &&
        !agent.hidden &&
        !INTERNAL_AGENT_NAMES.has(agent.name) &&
        agent.name !== BOARD_WORKER_AGENT,
    )
    .map((agent) => agent.name)
    .sort((a, b) => a.localeCompare(b));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Whether `caller` may invoke `target` through the `task` tool, from its
 * ordered permission rules (last matching rule wins).
 */
export function canInvokeAgent(caller: AgentLike, target: string): boolean {
  let allowed = false;
  for (const rule of caller.permission ?? []) {
    if (rule.permission !== "task" && rule.permission !== "*") continue;
    if (!globToRegExp(rule.pattern).test(target)) continue;
    allowed = rule.action === "allow";
  }
  return allowed;
}

/**
 * Agents that can invoke `target`, i.e. where a subagent's default model can be
 * inherited from. Primary agents sort first, then subagents, each alphabetically.
 */
export function agentCallers(agents: AgentLike[], target: string): string[] {
  return agents
    .filter((agent) => agent.name !== target && !agent.hidden && canInvokeAgent(agent, target))
    .sort((a, b) => {
      const primary = (a.mode === "primary" ? 0 : 1) - (b.mode === "primary" ? 0 : 1);
      return primary !== 0 ? primary : a.name.localeCompare(b.name);
    })
    .map((agent) => agent.name);
}

/** Human-readable parent-agent list for a subagent's inherited default model. */
export function agentCallerLabel(agents: AgentLike[], target: string): string | undefined {
  const callers = agentCallers(agents, target);
  if (callers.length === 0) return undefined;
  return callers
    .map((name) => name.charAt(0).toUpperCase() + name.slice(1))
    .join(", ");
}

/**
 * Group agents for display, in order: entry points (main/orchestrator), then
 * subagents, then opencode internals (compaction/summary/title). Empty groups
 * are dropped and names are alphabetical within each group.
 */
export function groupAgentNames(agents: AgentLike[]): string[][] {
  const groups: string[][] = [[], [], []];
  for (const agent of agents) {
    groups[agentGroup(agent)]!.push(agent.name);
  }
  return groups
    .map((group) => group.sort((a, b) => a.localeCompare(b)))
    .filter((group) => group.length > 0);
}

function agentGroup(agent: AgentLike): number {
  if (INTERNAL_AGENT_NAMES.has(agent.name)) return 2;
  if (ENTRY_AGENTS.has(agent.name)) return 0;
  // `task` is the board worker that picks up orchestrator tasks, so it reads as
  // a subagent here even though its mode is `primary`.
  if (SUBAGENT_AGENTS.has(agent.name) || agent.mode !== "primary") return 1;
  return 0;
}

/** Single section id shared by every `/agents` row, so none is set apart. */
export const AGENT_SETTINGS_GROUP = "agents";

/** A `/agents` overlay row: one flat section, internals alongside the rest. */
export interface AgentSettingsRow {
  name: string;
  /** Plain capitalized label, styled exactly like every other agent row. */
  label: string;
  /** Identical for all rows, so SettingsList inserts no divider between them. */
  group: string;
}

/**
 * Rows for the `/agents` overlay. The entry/subagent/internal ordering still
 * comes from `groupAgentNames`, but the sections are flattened into one so
 * opencode internals (compaction/summary/title) render as ordinary selectable
 * rows instead of a detached utility block. The startup header keeps using
 * `groupAgentNames` directly and is unaffected.
 */
export function agentSettingsRows(agents: AgentLike[]): AgentSettingsRow[] {
  return groupAgentNames(agents)
    .flat()
    .map((name) => ({ name, label: capitalize(name), group: AGENT_SETTINGS_GROUP }));
}
