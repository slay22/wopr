import type { ProgressStepUsage, ProgressTokens, ProgressUsage } from "./progress"

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
