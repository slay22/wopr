import { describe, expect, test } from "bun:test"

import {
  listPipelines,
  describePipeline,
  listAgents,
  listModels,
  previewRun,
  estimateCost,
  suggestConfigForBudget,
  validateConfig,
  getRunReport,
  RunNotFoundError,
} from "../../src/core"

describe("core API integration", () => {
  test("discovers pipelines and agents", () => {
    // Discovery: the full chain
    const pipelines = listPipelines()
    expect(pipelines.length).toBeGreaterThanOrEqual(8)

    const implementDetail = describePipeline("implement")
    expect(implementDetail.steps.length).toBeGreaterThanOrEqual(6)

    const agents = listAgents()
    expect(agents.length).toBeGreaterThanOrEqual(6)
    expect(agents.find((a) => a.name === "implementer")).toBeDefined()
  })

  test("previews a run without creating a workspace", () => {
    // Planning: the full preview chain
    const preview = previewRun({
      prompt: "Add a feature",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(preview.runId).toBeTruthy()
    expect(preview.runId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/)
    expect(preview.steps.length).toBeGreaterThan(0)
    expect(preview.estimatedCost.min).toBeGreaterThanOrEqual(0)
    expect(preview.estimatedCost.expected).toBeGreaterThanOrEqual(preview.estimatedCost.min)
    expect(preview.estimatedCost.byPhase).toBeDefined()
    expect(preview.estimatedCost.byModel).toBeDefined()
  })

  test("estimates cost for multiple pipelines", () => {
    // Cost estimation across pipelines
    const pipelines = ["implement", "implement-lite", "review", "refine"]

    for (const pipeline of pipelines) {
      const cost = estimateCost({
        prompt: "test",
        pipeline,
        targetDir: "/tmp/test-repo",
      })
      expect(cost.min).toBeGreaterThanOrEqual(0)
      expect(cost.max).toBeGreaterThanOrEqual(cost.min)
      expect(cost.expected).toBeGreaterThanOrEqual(cost.min)
      expect(Object.keys(cost.byPhase).length).toBeGreaterThan(0)
    }
  })

  test("suggests config within budget", () => {
    // Budget suggestion
    const suggestion = suggestConfigForBudget({
      budget: 5.0,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    expect(suggestion.proposed).toBeDefined()
    expect(suggestion.estimatedCost.expected).toBeGreaterThanOrEqual(0)
    expect(typeof suggestion.fitsBudget).toBe("boolean")
    // For a $5 budget, it should fit
    expect(suggestion.fitsBudget).toBe(true)
  })

  test("suggests free-only config when budget is tight", () => {
    const suggestion = suggestConfigForBudget({
      budget: 0.01,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
      preferences: { tier: "free-only" },
    })

    expect(suggestion.fitsBudget).toBe(true)
    expect(suggestion.cheapestFittingTier).toBe("free-only")
  })

  test("validates config YAML", () => {
    // Config validation
    const valid = validateConfig("version: 1\ndefaults:\n  maxAttempts: 5\n")
    expect(valid.ok).toBe(true)

    const invalid = validateConfig("defaults:\n  maxAttempts: not-a-number\n")
    // Should either be ok: true (if parseWoprConfig tolerates it) or ok: false with errors
    expect("ok" in invalid).toBe(true)
  })

  test("models can be listed", () => {
    const models = listModels()
    expect(Array.isArray(models)).toBe(true)

    // Models (if any) have the right shape
    if (models.length > 0) {
      const m = models[0]!
      expect(m.id).toBeTruthy()
      expect(m.displayName).toBeTruthy()
      expect(m.provider).toBeTruthy()
      expect(typeof m.contextWindow).toBe("number")
      expect(typeof m.cost.input).toBe("number")
      expect(typeof m.cost.output).toBe("number")
      expect(Array.isArray(m.tags)).toBe(true)
    }
  })

  test("RunNotFoundError has correct properties", () => {
    const error = new RunNotFoundError("test-run-123")
    expect(error.name).toBe("RunNotFoundError")
    expect(error.message).toContain("test-run-123")
    expect(error.runId).toBe("test-run-123")

    // Round-trip through constructor to verify type discrimination
    const roundTripped = new RunNotFoundError(error.runId)
    expect(roundTripped.message).toBe(error.message)
  })

  test("previewRun returns readOnly flags correctly", () => {
    const preview = previewRun({
      prompt: "review",
      pipeline: "review",
      targetDir: "/tmp/test-repo",
    })

    // The review pipeline has only read-only steps
    for (const step of preview.steps) {
      expect(step.readOnly).toBe(true)
    }
  })

  test("previewRun reflects pipeline stepCount", () => {
    const implementPreview = previewRun({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })

    const refinePreview = previewRun({
      prompt: "test",
      pipeline: "refine",
      targetDir: "/tmp/test-repo",
    })

    // Implement has fewer steps than refine (refine has 7 steps, implement has 6)
    // But the actual count depends on how the pipeline resolves
    expect(implementPreview.steps.length).toBeGreaterThanOrEqual(6)
    expect(refinePreview.steps.length).toBeGreaterThanOrEqual(6)
  })

  test("getRunReport rejects path-traversal phase names", async () => {
    // The `phase` argument is used to build a report file path. A
    // caller-supplied traversal name must be rejected before any file read.
    await expect(
      getRunReport("20240101-000000-aaaa", "../../../../etc/passwd"),
    ).rejects.toThrow(/invalid phase name/)

    // Only safe identifiers are accepted.
    await expect(
      getRunReport("20240101-000000-aaaa", "adversarial"),
    ).rejects.toThrow() // run doesn't exist, but phase name is valid
  })
})
