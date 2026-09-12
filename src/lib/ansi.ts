/**
 * Minimal 24-bit ANSI styling with correct nested close codes, so styles can be
 * composed (e.g. bold inside a colored frame) without resetting the outer style.
 */

const RESET = "\x1b[0m";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function fg(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function bg(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

export const bold = (t: string): string => `\x1b[1m${t}\x1b[22m`;
export const dim = (t: string): string => `\x1b[2m${t}\x1b[22m`;
export const italic = (t: string): string => `\x1b[3m${t}\x1b[23m`;
export const underline = (t: string): string => `\x1b[4m${t}\x1b[24m`;
export const inverse = (t: string): string => `\x1b[7m${t}\x1b[27m`;
export const strikethrough = (t: string): string => `\x1b[9m${t}\x1b[29m`;

/** Strip all SGR sequences so text can be measured/styled cleanly. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export { RESET };

/**
 * Zero-width content bounds used by pi-tui's selection logic. Padding placed
 * outside these markers is excluded when drag-selecting text to copy.
 */
export const CONTENT_START = "\x1b]777;pi-content-start\x07";
export const CONTENT_END = "\x1b]777;pi-content-end\x07";

export function markContent(text: string): string {
  return CONTENT_START + text + CONTENT_END;
}

/** Lines containing this marker are skipped when a selection is copied. */
export const DECORATION = "\x1b]777;pi-decoration\x07";

export function markDecoration(text: string): string {
  return DECORATION + text;
}
