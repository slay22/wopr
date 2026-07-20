import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import { log } from "./log"

/**
 * Per-model rate in USD per million tokens, matching the shape of pi's
 * models-store.json cost entries.
 */
export type ModelRate = {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

/** Token estimate for one invocation. */
export type TokenEstimate = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Default token estimate used by the budget enforcer until we have
 * calibration data. Conservative: 5k input + 2k output.
 */
export const defaultTokenEstimate: TokenEstimate = { input: 5000, output: 2000 }

/**
 * A model from pi's models-store.json, with the cost sub-object that every
 * opencode model entry carries.
 */
type CatalogModel = {
  id: string
  provider: string
  name: string
  cost: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
  contextWindow?: number
}

/** Catalog loaded once and cached. */
let cachedCatalog: ModelCatalog | undefined

/** Model catalog loaded from pi's models-store.json. */
export class ModelCatalog {
  private readonly models: Map<string, CatalogModel> = new Map()

  constructor(models: CatalogModel[]) {
    for (const m of models) {
      this.models.set(`${m.provider}/${m.id}`, m)
    }
  }

  /** Look up a model by its `provider/id` string. */
  find(fullID: string): CatalogModel | undefined {
    // Strip variant if present
    const key = fullID.includes("#") ? fullID.slice(0, fullID.indexOf("#")) : fullID
    return this.models.get(key)
  }

  get all(): CatalogModel[] {
    return [...this.models.values()]
  }

  /** Returns true if a model's input and output costs are both zero (free-tier). */
  isFree(modelID: string): boolean {
    const m = this.find(modelID)
    if (!m) return false
    return m.cost.input === 0 && m.cost.output === 0
  }

  /** Returns true if a model costs ≤ $2/MTok input + output combined. */
  isCheap(modelID: string): boolean {
    const m = this.find(modelID)
    if (!m) return false
    return m.cost.input + m.cost.output <= 2
  }
}

/** Path to pi's model catalog. */
function modelsStorePath(): string {
  return join(homedir(), ".pi", "agent", "models-store.json")
}

/** Reset the cached model catalog. Tests use this to swap in a fixture catalog. */
export function resetModelCatalog(): void {
  cachedCatalog = undefined
}

/**
 * Load the model catalog from disk. Cached after first load. Returns an empty
 * catalog if the file can't be read.
 */
export function loadModelCatalog(): ModelCatalog {
  if (cachedCatalog) return cachedCatalog
  try {
    const body = readFileSync(modelsStorePath(), "utf8")
    const data = JSON.parse(body) as Record<string, { models: CatalogModel[] }>
    const models: CatalogModel[] = []
    for (const provider of Object.values(data)) {
      for (const m of provider.models ?? []) {
        // Ensure provider is set on each model
        models.push(m)
      }
    }
    cachedCatalog = new ModelCatalog(models)
    return cachedCatalog
  } catch (error) {
    log.warn(`couldn't load model catalog from ${modelsStorePath()}: ${error instanceof Error ? error.message : String(error)}`)
    // Do not cache the empty fallback: a later call may succeed once the
    // catalog exists, and permanently caching the failure would make every
    // subsequent estimate $0 (see security review finding).
    return new ModelCatalog([])
  }
}

/** Get the rate for a model. Returns a default rate if the model isn't found. */
export function rateForModel(modelID: string, catalog: ModelCatalog = loadModelCatalog()): ModelRate {
  const entry = catalog.find(modelID)
  if (!entry) {
    // Unknown model: return a reasonable default based on the free/cheap heuristic
    return { inputPerMTok: 0, outputPerMTok: 0 }
  }
  return {
    inputPerMTok: entry.cost.input,
    outputPerMTok: entry.cost.output,
    cacheReadPerMTok: entry.cost.cacheRead,
    cacheWritePerMTok: entry.cost.cacheWrite,
  }
}

/**
 * Estimate the cost of one invocation given a model and token estimate.
 * Returns the cost in USD.
 */
export function estimateCost(
  modelID: string,
  tokens: TokenEstimate,
  catalog: ModelCatalog = loadModelCatalog(),
): number {
  const rate = rateForModel(modelID, catalog)
  const inputCost = (tokens.input / 1_000_000) * rate.inputPerMTok
  const outputCost = (tokens.output / 1_000_000) * rate.outputPerMTok
  const cacheReadCost = tokens.cacheRead !== undefined && rate.cacheReadPerMTok !== undefined
    ? (tokens.cacheRead / 1_000_000) * rate.cacheReadPerMTok
    : 0
  const cacheWriteCost = tokens.cacheWrite !== undefined && rate.cacheWritePerMTok !== undefined
    ? (tokens.cacheWrite / 1_000_000) * rate.cacheWritePerMTok
    : 0
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

/**
 * Estimate the cost of one pipeline step given the agent/model and token estimate.
 */
export function estimatePhaseCost(
  modelID: string,
  tokens: TokenEstimate,
  catalog: ModelCatalog = loadModelCatalog(),
): number {
  return estimateCost(modelID, tokens, catalog)
}

/**
 * Estimate the cost of a full pipeline run for each step, with a range
 * (min = free/cheap, max = frontier).
 */
export function estimateRunCost(
  steps: { name: string; model: string }[],
  tokens: TokenEstimate,
  catalog: ModelCatalog = loadModelCatalog(),
): {
  min: number
  max: number
  byPhase: Record<string, { min: number; max: number }>
  byModel: Record<string, { min: number; max: number }>
} {
  const byPhase: Record<string, { min: number; max: number }> = {}
  const byModel: Record<string, { min: number; max: number }> = {}
  let totalMin = 0
  let totalMax = 0

  for (const step of steps) {
    const cost = estimateCost(step.model, tokens, catalog)
    // For min/max: we vary the token estimate within ±50%
    const min = cost * 0.5
    const max = cost * 2.0
    byPhase[step.name] = { min, max }
    totalMin += min
    totalMax += max

    if (!byModel[step.model]) byModel[step.model] = { min: 0, max: 0 }
    byModel[step.model]!.min += min
    byModel[step.model]!.max += max
  }

  return { min: totalMin, max: totalMax, byPhase, byModel }
}

/**
 * Free-tier detection helper: returns true when input and output costs are
 * both zero.
 */
export function isFreeModel(modelID: string, catalog: ModelCatalog = loadModelCatalog()): boolean {
  return catalog.isFree(modelID)
}
