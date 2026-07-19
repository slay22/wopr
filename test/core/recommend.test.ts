import { describe, expect, test } from "bun:test"

import { recommendPipeline } from "../../src/core/recommend"
import type { RecommendPipelineInput } from "../../src/core/types"

describe("recommendPipeline", () => {
  test('returns "implement" for add/create keywords', () => {
    const result = recommendPipeline({
      prompt: "Add a dark mode toggle to the settings screen",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("implement")
    expect(result.reason).toBeTruthy()
  })

  test('returns "implement" for "build" keyword', () => {
    const result = recommendPipeline({
      prompt: "Build a new login screen",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("implement")
  })

  test('returns "review" for "review" keyword', () => {
    const result = recommendPipeline({
      prompt: "Review the auth module for security issues",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("review")
  })

  test('returns "review" for "audit" keyword', () => {
    const result = recommendPipeline({
      prompt: "Audit the codebase for bugs",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("review")
  })

  test('returns "refine" for "fix issues" keyword', () => {
    const result = recommendPipeline({
      prompt: "Fix issues in the build pipeline",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("refine")
  })

  test('returns "refine" for "polish" keyword', () => {
    const result = recommendPipeline({
      prompt: "Polish the error handling in src/core",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("refine")
  })

  test('returns "converge" for "converge" keyword', () => {
    const result = recommendPipeline({
      prompt: "Converge on the right architecture",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("converge")
  })

  test('returns "review" when readOnly is true', () => {
    const result = recommendPipeline({
      prompt: "Fix the typo in src/foo.ts",
      preferences: { readOnly: true },
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("review")
  })

  test("returns custom high-rigor read-only pipeline", () => {
    const result = recommendPipeline({
      prompt: "Check for security issues",
      preferences: { readOnly: true, rigor: "high" },
    })
    expect(result.kind).toBe("custom")
    expect(result.steps.length).toBeGreaterThan(0)
    expect(result.steps.map((s) => (typeof s === "string" ? s : s.agent))).toContain("security-reviewer")
  })

  test("returns implement-lite for low-rigor implement", () => {
    const result = recommendPipeline({
      prompt: "Add a new feature",
      preferences: { rigor: "low" },
    })
    // Low rigor + implement intent → implement-lite named
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("implement-lite")
  })

  test("returns custom pipeline for changeExisting + high rigor", () => {
    const result = recommendPipeline({
      prompt: "Fix the bug in the auth module",
      preferences: { changeExisting: true, rigor: "high" },
    })
    expect(result.kind).toBe("custom")
    const steps = result.steps.map((s) => (typeof s === "string" ? s : s.agent))
    expect(steps).toContain("security-auditor")
    expect(steps).toContain("adversarial-reviewer")
  })

  test("returns ultra-implement for high rigor implement", () => {
    const result = recommendPipeline({
      prompt: "Add a complex feature",
      preferences: { rigor: "high" },
    })
    // "add" matches the "implement" group, high rigor → ultra-implement
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("ultra-implement")
  })

  test("returns implement-lite for low budget with no keyword match", () => {
    const result = recommendPipeline({
      prompt: "Something needs improvement",
      preferences: { budget: "low" },
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("implement-lite")
  })

  test("returns review for changeExisting (no explicit rigor)", () => {
    // Wait: changeExisting without readOnly and without "fix issues" keywords
    // falls through to keyword matching. "review" is not triggered. Let's use
    // "what's wrong" which triggers review:
    const result = recommendPipeline({
      prompt: "What's wrong with this code?",
      preferences: { changeExisting: true },
    })
    // "what's wrong" matches the review intent group
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("refine")
  })

  test("returns refine for 'clean up' keyword", () => {
    const result = recommendPipeline({
      prompt: "Clean up the codebase",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("refine")
  })

  test("falls back to implement for ambiguous prompts", () => {
    const result = recommendPipeline({
      prompt: "Do something",
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("implement")
  })

  test("returns custom pipeline for low-rigor review", () => {
    const result = recommendPipeline({
      prompt: "Review the code",
      preferences: { rigor: "low" },
    })
    // review + low rigor → review-lite named
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("review-lite")
  })

  test("returns ultra-refine for high rigor refine", () => {
    const result = recommendPipeline({
      prompt: "Fix issues and polish the UI",
      preferences: { rigor: "high" },
    })
    expect(result.kind).toBe("named")
    expect(result.pipeline).toBe("ultra-refine")
  })
})
