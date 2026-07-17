import type { Model } from "@earendil-works/pi-ai/compat"

import { log } from "./log"
import { piRuntime } from "./pi"

/** A selectable model for the config TUI's picker. `value` is what gets written to config. */
export type ModelChoice = {
  /** Canonical `provider/model` or `provider/model#variant`. */
  value: string
  /** Human-readable model name (with the variant in parentheses). */
  label: string
  providerID: string
  /** Non-"active" status (alpha/beta/deprecated), surfaced as a hint; undefined when active. */
  status?: string
  /** Context window in thousands of tokens, for the description line. */
  contextK?: number
}

const catalogTimeoutMs = 12_000
const modelsDevUrl = "https://models.dev/api.json"

let cached: ModelChoice[] | undefined

/**
 * The models offered in the picker: pi's model registry first (built-in +
 * models.json), falling back to the full models.dev catalog when the registry
 * is empty. Returns [] if both fail, since the picker always also accepts
 * free-typed text. Cached per process once a non-empty list is obtained.
 */
export async function listModels(_targetDir: string): Promise<ModelChoice[]> {
  if (cached) return cached

  const fromRegistry = await safe(() => Promise.resolve(listModelsFromRegistry()), "pi model registry")
  if (fromRegistry && fromRegistry.length > 0) return (cached = fromRegistry)

  const fromDev = await safe(() => fetchModelsDev(), "models.dev")
  if (fromDev && fromDev.length > 0) return (cached = fromDev)

  return []
}

function listModelsFromRegistry(): ModelChoice[] {
  // pi has no model "variants"; each model maps to a single choice.
  return toModelChoices(piRuntime().modelRegistry.getAll())
}

/** Pure transform from pi's model list to picker choices. */
export function toModelChoices(models: readonly Model<any>[]): ModelChoice[] {
  const choices: ModelChoice[] = []
  const seen = new Set<string>()
  for (const model of models) {
    const value = `${model.provider}/${model.id}`
    if (seen.has(value)) continue
    seen.add(value)
    const contextK = model.contextWindow ? Math.round(model.contextWindow / 1000) : undefined
    choices.push({ value, label: model.name, providerID: model.provider, ...(contextK ? { contextK } : {}) })
  }
  return choices
}

type ModelsDevModel = { name?: string; limit?: { context?: number } }
type ModelsDevProvider = { models?: Record<string, ModelsDevModel> }

/** Fallback catalog from models.dev. No variants and no enabled-provider filter; the full public list. */
export async function fetchModelsDev(): Promise<ModelChoice[]> {
  const response = await fetch(modelsDevUrl, { signal: AbortSignal.timeout(catalogTimeoutMs) })
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`)
  const data = (await response.json()) as Record<string, ModelsDevProvider>
  return parseModelsDev(data)
}

/** Pure transform of the models.dev payload, split out so it can be unit-tested with a fixture. */
export function parseModelsDev(data: Record<string, ModelsDevProvider>): ModelChoice[] {
  const choices: ModelChoice[] = []
  for (const [providerID, provider] of Object.entries(data)) {
    for (const [modelID, model] of Object.entries(provider?.models ?? {})) {
      const contextK = model?.limit?.context ? Math.round(model.limit.context / 1000) : undefined
      choices.push({ value: `${providerID}/${modelID}`, label: model?.name ?? modelID, providerID, ...(contextK ? { contextK } : {}) })
    }
  }
  choices.sort((a, b) => a.value.localeCompare(b.value))
  return choices
}

async function safe(fn: () => Promise<ModelChoice[]>, source: string): Promise<ModelChoice[] | undefined> {
  try {
    return await fn()
  } catch (error) {
    log.warn(`model catalog: ${source} unavailable (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}
