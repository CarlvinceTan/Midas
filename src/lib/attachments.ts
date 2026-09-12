import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** A file part sent to the model alongside the text prompt. */
export interface PromptAttachment {
  mime: string;
  filename: string;
  url: string;
}

export interface ImageMatch {
  /** The exact substring in the prompt, replaced when the image is attached. */
  raw: string;
  /** Resolved absolute path to try to read. */
  path: string;
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Guard against inlining enormous files into a request body. */
const MAX_BYTES = 25 * 1024 * 1024;

// A dragged/pasted path: absolute or ~/, optionally a file:// URL, containing
// spaces (macOS screenshot names), ending in an image extension.
const IMAGE_RE = /(?:^|[\s'"(])((?:file:\/\/)?(?:~\/|\/)[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|heic|heif|tiff?))(?=$|[\s'")])/gim;

/** Find image file paths in a prompt (e.g. a screenshot dragged into the input). */
export function findImagePaths(text: string): ImageMatch[] {
  const matches: ImageMatch[] = [];
  for (const match of text.matchAll(IMAGE_RE)) {
    const raw = match[1]!;
    let path = raw;
    try {
      if (path.startsWith("file://")) path = fileURLToPath(path);
    } catch {
      continue;
    }
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    matches.push({ raw, path });
  }
  return matches;
}

/** Read an image from disk into a base64 data URL, or undefined if unreadable. */
export function readImageAttachment(path: string): PromptAttachment | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) return undefined;
    return { mime, filename: basename(path), url: `data:${mime};base64,${readFileSync(path).toString("base64")}` };
  } catch {
    return undefined;
  }
}
