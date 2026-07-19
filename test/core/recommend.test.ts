import { describe, expect, test } from "bun:test"

import { recommendPipeline } from "../../src/core/recommend"
import type { PipelineRecommendation, RecommendPipelineInput } from "../../src/core/types"

/**
 * Narrow a named recommendation.
 * TypeScript's control-flow analysis doesn't flow through expect(), so
 * we cast via a helper that also makes the assertion at runtime.
 */
function asNamed(r: PipelineRecommendation): { kind: "named"; pipeline: string; reason: string } {
  expect(r.kind).toBe("named")
  return r as { kind: "named"; pipeline: string; reason: string }
}

/**
 * Narrow a custom recommendation.
 */
function asCustom(r: PipelineRecommendation): { kind: "custom"; steps: any[]; reason: string } {
  expect(r.kind).toBe("custom")
  return r as { kind: "custom"; steps: any[]; reason: string }
}

describe("recommendPipeline", () => {
  test('returns "implement" for add/create keywords', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Add a dark mode toggle to the settings screen",
    }))
    expect(result.pipeline).toBe("implement")
    expect(result.reason).toBeTruthy()
  })

  test('returns "implement" for "build" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Build a new login screen",
    }))
    expect(result.pipeline).toBe("implement")
  })

  test('returns "review" for "review" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Review the auth module for security issues",
    }))
    expect(result.pipeline).toBe("review")
  })

  test('returns "review" for "audit" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Audit the codebase for bugs",
    }))
    expect(result.pipeline).toBe("review")
  })

  test('returns "refine" for "fix issues" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Fix issues in the build pipeline",
    }))
    expect(result.pipeline).toBe("refine")
  })

  test('returns "refine" for "polish" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Polish the error handling in src/core",
    }))
    expect(result.pipeline).toBe("refine")
  })

  test('returns "converge" for "converge" keyword', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Converge on the right architecture",
    }))
    expect(result.pipeline).toBe("converge")
  })

  test('returns "review" when readOnly is true', () => {
    const result = asNamed(recommendPipeline({
      prompt: "Fix the typo in src/foo.ts",
      preferences: { readOnly: true },
    }))
    expect(result.pipeline).toBe("review")
  })

  test("returns custom high-rigor read-only pipeline", () => {
    const result = asCustom(recommendPipeline({
      prompt: "Check for security issues",
      preferences: { readOnly: true, rigor: "high" },
    }))
    expect(result.steps.length).toBeGreaterThan(0)
    const names = result.steps.map((s) => (typeof s === "string" ? s : s.agent))
    expect(names).toContain("security-reviewer")
  })

  test("returns implement-lite for low-rigor implement", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Add a new feature",
      preferences: { rigor: "low" },
    }))
    expect(result.pipeline).toBe("implement-lite")
  })

  test("returns custom pipeline for changeExisting + high rigor", () => {
    const result = asCustom(recommendPipeline({
      prompt: "Fix the bug in the auth module",
      preferences: { changeExisting: true, rigor: "high" },
    }))
    const steps = result.steps.map((s) => (typeof s === "string" ? s : s.agent))
    expect(steps).toContain("security-auditor")
    expect(steps).toContain("adversarial-reviewer")
  })

  test("returns ultra-implement for high rigor implement", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Add a complex feature",
      preferences: { rigor: "high" },
    }))
    expect(result.pipeline).toBe("ultra-implement")
  })

  test("returns implement-lite for low budget with no keyword match", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Something needs improvement",
      preferences: { budget: "low" },
    }))
    expect(result.pipeline).toBe("implement-lite")
  })

  test("changeExisting at standard rigor returns refine", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Fix the codebase",
      preferences: { changeExisting: true },
    }))
    expect(result.pipeline).toBe("refine")
  })

  test("returns refine for 'clean up' keyword", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Clean up the codebase",
    }))
    expect(result.pipeline).toBe("refine")
  })

  test("falls back to implement for ambiguous prompts", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Do something",
    }))
    expect(result.pipeline).toBe("implement")
  })

  test("returns custom pipeline for low-rigor review", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Review the code",
      preferences: { rigor: "low" },
    }))
    expect(result.pipeline).toBe("review-lite")
  })

  test("returns ultra-refine for high rigor refine", () => {
    const result = asNamed(recommendPipeline({
      prompt: "Fix issues and polish the UI",
      preferences: { rigor: "high" },
    }))
    expect(result.pipeline).toBe("ultra-refine")
  })
})
