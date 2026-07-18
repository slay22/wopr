import { builtInAgents } from "./pipeline"
import { estimateCost, loadModelCatalog, type ModelCatalog } from "./cost"
import type { AgentSpec, AgentStep, Pipeline } from "./types"

/** Preferences for budget-based config suggestion. */
export type BudgetPreferences = {
  /** Free-only / cheap / any — picks from the catalog accordingly. */
  tier?: "free-only" | "cheap" | "any"
  /** Per-agent preferences: which agents must use the strongest available model. */
  perAgent?: Record<string, "free" | "cheap" | "frontier" | "reasoning">
}

/** The proposed config returned by suggestConfigForBudget. */
export type BudgetSuggestion = {
  proposed: {
    defaults?: Partial<{ model: string; maxAttempts: number }>
    agents: Record<string, Partial<{ model: string }>>
    pipelines: Record<string, { steps: { agent: string; model?: string }[] }>
  }
  estimatedCost: {
    min: number
    max: number
    expected: number
    byPhase: Record<string, { min: number; max: number }>
  }
  fitsBudget: boolean
  cheapestFittingTier?: "free-only" | "cheap" | "frontier"
}

/** A candidate model tier for selection. */
type ModelTier = {
  id: string
  label: string
  /** Full `provider/model` string. */
  fullID: string
  costPerCall: number
  isFree: boolean
  isCheap: boolean
}

/**
 * Suggests a wopr configuration (agents + pipeline steps) that fits the
 * given budget. Pure function: no I/O beyond reading the model catalog from
 * disk (cached after first load).
 */
export function suggestConfigForBudget(input: {
  budget: number
  pipeline: string
  targetDir?: string
  preferences?: BudgetPreferences
}): BudgetSuggestion {
  const catalog = loadModelCatalog()
  const tier = input.preferences?.tier ?? "any"
  const perAgentPrefs = input.preferences?.perAgent ?? {}

  // 1. Hard-code the implement pipeline steps (MVP; in production, load from
  //    built-in or project pipelines).
  const pipelineSteps = implementPipelineSteps()

  // 2. For each step, pick a candidate model from each tier.
  const stepCandidates = pipelineSteps.map((step) => ({
    name: step.name,
    agent: step.agentName,
    currentModel: step.model,
    candidates: pickCandidates(step.agentName, catalog, perAgentPrefs[step.agentName]),
  }))

  // 3. Greedy assignment: try each tier from most restrictive to least.
  const tiersToTry: Array<"free-only" | "cheap" | "any"> = tier === "free-only" ? ["free-only"] : tier === "cheap" ? ["cheap", "free-only"] : ["any", "cheap", "free-only"]

  for (const tryTier of tiersToTry) {
    const assignment = assignTier(stepCandidates, tryTier)
    if (!assignment) continue

    const total = assignment.reduce((sum, a) => sum + a.costPerCall, 0)
    if (total <= input.budget) {
      const byPhase: Record<string, { min: number; max: number }> = {}
      for (const a of assignment) {
        byPhase[a.name] = { min: a.costPerCall * 0.5, max: a.costPerCall * 2.0 }
      }

      const agents: Record<string, Partial<{ model: string }>> = {}
      for (const a of assignment) {
        if (a.modelID !== a.currentModel) {
          agents[a.agent] = { model: a.modelID }
        }
      }

      return {
        proposed: {
          ...(Object.keys(agents).length > 0 ? { agents } : {}),
          pipelines: {
            [input.pipeline]: {
              steps: assignment.map((a) => ({
                agent: a.agent,
                ...(a.modelID !== a.currentModel ? { model: a.modelID } : {}),
              })),
            },
          },
        },
        estimatedCost: {
          min: total * 0.5,
          max: total * 2.0,
          expected: total,
          byPhase,
        },
        fitsBudget: true,
        cheapestFittingTier: tryTier === "free-only" ? "free-only" : tryTier === "cheap" ? "cheap" : "frontier",
      }
    }
  }

  // 4. No tier fits: return the cheapest possible with fitsBudget: false.
  const cheapest = assignTier(stepCandidates, "free-only")
  const total = cheapest ? cheapest.reduce((sum, a) => sum + a.costPerCall, 0) : 0
  const byPhase: Record<string, { min: number; max: number }> = {}
  if (cheapest) {
    for (const a of cheapest) {
      byPhase[a.name] = { min: a.costPerCall * 0.5, max: a.costPerCall * 2.0 }
    }
  }

  return {
    proposed: {
      agents: cheapest
        ? Object.fromEntries(
            cheapest.filter((a) => a.modelID !== a.currentModel).map((a) => [a.agent, { model: a.modelID }]),
          )
        : {},
      pipelines: {
        [input.pipeline]: {
          steps: cheapest
            ? cheapest.map((a) => ({
                agent: a.agent,
                ...(a.modelID !== a.currentModel ? { model: a.modelID } : {}),
              }))
            : [],
        },
      },
    },
    estimatedCost: {
      min: total * 0.5,
      max: total * 2.0,
      expected: total,
      byPhase,
    },
    fitsBudget: false,
    cheapestFittingTier: total <= input.budget ? "free-only" : undefined,
  }
}

/** The built-in implement pipeline as an array of {name, agentName, model}. */
function implementPipelineSteps(): { name: string; agentName: string; model: string }[] {
  return [
    { name: "implementer", agentName: "implementer", model: "opencode-go/deepseek-v4-flash" },
    { name: "patterns", agentName: "pattern-auditor", model: "opencode-go/deepseek-v4-flash" },
    { name: "security", agentName: "security-auditor", model: "opencode-go/deepseek-v4-flash" },
    { name: "design", agentName: "design-polisher", model: "anthropic/claude-opus-4-8" },
    { name: "tests", agentName: "test-engineer", model: "opencode-go/deepseek-v4-flash" },
    { name: "adversarial", agentName: "adversarial-reviewer", model: "anthropic/claude-opus-4-8" },
  ]
}

/** Pick candidate models for an agent across tiers. */
function pickCandidates(
  agentName: string,
  catalog: ModelCatalog,
  preference?: "free" | "cheap" | "frontier" | "reasoning",
): ModelTier[] {
  const all = catalog.all
  const tiers: ModelTier[] = []

  // Free tier: any model with input + output cost == 0
  const freeModels = all.filter((m) => m.cost.input === 0 && m.cost.output === 0)
  const freeBest = freeModels[0]
  if (freeBest) {
    tiers.push({
      id: "free",
      label: freeBest.name,
      fullID: `${freeBest.provider}/${freeBest.id}`,
      costPerCall: estimateCost(`${freeBest.provider}/${freeBest.id}`, { input: 5000, output: 2000 }, catalog),
      isFree: true,
      isCheap: false,
    })
  }

  // Cheap tier: input + output cost ≤ $2/MTok, not free
  const cheapModels = all.filter((m) => m.cost.input + m.cost.output <= 2 && !(m.cost.input === 0 && m.cost.output === 0))
  const cheapBest = cheapModels[0]
  if (cheapBest) {
    tiers.push({
      id: "cheap",
      label: cheapBest.name,
      fullID: `${cheapBest.provider}/${cheapBest.id}`,
      costPerCall: estimateCost(`${cheapBest.provider}/${cheapBest.id}`, { input: 5000, output: 2000 }, catalog),
      isFree: false,
      isCheap: true,
    })
  }

  // Frontier tier: the most expensive model in the catalog (likely the best)
  const sortedByCost = [...all].sort((a, b) => b.cost.input + b.cost.output - (a.cost.input + a.cost.output))
  const frontier = sortedByCost[0]
  if (frontier) {
    tiers.push({
      id: "frontier",
      label: frontier.name,
      fullID: `${frontier.provider}/${frontier.id}`,
      costPerCall: estimateCost(`${frontier.provider}/${frontier.id}`, { input: 5000, output: 2000 }, catalog),
      isFree: false,
      isCheap: sortedByCost[0] === cheapBest,
    })
  }

  // Apply preference: filter or sort
  if (preference === "free") return tiers.filter((t) => t.isFree)
  if (preference === "cheap") return tiers.filter((t) => t.isFree || t.isCheap)
  if (preference === "frontier") return tiers

  return tiers
}

/** Assign a tier to each step. Returns null if no assignment is possible. */
function assignTier(
  stepCandidates: { name: string; agent: string; currentModel: string; candidates: ModelTier[] }[],
  tier: "free-only" | "cheap" | "any",
): { name: string; agent: string; modelID: string; currentModel: string; costPerCall: number }[] | null {
  const assignment: { name: string; agent: string; modelID: string; currentModel: string; costPerCall: number }[] = []

  for (const step of stepCandidates) {
    let candidates = step.candidates

    if (tier === "free-only") {
      candidates = candidates.filter((c) => c.isFree)
    } else if (tier === "cheap") {
      // Prefer cheap, fall back to free
      const cheap = candidates.filter((c) => c.isCheap || c.isFree)
      if (cheap.length > 0) candidates = cheap
    }

    // Sort by cost (cheapest first)
    candidates = [...candidates].sort((a, b) => a.costPerCall - b.costPerCall)

    if (candidates.length === 0) {
      // No model available for this tier; use the cheapest available
      if (step.candidates.length === 0) return null
      candidates = [step.candidates.sort((a, b) => a.costPerCall - b.costPerCall)[0]!]
    }

    const best = candidates[0]!
    assignment.push({
      name: step.name,
      agent: step.agent,
      modelID: best.fullID,
      currentModel: step.currentModel,
      costPerCall: best.costPerCall,
    })
  }

  return assignment
}
