import { describe, it, expect } from "bun:test"

import { previewRun, estimateCost, suggestConfigForBudget } from "../../src/core/planning"

describe("previewRun", () => {
  it("returns a complete RunPreview for the implement pipeline", () => {
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

  it("returns cost estimates for each step", () => {
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

  it("throws for unknown pipeline", () => {
    expect(() =>
      previewRun({
        prompt: "test",
        pipeline: "non-existent-pipeline",
        targetDir: "/tmp/test-repo",
      }),
    ).toThrow()
  })

  it("returns readOnly status for each step", () => {
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
  it("returns a cost estimate", () => {
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
  it("returns a suggestion that fits the budget", () => {
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

  it("works with no preferences", () => {
    const suggestion = suggestConfigForBudget({
      budget: 5.0,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(suggestion.proposed).toBeDefined()
    expect(suggestion.estimatedCost).toBeDefined()
  })
})
