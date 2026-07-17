import { readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, resolve } from "node:path"

import { log } from "./log"

type MissingMode = "skip" | "error"

// OpenCode accepted rich file "parts" in a prompt; pi's prompt() takes text (and
// images). archer's attachments are its own reports, pre-diffs, and project
// context files — all text — so we inline their content into the prompt.
// ponytail: text only; binary/image attachments are skipped with a warning.
// Add pi ImageContent handling if image attachments become a real need.
export type Attachment = {
  filename: string
  mime: string
  text: string
}

export async function fileParts(paths: string[], baseDir: string, missing: MissingMode): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const input of paths) {
    const path = isAbsolute(input) ? input : resolve(baseDir, input)
    let info
    try {
      info = await stat(path)
    } catch {
      if (missing === "error") throw new Error(`file not found for --file: ${input}`)
      continue
    }
    if (info.isDirectory()) {
      log.warn(`attachment skipped (directory, unsupported on pi): ${input}`)
      continue
    }
    const mime = guessMime(path)
    if (!isTextAttachment(path, mime)) {
      log.warn(`attachment skipped (non-text, unsupported on pi): ${input}`)
      continue
    }
    out.push({ filename: basename(path), mime, text: await readFile(path, "utf8") })
  }
  return out
}

/** Render attachments as labeled fenced blocks to append after the prompt text. */
export function renderAttachments(attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return ""
  return attachments
    .map((file) => `\n\n=== attached file: ${file.filename} ===\n${file.text}`)
    .join("")
}

function guessMime(path: string) {
  const mime = Bun.file(path).type
  if (isTextAttachment(path, mime)) return "text/plain"
  return mime || "text/plain"
}

const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".diff",
  ".go",
  ".gradle",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".lock",
  ".md",
  ".patch",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
])

const textFilenames = new Set(["dockerfile", "makefile", "readme", "license"])
const textMimes = new Set(["application/json", "application/javascript", "application/xml", "application/x-ndjson"])

function isTextAttachment(path: string, mime: string) {
  const baseMime = mime.split(";")[0]?.toLowerCase() ?? ""
  if (baseMime.startsWith("text/")) return true
  if (textMimes.has(baseMime)) return true
  if (textExtensions.has(extname(path).toLowerCase())) return true
  return textFilenames.has(basename(path).toLowerCase())
}
