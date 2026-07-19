import { estimateRunCost, defaultTokenEstimate } from "../cost"
import { buildAgentRegistry as buildAgentRegistryFromConfig } from "../config"
import { builtInPipelines, resolvePipeline } from "../pipeline"
import { suggestConfigForBudget as suggestConfig, type BudgetSuggestion } from "../suggest"

import { newRunID } from "../workspace"
import type { AgentStep } from "../types"

import type { RunInput, RunPreview, CostEstimate } from "./types"

export { type BudgetSuggestion }

/**
 * Preview a run without creating a workspace or kicking off execution.
 * Composes pipeline resolution + cost estimation + worktree name generation.
 */
export function previewRun(input: RunInput): RunPreview {
  const dir = input.targetDir
  const pipelineName = input.pipeline

  // Resolve the pipeline
  const spec = builtInPipelines[pipelineName]
  if (!spec) {
    throw new Error(`unknown pipeline "${pipelineName}"`)
  }

  const agents = buildAgentRegistryFromConfig()
  const pipeline = resolvePipeline({ name: pipelineName, spec, agents })

  // Get step info
  const steps = pipeline.steps
    .filter((s): s is AgentStep => s.type === "agent")
    .map((s) => ({
      name: s.name,
      agentName: s.agentName,
      model: s.model + (s.variant ? `#${s.variant}` : ""),
      readOnly: Boolean(s.readOnly),
    }))

  // Estimate cost
  const estimated = estimateRunCost(
    steps.map((s) => ({ name: s.name, model: s.model })),
    defaultTokenEstimate,
  )

  const costEstimate: CostEstimate = {
    min: estimated.min,
    max: estimated.max,
    expected: (estimated.min + estimated.max) / 2,
    byPhase: Object.fromEntries(
      Object.entries(estimated.byPhase).map(([phase, { min, max }]) => [phase, { min, max }]),
    ),
    byModel: Object.fromEntries(
      Object.entries(estimated.byModel).map(([model, { min, max }]) => [model, (min + max) / 2]),
    ),
  }

  // Generate a run ID
  const runId = newRunID()

  // Collect warnings
  const warnings: string[] = []

  return {
    runId,
    baseRef: input.baseRef ?? "HEAD",
    steps,
    estimatedCost: costEstimate,
    warnings,
  }
}

/**
 * Estimate the cost of a run without resolving the full pipeline.
 */
export function estimateCost(input: RunInput): CostEstimate {
  const pipelineName = input.pipeline
  const spec = builtInPipelines[pipelineName]
  if (!spec) {
    throw new Error(`unknown pipeline "${pipelineName}"`)
  }

  const agents = buildAgentRegistryFromConfig()
  const pipeline = resolvePipeline({ name: pipelineName, spec, agents })

  const steps = pipeline.steps
    .filter((s): s is AgentStep => s.type === "agent")
    .map((s) => ({ name: s.name, model: s.model + (s.variant ? `#${s.variant}` : "") }))

  const estimated = estimateRunCost(steps, defaultTokenEstimate)

  return {
    min: estimated.min,
    max: estimated.max,
    expected: (estimated.min + estimated.max) / 2,
    byPhase: Object.fromEntries(
      Object.entries(estimated.byPhase).map(([phase, { min, max }]) => [phase, { min, max }]),
    ),
    byModel: Object.fromEntries(
      Object.entries(estimated.byModel).map(([model, { min, max }]) => [model, (min + max) / 2]),
    ),
  }
}

/**
 * Delegate to suggest.ts's suggestConfigForBudget with the right types.
 */
export { suggestConfig as suggestConfigForBudget }
