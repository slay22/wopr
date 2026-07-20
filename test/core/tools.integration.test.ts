import { describe, expect, test } from "bun:test"
import { allToolDefs } from "../../src/core/tools"
import {
  listPipelines,
  listAgents,
  getConfig,
  previewRun,
  estimateCost,
  startRun,
  cancelRun,
} from "../../src/core"
import type { CostEstimate } from "../../src/core/types"

describe("shared tool definitions — integration with core API", () => {
  test("allToolDefs contains 23 tools (6 discovery + 4 config + 4 planning + 9 runs)", () => {
    expect(allToolDefs.length).toBe(23)
  })

  test("discovery tool executors match core API output", async () => {
    const pipelinesDef = allToolDefs.find((d) => d.name === "list_pipelines")!
    const agentsDef = allToolDefs.find((d) => d.name === "list_agents")!

    const pipelinesFromTool = await pipelinesDef.execute({}) as any[]
    const pipelinesFromCore = await listPipelines()
    expect(pipelinesFromTool).toEqual(pipelinesFromCore)

    const agentsFromTool = await agentsDef.execute({}) as any[]
    const agentsFromCore = await listAgents()
    expect(agentsFromTool).toEqual(agentsFromCore)
  })

  test("config tool executors match core API output", async () => {
    const configDef = allToolDefs.find((d) => d.name === "get_config")!

    const configFromTool = await configDef.execute({}) as any
    const configFromCore = await getConfig()
    expect(configFromTool).toEqual(configFromCore)
  })

  test("preview_run returns same shape via tool and core", async () => {
    const previewDef = allToolDefs.find((d) => d.name === "preview_run")!

    const toolResult = await previewDef.execute({
      prompt: "integration test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }) as any

    const coreResult = await previewRun({
      prompt: "integration test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    } as any)

    expect(toolResult.runId).toBeTruthy()
    expect(toolResult.steps.length).toBeGreaterThan(0)
    // Each preview call generates a unique run ID; check structure, not the value
    expect(typeof toolResult.runId).toBe("string")
    expect(typeof coreResult.runId).toBe("string")
    expect(toolResult.steps.length).toEqual(coreResult.steps.length)
  })

  test("estimate_cost returns same values via tool and core", async () => {
    const costDef = allToolDefs.find((d) => d.name === "estimate_cost")!

    const toolResult = await costDef.execute({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }) as any

    const coreResult = await estimateCost({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    } as any) as CostEstimate

    expect(toolResult.min).toEqual(coreResult.min)
    expect(toolResult.max).toEqual(coreResult.max)
    expect(toolResult.expected).toEqual(coreResult.expected)
  })

  test("start_run returns same shape via tool and core", async () => {
    const startDef = allToolDefs.find((d) => d.name === "start_run")!

    const toolResult = await startDef.execute({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/dev/null",
    }) as any

    const coreHandle = startRun({
      prompt: "test",
      pipeline: "implement",
      targetDir: "/dev/null",
    } as any)

    expect(toolResult.runId).toBeTruthy()
    expect(toolResult.status).toBe("started")
    // Each start call creates a unique run; check structure, not ID equality
    expect(typeof toolResult.runId).toBe("string")
    expect(typeof coreHandle.runId).toBe("string")
    expect(toolResult.status).toEqual("started")

    // Cleanup both runs
    await cancelRun(toolResult.runId)
    await cancelRun(coreHandle.runId)
  })

  test("all tool names are valid identifiers", () => {
    for (const def of allToolDefs) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
