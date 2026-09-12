import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * If `command` is a plain `cd [dir]` whose target exists, return the resolved
 * absolute directory. Returns undefined for anything else (compound commands,
 * `cd -`, missing targets) so it runs in the shell as usual.
 *
 * `isDir` is injected so the resolution is testable without touching the disk.
 */
export function resolveCdTarget(
  command: string,
  cwd: string,
  isDir: (path: string) => boolean,
): string | undefined {
  const match = command.trim().match(/^cd(?:\s+(.+))?$/);
  if (!match) return undefined;
  const raw = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
  // A compound command (`cd x && y`, `cd x; y`, expansions) is the shell's job.
  if (/[;&|<>`$]/.test(raw)) return undefined;
  const dir =
    raw === "" || raw === "~"
      ? homedir()
      : raw.startsWith("~")
        ? join(homedir(), raw.slice(1))
        : isAbsolute(raw)
          ? raw
          : resolve(cwd, raw);
  return isDir(dir) ? dir : undefined;
}
