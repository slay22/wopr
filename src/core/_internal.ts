import type { RunStatus } from "./types"

/** One registered run's state and control handles. */
export type RunRegistration = {
  runId: string
  startedAt: number
  status: RunStatus
  abort: (reason?: string) => void
  promise: Promise<RunStatus & { state: "completed" | "failed" | "aborted" | "budget_exceeded" }>
  signal: AbortSignal
}

/**
 * Process-level singleton run registry. Maps run IDs to their control handles
 * so cancelRun / getRunStatus can reach in-flight runs by ID.
 *
 * Exported only for tests (src/core/*.ts consumers go through the
 * public API). Tests can reset the singleton between cases.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRegistration>()
  private static _instance: RunRegistry | undefined

  /** Get or create the global singleton. */
  static instance(): RunRegistry {
    if (!RunRegistry._instance) RunRegistry._instance = new RunRegistry()
    return RunRegistry._instance
  }

  /** Replace the singleton (for tests). Returns the previous instance. */
  static replace(replacement: RunRegistry): RunRegistry | undefined {
    const prev = RunRegistry._instance
    RunRegistry._instance = replacement
    return prev
  }

  /** Reset the singleton to a fresh empty registry (for tests). */
  static reset(): void {
    RunRegistry._instance = new RunRegistry()
  }

  register(reg: RunRegistration): void {
    this.runs.set(reg.runId, reg)
  }

  get(runId: string): RunRegistration | undefined {
    return this.runs.get(runId)
  }

  unregister(runId: string): boolean {
    return this.runs.delete(runId)
  }

  all(): RunRegistration[] {
    return [...this.runs.values()]
  }

  size(): number {
    return this.runs.size
  }

  clear(): void {
    this.runs.clear()
  }
}
