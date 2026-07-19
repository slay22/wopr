import { describe, it, expect } from "bun:test"

import {
  listPipelines,
  describePipeline,
  listAgents,
  describeAgent,
  listModels,
  describeModel,
} from "../../src/core/discovery"
import { builtInPipelines } from "../../src/pipeline"
import { builtInAgents } from "../../src/pipeline"

describe("listPipelines", () => {
  it("returns 8 built-in pipelines", () => {
    const pipelines = listPipelines()
    expect(pipelines.length).toBeGreaterThanOrEqual(8)
    const names = pipelines.map((p) => p.name)
    expect(names).toContain("implement")
    expect(names).toContain("implement-lite")
    expect(names).toContain("review")
    expect(names).toContain("review-lite")
    expect(names).toContain("refine")
    expect(names).toContain("ultra-refine")
    expect(names).toContain("ultra-implement")
    expect(names).toContain("converge")
  })

  it("marks implement as built-in with correct step count", () => {
    const pipelines = listPipelines()
    const implement = pipelines.find((p) => p.name === "implement")
    expect(implement).toBeDefined()
    expect(implement!.source).toBe("built-in")
    expect(implement!.stepCount).toBeGreaterThan(0)
    expect(implement!.hasLoops).toBe(false)
  })

  it("marks converge as having loops", () => {
    const pipelines = listPipelines()
    const converge = pipelines.find((p) => p.name === "converge")
    expect(converge).toBeDefined()
    expect(converge!.hasLoops).toBe(true)
  })
})

describe("describePipeline", () => {
  it("returns detailed info for implement", () => {
    const detail = describePipeline("implement")
    expect(detail.name).toBe("implement")
    expect(detail.steps.length).toBeGreaterThan(0)
    expect(detail.steps[0]!.name).toBe("implementer")
    expect(detail.steps[0]!.agentName).toBe("implementer")
    expect(detail.steps[0]!.readOnly).toBe(false)
  })

  it("returns readOnly flags", () => {
    // Review pipeline has only read-only steps (report-only)
    const detail = describePipeline("review")
    for (const step of detail.steps) {
      expect(step.readOnly).toBe(true)
    }
  })

  it("throws for unknown pipeline", () => {
    expect(() => describePipeline("non-existent")).toThrow()
  })
})

describe("listAgents", () => {
  it("returns all built-in agents", () => {
    const agents = listAgents()
    expect(agents.length).toBeGreaterThanOrEqual(builtInAgents.length)
    const names = agents.map((a) => a.name)
    expect(names).toContain("implementer")
    expect(names).toContain("pattern-auditor")
    expect(names).toContain("security-auditor")
    expect(names).toContain("design-polisher")
    expect(names).toContain("test-engineer")
    expect(names).toContain("adversarial-reviewer")
  })
})

describe("describeAgent", () => {
  it("returns detail for implementer", () => {
    const detail = describeAgent("implementer")
    expect(detail.name).toBe("implementer")
    expect(detail.description).toBeTruthy()
    expect(detail.resolvedModel).toBeTruthy()
    expect(detail.readOnly).toBe(false)
  })

  it("throws for unknown agent", () => {
    expect(() => describeAgent("non-existent")).toThrow()
  })
})

describe("listModels", () => {
  it("returns an array (may be empty if no catalog)", () => {
    const models = listModels()
    expect(Array.isArray(models)).toBe(true)
  })

  it("filter freeOnly returns only free models", () => {
    const freeModels = listModels({ freeOnly: true })
    for (const m of freeModels) {
      expect(m.cost.input).toBe(0)
      expect(m.cost.output).toBe(0)
    }
  })
})

describe("describeModel", () => {
  it("throws for an unknown model", () => {
    expect(() => describeModel("nonexistent-provider/nonexistent-model")).toThrow()
  })
})
