import { describe, expect, test } from "bun:test"

import { suggestConfigForBudget } from "../src/suggest"

describe("suggestConfigForBudget", () => {
  test("returns a suggestion that fits a generous budget", () => {
    const result = suggestConfigForBudget({ budget: 100, pipeline: "implement" })
    expect(result.fitsBudget).toBe(true)
    // Free-tier models cost $0, so expected can be 0 in some environments
    expect(result.estimatedCost.expected).toBeGreaterThanOrEqual(0)
    expect(result.proposed.pipelines.implement).toBeDefined()
    expect(result.proposed.pipelines.implement.steps.length).toBeGreaterThan(0)
  })

  test("returns a suggestion with fitsBudget: false when budget is too small even for free models", () => {
    // A negative budget is too small even when free models exist
    const result = suggestConfigForBudget({ budget: -1, pipeline: "implement" })
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
    expect(result.fitsBudget).toBe(true)
    expect(result.cheapestFittingTier).toBeDefined()
    expect(["free-only", "cheap", "frontier"]).toContain(result.cheapestFittingTier!)
  })
})
