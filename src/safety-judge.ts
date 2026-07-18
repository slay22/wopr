import { log } from "./log"
import { type ModelSelection, runReadOnlyPrompt } from "./pi"

/** An external classifier's call on whether a permission request is safe to auto-approve. */
export type SafetyVerdict = { safe: boolean; reason: string }

export type JudgeRequest = {
  permission: string
  command?: string
  target?: string
  description?: string
  patterns?: string[]
}

export type JudgeInput = {
  request: JudgeRequest
  model: ModelSelection
  directory: string
  signal?: AbortSignal
  /** Override for the per-request budget; defaults to 20s. */
  timeoutMs?: number
}

const defaultTimeoutMs = 20_000

/**
 * The judge runs OUTSIDE the agentic loop: a single stateless prompt with every
 * tool disabled, so it can only classify — never act. It is deliberately
 * fail-closed: any error, timeout, or unparseable answer returns `safe: false`
 * so the request escalates to the human instead of being waved through.
 */
const judgeSystemPrompt = [
  "You are a security gatekeeper for an autonomous coding agent. You decide whether a single",
  "tool/command request may be auto-approved WITHOUT human review. You cannot run anything;",
  "you only classify.",
  "",
  "Mark it SAFE only when it is read-only or clearly reversible and local, with no access to",
  "secrets/credentials, no exfiltration of data to external hosts, and no destructive or",
  "irreversible effect. Examples of SAFE: reading or listing files, running tests, type-checks,",
  "linters, git status/diff/log, builds confined to the workspace.",
  "",
  "Mark it UNSAFE (requires a human) when it is destructive or irreversible (rm -rf, git push",
  "--force, resetting/dropping/altering data stores or remote state), installs or modifies",
  "global/system configuration, sends data to external hosts (curl/wget POST, scp, uploads),",
  "reads credentials/secrets/keys, or is ambiguous enough that you are not confident.",
  "",
  "When in doubt, choose UNSAFE. Reply with STRICT JSON and nothing else:",
  '{"safe": boolean, "reason": "<short explanation, <=140 chars>"}',
].join("\n")

export async function judgeCommand(input: JudgeInput): Promise<SafetyVerdict> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("safety judge timed out")), input.timeoutMs ?? defaultTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  try {
    // No tools: the judge classifies, it never acts. Throwaway in-memory session.
    const text = await runReadOnlyPrompt({
      cwd: input.directory,
      model: input.model,
      systemPrompt: judgeSystemPrompt,
      userText: renderRequest(input.request),
      signal: controller.signal,
      toolNames: [],
    })
    const verdict = parseVerdict(text)
    if (!verdict) {
      log.warn(`[safety-judge] unparseable verdict, escalating: ${truncate(text, 160)}`)
      return { safe: false, reason: "could not read the safety verdict" }
    }
    return verdict
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`[safety-judge] evaluation failed, escalating: ${message}`)
    return { safe: false, reason: `safety check failed (${message})` }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
  }
}

function renderRequest(request: JudgeRequest): string {
  const lines = [`category: ${request.permission}`]
  if (request.command) lines.push(`command: ${request.command}`)
  if (request.target) lines.push(`target: ${request.target}`)
  if (request.patterns && request.patterns.length > 0) lines.push(`patterns: ${request.patterns.join(", ")}`)
  if (request.description) lines.push(`description: ${request.description}`)
  lines.push("", "Is it safe to auto-approve this without human review?")
  return lines.join("\n")
}

/**
 * Pulls the verdict out of the model's reply: walks the text left-to-right,
 * balancing braces and ignoring braces inside string literals (including
 * escaped \" and \\ inside strings). Returns the first top-level JSON object
 * found, or undefined (→ fail-closed) if none is parseable. Includes a depth
 * limit of 32 to defend against pathological replies.
 *
 * Changed from the original first-{ / last-} slice: the old parser could
 * return the *second* object when prose or a code fence appeared before the
 * first object, which could flip an UNSAFE verdict to SAFE.
 */
export function parseVerdict(text: string): SafetyVerdict | undefined {
  if (!text) return undefined

  const maxDepth = 32
  const candidates: { start: number; end: number }[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objStart = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "{") {
      depth++
      if (depth > maxDepth) return undefined
      if (depth === 1) objStart = i
      continue
    }

    if (ch === "}") {
      if (depth === 0) continue // stray close brace, skip
      depth--
      if (depth === 0 && objStart !== -1) {
        candidates.push({ start: objStart, end: i })
        objStart = -1
        // Return the first top-level balanced object
        return tryParse(text.slice(candidates[0]!.start, candidates[0]!.end + 1))
      }
      continue
    }
  }

  return undefined
}

function tryParse(slice: string): SafetyVerdict | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const safe = (parsed as { safe?: unknown }).safe
  if (typeof safe !== "boolean") return undefined
  const rawReason = (parsed as { reason?: unknown }).reason
  const reason = typeof rawReason === "string" && rawReason.trim().length > 0 ? rawReason.trim() : safe ? "judged safe" : "judged unsafe"
  return { safe, reason: truncate(reason, 200) }
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}
