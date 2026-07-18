import { describe, expect, test } from "bun:test"

import { suggestConfigForBudget } from "../src/suggest"

describe("suggestConfigForBudget", () => {
  test("returns a suggestion that fits a generous budget", () => {
    const result = suggestConfigForBudget({ budget: 100, pipeline: "implement" })
    expect(result.fitsBudget).toBe(true)
    expect(result.estimatedCost.expected).toBeGreaterThan(0)
    expect(result.proposed.pipelines.implement).toBeDefined()
    expect(result.proposed.pipelines.implement.steps.length).toBeGreaterThan(0)
  })

  test("returns a suggestion with fitsBudget: false when budget is too small", () => {
    const result = suggestConfigForBudget({ budget: 0.0001, pipeline: "implement" })
    // Budget too small should still return a suggestion with fitsBudget: false
    expect(result.fitsBudget).toBe(false)
    expect(result.proposed.pipelines.implement).toBeDefined()
  })

  test("free-only preference uses cheapest models", () => {
    const result = suggestConfigForBudget({
      budget: 100,
      pipeline: "implement",
      preferences: { tier: "free-only" },
    })
    expect(result.fitsBudget).toBe(true)
  })

  test("applies per-agent preferences", () => {
    const result = suggestConfigForBudget({
      budget: 100,
      pipeline: "implement",
      preferences: {
        tier: "any",
        perAgent: { "design-polisher": "frontier" },
      },
    })
    expect(result.fitsBudget).toBe(true)
  })

  test("returns byPhase estimates", () => {
    const result = suggestConfigForBudget({ budget: 100, pipeline: "implement" })
    expect(Object.keys(result.estimatedCost.byPhase).length).toBeGreaterThan(0)
    for (const phaseCost of Object.values(result.estimatedCost.byPhase)) {
      expect(phaseCost.min).toBeGreaterThanOrEqual(0)
      expect(phaseCost.max).toBeGreaterThanOrEqual(phaseCost.min)
    }
  })

  test("cheapestFittingTier is set when fitsBudget", () => {
    const result = suggestConfigForBudget({ budget: 100, pipeline: "implement" })
    if (result.fitsBudget) {
      expect(["free-only", "cheap", "frontier"]).toContain(result.cheapestFittingTier)
    }
  })
})
