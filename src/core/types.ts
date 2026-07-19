import type { Budget } from "../types"

/** Structured finding from a phase review, closable by the MCP server. */
export type Finding = {
  id: string
  phase: string
  severity: "critical" | "high" | "medium" | "low" | "info"
  file?: string
  line?: number
  title: string
  description?: string
  fixApplied: boolean
  fixDiff?: string
}

/** Input for previewRun and startRun. Mirrors RunOptions with optional-friendly defaults. */
export type RunInput = {
  prompt: string
  pipeline: string
  targetDir: string
  baseRef?: string
  budget?: Budget
  files?: string[]
  modelOverride?: string
  onlySteps?: string[]
  skipSteps?: string[]
  keepRunDir?: boolean
  maxAttempts?: number
  worktree?: { dir: string; mainRepo: string }
  keepWorktree?: boolean
  includeDirty?: boolean
  yolo?: boolean
  smart?: boolean
  smartJudgeModel?: string
  initRepo?: boolean
  /** Resume from a previous run's workspace. */
  resumeRunID?: string
}

/** RunPreview: what would happen without actually doing it. */
export type RunPreview = {
  runId: string
  worktreePath?: string
  branch?: string
  baseRef: string
  steps: Array<{ name: string; agentName: string; model: string; readOnly: boolean }>
  estimatedCost: CostEstimate
  warnings: string[]
}

export type CostEstimate = {
  min: number
  max: number
  expected: number
  byPhase: Record<string, { min: number; max: number }>
  byModel: Record<string, number>
}

/** Discriminated union for a run's current status. */
export type RunStatus =
  | { state: "starting"; startedAt: number }
  | { state: "running"; startedAt: number; currentPhase: string; completedPhases: string[]; percentComplete: number }
  | { state: "completed"; startedAt: number; finishedAt: number; totalCost: number; outcome: "success" }
  | { state: "failed"; startedAt: number; finishedAt: number; error: string; failedPhase: string }
  | { state: "aborted"; startedAt: number; finishedAt: number; reason: string }
  | { state: "budget_exceeded"; startedAt: number; finishedAt: number; spent: number; budget: number; atPhase: string }

/** Handle returned by startRun; the promise resolves when the run terminates. */
export type RunHandle = {
  runId: string
  promise: Promise<RunStatus & { state: "completed" | "failed" | "aborted" | "budget_exceeded" }>
  abort: (reason?: string) => void
}

export type RunReport = {
  markdown: string
  findings?: Finding[]
  verdict?: "pass" | "partial" | "reject"
  stats: { tokens: number; cost: number; durationMs: number; model: string }
}

export type RunCostDetail = {
  total: number
  byPhase: Record<string, { cost: number; tokens: number; durationMs: number }>
  byModel: Record<string, { cost: number; calls: number }>
  budget?: { cap: number; spent: number; onExceed: "abort" | "warn-and-continue" }
}

export type RunDiff = {
  filesChanged: Array<{ path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted" }>
  totalAdditions: number
  totalDeletions: number
  commitCount: number
}

export type RunCommitInfo = {
  sha: string
  message: string
  author: string
  timestamp: number
  phase: string
  filesChanged: number
}

export type ConfigScope = "global" | "project" | "merged"
export type ConfigFormat = "yaml" | "json"
