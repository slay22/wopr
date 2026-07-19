import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent"

import { agentToolNames, basePromptName, loadAgentPrompt } from "./agents"
import { type Attachment, fileParts, renderAttachments } from "./attachments"
import { addAllAndCommit, createCleanRepoSnapshot, dirtyFilesPreview, dirtyTreeError, ensureRepoReady, initializeRepoWithInitialCommit, removeWorktree, restoreRepoSnapshot, type RepoSnapshot, statusPorcelain, writeDiff } from "./git"
import { formatEvalForValidator, runEvaluation } from "./evaluate"
import { hookPhaseNames, hooksForPipeline, runHooks, type HookStage } from "./hooks"
import { runHumanReviewGate } from "./human"
import { log } from "./log"
import { formatValidatorFeedback, isStalled, planSignature } from "./loop"
import { parsePlan, parseValidatorReport, type Verdict } from "./plan-schema"
import { openRunMetadata, recordProgress, type RunMetadataStore } from "./metadata"
import { openOpencodeSessionWindow } from "./opencode"
import { createPhaseSession, lastAssistantText, type ModelSelection } from "./pi"
import { startPermissionGate, type PermissionGate } from "./permissions"
import { splitModelVariant, synthesizeReadOnlyAgents, validateStepFilters } from "./pipeline"
import {
  createProgressUI,
  noopProgress,
  type ActivityKind,
  type AutoAccept,
  type ProgressDiffSummary,
  type ProgressMessage,
  type ProgressPhase,
  type ProgressStepUsage,
  type ProgressTodo,
  type ProgressTokens,
  type ProgressUI,
  type ProgressUsage,
  type RunOutcome,
} from "./progress"
import { discoverProjectContextFiles } from "./project-context"
import type { AgentSpec, AgentStep, HookSet, HookSpec, LoopMeta, Pipeline, RunOptions, Step } from "./types"
import { addTokens, emptyTokens, tokensFromValue, CostTracker } from "./usage"
import { cleanupWorkspace, createWorkspace, resumeWorkspace, type Workspace, writeSummary } from "./workspace"
import { ConfigError } from "./config"

export type ActiveSession = {
  agentSession: AgentSession
  sessionID: string
  phaseName: string
}

export class BudgetExceededError extends Error {
  readonly phase: string
  readonly spent: number
  readonly budget: number
  constructor(phase: string, spent: number, budget: number) {
    super(`budget exceeded: $${spent.toFixed(4)} of $${budget.toFixed(2)} before "${phase}"`)
    this.name = "BudgetExceededError"
    this.phase = phase
    this.spent = spent
    this.budget = budget
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, phase: this.phase, spent: this.spent, budget: this.budget }
  }
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

/**
 * Whether an unhandled rejection is the known-benign abort that the opencode SDK
 * leaks when its SSE reader is cancelled (the reader rejects without being
 * awaited). Only these are safe to swallow at the process level; anything else is
 * a real fault and must stay visible. See main.ts's unhandledRejection handler.
 */
/** Module-level CostTracker for the current run. Set by run() before phases start, cleared after. */
export let currentCostTracker: CostTracker | undefined

export function isIgnorableRejection(reason: unknown): boolean {
  if (isUserAbortError(reason)) return true
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return true
    return /\baborted?\b/i.test(reason.message)
  }
  return false
}

export function shouldRetryAttempt(error: unknown, signal: AbortSignal, attempt: number, maxAttempts: number) {
  return !signal.aborted && !isUserAbortError(error) && attempt < maxAttempts
}

export class RunShutdown {
  private readonly controller = new AbortController()
  private readonly activeSessions = new Map<string, ActiveSession>()
  private abortingSessions: Promise<void> | undefined
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
      // ponytail: easter egg — write straight to stderr; TUI teardown is bypassed on
      // force-exit, so log.warn may be swallowed. Best-effort on a quit path.
      process.stderr.write("\nA STRANGE GAME.\nThe only winning move is not to play.\n\n")
      process.exit(130)
    }

    log.warn(`${source} received; aborting active OpenCode session(s) and shutting down`)
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
    this.activeSessions.set(session.phaseName, session)
  }

  clearActiveSession(phaseName: string, sessionID: string) {
    if (this.activeSessions.get(phaseName)?.sessionID === sessionID) this.activeSessions.delete(phaseName)
  }

  async abortActiveSessions(progress?: ProgressUI) {
    if (this.abortingSessions) return this.abortingSessions
    const sessions = [...this.activeSessions.values()]
    if (sessions.length === 0) return

    this.abortingSessions = (async () => {
      await Promise.allSettled(
        sessions.map(async (session) => {
          progress?.phaseActivity(session.phaseName, "aborting active session")
          try {
            await session.agentSession.abort()
          } catch (error) {
            log.warn(`couldn't abort session ${session.sessionID}: ${formatSdkError(error)}`)
          }
        }),
      )
    })().finally(() => {
      this.abortingSessions = undefined
    })

    return this.abortingSessions
  }

  dispose() {
    if (this.forceTimer) clearTimeout(this.forceTimer)
  }
}

/**
 * Groups the flat step list into batches the runner executes together: a
 * human gate is always its own batch, and consecutive agent steps sharing a
 * groupId (a `parallel:` block, or one step fanned out across `models:`) form
 * one batch that runs concurrently. Validation guarantees group members are
 * always contiguous, so a linear scan suffices.
 */
export function planBatches(steps: readonly Step[]): Step[][] {
  const batches: Step[][] = []
  for (const step of steps) {
    const last = batches[batches.length - 1]
    const lastFirst = last?.[0]
    if (step.type === "agent" && lastFirst?.type === "agent" && step.groupId !== undefined && lastFirst.groupId === step.groupId) {
      last.push(step)
    } else {
      batches.push([step])
    }
  }
  return batches
}

/** Every group member runs to completion before the pipeline fails; this aggregates their failures into one error. */
export class PhaseGroupError extends Error {
  readonly failures: { name: string; error: unknown }[]

  constructor(failures: { name: string; error: unknown }[]) {
    super(failures.map((failure) => `[${failure.name}] ${formatSdkError(failure.error)}`).join("; "))
    this.name = "PhaseGroupError"
    this.failures = failures
  }
}

type GitLock = <T>(job: () => Promise<T>) => Promise<T>

/**
 * Serializes git operations across concurrently-running phases in the same
 * group: their agent sessions run fully in parallel, but git.ts's mutating
 * calls (`git add`, `git commit`, `git reset --hard`) would otherwise race on
 * `.git/index.lock`. Forced-read-only group members never actually change the
 * tree, so this only ever arbitrates housekeeping, not real content conflicts.
 */
export function createGitLock(): GitLock {
  let tail: Promise<unknown> = Promise.resolve()
  return function withGitLock<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function installShutdownSignals(shutdown: RunShutdown) {
  // Bun delivers the numeric signal value to handlers; normalize for logs.
  const handler = (signal: NodeJS.Signals | number) =>
    shutdown.request(typeof signal === "number" ? (signal === 15 ? "SIGTERM" : signal === 2 ? "SIGINT" : `signal ${signal}`) : signal)
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

export async function run(options: RunOptions) {
  if (options.initRepo) {
    // Greenfield: create the repo/initial commit, then pin the diff base to that
    // root commit. wopr commits each phase onto the current branch, so leaving the
    // base as a moving ref (the "HEAD" a fresh repo resolves to) would make every
    // phase after the first diff against its own last commit — i.e. empty.
    const initialSha = await initializeRepoWithInitialCommit(options.targetDir, { baseRef: options.baseRef })
    if (initialSha) options.baseRef = initialSha
  }

  await ensureRepoReady(options.targetDir, {
    includeDirty: options.includeDirty,
    maxAttempts: options.maxAttempts,
    baseRef: options.baseRef,
    allowDirty: Boolean(options.resumeRunID),
  })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let progress: ProgressUI = noopProgress
  let permissions: PermissionGate | undefined
  let metadata: RunMetadataStore | undefined
  let hookSet = hooksForPipeline(options.hooks, options.pipeline.name)
  let pipelineNameForHooks = options.pipeline.name
  let postHooksStarted = false
  const shutdown = new RunShutdown()
  const removeSignalHandlers = installShutdownSignals(shutdown)

  const autoAccept: AutoAccept = { mode: options.yolo ? "all" : options.smart ? "smart" : "off" }
  // cli.ts always resolves a concrete model string (--smart-model → config →
  // --model → defaults.model), so smart mode never lacks a judge.
  const judgeModel = parseModel(splitModelVariant(options.smartJudgeModel).model)

  try {
    metadata = await openRunMetadata(workspace, options.targetDir, options.pipeline)
    // Resumed runs replay the pipeline frozen in their metadata, so the steps
    // (and thus --only/--skip names and required agents) come from there.
    const pipeline = metadata.pipeline
    pipelineNameForHooks = pipeline.name
    hookSet = hooksForPipeline(options.hooks, pipeline.name)
    validateStepFilters(pipeline, options)
    // Parallel/multi-model steps are forced read-only and point at a synthesized
    // "<agent>__ro" variant when their base agent isn't already read-only;
    // register those variants alongside the normal registry for this run.
    const agents = [...options.agents, ...synthesizeReadOnlyAgents(pipeline, options.agents)]
    ensureAgentsAvailable(pipeline, agents)
    // A run interrupted before its phase commit leaves the tree dirty; on resume
    // offer to commit that work as the interrupted phase and continue. Runs here,
    // before the TUI grabs the terminal, so the readline prompt stays visible.
    await maybeRecoverDirtyTree(workspace, metadata, options)
    progress = recordProgress(
      await createProgressUI(progressPhases(pipeline, hookSet), options.tui, () => shutdown.request("Ctrl+C"), autoAccept),
      metadata,
    )
    progress.start(workspace.runID, options.targetDir, workspace.dir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)
    if (options.yolo) {
      progress.message("YOLO enabled: ask-level permissions will be auto-allowed (denylist still applies); shift+tab toggles")
      log.warn("YOLO enabled: unknown non-denied commands will be auto-allowed")
    } else if (options.smart) {
      progress.message(`smart auto-accept enabled: ${formatModel(judgeModel)} judges each request; risky ones still prompt (shift+tab toggles)`)
      log.warn(`smart auto-accept enabled: ${formatModel(judgeModel)} will auto-allow requests it judges safe`)
    }

    if (!options.resumeRunID) {
      await runHooks("pre", hookSet.pre, {
        workspace,
        targetDir: options.targetDir,
        pipelineName: pipeline.name,
        prompt: options.prompt,
        progress,
        signal: shutdown.signal,
      })
    } else if (hookSet.pre.length > 0) {
      for (const name of hookPhaseNames("pre", hookSet.pre)) progress.phaseSkipped(name)
      progress.message("pre-hooks skipped while resuming an existing run")
      log.info("pre-hooks skipped on resume")
    }

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`User attachments: ${extraFiles.map((file) => file.filename).join(", ")}`)
    const projectContextFiles = await discoverProjectContextFiles(options.targetDir)
    if (projectContextFiles.length > 0) log.info(`Project context: ${projectContextFiles.join(", ")}`)

    // pi runs in-process: no server to boot. Sessions are created per phase.
    progress.serverReady("in-process (pi)")
    log.info("pi runtime ready (in-process)")

    permissions = startPermissionGate({
      progress,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      directory: options.targetDir,
      permissions: options.permissions,
      autoAccept,
      judgeModel,
    })

    const resuming = Boolean(options.resumeRunID)
    const gitLock = createGitLock()
    // No pi server to attach to; the interactive "open window" paths degrade
    // gracefully with an empty URL. ponytail: MVP drops live attach/mirror.
    const serverUrl = ""
    // Narrow once, outside any closure: metadata/permissions are `let`s assigned
    // above and TS won't retain that narrowing inside the batch's nested arrows.
    const runMetadata = metadata
    const permissionGate = permissions
    // Budget tracker: records cost per phase and enforces the cap.
    const costTracker = new CostTracker()
    currentCostTracker = costTracker

    // Budget check before each batch runs. Returns false when the budget is
    // exhausted and onExceed is "abort"; throws BudgetExceededError in that case.
    const checkBudget = (step: Step): boolean => {
      if (!options.budget || step.type !== "agent") return true
      const spent = costTracker.spent()
      const nextEstimate = costTracker.estimateNext(step.name, step.model)
      if (spent + nextEstimate <= options.budget.perRun) return true

      if (options.budget.onExceed === "warn-and-continue") {
        progress.message(`⚠ budget warning: $${spent.toFixed(4)} of $${options.budget.perRun.toFixed(2)} (${step.name} estimated $${nextEstimate.toFixed(4)})`)
        log.warn(`[budget] $${spent.toFixed(4)} + $${nextEstimate.toFixed(4)} > $${options.budget.perRun.toFixed(2)}, continuing per onExceed=warn-and-continue`)
        return true
      }

      log.warn(`[budget] aborting before ${step.name}: $${spent.toFixed(4)} + $${nextEstimate.toFixed(4)} > $${options.budget.perRun.toFixed(2)}`)
      progress.message(`budget exceeded: $${spent.toFixed(4)} of $${options.budget.perRun.toFixed(2)}`)
      throw new BudgetExceededError(step.name, spent, options.budget.perRun)
    }

    // One non-loop batch: a human gate, or a group of agent steps run concurrently.
    const runStandardBatch = async (batch: Step[]) => {
      const [first] = batch
      if (batch.length === 1 && first?.type === "human") {
        if (shouldSkip(first, options)) {
          progress.phaseSkipped(first.name)
          log.warn(`[${first.name}] skipped by flag`)
          return
        }
        await runHumanReviewGate(workspace, options, serverUrl, progress, permissionGate, first.name)
        return
      }

      const agentBatch = batch as AgentStep[]
      // Budget check: verify every step in this batch fits the budget before running.
      for (const step of agentBatch) {
        checkBudget(step)
      }
      // Update TUI with latest budget info
      if (options.budget && progress.updateBudget) {
        progress.updateBudget(options.budget, costTracker.spent())
      }
      const results = await Promise.allSettled(
        agentBatch.map(async (step) => {
          if (shouldSkip(step, options)) {
            progress.phaseSkipped(step.name)
            log.warn(`[${step.name}] skipped by flag`)
            return
          }
          const restored = resuming && (await restorePhaseFromPreviousRun(workspace, runMetadata, step, progress))
          if (!restored) {
            await runPhase(workspace, step, options, extraFiles, projectContextFiles, progress, shutdown, gitLock, permissionGate, { serverUrl, permissions: permissionGate })
          }
        }),
      )

      // Every batch member runs to completion (Promise.allSettled, not
      // fail-fast) since forced-read-only siblings can't corrupt each other's
      // work; a user abort takes priority and propagates unwrapped so the
      // existing isUserAbortError handling below keeps working.
      const userAbort = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && isUserAbortError(result.reason))
      if (userAbort) throw userAbort.reason
      const failures = results.flatMap((result, index) => (result.status === "rejected" ? [{ name: agentBatch[index]!.name, error: result.reason }] : []))
      if (failures.length > 0) throw new PhaseGroupError(failures)

      // Persist cost snapshot after each batch
      const snap = costTracker.snapshot()
      runMetadata.updateCost(snap)
    }

    const batches = planBatches(pipeline.steps)
    for (let index = 0; index < batches.length; index++) {
      shutdown.throwIfRequested()
      const batch = batches[index]!
      const first = batch[0]
      const loopId = first?.type === "agent" ? first.loopId : undefined

      if (loopId) {
        // A loop group is a contiguous run of batches sharing one loopId; collect them,
        // then hand the whole span to the converge driver.
        const loopBatches: Step[][] = []
        while (index < batches.length) {
          const next = batches[index]![0]
          if (next?.type === "agent" && next.loopId === loopId) loopBatches.push(batches[index++]!)
          else break
        }
        index-- // the for-loop's ++ resumes at the first batch after the loop span
        const meta = (pipeline.loops ?? []).find((loop) => loop.loopId === loopId)
        if (meta) {
          await runConvergeLoop(meta, loopBatches, {
            workspace,
            options,
            extraFiles,
            projectContextFiles,
            progress,
            shutdown,
            gitLock,
            permissions: permissionGate,
            serverUrl,
          })
        } else {
          for (const loopBatch of loopBatches) await runStandardBatch(loopBatch)
        }
        continue
      }

      await runStandardBatch(batch)
    }

    progress.message("writing run summary")
    await writeSummary(workspace, pipeline.steps.map((step) => step.name))
    postHooksStarted = true
    await runHooks("post", hookSet.post, {
      workspace,
      targetDir: options.targetDir,
      pipelineName: pipeline.name,
      prompt: options.prompt,
      status: "success",
      progress,
      signal: shutdown.signal,
    })
    await holdFinishScreen(progress, shutdown, { status: "completed", runDir: workspace.dir })
  } catch (error) {
    let failure = error
    if (!postHooksStarted && !isUserAbortError(failure)) {
      postHooksStarted = true
      try {
        await runHooks("post", hookSet.post, {
          workspace,
          targetDir: options.targetDir,
          pipelineName: pipelineNameForHooks,
          prompt: options.prompt,
          status: "failure",
          progress,
          signal: shutdown.signal,
        })
      } catch (hookError) {
        failure = new Error(`${formatSdkError(error)}; post-hook failed: ${formatSdkError(hookError)}`)
      }
    }
    runErr = failure
    if (!isUserAbortError(failure)) {
      await holdFinishScreen(progress, shutdown, { status: "failed", error: formatSdkError(failure), runDir: workspace.dir })
    }
    throw failure
  } finally {
    currentCostTracker = undefined
    removeSignalHandlers()
    if (shutdown.aborted) await shutdown.abortActiveSessions(progress)
    await permissions?.stop()
    // The server dies at the end of this block; clear its metadata entry now so
    // `wopr runs` stops offering to attach to a run that's shutting down.
    metadata?.serverStopped()
    await metadata?.flush().catch((error) => log.warn(`couldn't flush run metadata: ${String(error)}`))
    progress.stop()
    shutdown.dispose()

    if (runErr) {
      log.warn(`Run dir preserved at ${workspace.dir}`)
    } else if (options.keepRunDir || progress.keepRunDirRequested?.()) {
      log.info(`Run dir kept at ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
    }

    // Auto-clean the isolated worktree on success when the user opted out of
    // keeping it. The branch (and its commits) stay in the main repo; a failed
    // run always keeps the worktree so the work-in-progress is inspectable.
    if (options.worktree && !runErr && !options.keepWorktree) {
      await removeWorktree(options.worktree.mainRepo, options.worktree.dir)
        .then(() => log.info(`Removed worktree ${options.worktree!.dir} (branch kept)`))
        .catch((error) => log.warn(`couldn't remove worktree ${options.worktree!.dir}: ${String(error)} (kept)`))
    }
  }
}

// The finish screen holds the run open while the opencode server and the run
// dir are still alive, so [o] can attach to phase sessions and reports stay
// readable. A signal (SIGTERM, a second Ctrl+C) must still tear the run down
// without user input, hence the race against the shutdown signal.
async function holdFinishScreen(progress: ProgressUI, shutdown: RunShutdown, outcome: RunOutcome) {
  if (!progress.runFinished || shutdown.aborted) return
  await Promise.race([
    progress.runFinished(outcome),
    new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true })),
  ])
}

// A failed phase can still leave a report behind (the agent writes it
// mid-session before the commit step or a later attempt blows up), so the
// report's existence alone can't prove the phase finished: a phase the
// metadata marks as failed must retry, and its stale report must go first or
// persistPhaseReport would keep it on the rerun.
export async function restorePhaseFromPreviousRun(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  progress: ProgressUI,
): Promise<boolean> {
  if (await phaseNeedsRun(workspace, metadata, phase)) {
    // A failed phase can leave its report behind; drop it so persistPhaseReport
    // writes a fresh one on the rerun instead of keeping the stale one.
    const reportAbs = join(workspace.dir, phase.reportPath)
    if (await exists(reportAbs)) {
      await rm(reportAbs, { force: true })
      log.info(`[${phase.name}] failed in the previous run; retrying`)
    }
    return false
  }

  const snapshot = metadata.snapshot(phase.name)
  if (snapshot) progress.phaseRestored(phase.name, snapshot)
  else progress.phaseCompleted(phase.name, "already completed in previous run")
  log.info(`[${phase.name}] report exists; skipping on resume`)
  return true
}

// A phase still needs to run on resume when its report is missing (it never
// finished) or the metadata marks it failed (its report, if any, is stale).
async function phaseNeedsRun(workspace: Workspace, metadata: RunMetadataStore, phase: AgentStep): Promise<boolean> {
  if (!(await exists(join(workspace.dir, phase.reportPath)))) return true
  return metadata.snapshot(phase.name)?.status === "failed"
}

// The agent phase a resume would run next: the first one still needing a run,
// skipping human gates. The dirty tree belongs to whichever phase was
// interrupted before its commit, which is exactly that phase.
export async function selectInterruptedPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  pipeline: Pipeline,
): Promise<AgentStep | undefined> {
  for (const step of pipeline.steps) {
    if (step.type !== "agent") continue
    if (await phaseNeedsRun(workspace, metadata, step)) return step
  }
  return undefined
}

// On resume with a dirty tree, offer to commit the interrupted phase's leftover
// work and continue. Runs before the TUI starts so the prompt owns the terminal.
async function maybeRecoverDirtyTree(workspace: Workspace, metadata: RunMetadataStore, options: RunOptions) {
  if (!options.resumeRunID) return
  const porcelain = await statusPorcelain(options.targetDir)
  if (porcelain.trim() === "") return

  const dirty = () => dirtyTreeError(options.targetDir, porcelain, { resuming: true })
  const phase = await selectInterruptedPhase(workspace, metadata, metadata.pipeline)
  // No pending agent phase means the changes don't belong to an interrupted
  // phase (stray edits); leave them for the user rather than guess.
  if (!phase) throw dirty()
  if (!(stdin.isTTY && stdout.isTTY)) throw dirty()
  if (!(await confirmRecovery(phase.name, porcelain))) throw dirty()

  await commitRecoveredPhase(workspace, metadata, phase, options.targetDir)
}

async function confirmRecovery(phaseName: string, porcelain: string): Promise<boolean> {
  stdout.write(`Resume found uncommitted changes from interrupted phase "${phaseName}":\n${dirtyFilesPreview(porcelain)}\n`)
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // Raw-mode readline swallows the process SIGINT and emits this event instead;
  // without it Ctrl+C at the prompt would hang.
  rl.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  try {
    const answer = (await rl.question(`commit changes as '${phaseName}' and continue? [y/N] > `, { signal: controller.signal })).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } catch (error) {
    if (interrupted) throw new UserAbortError("Ctrl+C received")
    throw error
  } finally {
    rl.close()
  }
}

// Treats the dirty tree as the interrupted phase's output: writes a recovery
// report if the phase never wrote one, commits everything as that phase, and
// marks it completed so the resume loop skips it and runs the rest.
export async function commitRecoveredPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  targetDir: string,
) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs))) {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, recoveryReport(phase.name))
  }

  const committed = await addAllAndCommit(`wopr(${phase.name}): ${await summaryFromReport(reportAbs)}`, targetDir)
  if (committed) log.info(`[${phase.name}] recovered uncommitted changes into a commit; continuing from the next phase`)
  else log.warn(`[${phase.name}] nothing to commit during recovery`)

  metadata.phaseEnded(phase.name, "completed")
  await metadata.flush()
}

function recoveryReport(phaseName: string) {
  return [
    "# Recovered uncommitted changes",
    "",
    `Phase "${phaseName}" was interrupted before wopr committed its work. The`,
    "uncommitted changes left in the working tree were committed as this phase during a",
    "manual resume recovery, and the pipeline continued from the next phase.",
    "",
  ].join("\n")
}

/** What the mid-step interactive gate needs to reopen the session window and hold permission prompts. */
export type TakeoverContext = {
  serverUrl: string
  permissions?: PermissionGate
}

async function runPhase(
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: Attachment[],
  projectContextFiles: string[],
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  permissions: PermissionGate,
  takeover?: TakeoverContext,
  /** Throws on an unusable final report (e.g. malformed loop JSON), which makes the phase retry. */
  validateOutput?: (text: string) => void,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles, projectContextFiles)
    const baseline = await gitLock(() => createCleanRepoSnapshot(options.targetDir))
    const assistantText = await runPhaseWithRetries(workspace, phase, options.targetDir, prepared, baseline, progress, shutdown, gitLock, permissions, takeover, validateOutput)

    const reportAbs = await persistPhaseReport(workspace, phase, assistantText)
    await gitLock(() => commitPhase(phase, reportAbs, options.targetDir))
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

type LoopDeps = {
  workspace: Workspace
  options: RunOptions
  extraFiles: Attachment[]
  projectContextFiles: string[]
  progress: ProgressUI
  shutdown: RunShutdown
  gitLock: GitLock
  permissions: PermissionGate
  serverUrl: string
}

/**
 * Drives a converge-loop group: run plan → implement → validate, gate on the validator's
 * verdict (and the optional build/test evaluation), and re-run — feeding the findings back to
 * the planner — until it PASSes, `maxIterations` is hit, or the plan stalls (same plan + no
 * verdict improvement). Each iteration's phases commit as usual, so iterations accumulate.
 *
 * ponytail: loops re-run their phases in place (the TUI rows just update); resuming mid-loop
 * re-runs the whole loop rather than restoring per-iteration reports. Fine for the MVP.
 */
async function runConvergeLoop(loop: LoopMeta, loopBatches: Step[][], deps: LoopDeps) {
  const { workspace, options, extraFiles, projectContextFiles, progress, shutdown, gitLock, permissions, serverUrl } = deps
  let prevPlanSig: string | undefined
  let prevVerdict: Verdict | undefined
  let converged = false

  for (let iteration = 1; iteration <= loop.maxIterations; iteration++) {
    shutdown.throwIfRequested()
    progress.loopState?.({ loopId: loop.loopId, iteration, maxIterations: loop.maxIterations, status: "running" })
    if (iteration > 1) {
      progress.message(`[${loop.loopId}] iteration ${iteration}/${loop.maxIterations}`)
      log.info(`[${loop.loopId}] iteration ${iteration}/${loop.maxIterations}`)
    }
    // Keep the dashboard budget meter current during the loop.
    if (options.budget && progress.updateBudget) {
      progress.updateBudget(options.budget, currentCostTracker?.spent() ?? 0)
    }

    for (const batch of loopBatches) {
      for (const step of batch as AgentStep[]) {
        // Converge loops bypass runStandardBatch, so re-apply the budget cap here
        // or the loop could spend without limit. Mirrors the check in runStandardBatch.
        if (options.budget) {
          const spent = currentCostTracker?.spent() ?? 0
          const nextEstimate = currentCostTracker?.estimateNext(step.name, step.model) ?? 0.001
          if (spent + nextEstimate > options.budget.perRun) {
            if (options.budget.onExceed === "warn-and-continue") {
              progress.message(`⚠ budget warning: $${spent.toFixed(4)} of $${options.budget.perRun.toFixed(2)} (${step.name} estimated $${nextEstimate.toFixed(4)})`)
              log.warn(`[budget] $${spent.toFixed(4)} + $${nextEstimate.toFixed(4)} > $${options.budget.perRun.toFixed(2)}, continuing per onExceed=warn-and-continue`)
            } else {
              log.warn(`[budget] aborting before ${step.name}: $${spent.toFixed(4)} + $${nextEstimate.toFixed(4)} > $${options.budget.perRun.toFixed(2)}`)
              progress.message(`budget exceeded: $${spent.toFixed(4)} of $${options.budget.perRun.toFixed(2)}`)
              throw new BudgetExceededError(step.name, spent, options.budget.perRun)
            }
          }
        }
        if (shouldSkip(step, options)) {
          progress.phaseSkipped(step.name)
          continue
        }
        // Validate the structured output inline so malformed JSON retries within the phase.
        const validateOutput =
          step.loopRole === "plan"
            ? (text: string) => void parsePlan(text)
            : step.loopRole === "validate"
              ? (text: string) => void parseValidatorReport(text)
              : undefined
        await runPhase(workspace, step, options, extraFiles, projectContextFiles, progress, shutdown, gitLock, permissions, { serverUrl, permissions }, validateOutput)
      }
    }

    // Optional build/test gate; a failure blocks PASS and is fed back to the planner.
    const evalResult = loop.evaluation ? await runEvaluation(options.targetDir, loop.evaluation, shutdown.signal) : undefined
    if (evalResult?.ran) log.info(`[${loop.loopId}] evaluation ${evalResult.passed ? "passed" : "FAILED"}`)

    const report = await readLoopReport(workspace, loop.validateName, parseValidatorReport)
    const plan = await readLoopReport(workspace, loop.planName, parsePlan)
    const currVerdict: Verdict = evalResult?.ran && !evalResult.passed ? "REJECT" : (report?.verdict ?? "REJECT")
    const currPlanSig = plan ? planSignature(plan) : ""

    const loopBase = { loopId: loop.loopId, iteration, maxIterations: loop.maxIterations, verdict: currVerdict }
    if (currVerdict === "PASS") {
      converged = true
      progress.loopState?.({ ...loopBase, status: "converged" })
      progress.message(`[${loop.loopId}] converged (PASS) after ${iteration} iteration${iteration === 1 ? "" : "s"}`)
      break
    }
    if (iteration >= loop.maxIterations) {
      progress.loopState?.({ ...loopBase, status: "exhausted" })
      break
    }
    if (isStalled({ prevPlanSig, currPlanSig, prevVerdict, currVerdict })) {
      progress.loopState?.({ ...loopBase, status: "stalled" })
      progress.message(`[${loop.loopId}] no progress (same plan, verdict ${currVerdict}); stopping after ${iteration} iterations — how about a nice game of chess?`)
      log.warn(`[${loop.loopId}] stalled after ${iteration} iterations`)
      break
    }
    progress.loopState?.({ ...loopBase, status: "replanning" })

    const feedback = [report ? formatValidatorFeedback(report) : `Verdict: ${currVerdict} (validator report unavailable)`, evalResult ? formatEvalForValidator(evalResult) : ""]
      .filter(Boolean)
      .join("\n\n")
    await writeLoopFeedback(workspace, loop.loopId, feedback)
    prevPlanSig = currPlanSig
    prevVerdict = currVerdict
  }

  if (!converged) {
    progress.message(`[${loop.loopId}] did not converge to PASS; leaving the latest attempt in place`)
    log.warn(`[${loop.loopId}] did not converge to PASS`)
  }
}

async function readLoopReport<T>(workspace: Workspace, stepName: string, parse: (text: string) => T): Promise<T | undefined> {
  try {
    return parse(await readFile(join(workspace.dir, "reports", `${stepName}.md`), "utf8"))
  } catch (error) {
    log.warn(`[loop] couldn't read/parse "${stepName}" report: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function writeLoopFeedback(workspace: Workspace, loopId: string, feedback: string) {
  const path = join(workspace.dir, "loops", loopId, "feedback.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `# Previous attempt — validator findings\n\n${feedback}\n`)
}

type PreparedPhaseRun = {
  attachments: Attachment[]
  prompt: string
  model: ModelSelection
  maxAttempts: number
  timeoutMs: number
}

async function preparePhaseRun(
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: Attachment[],
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
  if (phase.timeoutSeconds !== undefined && phase.timeoutSeconds <= 0) {
    throw new ConfigError(`step "${phase.name}": timeoutSeconds must be a positive number, got ${phase.timeoutSeconds}`)
  }
  const timeoutSeconds = phase.timeoutSeconds ?? 1800
  const timeoutMs = timeoutSeconds * 1000
  const maxAttempts = Math.max(1, phase.maxAttempts ?? options.maxAttempts)

  return { attachments, prompt, model, maxAttempts, timeoutMs }
}

async function projectContextFileParts(paths: string[], targetDir: string) {
  const out: Attachment[] = []
  for (const path of paths) {
    const parts = await fileParts([path], targetDir, "skip")
    out.push(...parts.map((part) => ({ ...part, filename: path })))
  }
  return out
}

async function runPhaseWithRetries(
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  permissions: PermissionGate,
  takeover?: TakeoverContext,
  validateOutput?: (text: string) => void,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] can't retry with dirty working tree; use --max-attempts 1 or clean the repo`)
  }

  let lastError: unknown
  const sessionRef: SessionRef = {}
  // Read fresh at each decision point: the user can arm/disarm [i] mid-attempt.
  const armed = () => Boolean(takeover && progress.isInteractiveTakeover?.(phase.name))

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    shutdown.throwIfRequested()
    progress.phaseAttempt(phase.name, { attempt, maxAttempts: prepared.maxAttempts, model: formatModel(prepared.model) })
    log.info(`[${phase.name}] attempt ${attempt}/${prepared.maxAttempts} with ${formatModel(prepared.model)}`)
    try {
      const assistantText = await runPhaseAttempt(workspace, phase, targetDir, prepared, attempt, progress, shutdown, permissions, sessionRef)
      // A malformed structured report (loop plan/verdict JSON) throws here so the
      // attempt is treated as a failure and the model is re-asked, up to maxAttempts.
      if (validateOutput) validateOutput(assistantText)
      if (armed()) {
        // Armed means "this step is mine": even a clean finish waits for the
        // user's decision before the step commits and the pipeline moves on.
        log.info(`[${phase.name}] attempt succeeded with interactive mode armed; waiting for manual action`)
        await waitForInteractiveGate(phase.name, targetDir, sessionRef.id, takeover!, progress)
      }
      return assistantText
    } catch (error) {
      if (!shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts) && (shutdown.aborted || isUserAbortError(error))) {
        throw shutdown.abortError(error)
      }
      if (armed()) {
        // The user took over (typically esc in the attached OpenCode window):
        // no retry and no baseline restore — their manual work must survive.
        log.info(`[${phase.name}] attempt ended with interactive mode armed (${formatSdkError(error)}); waiting for manual action`)
        if (!(error instanceof LoggedAttemptError)) {
          await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
        }
        await waitForInteractiveGate(phase.name, targetDir, sessionRef.id, takeover!, progress)
        return ""
      }
      lastError = error
      progress.phaseRunning(phase.name, `attempt ${attempt} failed`)
      log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
      if (!(error instanceof LoggedAttemptError)) {
        await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
      }
      if (shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts)) await gitLock(() => restorePhaseBaseline(phase, baseline, targetDir, error))
    }
  }

  if (lastError) {
    await gitLock(() => restorePhaseBaseline(phase, baseline, targetDir, lastError))
    throw lastError
  }

  return ""
}

/** Last session created for the phase's attempts, so the interactive gate can reopen its window. */
type SessionRef = { id?: string }

type InteractiveGateDeps = { openWindow: typeof openOpencodeSessionWindow }

/**
 * The mid-step gate for phases armed with [i]: holds the pipeline until the
 * user picks continue (commit whatever the tree holds and move on), reopens
 * the session window on iterate, or aborts the run — leaving the working tree
 * untouched either way. Permission prompts stay paused while it waits, since
 * the user's attached OpenCode TUI answers its own.
 */
export async function waitForInteractiveGate(
  phaseName: string,
  targetDir: string,
  sessionID: string | undefined,
  takeover: TakeoverContext,
  progress: ProgressUI,
  deps: InteractiveGateDeps = { openWindow: openOpencodeSessionWindow },
): Promise<void> {
  const ask = progress.askHumanReview?.bind(progress)
  if (!ask) return // no dashboard, no gate: arming is impossible without the TUI anyway

  progress.phaseRunning(phaseName, "interactive session — waiting for your decision")
  let iterations = 0
  takeover.permissions?.pause()
  try {
    for (;;) {
      const action = await ask({ stepName: phaseName, iterations, kind: "interactive" })
      if (action === "continue") return
      if (action === "abort") throw new UserAbortError("aborted from interactive session gate")

      iterations++
      if (!sessionID) {
        progress.phaseActivity(phaseName, "no session to reopen; use the OpenCode window you already have", "info")
        continue
      }
      try {
        const backend = await deps.openWindow({ url: takeover.serverUrl, targetDir, sessionID })
        progress.phaseActivity(phaseName, `session reopened in ${backend}; return here and press c to continue`, "system")
      } catch (error) {
        progress.phaseActivity(phaseName, `couldn't reopen the session window: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }
  } finally {
    takeover.permissions?.resume()
  }
}

async function runPhaseAttempt(
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
  progress: ProgressUI,
  shutdown: RunShutdown,
  permissions: PermissionGate,
  sessionRef?: SessionRef,
) {
  const result = await promptPhase({
    phase,
    workspace,
    targetDir,
    prompt: prepared.prompt,
    model: prepared.model,
    attachments: prepared.attachments,
    progress,
    shutdown,
    permissions,
    sessionRef,
    timeoutMs: prepared.timeoutMs,
  })

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.sessionID,
    agent: phase.agentName,
    model: prepared.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime })),
    finish: result.finish,
    cost: result.usage?.cost,
    tokens: result.usage?.tokens,
    error: result.error,
    text: result.text,
  })

  if (result.error) throw new LoggedAttemptError(result.error)

  return result.text
}

async function persistPhaseReport(workspace: Workspace, phase: AgentStep, assistantText: string) {
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

async function commitPhase(phase: AgentStep, reportAbs: string, targetDir: string) {
  const message = `wopr(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
  } else {
    log.info(`[${phase.name}] commit: ${message}`)
  }
}

async function restorePhaseBaseline(phase: AgentStep, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
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

async function promptPhase(input: {
  phase: AgentStep
  workspace: Workspace
  targetDir: string
  prompt: string
  model: ModelSelection
  attachments: Attachment[]
  progress: ProgressUI
  shutdown: RunShutdown
  permissions: PermissionGate
  sessionRef?: SessionRef
  timeoutMs: number
}): Promise<SessionResult> {
  input.shutdown.throwIfRequested()
  const systemPrompt = loadAgentPrompt(basePromptName(input.phase.agentName), input.targetDir)
  const session = await createPhaseSession({
    cwd: input.targetDir,
    model: input.model,
    systemPrompt,
    toolNames: agentToolNames(input.phase.readOnly),
    // The bash policy / safety judge / human prompt all live in this hook.
    extensions: [input.permissions.extension],
    // In-memory: the run dir + git history are wopr's source of truth; pi's
    // JSONL session isn't consumed anywhere in the MVP.
    sessionManager: SessionManager.inMemory(input.targetDir),
  })
  const sessionID = session.sessionId
  if (input.sessionRef) input.sessionRef.id = sessionID
  input.progress.phaseSession(input.phase.name, sessionID)
  input.shutdown.setActiveSession({ agentSession: session, sessionID, phaseName: input.phase.name })
  log.info(`[${input.phase.name}] session: ${sessionID}`)

  const inputStartTime = Date.now()

  const state = newActivityState()
  const unsubscribe = session.subscribe((event) => {
    const signal = describePiActivity(event, state)
    if (signal) input.progress.phaseActivity(input.phase.name, signal.message, signal.kind, signal.pulse)
    const chunk = describePiChunk(event)
    if (chunk) input.progress.phaseMessage(input.phase.name, chunk)
  })

  // Set up per-phase timeout + shutdown signal composition
  const phaseSignal = composePhaseSignal(input.shutdown.signal, input.timeoutMs)
  const onPhaseAbort = () => {
    session.abort().catch(() => {})
  }
  if (!phaseSignal.signal.aborted) {
    phaseSignal.signal.addEventListener("abort", onPhaseAbort, { once: true })
  }

  try {
    input.shutdown.throwIfRequested()
    // pi's prompt() resolves when the run completes (no server, no SSE, so none
    // of OpenCode's reconnect/poll machinery is needed); waitForIdle covers any
    // trailing retry/compaction settle.
    await session.prompt(`${input.prompt}${renderAttachments(input.attachments)}`)
    await session.waitForIdle()
    input.shutdown.throwIfRequested()
    // If the phase signal fired (timeout) but the SDK didn't reject, catch it here
    if (phaseSignal.signal.aborted) {
      throw phaseSignal.signal.reason ?? new Error(`phase "${input.phase.name}" timed out`)
    }

    const error = session.state.errorMessage
    const usage = usageFromStats(session, sessionID, formatModel(input.model))
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsage(usage)}`)
      // Record cost entry in the global cost tracker
      if (currentCostTracker && usage.cost !== undefined && usage.tokens) {
        currentCostTracker.record({
          phase: input.phase.name,
          agent: input.phase.agentName,
          model: formatModel(input.model),
          inputTokens: usage.tokens.input,
          outputTokens: usage.tokens.output,
          cacheReadTokens: usage.tokens.cacheRead,
          cacheWriteTokens: usage.tokens.cacheWrite,
          inputCost: (usage.tokens.input / 1_000_000) * 0, // approximated from total
          outputCost: (usage.tokens.output / 1_000_000) * 0,
          cacheReadCost: (usage.tokens.cacheRead / 1_000_000) * 0,
          cacheWriteCost: (usage.tokens.cacheWrite / 1_000_000) * 0,
          totalCost: usage.cost,
          durationMs: Date.now() - inputStartTime,
          timestamp: Date.now(),
        })
      }
    }
    return { text: lastAssistantText(session), error, usage, sessionID, finish: error ? "error" : "stop" }
  } catch (error) {
    if (phaseSignal.signal.aborted && !input.shutdown.aborted && !isUserAbortError(error)) {
      // The phase timed out (not a user abort), surface the timeout error
      throw phaseSignal.signal.reason ?? new Error(`phase "${input.phase.name}" timed out`)
    }
    if (!input.shutdown.aborted && !isUserAbortError(error)) {
      try {
        await session.abort()
      } catch {
        // best-effort
      }
    }
    throw error
  } finally {
    phaseSignal.cleanup()
    // { once: true } auto-removes onPhaseAbort; no removeEventListener needed.
    unsubscribe()
    if (input.shutdown.aborted) await input.shutdown.abortActiveSessions(input.progress)
    input.shutdown.clearActiveSession(input.phase.name, sessionID)
    session.dispose()
  }
}

type SessionResult = {
  text: string
  finish?: string
  error?: string
  usage?: ProgressUsage
  sessionID: string
}

type ActivityState = {
  reasoningChars: number
  textChars: number
  textTail: string
  lastReasoningUpdate: number
  lastTextUpdate: number
}

export function newActivityState(): ActivityState {
  return { reasoningChars: 0, textChars: 0, textTail: "", lastReasoningUpdate: 0, lastTextUpdate: 0 }
}

type SessionSignal = { kind: ActivityKind; message: string; pulse?: boolean }

function activity(kind: ActivityKind, message: string): SessionSignal {
  return { kind, message }
}

/**
 * Summarized one-line activity for the dashboard status line, translated from a
 * pi AgentSessionEvent. Deltas are throttled so the line updates smoothly rather
 * than once per token. Returns undefined for events with nothing to surface.
 */
export function describePiActivity(event: AgentSessionEvent, state: ActivityState): SessionSignal | undefined {
  const now = Date.now()
  switch (event.type) {
    case "agent_start":
      return activity("info", "prompt submitted")
    case "turn_start":
      return activity("step", "working")
    case "tool_execution_start":
      return activity(event.toolName === "bash" ? "bash" : "tool", describeToolStart(event.toolName, event.args))
    case "tool_execution_end":
      return event.isError ? activity("error", `tool failed: ${event.toolName}`) : undefined
    case "message_update": {
      const ev = event.assistantMessageEvent
      if (ev.type === "thinking_delta") {
        state.reasoningChars += ev.delta.length
        if (now - state.lastReasoningUpdate < 1000) return undefined
        state.lastReasoningUpdate = now
        return activity("think", `thinking… ${formatCharCount(state.reasoningChars)} hidden chars`)
      }
      if (ev.type === "text_delta") {
        state.textChars += ev.delta.length
        state.textTail = `${state.textTail}${ev.delta}`.slice(-160)
        if (now - state.lastTextUpdate < 350) return undefined
        state.lastTextUpdate = now
        return activity("write", `writing (${formatCharCount(state.textChars)}): ${state.textTail}`)
      }
      return undefined
    }
    case "auto_retry_start":
      return activity("retry", `provider retry ${event.attempt}: ${event.errorMessage}`)
    case "compaction_start":
      return activity("info", "compacting context…")
    default:
      return undefined
  }
}

/**
 * Verbatim model output for the live transcript, kept separate from the
 * summarized activity line so the transcript stays untouched by throttling.
 */
export function describePiChunk(event: AgentSessionEvent): ProgressMessage | undefined {
  if (event.type === "message_update") {
    const ev = event.assistantMessageEvent
    if (ev.type === "thinking_delta" && ev.delta) return { channel: "reasoning", text: ev.delta }
    if (ev.type === "text_delta" && ev.delta) return { channel: "response", text: ev.delta }
    return undefined
  }
  if (event.type === "tool_execution_start") {
    if (event.toolName === "bash") {
      const command = typeof (event.args as { command?: unknown })?.command === "string" ? (event.args as { command: string }).command : ""
      return command ? { channel: "bash", text: command } : undefined
    }
    return { channel: "tool", text: describeToolStart(event.toolName, event.args) }
  }
  return undefined
}

function describeToolStart(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  const target = pickString(input, ["command", "cmd", "filePath", "path", "pattern", "query", "url", "description"])
  return target ? `${toolName}: ${target}` : toolName
}

function usageFromStats(session: AgentSession, sessionID: string, model: string): ProgressUsage {
  const stats = session.getSessionStats()
  const t = stats.tokens
  const tokens: ProgressTokens = {
    input: t.input,
    output: t.output,
    reasoning: 0,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    total: t.total,
  }
  return { cost: stats.cost, tokens, sessionID, model }
}

function formatUsage(usage: ProgressUsage) {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "cost unavailable"
  const tokens = usage.tokens ? `tokens ${usage.tokens.input}/${usage.tokens.output}` : "tokens unavailable"
  return `${cost}, ${tokens}${usage.model ? ` model ${usage.model}` : ""}`
}

function formatCharCount(value: number) {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function pickString(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === "string" && value.length > 0) return truncate(value, 220)
  }
  return ""
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/**
 * Composes a parent (shutdown) signal with a per-phase timeout into a single
 * AbortSignal. The returned signal fires when either the parent aborts or the
 * timeout elapses.
 *
 * The caller should listen for abort on the returned signal and call
 * session.abort() to interrupt the SDK, since pi's session.prompt() does not
 * accept an AbortSignal directly.
 *
 * The listener uses { once: true } so it auto-removes on fire; cleanup only
 * needs clearTimeout.
 */
export function composePhaseSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()

  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason)
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true })
    }
  }

  const timeout = setTimeout(() => controller.abort(new Error(`phase timed out after ${timeoutMs}ms`)), timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      // { once: true } auto-removes onParentAbort on fire; idempotent if never fired.
    },
  }
}

function buildPhasePrompt(workspace: Workspace, phase: AgentStep) {
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    phase.readOnly
      ? `- Report: WOPR saves your report itself as ${phase.reportPath}; you do not (and cannot) write it.`
      : `- Write your final report to: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: the directory where `wopr` was invoked (root of the target repo).",
    "",
    "## Access mode",
    phase.readOnly
      ? "This phase is read-only: WOPR gives you no write, edit, or bash tools, and that is expected — do not try to write any file, and do not apologize for or comment on being unable to. WOPR saves your report itself by concatenating the text you emit and storing it verbatim, so your visible output for this phase must be the report and nothing else: no preamble (\"I'll review…\", \"Let me write the report…\"), no step-by-step narration, and no closing note about writing. Keep any planning in your private reasoning; begin your visible output at the report's first line (e.g. the `#` heading)."
      : "This phase may edit the target repository when the phase-specific instructions call for it.",
    "",
    "## Attachments",
    "You will receive as file attachments: project context files when present, the original PRD, previous phase reports, the cumulative diff against the base branch, and any `--file` passed by the user. Read them before acting.",
    "",
    "## Project context",
    "WOPR automatically attaches these target-repo files when they exist: `.wopr/rules.md`, `AGENTS.md`, and `CLAUDE.md`.",
    "Read them before making changes. `.wopr/rules.md` is the project-specific WOPR contract unless it conflicts with WOPR runtime safety guard rails.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    phase.readOnly ? "1. Have not modified the target repository." : "1. Have applied necessary changes to the repo code.",
    phase.readOnly
      ? "2. Make the report (markdown, max ~80 lines) your entire visible output — WOPR persists it for you. Nothing before or after it."
      : "2. Have written the report (markdown, max ~80 lines) at the absolute path indicated above. If you can't write it, respond with the exact report content and WOPR will save it.",
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

function selectedModel(phase: AgentStep, override: string): ModelSelection {
  if (override) {
    const { model, variant } = splitModelVariant(override)
    return { ...parseModel(model), ...(variant ? { variant } : {}) }
  }
  const model = parseModel(phase.model)
  return phase.variant ? { ...model, variant: phase.variant } : model
}

function formatModel(model: ModelSelection) {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base}#${model.variant}` : base
}

// A fanned-out step (name "clean-code__anthropic-claude-opus-4-7") matches
// --only/--skip by its full name or by its shared stepName ("clean-code"),
// so a filter can target one variant or every variant of a fanned-out step.
export function shouldSkip(step: Step, options: Pick<RunOptions, "onlySteps" | "skipSteps">) {
  const names = step.type === "agent" ? [step.name, step.stepName] : [step.name]
  if (options.onlySteps.length > 0) return !names.some((name) => options.onlySteps.includes(name))
  return names.some((name) => options.skipSteps.includes(name))
}

// A resumed run can outlive its config: the frozen pipeline may reference a
// project agent that has since been renamed or removed. Fail before any
// session starts instead of mid-pipeline.
function ensureAgentsAvailable(pipeline: Pipeline, agents: readonly AgentSpec[]) {
  const available = new Set(agents.map((agent) => agent.name))
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || available.has(step.agentName)) continue
    throw new Error(`pipeline "${pipeline.name}" needs agent "${step.agentName}", which is not defined (removed from .wopr/config.yaml?)`)
  }
}

export function progressPhases(pipeline: Pipeline, hooks?: HookSet): ProgressPhase[] {
  const steps = pipeline.steps.map((step) =>
    step.type === "agent"
      ? {
          name: step.name,
          description: step.description,
          groupId: step.groupId,
          stepName: step.stepName,
          plannedModel: step.model,
          ...(step.variant ? { plannedVariant: step.variant } : {}),
        }
      : { name: step.name, description: step.description },
  )
  if (!hooks) return steps
  // Hooks are dashboard rows too, so their execution is watchable like any
  // step: pre-hooks ahead of the pipeline, post-hooks after it.
  const hookPhase = (stage: HookStage, specs: readonly HookSpec[]) =>
    hookPhaseNames(stage, specs).map((name, index) => ({ name, description: specs[index]!.command }))
  return [...hookPhase("pre", hooks.pre), ...steps, ...hookPhase("post", hooks.post)]
}

class LoggedAttemptError extends Error {}

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

async function writeAttemptLog(workspace: Workspace, phase: AgentStep, attempt: number, payload: unknown) {
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
