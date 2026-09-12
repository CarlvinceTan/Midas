import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";

/**
 * pi-tui renders ATX headings of depth three or deeper with their literal
 * `###` markers (`headingStyleFn(headingPrefix) + headingText`). midas wants
 * every heading drawn as plain styled text, so rewrite deeper headings to
 * level two before pi parses them; levels two and deeper share one style, so
 * the only visual change is dropping the literal hashes.
 *
 * Fenced code blocks are left untouched, and a run of hashes without trailing
 * whitespace is not a heading (so `#hashtag` and seven-plus hashes are kept).
 */
export const normalizeHeadingDepth: MarkdownTransformer = (markdown) => {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^(#{3,6})([ \t])/, "##$2");
    })
    .join("\n");
};
