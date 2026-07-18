import { describe, expect, test } from "bun:test"

import { ModelCatalog, estimateCost, estimateRunCost, isFreeModel, rateForModel } from "../src/cost"

const testModels = [
  {
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    name: "DeepSeek V4 Flash",
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  },
  {
    id: "free-model",
    provider: "opencode-go",
    name: "Free Model",
    cost: { input: 0, output: 0 },
  },
  {
    id: "opus-4-8",
    provider: "anthropic",
    name: "Claude Opus 4.8",
    cost: { input: 15, output: 60 },
  },
]

const testCatalog = new ModelCatalog(testModels)

describe("ModelCatalog", () => {
  test("finds models by full ID", () => {
    const m = testCatalog.find("opencode-go/deepseek-v4-flash")
    expect(m?.id).toBe("deepseek-v4-flash")
  })

  test("strips variants when looking up", () => {
    const m = testCatalog.find("opencode-go/deepseek-v4-flash#xhigh")
    expect(m?.id).toBe("deepseek-v4-flash")
  })

  test("isFree returns true only when input and output are zero", () => {
    expect(testCatalog.isFree("opencode-go/free-model")).toBe(true)
    expect(testCatalog.isFree("opencode-go/deepseek-v4-flash")).toBe(false)
  })

  test("isFree returns false for unknown models", () => {
    expect(testCatalog.isFree("unknown/model")).toBe(false)
  })

  test("isCheap returns true for models with input+output <= $2/MTok", () => {
    // deepseek-v4-flash costs 0.14 + 0.28 = 0.42/MTok, well under $2
    expect(testCatalog.isCheap("opencode-go/deepseek-v4-flash")).toBe(true)
    // Free model (0 cost) is also cheap
    expect(testCatalog.isCheap("opencode-go/free-model")).toBe(true)
    // Expensive model (opus: 15 + 60 = 75/MTok) is not cheap
    expect(testCatalog.isCheap("anthropic/opus-4-8")).toBe(false)
  })

  test("isCheap returns false for unknown models", () => {
    expect(testCatalog.isCheap("unknown/model")).toBe(false)
  })

  test("returns empty for unknown models", () => {
    expect(testCatalog.find("nonexistent/model")).toBeUndefined()
  })

  test("all returns all models", () => {
    expect(testCatalog.all.length).toBe(3)
  })
})

describe("rateForModel", () => {
  test("returns rates for known models", () => {
    const rate = rateForModel("opencode-go/deepseek-v4-flash", testCatalog)
    expect(rate.inputPerMTok).toBe(0.14)
    expect(rate.outputPerMTok).toBe(0.28)
    expect(rate.cacheReadPerMTok).toBe(0.0028)
  })

  test("returns zero rates for unknown models", () => {
    const rate = rateForModel("unknown/model", testCatalog)
    expect(rate.inputPerMTok).toBe(0)
    expect(rate.outputPerMTok).toBe(0)
  })
})

describe("estimateCost", () => {
  test("estimates cost correctly for a free model", () => {
    const cost = estimateCost("opencode-go/free-model", { input: 5000, output: 2000 }, testCatalog)
    expect(cost).toBe(0)
  })

  test("estimates cost for a paid model", () => {
    const cost = estimateCost("opencode-go/deepseek-v4-flash", { input: 1000000, output: 500000 }, testCatalog)
    // (1M/1M) * 0.14 + (500k/1M) * 0.28 = 0.14 + 0.14 = 0.28
    expect(cost).toBeCloseTo(0.28, 4)
  })

  test("handles cache costs", () => {
    const cost = estimateCost(
      "opencode-go/deepseek-v4-flash",
      { input: 1000, output: 500, cacheRead: 500, cacheWrite: 200 },
      testCatalog,
    )
    const expected = (1000 / 1_000_000) * 0.14 + (500 / 1_000_000) * 0.28 + (500 / 1_000_000) * 0.0028 + (200 / 1_000_000) * 0
    expect(cost).toBeCloseTo(expected, 6)
  })
})

describe("isFreeModel", () => {
  test("returns true for free models", () => {
    expect(isFreeModel("opencode-go/free-model", testCatalog)).toBe(true)
  })

  test("returns false for paid models", () => {
    expect(isFreeModel("opencode-go/deepseek-v4-flash", testCatalog)).toBe(false)
  })
})

describe("estimateRunCost", () => {
  test("estimates run cost for a list of steps", () => {
    const steps = [
      { name: "implementer", model: "opencode-go/deepseek-v4-flash" },
      { name: "design", model: "anthropic/opus-4-8" },
    ]
    const tokens = { input: 1000000, output: 500000 }
    const result = estimateRunCost(steps, tokens, testCatalog)
    // implementer: (1M/1M)*0.14 + (500k/1M)*0.28 = 0.28
    // design: (1M/1M)*15 + (500k/1M)*60 = 45
    // min/max each scaled by 0.5/2.0
    expect(result.byPhase["implementer"]).toBeDefined()
    expect(result.byPhase["design"]).toBeDefined()
    expect(result.min).toBeGreaterThan(0)
    expect(result.max).toBeGreaterThan(result.min)
    expect(result.byModel["opencode-go/deepseek-v4-flash"]).toBeDefined()
    expect(result.byModel["anthropic/opus-4-8"]).toBeDefined()
  })

  test("estimateRunCost returns zero for free models", () => {
    const steps = [{ name: "test", model: "opencode-go/free-model" }]
    const tokens = { input: 5000, output: 2000 }
    const result = estimateRunCost(steps, tokens, testCatalog)
    expect(result.min).toBe(0)
    expect(result.max).toBe(0)
  })
})
