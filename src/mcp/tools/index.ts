import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { discoveryHandlers, discoveryToolDefs } from "./discovery"
import { configHandlers, configToolDefs } from "./config"
import { planningHandlers, planningToolDefs } from "./planning"
import { runsHandlers, runsToolDefs } from "./runs"
import { serializeError } from "../errors"

/**
 * A tool handler: receives the raw args and returns a JSON-serializable
 * result (will be wrapped in a text content block).
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

/** All tool definitions (used for tools/list). */
const allToolDefs = [...discoveryToolDefs, ...configToolDefs, ...planningToolDefs, ...runsToolDefs]

/** Map of tool name → handler. */
const allHandlers: Record<string, ToolHandler> = {
  ...discoveryHandlers,
  ...configHandlers,
  ...planningHandlers,
  ...runsHandlers,
}

/** Re-export tool defs for the CLI's --list-tools flag. */
export { discoveryToolDefs, configToolDefs, planningToolDefs, runsToolDefs }

/**
 * Register all 22 tools on the MCP server.
 * Handles tools/list and tools/call requests.
 */
export function registerAllTools(server: Server): void {
  // tools/list: return the list of all tools with their schemas
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allToolDefs }
  })

  // tools/call: dispatch to the right handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params

    const handler = allHandlers[name]
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
