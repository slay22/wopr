import type { ProgressStepUsage, ProgressTokens, ProgressUsage } from "./progress"

/** One cost observation recorded by the CostTracker after a phase completes. */
export type CostEntry = {
  phase: string
  agent: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  durationMs: number
  timestamp: number
}

/** Aggregated cost for a run: per-entry list plus rolled-up totals. */
export type RunCost = {
  entries: CostEntry[]
  total: { inputTokens: number; outputTokens: number; totalCost: number; durationMs: number }
  byPhase: Record<string, { totalCost: number; calls: number }>
  byModel: Record<string, { totalCost: number; calls: number }>
}

/**
 * Pure-function cost tracker that records per-phase cost entries and
 * provides read-only aggregation and estimation. No side effects beyond
 * mutating internal state.
 */
export class CostTracker {
  private readonly _entries: CostEntry[] = []

  /** Total USD spent so far. */
  spent(): number {
    return this._entries.reduce((sum, e) => sum + e.totalCost, 0)
  }

  /** Look up a phase by name. */
  byPhase(phaseName: string): CostEntry | undefined {
    return this._entries.find((e) => e.phase === phaseName)
  }

  /**
   * Naive estimate for the next phase. Uses a default token estimate
   * until calibration data is available (out of scope for MVP).
   */
  estimateNext(_phaseName: string, _model: string): number {
    // MVP: constant default estimate. Calibration (EMA + persistence) is
    // a separate feature — see PRD out-of-scope section.
    // A more accurate version would look up historical per-agent averages.
    return 0.001 // roughly $0.001 for 5k input + 2k output at cheap rates
  }

  /** Snapshot of all recorded data. */
  snapshot(): RunCost {
    const total = this._entries.reduce(
      (acc, e) => ({
        inputTokens: acc.inputTokens + e.inputTokens,
        outputTokens: acc.outputTokens + e.outputTokens,
        totalCost: acc.totalCost + e.totalCost,
        durationMs: acc.durationMs + e.durationMs,
      }),
      { inputTokens: 0, outputTokens: 0, totalCost: 0, durationMs: 0 },
    )

    const byPhase: Record<string, { totalCost: number; calls: number }> = {}
    const byModel: Record<string, { totalCost: number; calls: number }> = {}

    for (const e of this._entries) {
      if (!byPhase[e.phase]) byPhase[e.phase] = { totalCost: 0, calls: 0 }
      byPhase[e.phase]!.totalCost += e.totalCost
      byPhase[e.phase]!.calls++

      if (!byModel[e.model]) byModel[e.model] = { totalCost: 0, calls: 0 }
      byModel[e.model]!.totalCost += e.totalCost
      byModel[e.model]!.calls++
    }

    return {
      entries: [...this._entries],
      total,
      byPhase,
      byModel,
    }
  }

  /** Record one phase's cost entry. */
  record(entry: CostEntry): void {
    this._entries.push(entry)
  }

  /** Number of entries recorded. */
  get size(): number {
    return this._entries.length
  }
}


/** A zeroed token tally; the canonical empty value for every accumulator. */
export function emptyTokens(): ProgressTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function cloneTokens(tokens: ProgressTokens): ProgressTokens {
  return { ...tokens }
}

export function addTokens(left: ProgressTokens, right: ProgressTokens): ProgressTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  }
}

/** Drops NaN/Infinity/undefined to 0 so one bad event can't poison a running total. */
export function safeCost(cost: number | undefined): number {
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0
}

/** Normalizes opencode's `{ input, output, reasoning, cache: { read, write } }` token shape into ProgressTokens. */
export function tokensFromValue(value: unknown): ProgressTokens | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  const input = numberToken(tokens.input)
  const output = numberToken(tokens.output)
  const reasoning = numberToken(tokens.reasoning)
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const cacheRead = numberToken(cache.read)
  const cacheWrite = numberToken(cache.write)
  const total = typeof tokens.total === "number" && Number.isFinite(tokens.total) ? tokens.total : input + output + reasoning
  return { input, output, reasoning, cacheRead, cacheWrite, total }
}

function numberToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

type SessionUsage = {
  cost: number
  tokens: ProgressTokens
  model: string
  steps: number
  reported: boolean
  totalReported: boolean
}

export type PhaseUsageTotals = {
  cost: number
  tokens: ProgressTokens
  model: string
  steps: number
  reported: boolean
}

/**
 * Per-phase cost/token bookkeeping shared by the metadata store and the TUI.
 *
 * opencode reports usage two ways: incremental step deltas and an authoritative
 * cumulative total per opencode session. Both signals repeat, are keyed by session,
 * and the cumulative total must win over deltas once it lands. Centralizing the
 * dedup + "total wins" rules here keeps the live dashboard, the persisted metadata,
 * and the final summary from drifting apart.
 */
export class PhaseUsage {
  private readonly sessions = new Map<string, SessionUsage>()
  private readonly seenSteps = new Set<string>()
  /**
   * Session key for usage events that arrive without a sessionID. The TUI points
   * this at the phase's own session so stray deltas land in the same bucket as the
   * identified ones rather than a separate tally.
   */
  fallbackSessionID = "phase"

  /** Applies a step-delta usage event. Returns false when this stepID was already counted. */
  addStep(usage: ProgressStepUsage): boolean {
    if (usage.stepID) {
      if (this.seenSteps.has(usage.stepID)) return false
      this.seenSteps.add(usage.stepID)
    }
    const session = this.session(usage.sessionID)
    // Once the authoritative total has landed, deltas would double-count.
    if (!session.totalReported) {
      session.cost += safeCost(usage.cost)
      if (usage.tokens) session.tokens = addTokens(session.tokens, usage.tokens)
    }
    session.steps += 1
    if (usage.model) session.model = usage.model
    session.reported = true
    return true
  }

  /** Applies an authoritative cumulative total for a session; supersedes its deltas. */
  setTotal(usage: ProgressUsage): void {
    const session = this.session(usage.sessionID)
    if (typeof usage.cost === "number") session.cost = safeCost(usage.cost)
    if (usage.tokens) session.tokens = cloneTokens(usage.tokens)
    if (usage.model) session.model = usage.model
    session.reported = true
    session.totalReported = true
  }

  get isEmpty(): boolean {
    return this.sessions.size === 0
  }

  /** Collapses every session into one phase-level tally. Model is the last non-empty one seen. */
  totals(): PhaseUsageTotals {
    let cost = 0
    let tokens = emptyTokens()
    let steps = 0
    let model = ""
    let reported = false
    for (const session of this.sessions.values()) {
      cost += session.cost
      tokens = addTokens(tokens, session.tokens)
      steps += session.steps
      reported ||= session.reported
      if (session.model) model = session.model
    }
    return { cost, tokens, model, steps, reported }
  }

  private session(sessionID?: string): SessionUsage {
    const key = sessionID || this.fallbackSessionID
    let session = this.sessions.get(key)
    if (!session) {
      session = { cost: 0, tokens: emptyTokens(), model: "", steps: 0, reported: false, totalReported: false }
      this.sessions.set(key, session)
    }
    return session
  }
}
