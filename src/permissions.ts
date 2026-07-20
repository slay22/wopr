import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import type { InlineExtension } from "@earendil-works/pi-coding-agent"

import { bashPolicy, type BashDecision, evaluateBashPolicy } from "./bash-policy"
import { log } from "./log"
import type { ModelSelection } from "./pi"
import { noopProgress, type AutoAccept, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "./progress"
import { judgeCommand } from "./safety-judge"
import type { ApprovalsConfig, PermissionAdditions } from "./types"
import { askRemote } from "./permissions/remote"
import { AlwaysAllowStore } from "./permissions/always-allow"

// On OpenCode this was a directory-scoped event listener replying to
// `permission.asked`. On pi each phase session carries a `tool_call` extension
// that consults the same bash policy, safety judge, and human prompt inline and
// returns `{ block }` to allow or deny. Non-bash tools (read/grep/edit/write)
// are allowed: read-only phases simply aren't given edit/write/bash tools, and
// wopr always auto-allowed edits for writable phases.

export type PermissionGate = {
  /** Pass this into every phase session's `extensions` so the hook fires there. */
  extension: InlineExtension
  stop(): Promise<void>
  /** While paused, every tool call is allowed (used when a human owns the step). */
  pause(): void
  resume(): void
}

export type StartGateOptions = {
  progress?: ProgressUI
  interactive: boolean
  directory: string
  /** Project additions to the bash policy; deny always wins. */
  permissions?: PermissionAdditions
  /** When "all", ask-level requests are auto-allowed; "smart" runs the judge. */
  autoAccept?: AutoAccept
  /** Model for the smart auto-accept judge; required for "smart" to do anything. */
  judgeModel?: ModelSelection
  /** Remote approvals config; when set, non-TTY ask prompts fall back to ntfy. */
  approvals?: ApprovalsConfig
  /** The current run ID, used for always-allow state and request identification. */
  runId?: string
  /** The current phase name, used for request identification. */
  phase?: string
  /** The current agent name, used for request identification. */
  agent?: string
}

export function startPermissionGate(options: StartGateOptions): PermissionGate {
  const progress = options.progress ?? noopProgress
  const policy = bashPolicy(options.directory, options.permissions)
  const queue = serialQueue()
  const state = { paused: false, stopped: false }
  const alwaysAllow = options.approvals && options.runId ? new AlwaysAllowStore(options.runId) : undefined

  const extension: InlineExtension = {
    name: "wopr-permissions",
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (state.stopped || state.paused) return {}
        if (event.toolName !== "bash") return {}
        const command = String((event.input as { command?: unknown }).command ?? "").trim()
        if (!command) return {}
        // Serialize decisions so concurrent tool calls don't race the terminal
        // prompt or interleave judge output.
        const allowed = await queue(() => decide(command, policy, options, progress, state, alwaysAllow))
        return allowed ? {} : { block: true, reason: `wopr denied: ${command}` }
      })
    },
  }

  return {
    extension,
    async stop() {
      state.stopped = true
      // Clean up always-allow state on run completion
      if (alwaysAllow) {
        await alwaysAllow.clear().catch(() => {})
      }
    },
    pause() {
      state.paused = true
    },
    resume() {
      state.paused = false
    },
  }
}

async function decide(
  command: string,
  policy: Record<string, BashDecision>,
  options: StartGateOptions,
  progress: ProgressUI,
  state: { paused: boolean },
  alwaysAllow?: AlwaysAllowStore,
): Promise<boolean> {
  const decision = evaluateBashPolicy(command, policy)
  const summary = truncate(command, 200)
  if (decision === "deny") {
    log.info(`[permission] denied by policy: ${summary}`)
    progress.message(`denied: ${summary}`)
    return false
  }
  if (decision === "allow") return true

  // decision === "ask"
  if (options.autoAccept?.mode === "all") {
    log.info(`[permission] auto-allowed (auto-accept on): ${summary}`)
    progress.message(`auto-allowed: ${summary}`)
    return true
  }

  let judgeReason: string | undefined
  if (options.autoAccept?.mode === "smart" && options.judgeModel) {
    progress.message(`evaluating safety: ${summary}`)
    const verdict = await judgeCommand({
      request: { permission: "bash", command },
      model: options.judgeModel,
      directory: options.directory,
    })
    if (verdict.safe) {
      log.info(`[permission] smart-allowed: ${summary} — ${verdict.reason}`)
      progress.message(`smart-allowed: ${summary} — ${verdict.reason}`)
      return true
    }
    log.info(`[permission] smart auto-accept escalating to user: ${summary} — ${verdict.reason}`)
    judgeReason = `flagged by safety judge: ${verdict.reason}`
  }

  // Remote approvals: when not interactive (no TTY) and approvals are configured,
  // use the ntfy remote resolver instead of auto-rejecting.
  if (!options.interactive && options.approvals) {
    const request = {
      id: crypto.randomUUID(),
      command,
      agent: options.agent ?? "unknown",
      phase: options.phase ?? "unknown",
      runId: options.runId ?? "unknown",
      timestamp: Date.now() / 1000,
    }
    progress.message(`sending remote permission request: ${summary}`)
    log.info(`[permission] remote approval request ${request.id.slice(0, 8)}: ${summary}`)

    const result = await askRemote(request, options.approvals, alwaysAllow)

    if (result.source === "timeout") {
      log.warn(`[permission] remote approval timed out after ${options.approvals.timeoutSeconds || 300}s: ${summary}; decision: ${result.decision}`)
      progress.message(`remote approval timed out → ${result.decision}: ${summary}`)
    } else {
      log.info(`[permission] remote approval replied ${result.decision}: ${summary}`)
      progress.message(`remote permission ${result.decision}: ${summary}`)
    }

    return result.decision !== "reject"
  }

  if (!options.interactive) {
    log.warn(`[permission] auto-rejecting bash (no TTY): ${summary}`)
    return false
  }

  const answer = await promptHuman(command, progress, judgeReason)
  log.info(`[permission] replied ${answer} for bash`)
  return answer !== "reject"
}

async function promptHuman(command: string, progress: ProgressUI, judgeReason?: string): Promise<PermissionReply> {
  const info = promptInfo(command, judgeReason)
  // The TUI resolves the prompt in-place; the readline fallback keeps the run
  // from dropping to a bare screen when there's no dashboard.
  const ask = progress.askPermission?.bind(progress)
  if (ask) return ask(info)

  progress.suspend()
  try {
    log.section("permission request")
    stdout.write(formatRequest(info))
    return await askReply()
  } finally {
    progress.resume()
  }
}

function promptInfo(command: string, judgeReason?: string): PermissionPromptInfo {
  return {
    id: command.slice(0, 32),
    permission: "bash",
    patterns: [],
    command,
    sessionID: "",
    ...(judgeReason ? { judgeReason } : {}),
  }
}

function formatRequest(info: PermissionPromptInfo) {
  const lines: string[] = [""]
  if (info.judgeReason) lines.push(`⚠ ${info.judgeReason}`)
  lines.push("category: bash")
  if (info.command) lines.push(`command: ${truncate(info.command, 400)}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

async function askReply(): Promise<PermissionReply> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    for (;;) {
      const raw = (await rl.question("approve? [o]nce, [a]lways, [r]eject > ")).trim().toLowerCase()
      if (raw === "o" || raw === "once" || raw === "y" || raw === "yes") return "once"
      if (raw === "a" || raw === "always") return "always"
      if (raw === "r" || raw === "reject" || raw === "n" || raw === "no") return "reject"
      stdout.write("Choose o, a, or r.\n")
    }
  } finally {
    rl.close()
  }
}

function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job) as Promise<T>
    tail = run.catch(() => {})
    return run
  }
}
