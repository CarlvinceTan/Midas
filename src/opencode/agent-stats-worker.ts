import { parentPort } from "node:worker_threads";
import { computeAgentStats } from "./agent-stats.ts";

// Runs the agent-stat scan off the UI thread and posts the result back.
const stats = await computeAgentStats();
parentPort?.postMessage(stats);
