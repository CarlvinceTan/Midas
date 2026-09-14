// Fast-forward a midas checkout from its upstream, so a pushed change lands on
// the next `midas` run. Never blocks startup: offline, diverged or locally
// modified checkouts are left untouched and only a notice is printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POLL_MS = 30_000;
const FAIL_BACKOFF_MS = 600_000;

/**
 * @param {string} root checkout root (contains .git)
 * @param {{ env?: NodeJS.ProcessEnv, log?: (message: string) => void, now?: () => number }} [options]
 * @returns {"updated"|"up-to-date"|"skipped"|"disabled"|"no-checkout"}
 */
export function autoUpdate(root, options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message) => process.stderr.write(message));
  const now = options.now ? options.now() : Date.now();

  if (env.MIDAS_NO_UPDATE === "1") return "disabled";
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) return "no-checkout";

  const stampPath = join(gitDir, "midas-auto-update");
  try {
    const [at, state] = readFileSync(stampPath, "utf8").trim().split(" ");
    const lastAt = Number(at);
    // Poll at most every 30s; back off after a failure so an offline machine
    // does not stall every launch.
    if (Number.isFinite(lastAt) && now - lastAt < (state === "ok" ? POLL_MS : FAIL_BACKOFF_MS)) {
      return "skipped";
    }
  } catch {
    // No stamp yet.
  }

  const git = (args, timeout = 15_000) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout });
  const stamp = (state) => {
    try {
      writeFileSync(stampPath, `${Date.now()} ${state}`);
    } catch {
      // Read-only checkout; harmless.
    }
  };

  try {
    if (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).status !== 0) {
      return "skipped"; // no upstream configured
    }
    if (git(["fetch", "--quiet", "--no-tags"], 10_000).status !== 0) {
      stamp("err");
      return "skipped"; // offline / no remote
    }
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const upstream = git(["rev-parse", "@{u}"]).stdout.trim();
    if (!head || head === upstream) {
      stamp("ok");
      return "up-to-date";
    }
    // Only a fast-forward (behind, not diverged) can be applied silently.
    if (git(["merge-base", "HEAD", "@{u}"]).stdout.trim() !== head) {
      stamp("ok");
      return "skipped";
    }

    log("midas: pulling latest changes…\n");
    if (git(["merge", "--ff-only", "@{u}"], 30_000).status !== 0) {
      log("midas: auto-update skipped (local changes)\n");
      stamp("ok");
      return "skipped";
    }
    const after = git(["rev-parse", "HEAD"]).stdout.trim();
    const changed = git(["diff", "--name-only", head, after]).stdout;
    // Reinstall when the dependency graph (or the vendored pi-tui) changed.
    if (/(^|\n)(package\.json|package-lock\.json)(\n|$)|(^|\n)vendor\//.test(changed)) {
      log("midas: installing dependencies…\n");
      spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: root,
        stdio: "inherit",
        timeout: 600_000,
      });
    }
    log(`midas: updated to ${after.slice(0, 7)}\n`);
    stamp("ok");
    return "updated";
  } catch {
    // An update problem must never stop the app from starting.
    return "skipped";
  }
}
