import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCallers, canInvokeAgent, type AgentLike } from "./agents.ts";

const rule = (permission: string, pattern: string, action: string) => ({ permission, pattern, action });

const agents: AgentLike[] = [
  {
    name: "task",
    mode: "primary",
    permission: [rule("task", "*", "deny"), rule("task", "advisor", "allow"), rule("task", "explore", "allow")],
  },
  {
    name: "orchestrator",
    mode: "primary",
    permission: [rule("task", "*", "deny"), rule("task", "advisor", "allow"), rule("task", "explore", "allow")],
  },
  {
    name: "advisor",
    mode: "subagent",
    permission: [rule("task", "*", "deny"), rule("task", "explore", "allow")],
  },
  { name: "main", mode: "primary", permission: [rule("task", "*", "deny")] },
  { name: "merge", mode: "subagent", permission: [rule("task", "*", "deny")] },
];

test("agentCallers lists the agents that can invoke a subagent", () => {
  // Primary callers first (alphabetical), then subagents.
  assert.deepEqual(agentCallers(agents, "advisor"), ["orchestrator", "task"]);
  assert.deepEqual(agentCallers(agents, "explore"), ["orchestrator", "task", "advisor"]);
  assert.deepEqual(agentCallers(agents, "merge"), []);
  // A primary agent is chosen by the user, not invoked by another agent.
  assert.deepEqual(agentCallers(agents, "task"), []);
});

test("canInvokeAgent follows last-match-wins and glob patterns", () => {
  const caller: AgentLike = {
    name: "x",
    mode: "primary",
    permission: [rule("task", "*", "allow"), rule("task", "advisor", "deny")],
  };
  assert.equal(canInvokeAgent(caller, "advisor"), false);
  assert.equal(canInvokeAgent(caller, "explore"), true);

  const wildcard: AgentLike = { name: "y", mode: "primary", permission: [rule("task", "exp*", "allow")] };
  assert.equal(canInvokeAgent(wildcard, "explore"), true);
  assert.equal(canInvokeAgent(wildcard, "advisor"), false);
});

test("agentCallers skips hidden agents", () => {
  const hidden: AgentLike = {
    name: "title",
    mode: "primary",
    hidden: true,
    permission: [rule("task", "explore", "allow")],
  };
  assert.deepEqual(agentCallers([...agents, hidden], "explore"), ["orchestrator", "task", "advisor"]);
});
