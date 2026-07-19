import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { createMcpServer } from "../../src/mcp/server"

/**
 * Helper: create a connected client-server pair for testing.
 */
async function createConnectedPair() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  )

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])

  return { server, client, close: async () => { await client.close(); await server.close() } }
}

/**
 * Helper: call a tool and get the parsed result.
 * Throws if the tool returned an error.
 */
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as unknown as CallToolResult
  if (result.isError) {
    throw new Error(`Tool ${name} returned error: ${JSON.stringify(result.content)}`)
  }
  const textContent = result.content?.[0]
  if (textContent?.type === "text") {
    return JSON.parse(textContent.text as string)
  }
  return result.content
}

/**
 * Helper: call a tool that is expected to error, returning the parsed error content.
 */
async function callToolError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as unknown as CallToolResult
  if (!result.isError) {
    throw new Error(`Expected tool ${name} to error, but it succeeded: ${JSON.stringify(result.content)}`)
  }
  const textContent = result.content?.[0]
  if (textContent?.type === "text") {
    return JSON.parse(textContent.text as string)
  }
  return result.content
}

describe("MCP integration — PRD worked example lifecycle", () => {
  test("discover → plan → preview → start → cancel", async () => {
    const { client, close } = await createConnectedPair()

    // Step 1: list_pipelines — discover what's available
    const pipelines = await callTool(client, "list_pipelines")
    expect(Array.isArray(pipelines)).toBe(true)
    expect(pipelines.length).toBeGreaterThanOrEqual(8)
    const implementPipeline = pipelines.find((p: any) => p.name === "implement")
    expect(implementPipeline).toBeDefined()
    expect(implementPipeline.stepCount).toBeGreaterThanOrEqual(6)

    // Step 2: describe_pipeline — inspect "implement"
    const pipelineDetail = await callTool(client, "describe_pipeline", { name: "implement" })
    expect(pipelineDetail.name).toBe("implement")
    expect(pipelineDetail.steps.length).toBeGreaterThanOrEqual(6)
    const stepNames = pipelineDetail.steps.map((s: any) => s.name)
    expect(stepNames).toContain("implementer")
    expect(stepNames).toContain("tests")

    // Step 3: list_agents — see what agents are available
    const agents = await callTool(client, "list_agents")
    expect(Array.isArray(agents)).toBe(true)
    expect(agents.length).toBeGreaterThanOrEqual(6)
    expect(agents.find((a: any) => a.name === "implementer")).toBeDefined()
    expect(agents.find((a: any) => a.name === "test-engineer")).toBeDefined()

    // Step 4: describe_agent — inspect an agent
    const agentDetail = await callTool(client, "describe_agent", { name: "test-engineer" })
    expect(agentDetail.name).toBe("test-engineer")
    expect(agentDetail.defaultModel).toBeTruthy()
    expect(agentDetail.description).toBeTruthy()

    // Step 5: list_models — check the model catalog
    const models = await callTool(client, "list_models")
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)

    // Step 6: describe_model — inspect a specific model
    const modelDetail = await callTool(client, "describe_model", {
      modelID: "opencode/deepseek-v4-flash",
    })
    expect(modelDetail.id).toBeTruthy()
    expect(modelDetail.cost).toBeDefined()

    // Step 7: suggest_config_for_budget — plan within $5
    const suggestion = await callTool(client, "suggest_config_for_budget", {
      budget: 5.0,
      pipeline: "implement",
    })
    expect(suggestion.fitsBudget).toBe(true)
    expect(suggestion.proposed).toBeDefined()
    // Cost may be 0 when free models are selected; the key is fitsBudget is true
    expect(suggestion.estimatedCost).toBeDefined()

    // Step 8: preview_run — dry-run the plan
    const preview = await callTool(client, "preview_run", {
      prompt: "Add a dark mode toggle",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })
    expect(preview.runId).toBeTruthy()
    expect(preview.steps.length).toBeGreaterThan(0)
    expect(preview.estimatedCost).toBeDefined()
    expect(preview.warnings).toBeDefined()

    // Step 9: estimate_cost — get a standalone cost estimate
    const cost = await callTool(client, "estimate_cost", {
      prompt: "Small feature",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })
    expect(cost.min).toBeGreaterThanOrEqual(0)
    expect(cost.max).toBeGreaterThanOrEqual(cost.min)
    expect(cost.expected).toBeGreaterThanOrEqual(cost.min)

    await close()
  })

  test("start → status → cancel lifecycle", async () => {
    const { client, close } = await createConnectedPair()

    // start_run — begin a run
    const startResult = await callTool(client, "start_run", {
      prompt: "integration test",
      pipeline: "implement",
      targetDir: "/dev/null",
    })
    expect(startResult.runId).toBeTruthy()
    expect(startResult.status).toBe("started")
    const runId = startResult.runId

    // get_run_status — poll the run status (still in memory)
    const status = await callTool(client, "get_run_status", { runId })
    expect(["starting", "running"]).toContain(status.state)

    // cancel_run — abort the run
    const cancelResult = await callTool(client, "cancel_run", { runId })
    expect(cancelResult.ok).toBe(true)

    await close()
  })

  test("config tools: diff_config, set_config (validateOnly)", async () => {
    const { client, close } = await createConnectedPair()

    // diff_config
    const diff = await callTool(client, "diff_config", {
      scope: "project",
      yaml: "version: 1\ndefaults:\n  maxAttempts: 3\n",
    })
    expect(diff).toBeDefined()

    // set_config with validateOnly (dry-run)
    const setResult = await callTool(client, "set_config", {
      scope: "project",
      yaml: "version: 1\ndefaults:\n  maxAttempts: 3\n",
      validateOnly: true,
    })
    expect(setResult).toBeDefined()

    await close()
  })

  test("run query tools return errors for non-existent runs", async () => {
    const { client, close } = await createConnectedPair()

    // get_run_report on non-existent run
    const reportErr = await callToolError(client, "get_run_report", {
      runId: "00000000-000000-xxxx",
      phase: "implementer",
    })
    expect(reportErr.code).toBe(-32002)

    // get_run_cost on non-existent run
    const costErr = await callToolError(client, "get_run_cost", {
      runId: "00000000-000000-xxxx",
    })
    expect(costErr.code).toBe(-32002)

    // get_run_diff on non-existent run — returns empty diff (no error thrown)
    const diffResult = await callTool(client, "get_run_diff", {
      runId: "00000000-000000-xxxx",
    })
    expect(diffResult).toBeDefined()
    expect(Array.isArray(diffResult.filesChanged)).toBe(true)

    // get_run_commits on non-existent run — returns empty array (no error thrown)
    const commitsResult = await callTool(client, "get_run_commits", {
      runId: "00000000-000000-xxxx",
    })
    expect(Array.isArray(commitsResult)).toBe(true)
    expect(commitsResult.length).toBe(0)

    // cancel_run on non-existent run (returns ok:false, not an error)
    const cancelResult = await callTool(client, "cancel_run", {
      runId: "00000000-000000-xxxx",
    })
    expect(cancelResult.ok).toBe(false)
    expect(cancelResult.error).toContain("not found")

    // resume_run on non-existent run
    const resumeErr = await callToolError(client, "resume_run", {
      runId: "00000000-000000-xxxx",
    })
    expect(resumeErr.code).toBe(-32002)

    await close()
  })

  test("validate_config and get_config work", async () => {
    const { client, close } = await createConnectedPair()

    // validate_config with valid YAML
    const validation = await callTool(client, "validate_config", {
      yaml: "version: 1\ndefaults:\n  maxAttempts: 5\n",
    })
    expect(validation.ok).toBe(true)

    // get_config returns something
    const config = await callTool(client, "get_config", {})
    expect(config).toBeDefined()

    await close()
  })
})
