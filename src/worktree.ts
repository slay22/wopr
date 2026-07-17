import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { addWorktree } from "./git"
import { log } from "./log"
import { readOnlyToolNames, runReadOnlyPrompt } from "./pi"
import { parseModel } from "./runner"
import { woprHome } from "./workspace"

export type WorktreeResult = {
  /** Absolute path of the newly created worktree. */
  dir: string
  /** Name of the branch the worktree was created on. */
  branch: string
}

export type WorktreeInput = {
  targetDir: string
  prompt: string
  /** Commit/ref to base the new branch on; defaults to HEAD. */
  baseRef?: string
  /** Override the model used to name the branch (provider/model[#variant]). */
  model?: string
  signal?: AbortSignal
}

/** Cheap, fast model used to synthesize a branch name from the prompt. */
export const defaultBranchNameModel = "anthropic/claude-haiku-4-5"

// Generous enough for the namer to look up a referenced issue before answering;
// the deterministic fallback still guards the whole thing.
const branchNameTimeoutMs = 60_000
const maxBranchNameLength = 40

/**
 * Creates a new git branch checked out in a dedicated worktree under
 * `~/.wopr/worktrees/<slug>`, so WOPR runs against an isolated checkout
 * instead of the user's current working tree. The branch name is synthesized
 * from the prompt by a cheap model (Haiku by default), falling back to a
 * timestamped slug when the model is unavailable.
 */
export async function createIsolatedWorktree(input: WorktreeInput): Promise<WorktreeResult> {
  const base = input.baseRef ?? "HEAD"
  const branch = await generateBranchName(input.prompt, input.targetDir, input.model, input.signal)
  const slug = slugifyBranch(branch)
  const dir = join(woprHome(), "worktrees", slug)
  await mkdir(join(woprHome(), "worktrees"), { recursive: true })
  await addWorktree(dir, branch, base, input.targetDir)
  log.info(`created worktree at ${dir} on branch ${branch}`)
  return { dir, branch }
}

/**
 * Asks a cheap, read-only model for a short kebab-case branch name derived
 * from the prompt — it may look up referenced issues/tickets first. Any
 * failure (no auth, timeout, unparseable reply) falls back to a deterministic
 * slug so the worktree is always created.
 */
export async function generateBranchName(
  prompt: string,
  targetDir: string,
  model = defaultBranchNameModel,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = prompt.trim()
  if (!trimmed) return fallbackBranchName()
  try {
    const name = await askForBranchName(trimmed, targetDir, model, signal)
    const cleaned = cleanBranchName(name)
    return cleaned || fallbackBranchName()
  } catch (error) {
    log.warn(`worktree: couldn't generate an AI branch name (${error instanceof Error ? error.message : String(error)}); using fallback`)
    return fallbackBranchName()
  }
}

export async function askForBranchName(prompt: string, targetDir: string, model: string, signal?: AbortSignal): Promise<string> {
  return runReadOnlyPrompt({
    cwd: targetDir,
    model: parseModel(model),
    systemPrompt: branchNameSystemPrompt,
    userText: `Prompt:\n${truncate(prompt, 1200)}`,
    toolNames: readOnlyToolNames,
    signal: signal ?? AbortSignal.timeout(branchNameTimeoutMs),
  })
}

// ponytail: pi has no webfetch built-in, so the namer can't fetch a referenced
// issue URL anymore; it names from the prompt text (and repo files via read
// tools). Restore issue lookup when pi gains a fetch tool.
const branchNameSystemPrompt = [
  "You name git branches. Read the user's prompt and reply with ONE short, lowercase, kebab-case",
  "branch name that captures what the work does. 2-5 words. No leading 'feature/', no quotes,",
  "no punctuation except hyphens, no explanation, no markdown. Examples:",
  "add-onboarding-flow, fix-login-redirect, refactor-config-tui, dark-mode-toggle.",
  "If the prompt references an issue, ticket, or PR (#123, ABC-123, a URL) instead of describing",
  "the work, look for it in the repo files with the tools available to you and name the branch",
  "after what the issue is actually about. If the reference can't be resolved, use the issue ID",
  "itself as the name (e.g. dev-1339) — never transcribe the sentence around it. The last line",
  "of your reply must be the branch name alone.",
].join("\n")

/**
 * Keeps the model's reply within git's branch-name rules: lowercase,
 * kebab-case, <=40 chars. Reads the last non-empty line — a namer that
 * investigated an issue first may narrate before answering.
 */
export function cleanBranchName(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines[lines.length - 1] ?? ""
  const kebab = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxBranchNameLength)
  if (!kebab) return ""
  // Avoid a leading digit which can confuse some git/tooling; prefix "task-".
  return /^[0-9]/.test(kebab) ? `task-${kebab}` : kebab
}

/** Deterministic fallback so worktree creation never depends on a model being available. */
export function fallbackBranchName(): string {
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `wopr-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${randomSlug(4)}`
}

/** Filesystem-safe directory name for the worktree (mirrors the branch slug). */
export function slugifyBranch(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || `wopr-${randomSlug(6)}`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function randomSlug(size: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  for (const byte of bytes) out += chars[byte % chars.length]
  return out
}
