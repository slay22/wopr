import { describe, expect, test } from "bun:test"

import { CostTracker, type CostEntry } from "../src/usage"

function makeEntry(overrides: Partial<CostEntry> & { phase: string }): CostEntry {
  return {
    agent: "implementer",
    model: "openai/gpt-5.5",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputCost: 0.01,
    outputCost: 0.02,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0.03,
    durationMs: 5000,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe("CostTracker", () => {
  test("starts empty", () => {
    const tracker = new CostTracker()
    expect(tracker.spent()).toBe(0)
    expect(tracker.size).toBe(0)
  })

  test("tracks spent correctly", () => {
    const tracker = new CostTracker()
    tracker.record(makeEntry({ phase: "implementer", totalCost: 0.03 }))
    tracker.record(makeEntry({ phase: "patterns", totalCost: 0.02 }))
    expect(tracker.spent()).toBeCloseTo(0.05)
  })

  test("byPhase returns the entry for a phase", () => {
    const tracker = new CostTracker()
    tracker.record(makeEntry({ phase: "implementer", agent: "implementer", totalCost: 0.03 }))
    const entry = tracker.byPhase("implementer")
    expect(entry?.totalCost).toBeCloseTo(0.03)
    expect(tracker.byPhase("nonexistent")).toBeUndefined()
  })

  test("estimateNext returns a default constant", () => {
    const tracker = new CostTracker()
    const est = tracker.estimateNext("implementer", "openai/gpt-5.5")
    expect(est).toBe(0.001) // default estimate
  })

  test("snapshot aggregates by phase and model", () => {
    const tracker = new CostTracker()
    tracker.record(makeEntry({ phase: "implementer", model: "gpt-5.5", totalCost: 0.03, inputTokens: 1000, outputTokens: 500, durationMs: 5000 }))
    tracker.record(makeEntry({ phase: "patterns", model: "gpt-5.5", totalCost: 0.02, inputTokens: 800, outputTokens: 400, durationMs: 3000 }))
    tracker.record(makeEntry({ phase: "design", model: "opus-4.8", totalCost: 0.15, inputTokens: 2000, outputTokens: 1000, durationMs: 8000 }))

    const snap = tracker.snapshot()
    expect(snap.entries.length).toBe(3)
    expect(snap.total.totalCost).toBeCloseTo(0.20)
    expect(snap.total.inputTokens).toBe(3800)
    expect(snap.total.durationMs).toBe(16000)

    // Per-phase
    expect(snap.byPhase["implementer"].totalCost).toBeCloseTo(0.03)
    expect(snap.byPhase["design"].calls).toBe(1)

    // Per-model
    expect(snap.byModel["gpt-5.5"].totalCost).toBeCloseTo(0.05)
    expect(snap.byModel["gpt-5.5"].calls).toBe(2)
    expect(snap.byModel["opus-4.8"].totalCost).toBeCloseTo(0.15)
  })

  test("snapshot with no entries has zero totals", () => {
    const tracker = new CostTracker()
    const snap = tracker.snapshot()
    expect(snap.total.totalCost).toBe(0)
    expect(snap.entries).toEqual([])
    expect(snap.byPhase).toEqual({})
    expect(snap.byModel).toEqual({})
  })
})
