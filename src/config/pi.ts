import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Global pi config directory (respects PI_CONFIG_DIR like pi does). */
export function piConfigDir(): string {
  return process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi");
}

export function piAgentDir(): string {
  return join(piConfigDir(), "agent");
}

/** midas's own global config directory (`~/.midas`, override with MIDAS_CONFIG_DIR). */
export function midasConfigDir(): string {
  return process.env.MIDAS_CONFIG_DIR ?? join(homedir(), ".midas");
}

/** midas's project config directory (`<cwd>/.midas`). */
export function midasProjectDir(cwd: string): string {
  return join(cwd, ".midas");
}

/** `.agents` directories (global and project) used for skills/commands/context. */
export function agentsGlobalDir(): string {
  return join(homedir(), ".agents");
}

export function agentsProjectDir(cwd: string): string {
  return join(cwd, ".agents");
}

/**
 * midas's opencode config file (merged on top of opencode.jsonc by the server).
 * Search order: MIDAS_CONFIG_FILE, project `.midas/midas.jsonc`, global `~/.midas/midas.jsonc`.
 */
export function midasConfigFile(cwd: string): string | undefined {
  const candidates = [
    process.env.MIDAS_CONFIG_FILE,
    join(midasProjectDir(cwd), "midas.jsonc"),
    join(midasProjectDir(cwd), "midas.json"),
    join(midasConfigDir(), "midas.jsonc"),
    join(midasConfigDir(), "midas.json"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not present; try the next candidate.
    }
  }
  return undefined;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Transcript/UI row padding is fixed at 1 (not configurable). */
export function rowPad(_cwd?: string): number {
  return 1;
}

export interface PiSettings {
  theme?: string;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  hideThinkingBlock?: boolean;
  /** Max concurrent board task agents; defaults to a machine-tuned value. */
  taskConcurrency?: number;
  /** Command whose stdout streams JSONL STT events for `/voice`. */
  voiceSttCommand?: string;
  /** Per-agent "Last Used" model ref (`provider/model`), used when no specific override is set. */
  agentLastUsed?: Record<string, string>;
  /** Per-agent reasoning level chosen alongside its specific model. */
  agentThinkingLevels?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Settings resolution order (later wins):
 * pi global -> pi project -> midas global (~/.midas) -> midas project (.midas)
 */
export function loadPiSettings(cwd?: string): PiSettings {
  const piGlobal = readJson<PiSettings>(join(piAgentDir(), "settings.json")) ?? {};
  const piProject = (cwd ? readJson<PiSettings>(join(cwd, ".pi", "settings.json")) : undefined) ?? {};
  const midasGlobal = readJson<PiSettings>(join(midasConfigDir(), "settings.json")) ?? {};
  const midasProject = (cwd ? readJson<PiSettings>(join(midasProjectDir(cwd), "settings.json")) : undefined) ?? {};
  return { ...piGlobal, ...piProject, ...midasGlobal, ...midasProject };
}

export function homePath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

interface PiModel {
  id?: string;
  provider?: string;
  name?: string;
}

export interface LastSelectedModel {
  providerID: string;
  modelID: string;
  name?: string;
}

/** midas's own last-selected model (`~/.midas/last-selected-model.json`). */
function midasLastSelectedModelPath(): string {
  return join(midasConfigDir(), "last-selected-model.json");
}

/**
 * The last model used, preferring midas's own store and falling back to pi's last
 * interactively selected model so a shared install still resumes sensibly.
 */
export function readLastSelectedModel(): LastSelectedModel | undefined {
  const own = readJson<{ providerID?: string; provider?: string; modelID?: string; id?: string; name?: string }>(
    midasLastSelectedModelPath(),
  );
  const ownProvider = own?.providerID ?? own?.provider;
  const ownModel = own?.modelID ?? own?.id;
  if (ownProvider && ownModel) {
    return { providerID: ownProvider, modelID: ownModel, ...(own?.name ? { name: own.name } : {}) };
  }
  const pi = readJson<PiModel>(join(piAgentDir(), "last-selected-model.json"));
  if (pi?.provider && pi.id) {
    return { providerID: pi.provider, modelID: pi.id, ...(pi.name ? { name: pi.name } : {}) };
  }
  return undefined;
}

/** Remember the model chosen in midas so the next launch resumes with it. */
export function writeLastSelectedModel(model: LastSelectedModel): void {
  try {
    mkdirSync(midasConfigDir(), { recursive: true });
    writeFileSync(midasLastSelectedModelPath(), `${JSON.stringify(model, null, 2)}\n`);
  } catch {
    // Best-effort: selection still applies for the current session.
  }
}

/** Per-model thinking level override from pi settings. */
export function thinkingLevelFor(settings: PiSettings, providerID: string, modelID: string): string {
  const map = settings.modelThinkingLevels as Record<string, string> | undefined;
  const value = map?.[`${providerID}/${modelID}`];
  if (typeof value === "string" && value) return value;
  return typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "medium";
}

/** Merge one key into the global pi settings file. */
export function updateGlobalSetting(key: string, value: unknown): void {
  const path = join(midasConfigDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  settings[key] = value;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Persist a per-model thinking level into midas's global settings file. */
export function updateModelThinkingLevel(providerID: string, modelID: string, level: string): void {
  const path = join(midasConfigDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const map = { ...((settings.modelThinkingLevels as Record<string, string>) ?? {}) };
  map[`${providerID}/${modelID}`] = level;
  settings.modelThinkingLevels = map;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Provider ids with stored opencode credentials. */
export function readAuthedProviders(): string[] {
  try {
    return Object.keys(JSON.parse(readFileSync(opencodeAuthPath(), "utf8")) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function opencodeAuthPath(): string {
  const dataDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataDir, "opencode", "auth.json");
}

/** Remove a provider's stored credentials from opencode's auth store. */
export function removeAuthedProvider(providerID: string): void {
  try {
    const store = JSON.parse(readFileSync(opencodeAuthPath(), "utf8")) as Record<string, unknown>;
    delete store[providerID];
    writeFileSync(opencodeAuthPath(), `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    // Nothing stored or unreadable.
  }
}

export interface SkillEntry {
  name: string;
  path: string;
  /** Where the skill came from: user/global dirs vs the current project. */
  scope: "global" | "local";
}

/**
 * Skills visible to midas: global `~/.midas/skills`, project `.midas/skills`,
 * and project `.agents/skills`. The global `~/.agents/skills` dir is not scanned.
 */
export function listSkills(cwd: string): SkillEntry[] {
  const dirs: Array<{ dir: string; scope: SkillEntry["scope"] }> = [
    { dir: join(midasProjectDir(cwd), "skills"), scope: "local" },
    { dir: join(midasConfigDir(), "skills"), scope: "global" },
    { dir: join(agentsProjectDir(cwd), "skills"), scope: "local" },
  ];
  const byName = new Map<string, SkillEntry>();
  for (const { dir, scope } of dirs) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const name = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
      if (!byName.has(name)) byName.set(name, { name, path: join(dir, entry.name), scope });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
