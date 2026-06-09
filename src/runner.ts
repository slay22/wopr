import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { FilePartInput, OpencodeClient, Part } from "@opencode-ai/sdk/v2"

import { opencodeConfig } from "./agents"
import { fileParts } from "./attachments"
import { addAllAndCommit, createCleanRepoSnapshot, ensureRepoReady, restoreRepoSnapshot, type RepoSnapshot, writeDiff } from "./git"
import { runHumanReviewGate } from "./human"
import { log } from "./log"
import { startOpencode } from "./opencode"
import { startPermissionGate, type PermissionGate } from "./permissions"
import { phases } from "./phases"
import { createProgressUI, noopProgress, type ProgressPhase, type ProgressStepUsage, type ProgressTokens, type ProgressUI, type ProgressUsage } from "./progress"
import { discoverProjectContextFiles } from "./project-context"
import type { Phase, RunOptions } from "./types"
import { cleanupWorkspace, createWorkspace, resumeWorkspace, type Workspace, writeSummary } from "./workspace"

type ActiveSession = {
  client: OpencodeClient
  sessionID: string
  directory: string
  phaseName: string
}

export class UserAbortError extends Error {
  constructor(message = "aborted by user") {
    super(message)
    this.name = "UserAbortError"
  }
}

export function isUserAbortError(error: unknown): error is UserAbortError {
  return error instanceof UserAbortError || (error instanceof Error && error.name === "UserAbortError")
}

export function shouldRetryAttempt(error: unknown, signal: AbortSignal, attempt: number, maxAttempts: number) {
  return !signal.aborted && !isUserAbortError(error) && attempt < maxAttempts
}

class RunShutdown {
  private readonly controller = new AbortController()
  private activeSession: ActiveSession | undefined
  private abortingSession: Promise<void> | undefined
  private requests = 0
  private forceTimer: ReturnType<typeof setTimeout> | undefined

  get signal() {
    return this.controller.signal
  }

  get aborted() {
    return this.controller.signal.aborted
  }

  request(source: string) {
    this.requests++
    if (this.requests > 1) {
      log.warn(`${source} received again; forcing exit`)
      process.exit(130)
    }

    log.warn(`${source} received; aborting active OpenCode session and shutting down`)
    this.controller.abort(new UserAbortError(`${source} received`))
    this.forceTimer = setTimeout(() => {
      log.warn("Shutdown cleanup timed out; forcing exit")
      process.exit(130)
    }, 15_000)
    this.forceTimer.unref?.()
  }

  throwIfRequested() {
    if (this.aborted) throw this.abortError()
  }

  abortError(fallback?: unknown) {
    if (isUserAbortError(this.signal.reason)) return this.signal.reason
    if (isUserAbortError(fallback)) return fallback
    return new UserAbortError()
  }

  setActiveSession(session: ActiveSession) {
    this.activeSession = session
  }

  clearActiveSession(sessionID: string) {
    if (this.activeSession?.sessionID === sessionID) this.activeSession = undefined
  }

  async abortActiveSession(progress?: ProgressUI) {
    if (this.abortingSession) return this.abortingSession
    const session = this.activeSession
    if (!session) return

    this.abortingSession = (async () => {
      progress?.phaseActivity(session.phaseName, "aborting active OpenCode session")
      try {
        const response = await session.client.session.abort({ sessionID: session.sessionID, directory: session.directory })
        if (response.error) log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(response.error)}`)
      } catch (error) {
        log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(error)}`)
      }
    })().finally(() => {
      this.abortingSession = undefined
    })

    return this.abortingSession
  }

  dispose() {
    if (this.forceTimer) clearTimeout(this.forceTimer)
  }
}

function installShutdownSignals(shutdown: RunShutdown) {
  const handler = (signal: NodeJS.Signals) => shutdown.request(signal)
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

export async function run(options: RunOptions) {
  await ensureRepoReady(options.targetDir, { includeDirty: options.includeDirty, maxAttempts: options.maxAttempts })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined
  let progress: ProgressUI = noopProgress
  let permissions: PermissionGate | undefined
  const shutdown = new RunShutdown()
  const removeSignalHandlers = installShutdownSignals(shutdown)

  try {
    progress = await createProgressUI(progressPhases(options), options.tui, () => shutdown.request("Ctrl+C"))
    progress.start(workspace.runID, options.targetDir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`User attachments: ${extraFiles.map((file) => file.filename).join(", ")}`)
    const projectContextFiles = await discoverProjectContextFiles(options.targetDir)
    if (projectContextFiles.length > 0) log.info(`Project context: ${projectContextFiles.join(", ")}`)

    opencode = await startOpencode(opencodeConfig(workspace.dir, options.targetDir), shutdown.signal)
    progress.serverReady(opencode.url)
    log.info(`opencode SDK ready at ${opencode.url}`)

    permissions = startPermissionGate({
      client: opencode.client,
      progress,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    })

    for (const phase of phases) {
      shutdown.throwIfRequested()
      if (shouldSkip(phase.name, options)) {
        progress.phaseSkipped(phase.name)
        if (phase.name === "implementer" && options.humanReview) progress.phaseSkipped("human-review")
        log.warn(`[${phase.name}] skipped by flag`)
        continue
      }
      await runPhase(opencode.client, workspace, phase, options, extraFiles, projectContextFiles, progress, shutdown)
      if (phase.name === "implementer") await runHumanReviewGate(workspace, options, opencode.url, progress)
    }

    progress.message("writing run summary")
    await writeSummary(workspace, summaryReportNames(options.humanReview))
  } catch (error) {
    runErr = error
    throw error
  } finally {
    removeSignalHandlers()
    if (shutdown.aborted) await shutdown.abortActiveSession(progress)
    await permissions?.stop()
    progress.stop()
    opencode?.close()
    shutdown.dispose()

    if (runErr || options.keepRunDir) {
      log.warn(`Run dir preserved at ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
    }
  }
}

async function runPhase(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
  progress: ProgressUI,
  shutdown: RunShutdown,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles, projectContextFiles)
    const baseline = await createCleanRepoSnapshot(options.targetDir)
    const assistantText = await runPhaseWithRetries(client, workspace, phase, options.targetDir, prepared, baseline, progress, shutdown)

    const reportAbs = await persistPhaseReport(workspace, phase, assistantText)
    await commitPhase(phase, reportAbs, options.targetDir)
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

type PreparedPhaseRun = {
  attachments: FilePartInput[]
  prompt: string
  model: ModelSelection
  maxAttempts: number
}

type ModelSelection = { providerID: string; modelID: string; variant?: string }

async function preparePhaseRun(
  workspace: Workspace,
  phase: Phase,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
): Promise<PreparedPhaseRun> {
  const inputs = [...phase.inputFiles]
  if (phase.inputDiff) {
    const diffRel = join("diffs", `${phase.name}.pre.diff`)
    const diffAbs = join(workspace.dir, diffRel)
    await writeDiff(diffAbs, options.baseRef, options.targetDir)
    inputs.push(diffRel)
  }

  const phaseFiles = await fileParts(inputs, workspace.dir, "skip")
  const contextFiles = await projectContextFileParts(projectContextFiles, options.targetDir)
  const attachments = [...contextFiles, ...phaseFiles, ...extraFiles]
  const prompt = buildPhasePrompt(workspace, phase)
  const model = selectedModel(phase, options.modelOverride)
  const maxAttempts = Math.max(1, options.maxAttempts)

  return { attachments, prompt, model, maxAttempts }
}

async function projectContextFileParts(paths: string[], targetDir: string) {
  const out: FilePartInput[] = []
  for (const path of paths) {
    const parts = await fileParts([path], targetDir, "skip")
    out.push(...parts.map((part) => ({ ...part, filename: path })))
  }
  return out
}

async function runPhaseWithRetries(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
  progress: ProgressUI,
  shutdown: RunShutdown,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] can't retry with dirty working tree; use --max-attempts 1 or clean the repo`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    shutdown.throwIfRequested()
    progress.phaseRunning(phase.name, `attempt ${attempt}/${prepared.maxAttempts} ${formatModel(prepared.model)}`)
    log.info(`[${phase.name}] attempt ${attempt}/${prepared.maxAttempts} with ${formatModel(prepared.model)}`)
    try {
      return await runPhaseAttempt(client, workspace, phase, targetDir, prepared, attempt, progress, shutdown)
    } catch (error) {
      if (!shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts) && (shutdown.aborted || isUserAbortError(error))) {
        throw shutdown.abortError(error)
      }
      lastError = error
      progress.phaseRunning(phase.name, `attempt ${attempt} failed`)
      log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
      if (!(error instanceof LoggedAttemptError)) {
        await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
      }
      if (shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts)) await restorePhaseBaseline(phase, baseline, targetDir, error)
    }
  }

  if (lastError) {
    await restorePhaseBaseline(phase, baseline, targetDir, lastError)
    throw lastError
  }

  return ""
}

async function runPhaseAttempt(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
  progress: ProgressUI,
  shutdown: RunShutdown,
) {
  const result = await promptPhase(client, {
    phase,
    workspace,
    targetDir,
    prompt: prepared.prompt,
    model: prepared.model,
    attachments: prepared.attachments,
    progress,
    shutdown,
  })
  const assistantText = extractAssistantText(result.parts)

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.info.sessionID,
    agent: phase.agentName,
    model: prepared.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime, url: file.url })),
    finish: result.info.finish,
    cost: result.info.cost,
    tokens: result.info.tokens,
    error: result.info.error,
    text: assistantText,
  })

  if (result.info.error) throw new LoggedAttemptError(formatSdkError(result.info.error))

  return assistantText
}

async function persistPhaseReport(workspace: Workspace, phase: Phase, assistantText: string) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs)) && assistantText.trim() !== "") {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, assistantText)
  }

  if (!(await exists(reportAbs))) {
    log.warn(`[${phase.name}] agent didn't write the expected report at ${reportAbs}`)
  }

  return reportAbs
}

async function commitPhase(phase: Phase, reportAbs: string, targetDir: string) {
  const message = `archer(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
  } else {
    log.info(`[${phase.name}] commit: ${message}`)
  }
}

async function restorePhaseBaseline(phase: Phase, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
  if (!baseline) return
  try {
    await restoreRepoSnapshot(baseline, targetDir)
  } catch (restoreError) {
    throw new Error(
      `[${phase.name}] failed and couldn't restore git snapshot: ${formatSdkError(restoreError)}; original error: ${formatSdkError(
        originalError,
      )}`,
    )
  }
}

async function promptPhase(
  client: OpencodeClient,
  input: {
    phase: Phase
    workspace: Workspace
    targetDir: string
    prompt: string
    model: ModelSelection
    attachments: FilePartInput[]
    progress: ProgressUI
    shutdown: RunShutdown
  },
) {
  input.shutdown.throwIfRequested()
  const session = await client.session.create({
    directory: input.targetDir,
    title: `archer ${input.workspace.runID} ${input.phase.name}`,
  }, { signal: input.shutdown.signal })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")

  input.progress.phaseSession(input.phase.name, session.data.id)
  input.shutdown.setActiveSession({ client, sessionID: session.data.id, directory: input.targetDir, phaseName: input.phase.name })
  log.info(`[${input.phase.name}] session: ${session.data.id}`)

  const activity = await startSessionActivityMonitor(client, input.targetDir, input.phase.name, session.data.id, input.progress)

  try {
    const response = await client.session.prompt({
      sessionID: session.data.id,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [...input.attachments, { type: "text", text: input.prompt }],
    }, { signal: input.shutdown.signal })

    input.shutdown.throwIfRequested()
    if (response.error) throw new Error(formatSdkError(response.error))
    if (!response.data) throw new Error("opencode didn't return response")
    const usage = assistantUsage(response.data.info, session.data.id)
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsageForLog(usage)}`)
    }
    return response.data
  } finally {
    if (input.shutdown.aborted) await input.shutdown.abortActiveSession(input.progress)
    input.shutdown.clearActiveSession(session.data.id)
    await activity.stop()
  }
}

type SessionActivityMonitor = {
  stop(): Promise<void>
}

type ActivityState = {
  reasoningChars: number
  textChars: number
  textTail: string
  currentStepModel: string
  lastReasoningUpdate: number
  lastTextUpdate: number
  lastServerEvent: number
}

type ActivityDescription =
  | string
  | {
      message: string
      stepUsage?: ProgressStepUsage
    }

const serverHeartbeatMs = 30_000

async function startSessionActivityMonitor(
  client: OpencodeClient,
  directory: string,
  phaseName: string,
  sessionID: string,
  progress: ProgressUI,
): Promise<SessionActivityMonitor> {
  const controller = new AbortController()
  const state: ActivityState = {
    reasoningChars: 0,
    textChars: 0,
    textTail: "",
    currentStepModel: "",
    lastReasoningUpdate: 0,
    lastTextUpdate: 0,
    lastServerEvent: Date.now(),
  }

  try {
    const stream = await client.event.subscribe({ directory }, { signal: controller.signal })
    let heartbeatRunning = false
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted || heartbeatRunning || Date.now() - state.lastServerEvent < serverHeartbeatMs) return
      heartbeatRunning = true
      void (async () => {
        try {
          const response = await client.session.get({ sessionID, directory })
          if (controller.signal.aborted) return
          if (response.error) {
            progress.phaseActivity(phaseName, `server heartbeat failed: ${formatSdkError(response.error)}`)
            return
          }
          state.lastServerEvent = Date.now()
          progress.phaseActivity(phaseName, "server heartbeat ok; OpenCode is still working")
        } catch (error) {
          if (!controller.signal.aborted) progress.phaseActivity(phaseName, `server heartbeat failed: ${formatSdkError(error)}`)
        } finally {
          heartbeatRunning = false
        }
      })()
    }, serverHeartbeatMs)

    const listenerDone = (async () => {
      try {
        for await (const event of stream.stream) {
          if (controller.signal.aborted) return
          const payload = eventPayload(event)
          if (!payloadMatchesSession(payload, sessionID)) continue
          state.lastServerEvent = Date.now()
          const activity = describeSessionActivity(payload, state)
          if (typeof activity === "string") {
            progress.phaseActivity(phaseName, activity)
          } else if (activity) {
            if (activity.stepUsage) progress.phaseStepUsage(phaseName, activity.stepUsage)
            progress.phaseActivity(phaseName, activity.message)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) progress.phaseActivity(phaseName, `event stream stopped: ${formatSdkError(error)}`)
      }
    })()

    return {
      async stop() {
        controller.abort()
        clearInterval(heartbeat)
        try {
          await listenerDone
        } catch {
          // ignore shutdown races
        }
      },
    }
  } catch (error) {
    progress.phaseActivity(phaseName, `live events unavailable: ${formatSdkError(error)}`)
    return { async stop() {} }
  }
}

function eventPayload(event: unknown) {
  if (event && typeof event === "object" && "payload" in event) return (event as { payload?: unknown }).payload
  return event
}

function payloadProperties(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const properties = (payload as { properties?: unknown }).properties
  if (properties && typeof properties === "object") return properties as Record<string, unknown>
  const data = (payload as { data?: unknown }).data
  if (data && typeof data === "object") return data as Record<string, unknown>
  return undefined
}

function payloadType(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const type = (payload as { type?: unknown }).type
  if (typeof type === "string") return type === "sync" ? String((payload as { name?: unknown }).name ?? "").replace(/\.1$/, "") : type
  const name = (payload as { name?: unknown }).name
  return typeof name === "string" ? name.replace(/\.1$/, "") : ""
}

function payloadMatchesSession(payload: unknown, sessionID: string) {
  const properties = payloadProperties(payload)
  return properties?.sessionID === sessionID
}

function describeSessionActivity(payload: unknown, state: ActivityState): ActivityDescription | undefined {
  const type = payloadType(payload)
  const properties = payloadProperties(payload)
  if (!properties) return undefined
  const now = Date.now()

  switch (type) {
    case "session.next.prompted":
      return "prompt submitted"
    case "session.next.step.started":
      state.currentStepModel = formatModelFromEvent(properties.model)
      return `thinking with ${state.currentStepModel}`
    case "session.next.step.ended": {
      const message = `step finished: ${pickString(properties, ["finish"]) || "complete"}${formatCost(properties)}`
      const stepUsage = stepUsageFromEvent(payload, properties, state.currentStepModel)
      return stepUsage ? { message, stepUsage } : message
    }
    case "session.next.step.failed":
      return `step failed: ${formatEventError(properties.error)}`
    case "session.status":
      return formatSessionStatus(properties.status)
    case "session.idle":
      return "session idle"
    case "session.next.reasoning.started":
      state.reasoningChars = 0
      state.lastReasoningUpdate = now
      return "thinking..."
    case "session.next.reasoning.delta":
      state.reasoningChars += pickString(properties, ["delta"]).length
      if (now - state.lastReasoningUpdate < 1000) return undefined
      state.lastReasoningUpdate = now
      return `thinking (${state.reasoningChars} hidden chars)`
    case "session.next.reasoning.ended":
      return "thinking complete"
    case "session.next.text.started":
      state.textChars = 0
      state.textTail = ""
      state.lastTextUpdate = now
      return "writing response..."
    case "session.next.text.delta": {
      const delta = pickString(properties, ["delta"])
      state.textChars += delta.length
      state.textTail = `${state.textTail}${delta}`.slice(-160)
      if (now - state.lastTextUpdate < 350) return undefined
      state.lastTextUpdate = now
      return `writing response (${state.textChars} chars): ${state.textTail}`
    }
    case "session.next.text.ended":
      return `response complete (${pickString(properties, ["text"]).length || state.textChars} chars)`
    case "message.part.delta":
      return `streaming ${pickString(properties, ["field"]) || "message"}`
    case "session.next.tool.input.started":
      return `preparing ${pickString(properties, ["name"]) || "tool"}`
    case "session.next.tool.called":
      return `tool ${describeToolCall(properties)}`
    case "session.next.tool.progress":
      return `tool progress: ${describeToolContent(properties.content)}`
    case "session.next.tool.success":
      return `tool complete: ${describeToolContent(properties.content)}`
    case "session.next.tool.failed":
      return `tool failed: ${formatEventError(properties.error)}`
    case "session.next.shell.started":
      return `bash: ${pickString(properties, ["command"])}`
    case "session.next.shell.ended":
      return `bash complete: ${firstLine(pickString(properties, ["output"]))}`
    case "session.next.retried":
      return `provider retry ${properties.attempt ?? ""}: ${formatEventError(properties.error)}`
    case "session.next.compaction.started":
      return `compacting context (${pickString(properties, ["reason"]) || "auto"})`
    case "session.next.compaction.delta":
      return "compacting context..."
    case "session.next.compaction.ended":
      return "context compaction complete"
    case "permission.asked":
      return `permission requested: ${pickString(properties, ["permission"])}`
    case "permission.replied":
      return `permission ${pickString(properties, ["reply"])}`
    case "todo.updated":
      return `todo list updated (${Array.isArray(properties.todos) ? properties.todos.length : 0})`
    case "session.diff":
      return `diff updated (${Array.isArray(properties.diff) ? properties.diff.length : 0} files)`
    case "session.error":
      return `session error: ${formatEventError(properties.error)}`
    default:
      if (type.startsWith("session.next.")) return type.replace(/^session\.next\./, "")
      return undefined
  }
}

function formatModelFromEvent(value: unknown) {
  if (!value || typeof value !== "object") return "selected model"
  const model = value as { providerID?: unknown; id?: unknown; variant?: unknown }
  const provider = typeof model.providerID === "string" ? model.providerID : "provider"
  const id = typeof model.id === "string" ? model.id : "model"
  const variant = typeof model.variant === "string" && model.variant ? `#${model.variant}` : ""
  return `${provider}/${id}${variant}`
}

function formatCost(properties: Record<string, unknown>) {
  const tokens = tokensFromValue(properties.tokens)
  const cost = typeof properties.cost === "number" ? `, $${properties.cost.toFixed(4)}` : ""
  if (!tokens) return cost
  const reasoning = tokens.reasoning ? `/${tokens.reasoning}` : ""
  return `, tokens ${tokens.input}/${tokens.output}${reasoning}${cost}`
}

function stepUsageFromEvent(payload: unknown, properties: Record<string, unknown>, model: string): ProgressStepUsage | undefined {
  const usage = usageFromRecord(properties)
  if (!usage) return undefined
  return {
    ...usage,
    stepID: payloadID(payload),
    sessionID: typeof properties.sessionID === "string" ? properties.sessionID : undefined,
    model: model || usage.model,
  }
}

function assistantUsage(info: unknown, fallbackSessionID: string): ProgressUsage | undefined {
  if (!info || typeof info !== "object") return undefined
  const values = info as Record<string, unknown>
  const usage = usageFromRecord(values)
  if (!usage) return undefined
  const modelObject = values.model && typeof values.model === "object" ? (values.model as Record<string, unknown>) : {}
  const provider = typeof values.providerID === "string" ? values.providerID : typeof modelObject.providerID === "string" ? modelObject.providerID : ""
  const modelID = typeof values.modelID === "string" ? values.modelID : typeof modelObject.modelID === "string" ? modelObject.modelID : typeof modelObject.id === "string" ? modelObject.id : ""
  const variantValue = typeof values.variant === "string" ? values.variant : typeof modelObject.variant === "string" ? modelObject.variant : ""
  const variant = variantValue ? `#${variantValue}` : ""
  const model = provider && modelID ? `${provider}/${modelID}${variant}` : usage.model
  return {
    ...usage,
    sessionID: typeof values.sessionID === "string" ? values.sessionID : fallbackSessionID,
    model,
  }
}

function usageFromRecord(values: Record<string, unknown>): ProgressUsage | undefined {
  const cost = typeof values.cost === "number" && Number.isFinite(values.cost) ? values.cost : undefined
  const tokens = tokensFromValue(values.tokens)
  if (cost === undefined && !tokens) return undefined
  return { cost, tokens }
}

function tokensFromValue(value: unknown): ProgressTokens | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  const input = numberToken(tokens.input)
  const output = numberToken(tokens.output)
  const reasoning = numberToken(tokens.reasoning)
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const cacheRead = numberToken(cache.read)
  const cacheWrite = numberToken(cache.write)
  const total = typeof tokens.total === "number" && Number.isFinite(tokens.total) ? tokens.total : input + output + reasoning
  return { input, output, reasoning, cacheRead, cacheWrite, total }
}

function numberToken(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function payloadID(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const id = (payload as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function formatUsageForLog(usage: ProgressUsage) {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "cost unavailable"
  const tokens = usage.tokens ? `tokens ${usage.tokens.input}/${usage.tokens.output}${usage.tokens.reasoning ? `/${usage.tokens.reasoning}` : ""}` : "tokens unavailable"
  const model = usage.model ? ` model ${usage.model}` : ""
  return `${cost}, ${tokens}${model}`
}

function formatSessionStatus(value: unknown) {
  if (!value || typeof value !== "object") return "session status changed"
  const status = value as { type?: unknown; attempt?: unknown; message?: unknown }
  if (status.type === "busy") return "provider busy"
  if (status.type === "idle") return "provider idle"
  if (status.type === "retry") return `provider retry ${status.attempt ?? ""}: ${typeof status.message === "string" ? status.message : "waiting"}`
  return "session status changed"
}

function describeToolCall(properties: Record<string, unknown>) {
  const tool = pickString(properties, ["tool"]) || "tool"
  const input = properties.input && typeof properties.input === "object" ? (properties.input as Record<string, unknown>) : {}
  const target = pickString(input, ["command", "cmd", "filePath", "path", "pattern", "query", "url", "description"])
  return target ? `${tool}: ${target}` : tool
}

function describeToolContent(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "done"
  const text = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined
  if (typeof text?.text === "string" && text.text.trim()) return firstLine(text.text)
  const file = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "file") as { name?: unknown; uri?: unknown } | undefined
  if (typeof file?.name === "string") return file.name
  if (typeof file?.uri === "string") return file.uri
  return "done"
}

function formatEventError(value: unknown) {
  if (!value || typeof value !== "object") return String(value ?? "unknown error")
  const message = (value as { message?: unknown }).message
  if (typeof message === "string") return message
  const data = (value as { data?: unknown }).data
  if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") return (data as { message: string }).message
  return String((value as { name?: unknown; type?: unknown }).name ?? (value as { type?: unknown }).type ?? "unknown error")
}

function pickString(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === "string" && value.length > 0) return truncate(value, 220)
  }
  return ""
}

function firstLine(value: string) {
  return truncate(value.split("\n").find((line) => line.trim()) ?? "done", 220)
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}

function buildPhasePrompt(workspace: Workspace, phase: Phase) {
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    `- Write your final report to: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: the directory where `archer` was invoked (root of the target repo).",
    "",
    "## Attachments",
    "You will receive as file attachments: project context files when present, the original PRD, previous phase reports, the cumulative diff against the base branch, and any `--file` passed by the user. Read them before acting.",
    "",
    "## Project context",
    "Archer automatically attaches these target-repo files when they exist: `.archer/rules.md`, `AGENTS.md`, and `CLAUDE.md`.",
    "Read them before making changes. `.archer/rules.md` is the project-specific Archer contract unless it conflicts with Archer runtime safety guard rails.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    "1. Have applied necessary changes to the repo code.",
    "2. Have written the report (markdown, max ~80 lines) at the absolute path indicated above. If you can't write it, respond with the exact report content and Archer will save it.",
    "3. Leave the tree in a compilable state.",
    "",
    "Follow your system prompt instructions for everything else.",
  ].join("\n")
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`invalid model: ${value}`)
  return { providerID, modelID }
}

function selectedModel(phase: Phase, override: string): ModelSelection {
  const model = parseModel(override || phase.model)
  if (override || !phase.variant) return model
  return { ...model, variant: phase.variant }
}

function formatModel(model: ModelSelection) {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base}#${model.variant}` : base
}

export function shouldSkip(name: string, options: Pick<RunOptions, "onlyPhases" | "skipPhases">) {
  if (options.onlyPhases.length > 0) return !options.onlyPhases.includes(name)
  return options.skipPhases.includes(name)
}

function summaryReportNames(includeHumanReview: boolean) {
  return phases.flatMap((phase) => (phase.name === "implementer" && includeHumanReview ? [phase.name, "human-review"] : [phase.name]))
}

function progressPhases(options: RunOptions): ProgressPhase[] {
  return phases.flatMap((phase) => {
    const progressPhase: ProgressPhase = { name: phase.name, description: phase.description }
    if (phase.name === "implementer" && options.humanReview) {
      return [progressPhase, { name: "human-review", description: "Manual implementation checkpoint" }]
    }
    return [progressPhase]
  })
}

class LoggedAttemptError extends Error {}

function extractAssistantText(parts: Part[]) {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function summaryFromReport(path: string) {
  try {
    const content = await readFile(path, "utf8")
    for (const raw of content.split("\n")) {
      let line = raw.trim().replace(/^#+\s*/, "")
      if (!line) continue
      if (line.length > 72) line = line.slice(0, 72)
      return line
    }
  } catch {
    return "no summary"
  }
  return "no summary"
}

async function writeAttemptLog(workspace: Workspace, phase: Phase, attempt: number, payload: unknown) {
  await writeFile(join(workspace.dir, "logs", `${phase.name}.${attempt}.json`), JSON.stringify(payload, null, 2))
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data && "message" in data) return String((data as { message?: unknown }).message)
  }
  if (typeof error === "object" && error && "name" in error) return String((error as { name?: unknown }).name)
  return String(error)
}
