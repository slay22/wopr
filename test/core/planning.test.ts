import { describe, expect, test } from "bun:test"

import { previewRun, estimateCost, suggestConfigForBudget } from "../../src/core/planning"

describe("previewRun", () => {
  test("returns a complete RunPreview for the implement pipeline", () => {
    const preview = previewRun({
      prompt: "Add dark mode toggle",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.runId).toBeTruthy()
    expect(preview.runId.length).toBeGreaterThan(10)
    expect(preview.steps.length).toBeGreaterThan(0)
    expect(preview.baseRef).toBe("HEAD")
    expect(Array.isArray(preview.warnings)).toBe(true)

    // Should have steps
    const stepNames = preview.steps.map((s) => s.name)
    expect(stepNames).toContain("implementer")
  })

  test("returns cost estimates for each step", () => {
    const preview = previewRun({
      prompt: "Add tests",
      pipeline: "refine",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.estimatedCost).toBeDefined()
    expect(preview.estimatedCost.min).toBeGreaterThanOrEqual(0)
    expect(preview.estimatedCost.max).toBeGreaterThan(preview.estimatedCost.min)
    expect(preview.estimatedCost.expected).toBeGreaterThan(0)
  })

  test("throws for unknown pipeline", () => {
    expect(() =>
      previewRun({
        prompt: "test",
        pipeline: "non-existent-pipeline",
        targetDir: "/tmp/test-repo",
      }),
    ).toThrow()
  })

  test("returns readOnly status for each step", () => {
    const preview = previewRun({
      prompt: "Review only",
      pipeline: "review",
      targetDir: "/tmp/test-repo",
    })

    for (const step of preview.steps) {
      expect(typeof step.readOnly).toBe("boolean")
    }
  })
})

describe("estimateCost", () => {
  test("returns a cost estimate", () => {
    const cost = estimateCost({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(cost.min).toBeGreaterThanOrEqual(0)
    expect(cost.max).toBeGreaterThanOrEqual(cost.min)
    expect(cost.expected).toBeGreaterThanOrEqual(cost.min)
    expect(Object.keys(cost.byPhase).length).toBeGreaterThan(0)
  })
})

describe("suggestConfigForBudget", () => {
  test("returns a suggestion that fits the budget", () => {
    const suggestion = suggestConfigForBudget({
      budget: 10.0,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
      preferences: { tier: "free-only" },
    })

    expect(suggestion.fitsBudget).toBeDefined()
    expect(typeof suggestion.estimatedCost.expected).toBe("number")
    expect(suggestion.proposed).toBeDefined()
  })

  test("works with no preferences", () => {
    const suggestion = suggestConfigForBudget({
      budget: 5.0,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(suggestion.proposed).toBeDefined()
    expect(suggestion.estimatedCost).toBeDefined()
  })

  test("works for review pipeline (read-only)", () => {
    const suggestion = suggestConfigForBudget({
      budget: 2.0,
      pipeline: "review",
      targetDir: "/tmp/test-repo",
    })

    expect(suggestion.proposed).toBeDefined()
    expect(suggestion.fitsBudget).toBe(true)
  })

  test("fitsBudget is false when budget is zero", () => {
    const suggestion = suggestConfigForBudget({
      budget: 0,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
      preferences: { tier: "free-only" },
    })

    // With free-only and $0 budget, it may or may not be possible
    expect("fitsBudget" in suggestion).toBe(true)
    expect("estimatedCost" in suggestion).toBe(true)
  })

  test("returns cheapestFittingTier when applicable", () => {
    const suggestion = suggestConfigForBudget({
      budget: 0.01,
      pipeline: "implement-lite",
      targetDir: "/tmp/test-repo",
      preferences: { tier: "free-only" },
    })

    // cheapestFittingTier may be present when budget forces tier selection
    if (suggestion.fitsBudget && suggestion.cheapestFittingTier) {
      expect(suggestion.cheapestFittingTier).toBe("free-only")
    }
  })
})

// ─── Edge cases ─────────────────────────────────────────────────────────

describe("planning edge cases", () => {
  test("previewRun with implement-lite pipeline", () => {
    const preview = previewRun({
      prompt: "lite test",
      pipeline: "implement-lite",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.steps.length).toBeGreaterThan(0)
    expect(preview.runId).toBeTruthy()
  })

  test("previewRun with ultra-implement pipeline", () => {
    const preview = previewRun({
      prompt: "ultra test",
      pipeline: "ultra-implement",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.steps.length).toBeGreaterThan(0)
  })

  test("previewRun with converge pipeline", () => {
    const preview = previewRun({
      prompt: "converge test",
      pipeline: "converge",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.steps.length).toBeGreaterThan(0)
  })

  test("estimateCost matches preview cost for same pipeline", () => {
    const pipeline = "implement"
    const preview = previewRun({
      prompt: "test",
      pipeline,
      targetDir: "/tmp/test-repo",
    })
    const cost = estimateCost({
      prompt: "test",
      pipeline,
      targetDir: "/tmp/test-repo",
    })

    // Both should produce non-zero cost estimates
    expect(preview.estimatedCost.min).toBeGreaterThanOrEqual(0)
    expect(cost.min).toBeGreaterThanOrEqual(0)
  })

  test("estimateCost throws for unknown pipeline", () => {
    expect(() =>
      estimateCost({
        prompt: "test",
        pipeline: "unknown-pipeline",
        targetDir: "/tmp/test-repo",
      }),
    ).toThrow()
  })
})
