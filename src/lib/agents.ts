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
