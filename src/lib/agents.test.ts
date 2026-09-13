import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCallerLabel, agentCallers, canInvokeAgent, groupAgentNames, selectableAgentNames, type AgentLike } from "./agents.ts";

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

test("agentCallerLabel formats inherited-model parents for /agents", () => {
  const withMainParent = agents.map((agent) =>
    agent.name === "main"
      ? { ...agent, permission: [rule("task", "explore", "allow")] }
      : agent,
  );
  assert.equal(agentCallerLabel(withMainParent, "explore"), "Main, Orchestrator, Task, Advisor");
  assert.equal(agentCallerLabel(agents, "task"), undefined);
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

test("groupAgentNames orders entry points, subagents, then internals", () => {
  const catalog: AgentLike[] = [
    { name: "title", mode: "primary" },
    { name: "explore", mode: "subagent" },
    { name: "orchestrator", mode: "primary" },
    { name: "compaction", mode: "primary" },
    { name: "advisor", mode: "subagent" },
    { name: "main", mode: "primary" },
    { name: "task", mode: "primary" },
    { name: "merge", mode: "subagent" },
  ];
  assert.deepEqual(groupAgentNames(catalog), [
    ["main", "orchestrator"],
    ["advisor", "explore", "merge", "task"],
    ["compaction", "title"],
  ]);
  // Empty groups are omitted.
  assert.deepEqual(groupAgentNames([{ name: "explore", mode: "subagent" }]), [["explore"]]);
});

test("selectableAgentNames excludes the board-only task agent", () => {
  assert.deepEqual(selectableAgentNames(agents), ["main", "orchestrator"]);
});
