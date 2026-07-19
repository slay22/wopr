import { describe, expect, test } from "bun:test"

import { handleMcpSubcommand } from "../../src/mcp/cli"

describe("handleMcpSubcommand", () => {
  test("--version prints version and MCP server ready", async () => {
    // Capture stdout
    const origWrite = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    process.stdout.write = ((chunk: any) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await handleMcpSubcommand(["mcp", "--version"])
      const output = chunks.join("")
      expect(output).toContain("wopr")
      expect(output).toContain("MCP server ready")
    } finally {
      process.stdout.write = origWrite
    }
  })

  test("-v prints version and MCP server ready", async () => {
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: any) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await handleMcpSubcommand(["mcp", "-v"])
      const output = chunks.join("")
      expect(output).toContain("wopr")
      expect(output).toContain("MCP server ready")
    } finally {
      process.stdout.write = origWrite
    }
  })

  test("--list-tools prints all 23 tool names and descriptions", async () => {
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: any) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await handleMcpSubcommand(["mcp", "--list-tools"])
      const output = chunks.join("")

      // Every tool name should appear
      expect(output).toContain("list_pipelines")
      expect(output).toContain("describe_pipeline")
      expect(output).toContain("list_agents")
      expect(output).toContain("describe_agent")
      expect(output).toContain("list_models")
      expect(output).toContain("describe_model")
      expect(output).toContain("get_config")
      expect(output).toContain("validate_config")
      expect(output).toContain("diff_config")
      expect(output).toContain("set_config")
      expect(output).toContain("preview_run")
      expect(output).toContain("estimate_cost")
      expect(output).toContain("suggest_config_for_budget")
      expect(output).toContain("start_run")
      expect(output).toContain("get_run_status")
      expect(output).toContain("list_runs")
      expect(output).toContain("get_run_report")
      expect(output).toContain("get_run_cost")
      expect(output).toContain("get_run_diff")
      expect(output).toContain("get_run_commits")
      expect(output).toContain("cancel_run")
      expect(output).toContain("resume_run")
      expect(output).toContain("recommend_pipeline")

      // Each tool should have a description (indented on the next line)
      const lines = output.split("\n").filter((l) => l.trim().length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(23)
    } finally {
      process.stdout.write = origWrite
    }
  })

  test("--list-tools output has descriptions for every tool", async () => {
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: any) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await handleMcpSubcommand(["mcp", "--list-tools"])
      const output = chunks.join("")
      const lines = output.split("\n")

      // Every tool name line should be followed by an indented description
      const toolLines = lines.filter((l) => l.startsWith("list_") || l.startsWith("describe_") || l.startsWith("get_") || l.startsWith("set_") || l.startsWith("diff_") || l.startsWith("validate_") || l.startsWith("preview_") || l.startsWith("estimate_") || l.startsWith("suggest_") || l.startsWith("start_") || l.startsWith("cancel_") || l.startsWith("resume_") || l.startsWith("recommend_"))
      expect(toolLines.length).toBe(23)

      // Each tool should have an indented description line
      for (const line of toolLines) {
        const idx = lines.indexOf(line)
        if (idx >= 0 && idx + 1 < lines.length) {
          expect(lines[idx + 1].startsWith("  ")).toBe(true)
        }
      }
    } finally {
      process.stdout.write = origWrite
    }
  })
})
