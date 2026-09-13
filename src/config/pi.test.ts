import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSkills, midasOpencodeConfig, parseJsonc } from "./pi.ts";

function withSandbox(run: (root: string, cwd: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "midas-pi-"));
  const cwd = join(root, "project");
  const savedConfigDir = process.env.MIDAS_CONFIG_DIR;
  const savedConfigFile = process.env.MIDAS_CONFIG_FILE;
  mkdirSync(cwd, { recursive: true });
  process.env.MIDAS_CONFIG_DIR = join(root, "midas");
  delete process.env.MIDAS_CONFIG_FILE;
  try {
    run(root, cwd);
  } finally {
    if (savedConfigDir === undefined) delete process.env.MIDAS_CONFIG_DIR;
    else process.env.MIDAS_CONFIG_DIR = savedConfigDir;
    if (savedConfigFile === undefined) delete process.env.MIDAS_CONFIG_FILE;
    else process.env.MIDAS_CONFIG_FILE = savedConfigFile;
    rmSync(root, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("parseJsonc tolerates comments and trailing commas", () => {
  const parsed = parseJsonc(`{
    // line comment
    "mcp": {
      /* block comment */
      "search": { "type": "local", "command": ["run", "a,}"], },
    },
  }`);
  assert.deepEqual(parsed, { mcp: { search: { type: "local", command: ["run", "a,}"] } } });
});

test("midasOpencodeConfig merges midas dirs into mcp, skills and instructions", () => {
  withSandbox((_root, cwd) => {
    const midas = process.env.MIDAS_CONFIG_DIR!;
    write(join(midas, "midas.jsonc"), `{ "mcp": { "global": { "type": "remote", "url": "https://g" } } }`);
    write(join(cwd, ".midas", "midas.json"), `{ "mcp": { "project": { "type": "local", "command": ["p"] } } }`);
    write(join(cwd, ".agents", "midas.jsonc"), `{ "mcp": { "agents": { "type": "local", "command": ["a"] } } }`);
    mkdirSync(join(midas, "skills", "notion"), { recursive: true });
    write(join(cwd, ".agents", "AGENTS.md"), "# agents");

    const config = midasOpencodeConfig(cwd) as {
      mcp: Record<string, unknown>;
      skills: string[];
      instructions: string[];
    };

    assert.deepEqual(Object.keys(config.mcp).sort(), ["agents", "global", "project"]);
    assert.deepEqual(config.skills, [join(midas, "skills")]);
    assert.deepEqual(config.instructions, [join(cwd, ".agents", "AGENTS.md")]);
  });
});

test("midasOpencodeConfig applies MIDAS_CONFIG_FILE last", () => {
  withSandbox((root, cwd) => {
    const override = join(root, "override.jsonc");
    write(override, `{ "mcp": { "winner": { "type": "local", "command": ["w"] } }, "model": "a/b" }`);
    process.env.MIDAS_CONFIG_FILE = override;
    const config = midasOpencodeConfig(cwd) as { model: string; mcp: Record<string, unknown> };
    assert.equal(config.model, "a/b");
    assert.deepEqual(Object.keys(config.mcp), ["winner"]);
  });
});

test("listSkills includes only folders with a SKILL.md, using its frontmatter name", () => {
  withSandbox((_root, cwd) => {
    const midas = process.env.MIDAS_CONFIG_DIR!;
    mkdirSync(join(midas, "skills", "notion"), { recursive: true });
    write(join(midas, "skills", "notion", "SKILL.md"), "# notion");
    mkdirSync(join(midas, "skills", "career-ops"), { recursive: true });
    write(join(midas, "skills", "career-ops", "SKILL.md"), `---\nname: job-search\ndescription: find jobs\n---\n# jobs`);
    mkdirSync(join(midas, "skills", "work"), { recursive: true });
    write(join(midas, "skills", "work", "whatsapp-share", "x.md"), "# no skill file");
    mkdirSync(join(cwd, ".agents", "skills", "research"), { recursive: true });
    write(join(cwd, ".agents", "skills", "research", "SKILL.md"), "# research");

    const skills = listSkills(cwd);
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.scope]),
      [
        ["job-search", "global"],
        ["notion", "global"],
        ["research", "local"],
      ],
    );
    assert.equal(skills[0]!.path, join(midas, "skills", "career-ops"));
  });
});
