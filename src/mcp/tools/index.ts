import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { allToolDefs } from "../../core/tools"
import { serializeError } from "../errors"

/** Map of tool name → handler, built from the shared tool definitions. */
const handlersByName: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {}
for (const def of allToolDefs) {
  handlersByName[def.name] = def.execute
}

// Re-export tool defs for the CLI's --list-tools flag.
// Build arrays with only the name/description fields needed for listing.
export const discoveryToolDefs = allToolDefs.filter((d) =>
  ["list_pipelines", "describe_pipeline", "list_agents", "describe_agent", "list_models", "describe_model"].includes(d.name),
).map(({ name, description }) => ({ name, description }))

export const configToolDefs = allToolDefs.filter((d) =>
  ["get_config", "validate_config", "diff_config", "set_config"].includes(d.name),
).map(({ name, description }) => ({ name, description }))

export const planningToolDefs = allToolDefs.filter((d) =>
  ["recommend_pipeline", "preview_run", "estimate_cost", "suggest_config_for_budget"].includes(d.name),
).map(({ name, description }) => ({ name, description }))

export const runsToolDefs = allToolDefs.filter((d) =>
  ["start_run", "get_run_status", "list_runs", "get_run_report", "get_run_cost", "get_run_diff", "get_run_commits", "cancel_run", "resume_run"].includes(d.name),
).map(({ name, description }) => ({ name, description }))

/**
 * Register all 22 tools on the MCP server.
 * Handles tools/list and tools/call requests.
 */
export function registerAllTools(server: Server): void {
  // Build the MCP tool definitions from the shared source
  const mcpToolDefs = allToolDefs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  }))

  // tools/list: return the list of all tools with their schemas
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: mcpToolDefs }
  })

  // tools/call: dispatch to the right handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params

    const handler = handlersByName[name]
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code: -32601, message: `unknown tool: ${name}` }) }],
      }
    }

    try {
      const result = await handler(args ?? {})
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      const serialized = serializeError(e)
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(serialized) }],
      }
    }
  })
}
