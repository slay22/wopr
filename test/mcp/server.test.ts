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
 * Helper: call a tool and parse the text content.
 */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ content: any; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args }) as unknown as CallToolResult
  return { content: result.content, isError: result.isError }
}

/**
 * Helper: parse text content from a tool result.
 */
function parseTextContent(result: { content: any }): any {
  const textContent = result.content?.[0]
  if (textContent?.type === "text") {
    return JSON.parse(textContent.text as string)
  }
  return textContent
}

describe("MCP server tools/list", () => {
  test("returns all 22 tools", async () => {
    const { client, close } = await createConnectedPair()

    const result = await client.listTools()
    const tools = result.tools

    expect(tools).toBeDefined()
    expect(tools.length).toBe(22)

    // Verify all expected tool names are present
    const toolNames = tools.map((t: any) => t.name).sort()
    expect(toolNames).toEqual([
      "cancel_run",
      "describe_agent",
      "describe_model",
      "describe_pipeline",
      "diff_config",
      "estimate_cost",
      "get_config",
      "get_run_commits",
      "get_run_cost",
      "get_run_diff",
      "get_run_report",
      "get_run_status",
      "list_agents",
      "list_models",
      "list_pipelines",
      "list_runs",
      "preview_run",
      "resume_run",
      "set_config",
      "start_run",
      "suggest_config_for_budget",
      "validate_config",
    ])

    // Each tool must have an inputSchema
    for (const tool of tools) {
      expect((tool as any).inputSchema).toBeDefined()
    }

    await close()
  })
})

describe("MCP server tools/call", () => {
  test("list_pipelines returns pipeline summaries", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "list_pipelines", {})
    expect(result.isError).toBeFalsy()

    const pipelines = parseTextContent(result)
    expect(Array.isArray(pipelines)).toBe(true)
    expect(pipelines.length).toBeGreaterThanOrEqual(8)
    expect(pipelines.find((p: any) => p.name === "implement")).toBeDefined()
    expect(pipelines.find((p: any) => p.name === "refine")).toBeDefined()

    await close()
  })

  test("describe_pipeline returns step details", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "describe_pipeline", { name: "implement" })
    expect(result.isError).toBeFalsy()

    const content = parseTextContent(result)
    expect(content.name).toBe("implement")
    expect(content.steps.length).toBeGreaterThanOrEqual(6)

    await close()
  })

  test("list_agents returns agent summaries", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "list_agents", {})
    expect(result.isError).toBeFalsy()

    const agents = parseTextContent(result)
    expect(Array.isArray(agents)).toBe(true)
    expect(agents.length).toBeGreaterThanOrEqual(6)
    expect(agents.find((a: any) => a.name === "implementer")).toBeDefined()

    await close()
  })

  test("list_models returns model summaries", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "list_models", {})
    expect(result.isError).toBeFalsy()

    const models = parseTextContent(result)
    expect(Array.isArray(models)).toBe(true)

    await close()
  })

  test("preview_run returns run preview", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "preview_run", {
      prompt: "Add a feature",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })
    expect(result.isError).toBeFalsy()

    const preview = parseTextContent(result)
    expect(preview.runId).toBeTruthy()
    expect(preview.steps.length).toBeGreaterThan(0)
    expect(preview.estimatedCost).toBeDefined()

    await close()
  })

  test("estimate_cost returns cost projection", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "estimate_cost", {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    })
    expect(result.isError).toBeFalsy()

    const cost = parseTextContent(result)
    expect(cost.min).toBeGreaterThanOrEqual(0)
    expect(cost.max).toBeGreaterThanOrEqual(cost.min)

    await close()
  })

  test("suggest_config_for_budget returns suggestion", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "suggest_config_for_budget", {
      budget: 5.0,
      pipeline: "implement",
    })
    expect(result.isError).toBeFalsy()

    const suggestion = parseTextContent(result)
    expect(suggestion.fitsBudget).toBe(true)
    expect(suggestion.proposed).toBeDefined()

    await close()
  })

  test("config tools work", async () => {
    const { client, close } = await createConnectedPair()

    // validate_config
    const validateResult = await callTool(client, "validate_config", {
      yaml: "version: 1\ndefaults:\n  maxAttempts: 5\n",
    })
    expect(validateResult.isError).toBeFalsy()
    const validation = parseTextContent(validateResult)
    expect(validation.ok).toBe(true)

    // get_config (merged)
    const configResult = await callTool(client, "get_config", {})
    expect(configResult.isError).toBeFalsy()

    await close()
  })

  test("start_run and cancel_run lifecycle", async () => {
    const { client, close } = await createConnectedPair()

    // Start a run
    const startResult = await callTool(client, "start_run", {
      prompt: "lifecycle test",
      pipeline: "implement",
      targetDir: "/dev/null",
    })
    expect(startResult.isError).toBeFalsy()

    const startData = parseTextContent(startResult)
    expect(startData.runId).toBeTruthy()
    expect(startData.status).toBe("started")

    // Get status
    const statusResult = await callTool(client, "get_run_status", { runId: startData.runId })
    expect(statusResult.isError).toBeFalsy()

    const status = parseTextContent(statusResult)
    expect(["starting", "running"]).toContain(status.state)

    // Cancel the run
    const cancelResult = await callTool(client, "cancel_run", {
      runId: startData.runId,
      reason: "test cleanup",
    })
    expect(cancelResult.isError).toBeFalsy()

    const cancelData = parseTextContent(cancelResult)
    expect(cancelData.ok).toBe(true)

    // Cancel on non-existent run returns ok: false (not an MCP error, but a business-level error)
    const badCancelResult = await callTool(client, "cancel_run", {
      runId: "00000000-000000-xxxx",
    })
    expect(badCancelResult.isError).toBeFalsy()
    const badCancelData = parseTextContent(badCancelResult)
    expect(badCancelData.ok).toBe(false)
    expect(badCancelData.error).toContain("not found")

    await close()
  })

  test("unknown tool returns error", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "nonexistent_tool", {})
    expect(result.isError).toBe(true)

    await close()
  })

  test("tool with missing required arg returns error", async () => {
    const { client, close } = await createConnectedPair()

    const result = await callTool(client, "describe_pipeline", {})
    expect(result.isError).toBe(true)

    await close()
  })
})
