import { buildAgentRegistry } from "../config"
import { loadModelCatalog, type ModelCatalog } from "../cost"
import { builtInAgents, builtInPipelines, resolvePipeline, splitModelVariant } from "../pipeline"
import type { AgentSpec, AgentStep, Step } from "../types"

// ─── Public types ───────────────────────────────────────────────────────────

export type PipelineSummary = {
  name: string
  description?: string
  source: "built-in" | "project" | "global"
  stepCount: number
  hasLoops: boolean
  hasParallel: boolean
}

export type PipelineDetail = PipelineSummary & {
  steps: Array<{
    name: string
    agentName: string
    model: string
    readOnly: boolean
    loopRole?: "plan" | "implement" | "validate"
    loopId?: string
  }>
}

export type AgentSummary = {
  name: string
  description: string
  defaultModel: string
  readOnly: boolean
  source: "built-in" | "project" | "global"
}

export type AgentDetail = AgentSummary & {
  promptPath?: string
  temperature?: number
  variant?: string
  resolvedModel: string
}

export type ModelSummary = {
  id: string
  displayName: string
  provider: string
  contextWindow: number
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  reasoning: boolean
  tags: string[]
}

// ─── Pipeline discovery ─────────────────────────────────────────────────────

export function listPipelines(targetDir?: string): PipelineSummary[] {
  const dir = targetDir ?? process.cwd()
  // Synchronous for now; async version would need the full config load chain.
  // We use a best-effort sync read of the config to build the summary.
  const summaries: PipelineSummary[] = []

  // Built-in pipelines — always present.
  for (const [name, spec] of Object.entries(builtInPipelines)) {
    summaries.push({
      name,
      description: spec.description,
      source: "built-in",
      stepCount: countSteps(spec.steps),
      hasLoops: spec.steps.some((s: unknown) => typeof s === "object" && s !== null && "loop" in (s as Record<string, unknown>)),
      hasParallel: spec.steps.some((s: unknown) => typeof s === "object" && s !== null && "parallel" in (s as Record<string, unknown>)),
    })
  }

  return summaries
}

function countSteps(steps: unknown[]): number {
  let count = 0
  for (const step of steps) {
    if (typeof step === "object" && step !== null) {
      const s = step as Record<string, unknown>
      if ("parallel" in s && Array.isArray(s.parallel)) {
        count += s.parallel.length
      } else if ("loop" in s && typeof s.loop === "object" && s.loop !== null) {
        const loop = s.loop as Record<string, unknown>
        count += 1 // plan
        count += Array.isArray(loop.implement) ? loop.implement.length : 1
        count += 1 // validate
      } else {
        count += 1
      }
    } else {
      count += 1
    }
  }
  return count
}

export function describePipeline(name: string, targetDir?: string): PipelineDetail {
  const dir = targetDir ?? process.cwd()
  const spec = builtInPipelines[name]
  if (!spec) {
    throw new Error(`unknown pipeline "${name}" (available: ${Object.keys(builtInPipelines).sort().join(", ")})`)
  }

  // Resolve to get step details.
  const agents = buildAgentRegistry()
  const pipeline = resolvePipeline({ name, spec, agents })
  const source = "built-in" as const

  return {
    name,
    description: spec.description,
    source,
    stepCount: pipeline.steps.length,
    hasLoops: pipeline.steps.some((s: Step) => s.type === "agent" && s.loopId !== undefined),
    hasParallel: false, // groups are collapsed in the flat step list
    steps: pipeline.steps
      .filter((s: Step): s is AgentStep => s.type === "agent")
      .map((s) => ({
        name: s.name,
        agentName: s.agentName,
        model: s.model + (s.variant ? `#${s.variant}` : ""),
        readOnly: Boolean(s.readOnly),
        loopRole: s.loopRole,
        loopId: s.loopId,
      })),
  }
}

// ─── Agent discovery ────────────────────────────────────────────────────────

export function listAgents(targetDir?: string): AgentSummary[] {
  const dir = targetDir ?? process.cwd()
  return builtInAgents.map((agent: AgentSpec) => ({
    name: agent.name,
    description: agent.description,
    defaultModel: agent.defaultModel ?? agent.model ?? "openai/gpt-5.6-terra#xhigh",
    readOnly: Boolean(agent.readOnly),
    source: agent.builtIn ? "built-in" : "project" as const,
  }))
}

export function describeAgent(name: string, targetDir?: string): AgentDetail {
  const dir = targetDir ?? process.cwd()
  const agent = builtInAgents.find((a: AgentSpec) => a.name === name)
  if (!agent) {
    throw new Error(`unknown agent "${name}"`)
  }

  const defaultModel = agent.defaultModel ?? agent.model ?? "openai/gpt-5.6-terra#xhigh"
  const { model, variant } = splitModelVariant(defaultModel)
  const promptPath = `.wopr/agents/${name}.md`

  return {
    name: agent.name,
    description: agent.description,
    defaultModel,
    readOnly: Boolean(agent.readOnly),
    source: agent.builtIn ? "built-in" as const : "project" as const,
    promptPath,
    temperature: agent.temperature,
    variant,
    resolvedModel: model,
  }
}

// ─── Model discovery ────────────────────────────────────────────────────────

/** Proxy to loadModelCatalog for the core API. */
function resolveCatalog(): ModelCatalog {
  return loadModelCatalog()
}

export function listModels(filter?: { tag?: string; freeOnly?: boolean; reasoningOnly?: boolean }): ModelSummary[] {
  const catalog = resolveCatalog()
  let models = catalog.all.map((m) => {
    const cost = m.cost
    const isFree = cost.input === 0 && cost.output === 0
    const isCheap = cost.input + cost.output <= 2
    const tags: string[] = []
    if (isFree) tags.push("free")
    else if (isCheap) tags.push("cheap")
    else tags.push("frontier")
    tags.push("code")

    return {
      id: `${m.provider}/${m.id}`,
      displayName: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow ?? 0,
      cost: {
        input: cost.input,
        output: cost.output,
        ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead } : {}),
        ...(cost.cacheWrite !== undefined ? { cacheWrite: cost.cacheWrite } : {}),
      },
      reasoning: false,
      tags,
    }
  })

  if (filter?.freeOnly) models = models.filter((m) => m.tags.includes("free"))
  if (filter?.tag) models = models.filter((m) => m.tags.includes(filter.tag!))
  if (filter?.reasoningOnly) models = models.filter((m) => m.reasoning)

  return models
}

export function describeModel(modelID: string): ModelSummary {
  const catalog = resolveCatalog()
  const found = catalog.find(modelID)
  if (!found) {
    throw new Error(`unknown model "${modelID}"`)
  }

  const cost = found.cost
  const isFree = cost.input === 0 && cost.output === 0
  const isCheap = cost.input + cost.output <= 2
  const tags: string[] = []
  if (isFree) tags.push("free")
  else if (isCheap) tags.push("cheap")
  else tags.push("frontier")
  tags.push("code")

  return {
    id: `${found.provider}/${found.id}`,
    displayName: found.name,
    provider: found.provider,
    contextWindow: found.contextWindow ?? 0,
    cost: {
      input: cost.input,
      output: cost.output,
      ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead } : {}),
      ...(cost.cacheWrite !== undefined ? { cacheWrite: cost.cacheWrite } : {}),
    },
    reasoning: false,
    tags,
  }
}
