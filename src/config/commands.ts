import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentsGlobalDir, agentsProjectDir, midasConfigDir, midasProjectDir } from "./pi.ts";

/**
 * User-defined slash commands: markdown files whose body primes the
 * conversation with a configured instruction. Not skills.
 *
 *   ~/.pi/agent/commands/<name>.md
 *   <cwd>/.pi/commands/<name>.md
 *
 * Optional frontmatter: `description`, `agent`, `model`.
 * `$ARGUMENTS` in the body is replaced with the text typed after the command.
 */
export interface CustomCommand {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  template: string;
  source: string;
}

function parseCommand(filePath: string, name: string): CustomCommand {
  const raw = readFileSync(filePath, "utf8");
  let description: string | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let template = raw;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    template = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "description") description = value;
      else if (key === "agent") agent = value;
      else if (key === "model") model = value;
    }
  }
  return { name, description, agent, model, template: template.trim(), source: filePath };
}

export function loadCustomCommands(cwd: string): CustomCommand[] {
  const dirs = [
    join(midasProjectDir(cwd), "commands"),
    join(midasConfigDir(), "commands"),
    join(agentsProjectDir(cwd), "commands"),
    join(agentsGlobalDir(), "commands"),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const dir of dirs) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      if (byName.has(name)) continue;
      try {
        byName.set(name, parseCommand(join(dir, entry.name), name));
      } catch {
        // Unreadable command file.
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute the typed arguments into the command template. */
export function renderCommandTemplate(command: CustomCommand, args: string): string {
  if (command.template.includes("$ARGUMENTS")) return command.template.replaceAll("$ARGUMENTS", args);
  return args ? `${command.template}\n\n${args}` : command.template;
}
