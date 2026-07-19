import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { execSync } from "node:child_process"

import { readRunMetadata } from "../metadata"
import { listRuns as listRunEntries, type RunEntry } from "../runs"
import { BudgetExceededError, isUserAbortError } from "../runner"
import { newRunID, runDir } from "../workspace"

import { RunRegistry } from "./_internal"
import { RunNotFoundError } from "./errors"
import type { RunHandle, RunInput, RunReport, RunStatus, RunCostDetail, RunDiff, RunCommitInfo } from "./types"

/**
 * Start a run and return immediately with a handle for status/abort.
 * The run executes in a background task; await handle.promise to block.
 */
export function startRun(input: RunInput): RunHandle {
  const runId = newRunID()
  const startedAt = Date.now()
  const registry = RunRegistry.instance()
  const controller = new AbortController()

  let resolveStatus!: (value: RunStatus & { state: "completed" | "failed" | "aborted" | "budget_exceeded" }) => void
  const promise = new Promise<RunStatus & { state: "completed" | "failed" | "aborted" | "budget_exceeded" }>((resolve) => {
    resolveStatus = resolve
  })

  // Register immediately with "starting" status
  const registration = {
    runId,
    startedAt,
    status: { state: "starting" as const, startedAt },
    abort: (reason?: string) => {
      controller.abort(new Error(reason ?? "aborted"))
    },
    promise,
    signal: controller.signal,
  }
  registry.register(registration)

  // Kick off the pipeline execution in the background
  runBackground(input, runId, controller.signal, resolveStatus).catch(() => {
    // Ensure the promise always resolves, even on unexpected errors.
    // Calling resolveStatus on an already-settled promise is a no-op.
    const reg = registry.get(runId)
    if (reg) registry.unregister(runId)
    resolveStatus({ state: "failed", startedAt, finishedAt: Date.now(), error: "internal error", failedPhase: "" })
  })

  return {
    runId,
    promise,
    abort: (reason?: string) => controller.abort(new Error(reason ?? "aborted")),
  }
}

/** Background task that resolves RunInput → RunOptions and delegates to the existing run(). */
async function runBackground(
  input: RunInput,
  runId: string,
  signal: AbortSignal,
  resolve: (status: RunStatus & { state: "completed" | "failed" | "aborted" | "budget_exceeded" }) => void,
) {
  const registry = RunRegistry.instance()
  const startedAt = registry.get(runId)?.startedAt ?? Date.now()

  try {
    // Update status to running
    updateRegistryStatus(runId, { state: "running", startedAt, currentPhase: "starting", completedPhases: [], percentComplete: 0 })

    // Build RunOptions from RunInput (minimal mapping)
    const { resolveRunOptions } = await import("../cli")
    const parsed = parseArgsFromInput(input)
    const options = await resolveRunOptions(parsed)

    // Override with input-specific values
    const finalOptions = {
      ...options,
      prompt: input.prompt,
      pipeline: options.pipeline,
      agents: options.agents,
    }

    // Call the existing run() from runner.ts — it handles everything internally
    const { run: runPipeline } = await import("../runner")
    await runPipeline(finalOptions)

    // Run completed successfully
    const finishedAt = Date.now()
    const status: RunStatus & { state: "completed" } = {
      state: "completed",
      startedAt,
      finishedAt,
      totalCost: 0, // cost is read from metadata
      outcome: "success",
    }

    registry.unregister(runId)
    resolve(status)
  } catch (error) {
    const finishedAt = Date.now()

    if (error instanceof BudgetExceededError) {
      const status: RunStatus & { state: "budget_exceeded" } = {
        state: "budget_exceeded",
        startedAt,
        finishedAt,
        spent: error.spent,
        budget: error.budget,
        atPhase: error.phase,
      }
      registry.unregister(runId)
      resolve(status)
    } else if (isUserAbortError(error)) {
      const status: RunStatus & { state: "aborted" } = {
        state: "aborted",
        startedAt,
        finishedAt,
        reason: error.message,
      }
      registry.unregister(runId)
      resolve(status)
    } else {
      const status: RunStatus & { state: "failed" } = {
        state: "failed",
        startedAt,
        finishedAt,
        error: error instanceof Error ? error.message : String(error),
        failedPhase: "",
      }
      registry.unregister(runId)
      resolve(status)
    }
  }
}

/** Build a ParsedArgs-shaped object from RunInput for resolveRunOptions. */
function parseArgsFromInput(input: RunInput): import("../cli").ParsedArgs {
  return {
    targetDir: input.targetDir,
    files: input.files ?? [],
    onlySteps: input.onlySteps ?? [],
    skipSteps: input.skipSteps ?? [],
    resumeRunID: (input as any).resumeRunID ?? "",
    keepRunDir: input.keepRunDir ?? true,
    modelOverride: input.modelOverride ?? "",
    tui: false,
    humanReview: false,
    maxAttempts: input.maxAttempts ?? 2,
    baseRef: input.baseRef,
    pipeline: input.pipeline,
    budget: input.budget ? String(input.budget.perRun) : undefined,
    budgetMode: input.budget?.onExceed === "warn-and-continue" ? "warn" : undefined,
    worktree: input.worktree ? true : undefined,
    keepWorktree: input.keepWorktree ?? true,
    includeDirty: input.includeDirty ?? false,
    yolo: input.yolo ?? false,
    smart: input.smart ?? false,
    initRepo: input.initRepo ?? false,
    prompt: input.prompt,
    promptFile: undefined,
  } as import("../cli").ParsedArgs
}

/** Update the registry status for a run. */
function updateRegistryStatus(runId: string, status: RunStatus): void {
  const registry = RunRegistry.instance()
  const reg = registry.get(runId)
  if (reg) {
    reg.status = status
  }
}

// ─── Status polling ─────────────────────────────────────────────────────────

export function getRunStatus(runId: string): RunStatus {
  // Check in-memory registry first
  const registry = RunRegistry.instance()
  const reg = registry.get(runId)
  if (reg) return reg.status

  // Check on-disk metadata for completed runs
  const dir = runDir(runId)
  const metadataPath = join(dir, "metadata.json")
  const metadata = readRunMetadata(metadataPath)
  if (metadata instanceof Promise) {
    // Fallthrough — async, not available sync
  } else {
    // We actually need to await this. For now, return a simple status.
  }

  throw new RunNotFoundError(runId)
}

export async function getRunStatusAsync(runId: string): Promise<RunStatus> {
  // Check in-memory registry first
  const registry = RunRegistry.instance()
  const reg = registry.get(runId)
  if (reg) return reg.status

  // Check on-disk metadata
  const dir = runDir(runId)
  const metadataPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metadataPath)
  if (!metadata) throw new RunNotFoundError(runId)

  const phaseEntries = Object.entries(metadata.phases)
  const startedAt = metadata.createdAt
  const finishedAt = metadata.updatedAt
  const completed = phaseEntries.filter(([, p]) => p.status === "completed" || p.status === "skipped").length
  const total = phaseEntries.length

  // Determine overall status
  const failedEntry = phaseEntries.find(([, p]) => p.status === "failed")
  if (failedEntry) {
    return { state: "failed", startedAt, finishedAt, error: "phase failed", failedPhase: failedEntry[0] }
  }
  if (completed === total && total > 0) {
    return { state: "completed", startedAt, finishedAt, totalCost: metadata.cost?.total.totalCost ?? 0, outcome: "success" }
  }
  if (completed > 0) {
    const completedNames = phaseEntries.filter(([, p]) => p.status === "completed" || p.status === "skipped").map(([name]) => name)
    return { state: "running", startedAt, currentPhase: "", completedPhases: completedNames, percentComplete: Math.round((completed / total) * 100) }
  }
  return { state: "starting", startedAt }
}

// ─── Run listing ────────────────────────────────────────────────────────────

export function listRuns(filter?: { targetDir?: string; since?: number; pipeline?: string; limit?: number }): Array<{
  runId: string
  targetDir: string
  pipeline: string
  prompt: string
  startedAt: number
  finishedAt?: number
  state: string
  totalCost: number
}> {
  // Use the runs.ts browser's listRuns synchronously (best-effort)
  // The actual implementation reads on-disk metadata.
  const entries = listRunEntries() // returns Promise<RunEntry[]>
  // Since this is a sync function, we return an empty array.
  // Consumers should use listRunsAsync for real results.
  return []
}

export async function listRunsAsync(filter?: { targetDir?: string; since?: number; pipeline?: string; limit?: number }): Promise<Array<{
  runId: string
  targetDir: string
  pipeline: string
  prompt: string
  startedAt: number
  finishedAt?: number
  state: string
  totalCost: number
}>> {
  const entries = await listRunEntries()
  let result = entries.map((entry: RunEntry) => ({
    runId: entry.runID,
    targetDir: entry.targetDir ?? "",
    pipeline: "",
    prompt: entry.title,
    startedAt: entry.createdAt ?? 0,
    finishedAt: undefined as number | undefined,
    state: entry.statusKind,
    totalCost: entry.cost ?? 0,
  }))

  if (filter?.since) result = result.filter((r) => r.startedAt >= filter.since!)
  if (filter?.limit) result = result.slice(0, filter.limit)
  return result
}

// ─── Report reading ─────────────────────────────────────────────────────────

export async function getRunReport(runId: string, phase: string): Promise<RunReport> {
  const dir = runDir(runId)
  const reportPath = join(dir, "reports", `${phase}.md`)

  let markdown = ""
  try {
    markdown = await readFile(reportPath, "utf8")
  } catch {
    throw new RunNotFoundError(runId)
  }

  // Parse verdict from markdown if present
  let verdict: "pass" | "partial" | "reject" | undefined
  const verdictMatch = markdown.match(/^Validation result:\s*(pass|partial|reject)\b/im)
  if (verdictMatch) verdict = verdictMatch[1] as "pass" | "partial" | "reject"

  // Try to read metadata for stats
  const metadataPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metadataPath)
  const phaseMeta = metadata?.phases[phase]
  const stats = {
    tokens: phaseMeta?.tokens?.total ?? 0,
    cost: phaseMeta?.cost ?? 0,
    durationMs: phaseMeta?.durationMs ?? 0,
    model: phaseMeta?.model ?? "",
  }

  return { markdown, verdict, stats }
}

// ─── Cost details ───────────────────────────────────────────────────────────

export async function getRunCost(runId: string): Promise<RunCostDetail> {
  const dir = runDir(runId)
  const metadataPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metadataPath)
  if (!metadata) throw new RunNotFoundError(runId)

  const costData = metadata.cost
  const byPhase: Record<string, { cost: number; tokens: number; durationMs: number }> = {}
  const byModel: Record<string, { cost: number; calls: number }> = {}

  if (costData) {
    for (const entry of costData.entries) {
      if (!byPhase[entry.phase]) byPhase[entry.phase] = { cost: 0, tokens: 0, durationMs: 0 }
      byPhase[entry.phase]!.cost += entry.totalCost
      byPhase[entry.phase]!.tokens += entry.inputTokens + entry.outputTokens
      byPhase[entry.phase]!.durationMs += entry.durationMs

      if (!byModel[entry.model]) byModel[entry.model] = { cost: 0, calls: 0 }
      byModel[entry.model]!.cost += entry.totalCost
      byModel[entry.model]!.calls++
    }
  }

  return {
    total: costData?.total.totalCost ?? 0,
    byPhase,
    byModel,
  }
}

// ─── Diff ───────────────────────────────────────────────────────────────────

export async function getRunDiff(runId: string, against: "base" | "previous" = "base"): Promise<RunDiff> {
  const dir = runDir(runId)

  // Read the diff files if they exist
  try {
    const diffFiles = await readdir(join(dir, "diffs"))
    const totalAdditions = 0
    const totalDeletions = 0
    const filesChanged: RunDiff["filesChanged"] = []

    for (const file of diffFiles) {
      const content = await readFile(join(dir, "diffs", file), "utf8")
      // Parse the diff for file stats
      const fileRegex = /^diff --git a\/(.+?) b\/(.+)$/gm
      let match
      while ((match = fileRegex.exec(content)) !== null) {
        filesChanged.push({
          path: match[2]!,
          additions: 0,
          deletions: 0,
          status: "modified",
        })
      }
    }

    return {
      filesChanged,
      totalAdditions,
      totalDeletions,
      commitCount: filesChanged.length > 0 ? 1 : 0,
    }
  } catch {
    // No diffs directory; try git log
    try {
      const output = execSync(`cd "${dir}" && git rev-list --count HEAD`, { encoding: "utf8" }).trim()
      const commitCount = parseInt(output, 10) || 0
      return { filesChanged: [], totalAdditions: 0, totalDeletions: 0, commitCount }
    } catch {
      return { filesChanged: [], totalAdditions: 0, totalDeletions: 0, commitCount: 0 }
    }
  }
}

// ─── Commits ────────────────────────────────────────────────────────────────

export async function getRunCommits(runId: string): Promise<RunCommitInfo[]> {
  const dir = runDir(runId)

  try {
    const output = execSync(
      `cd "${dir}" && git log --format="%H|||%s|||%an|||%ct" --reverse`,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    )
    const lines = output.trim().split("\n").filter(Boolean)
    return lines.map((line: string) => {
      const parts = line.split("|||")
      const sha = parts[0] ?? ""
      const message = parts[1] ?? ""
      const author = parts[2] ?? ""
      const timestamp = parseInt(parts[3] ?? "0", 10) * 1000
      // Extract phase name from commit message (wopr(phaseName): ...)
      const phaseMatch = message.match(/^wopr\((.+?)\)/)
      const phase = phaseMatch ? phaseMatch[1]! : ""
      return { sha, message, author, timestamp, phase, filesChanged: 0 }
    })
  } catch {
    return []
  }
}

// ─── Cancel / Resume ────────────────────────────────────────────────────────

export function cancelRun(runId: string, reason?: string): { ok: true } | { ok: false; error: string } {
  const registry = RunRegistry.instance()
  const reg = registry.get(runId)
  if (!reg) return { ok: false, error: `run not found: ${runId}` }

  reg.abort(reason ?? "cancelled by user")
  return { ok: true }
}

export async function resumeRun(runId: string): Promise<RunHandle> {
  const dir = runDir(runId)
  const metadataPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metadataPath)
  if (!metadata) throw new RunNotFoundError(runId)

  // Validate that the run can be resumed (it's incomplete)
  const phases = Object.values(metadata.phases)
  const allDone = phases.every((p) => p.status === "completed" || p.status === "skipped")
  if (allDone && phases.length > 0) {
    throw new Error(`run ${runId} is already complete and cannot be resumed`)
  }

  // Start a new run with resumeRunID set
  const targetDir = metadata.targetDir
  const input: RunInput = {
    prompt: "",
    pipeline: metadata.pipeline?.name ?? "implement",
    targetDir,
    resumeRunID: runId,
    keepRunDir: true,
  }

  return startRun(input)
}
