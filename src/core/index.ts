// Core API — typed primitives for orchestrating wopr programmatically.
//
// Every operation an external agent (MCP server, pi extension, etc.) needs
// lives here. The existing CLI/TUI go through the same code path internally.
//
// See AGENTS.md §16 for the contract reference.

// Re-export the error types that consumers need
export {
  RunNotFoundError,
  ValidationError,
  AbortError,
  ConfigError,
  BudgetExceededError,
} from "./errors"

// Shared types
export type {
  Finding,
  RunInput,
  RunPreview,
  CostEstimate,
  RunStatus,
  RunHandle,
  RunReport,
  RunCostDetail,
  RunDiff,
  RunCommitInfo,
  ConfigScope,
  ConfigFormat,
  PipelineRecommendation,
  RecommendPipelineInput,
} from "./types"

/** Convenience re-export of StepSpec from pipeline.ts for dynamic pipeline composition. */
export type { StepSpec } from "../pipeline"
export type { AgentStepSpec, HumanStepSpec, ParallelStepSpec, LoopStepSpec } from "../pipeline"

// Discovery — what's available
export {
  listPipelines,
  describePipeline,
  listAgents,
  describeAgent,
  listModels,
  describeModel,
} from "./discovery"
export type {
  PipelineSummary,
  PipelineDetail,
  AgentSummary,
  AgentDetail,
  ModelSummary,
} from "./discovery"

// Config — what's configured
export {
  getConfig,
  getConfigAsync,
  validateConfig,
  diffConfig,
  diffConfigAsync,
  setConfig,
} from "./config"

// Planning — what would happen
export {
  previewRun,
  estimateCost,
  suggestConfigForBudget,
} from "./planning"
export type { BudgetSuggestion } from "./planning"

// Recommendation — what pipeline to run
export { recommendPipeline } from "./recommend"

// Runs — execute and observe
export {
  startRun,
  getRunStatus,
  getRunStatusAsync,
  listRuns,
  listRunsAsync,
  getRunReport,
  getRunCost,
  getRunDiff,
  getRunCommits,
  cancelRun,
  resumeRun,
} from "./runs"
