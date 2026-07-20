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

/**
 * Register all 23 tools on the MCP server.
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
