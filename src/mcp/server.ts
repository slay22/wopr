import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { registerAllTools } from "./tools/index"
import { log } from "../log"

/**
 * Create a configured MCP server with all 23 tools registered.
 * Does not connect to a transport — call startMcpServer() for that.
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: "wopr", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  registerAllTools(server)

  return server
}

/**
 * Start the MCP server with stdio transport.
 * Runs until SIGINT/SIGTERM.
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()

  log.info("[mcp] wopr MCP server starting (stdio transport)")
  await server.connect(transport)
  log.info("[mcp] wopr MCP server connected via stdio")

  // Graceful shutdown only matters for the long-running server process.
  // Kept out of createMcpServer() so that factory use (e.g. in tests) does
  // not accumulate process-level listeners.
  process.on("SIGINT", async () => {
    await server.close()
    process.exit(0)
  })
  process.on("SIGTERM", async () => {
    await server.close()
    process.exit(0)
  })
}
