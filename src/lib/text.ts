/** Capitalize the first character, leaving the rest unchanged. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** A leading `!`/`!!` shell command parsed from typed input. */
export interface ShellCommand {
  command: string;
  /** `!!` commands are excluded from the model context. */
  exclude: boolean;
}

/**
 * Parse a leading `! ` (or `!! ` to exclude from context) shell command.
 * Only a bang at the very start activates shell mode: any leading whitespace
 * makes it ordinary text. A bare `! ` yields an empty command so the caller can
 * ignore it; normal text returns undefined.
 */
export function parseShellCommand(text: string): ShellCommand | undefined {
  if (text.startsWith("!! ")) return { command: text.slice(3).trim(), exclude: true };
  if (text.startsWith("! ")) return { command: text.slice(2).trim(), exclude: false };
  return undefined;
}

/** Trim to at most `maxWords` words. */
export function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (maxWords <= 0 || words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

/**
 * opencode names an untouched session "New session - <ISO timestamp>". Treat
 * that (and the bare placeholders) as empty so the header shows "New Session".
 */
const PLACEHOLDER_SESSION_TITLE =
  /^new (?:session|chat)(?:\s*[-–—:]\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)?$/i;

/**
 * A session's stored title if it is meaningful; empty for missing titles and
 * server placeholders, so a resumed run is not labelled "New session".
 */
export function usableSessionTitle(title: string | undefined): string {
  const value = (title ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase() === "untitled") return "";
  if (PLACEHOLDER_SESSION_TITLE.test(value)) return "";
  return value;
}
