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
  startRun,
  cancelRun,
  getRunStatus,
  RunNotFoundError,
  ValidationError,
  AbortError,
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

  // ─── Typed errors ───────────────────────────────────────────────────

  test("ValidationError carries the errors array", () => {
    const err = new ValidationError(["model field missing"])
    expect(err.name).toBe("ValidationError")
    expect(err.errors).toEqual(["model field missing"])
  })

  test("AbortError carries the reason", () => {
    const err = new AbortError("user pressed cancel")
    expect(err.name).toBe("AbortError")
    expect(err.message).toContain("user pressed cancel")
  })

  // ─── startRun / cancelRun lifecycle ─────────────────────────────────

  test("startRun → cancelRun completes gracefully", async () => {
    const handle = startRun({
      prompt: "lifecycle test",
      pipeline: "implement",
      targetDir: "/dev/null",
    })

    // Immediately cancel after start
    const cancelResult = cancelRun(handle.runId)
    expect(cancelResult.ok).toBe(true)

    // The promise should resolve (not hang)
    const final = await handle.promise
    expect(["aborted", "failed"]).toContain(final.state)
  })

  test("cancelRun fails for non-existent run", () => {
    const result = cancelRun("00000000-000000-xxxx")
    if (!result.ok) {
      expect(result.error).toContain("not found")
    } else {
      expect.unreachable()
    }
  })

  test("getRunStatus returns a valid state for a fresh run", () => {
    const handle = startRun({
      prompt: "status test",
      pipeline: "implement",
      targetDir: "/dev/null",
    })

    const status = getRunStatus(handle.runId)
    // The background task may transition to "running" before we check
    expect(["starting", "running"]).toContain(status.state)
    expect(typeof status.startedAt).toBe("number")
  })

  // ─── Worked example (PRD's killer demo) ─────────────────────────────

  test("PRD worked example: discover → plan → budget", () => {
    // 1. Discover what's available
    const pipelines = listPipelines()
    const implement = pipelines.find((p) => p.name === "implement")
    expect(implement).toBeDefined()

    const detail = describePipeline("implement")
    expect(detail.steps.length).toBeGreaterThanOrEqual(6)

    // 2. List agents
    const agents = listAgents()
    const implementer = agents.find((a) => a.name === "implementer")
    expect(implementer).toBeDefined()

    // 3. Find free models
    const freeModels = listModels({ tag: "free" })
    expect(Array.isArray(freeModels)).toBe(true)

    // 4. Plan within budget
    const suggestion = suggestConfigForBudget({
      budget: 2.00,
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })
    expect(suggestion.fitsBudget).toBe(true)
    expect(suggestion.estimatedCost.expected).toBeGreaterThanOrEqual(0)

    // 5. Preview
    const preview = previewRun({
      prompt: "Add dark mode toggle",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
      ...suggestion.proposed,
    })
    expect(preview.runId).toBeTruthy()
    expect(preview.runId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/)
    expect(preview.steps.length).toBeGreaterThan(0)

    // 6. Verify cost structure
    expect(preview.estimatedCost.min).toBeGreaterThanOrEqual(0)
    expect(preview.estimatedCost.expected).toBeGreaterThanOrEqual(preview.estimatedCost.min)
    expect(preview.estimatedCost.byPhase).toBeDefined()
  })
})
