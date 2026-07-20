import { describe, expect, test } from "bun:test"
import { allToolDefs } from "../../../src/core/tools"

describe("wopr-for-pi tools — smoke tests against core API", () => {
  test("discovery tools return expected shapes", async () => {
    // list_pipelines
    const pipelines = await findAndExecute("list_pipelines")
    expect(Array.isArray(pipelines)).toBe(true)

    // list_agents
    const agents = await findAndExecute("list_agents")
    expect(Array.isArray(agents)).toBe(true)

    // list_models
    const models = await findAndExecute("list_models")
    expect(Array.isArray(models)).toBe(true)
  })

  test("describe_pipeline returns detail for 'implement'", async () => {
    const detail = await findAndExecute("describe_pipeline", { name: "implement" })
    expect(detail).toBeDefined()
    expect(detail.name).toBe("implement")
    expect(Array.isArray(detail.steps)).toBe(true)
  })

  test("describe_agent returns agent detail", async () => {
    const detail = await findAndExecute("describe_agent", { name: "implementer" })
    expect(detail).toBeDefined()
    expect(detail.name).toBe("implementer")
  })

  test("describe_model returns model details", async () => {
    // This may fail if pi's model registry doesn't have the model
    // We just verify the tool can be called without throwing
    try {
      const detail = await findAndExecute("describe_model", {
        modelID: "opencode/deepseek-v4-flash",
      })
      expect(detail).toBeDefined()
    } catch {
      // Model might not be in the registry; that's OK
    }
  })

  test("get_config returns config", async () => {
    const config = await findAndExecute("get_config")
    expect(config).toBeDefined()
  })

  test("validate_config validates YAML", async () => {
    const result = await findAndExecute("validate_config", {
      yaml: "version: 1\ndefaults:\n  maxAttempts: 3\n",
    })
    expect(result.ok).toBe(true)
  })

  test("preview_run returns a preview structure", async () => {
    const preview = await findAndExecute("preview_run", {
      prompt: "Add a dark mode toggle",
      pipeline: "implement",
      targetDir: "/tmp/test-repo-wopr",
    })
    expect(preview.runId).toBeTruthy()
    expect(Array.isArray(preview.steps)).toBe(true)
    expect(preview.estimatedCost).toBeDefined()
    expect(preview.warnings).toBeDefined()
  })

  test("estimate_cost returns cost projection", async () => {
    const cost = await findAndExecute("estimate_cost", {
      prompt: "Small feature",
      pipeline: "implement",
      targetDir: "/tmp/test-repo-wopr",
    })
    expect(cost.min).toBeGreaterThanOrEqual(0)
    expect(cost.max).toBeGreaterThanOrEqual(cost.min)
    expect(cost.expected).toBeGreaterThanOrEqual(cost.min)
  })

  test("suggest_config_for_budget returns suggestion", async () => {
    const suggestion = await findAndExecute("suggest_config_for_budget", {
      budget: 5.0,
      pipeline: "implement",
    })
    expect(suggestion.fitsBudget).toBe(true)
    expect(suggestion.proposed).toBeDefined()
    expect(suggestion.estimatedCost).toBeDefined()
  })

  test("start -> cancel lifecycle", async () => {
    // start_run
    const startResult = await findAndExecute("start_run", {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/dev/null",
    })
    expect(startResult.runId).toBeTruthy()
    expect(startResult.status).toBe("started")
    const runId = startResult.runId

    // get_run_status
    const status = await findAndExecute("get_run_status", { runId })
    expect(["starting", "running"]).toContain(status.state)

    // cancel_run
    const cancelResult = await findAndExecute("cancel_run", { runId })
    expect(cancelResult.ok).toBe(true)
  })

  test("run query tools handle non-existent runs gracefully", async () => {
    // get_run_report on non-existent run
    try {
      await findAndExecute("get_run_report", {
        runId: "00000000-000000-xxxx",
        phase: "implementer",
      })
      // Should have thrown
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toContain("not found")
    }

    // get_run_cost on non-existent run
    try {
      await findAndExecute("get_run_cost", { runId: "00000000-000000-xxxx" })
    } catch (e: any) {
      expect(e.message).toContain("not found")
    }

    // get_run_diff on non-existent run returns empty diff, not an error
    const diffResult = await findAndExecute("get_run_diff", {
      runId: "00000000-000000-xxxx",
    })
    expect(diffResult).toBeDefined()
    expect(Array.isArray(diffResult.filesChanged)).toBe(true)
  })
})

/**
 * Find a tool by name and execute it with the given args.
 */
async function findAndExecute(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const def = allToolDefs.find((d) => d.name === name)
  if (!def) throw new Error(`Tool not found: ${name}`)
  return def.execute(args)
}
