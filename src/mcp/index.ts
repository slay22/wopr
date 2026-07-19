/**
 * wopr MCP server module.
 *
 * Exposes the 22-tool MCP server wrapping the core API.
 * The server communicates via stdio (JSON-RPC 2.0).
 *
 * @module
 */

export { createMcpServer, startMcpServer } from "./server"
export { handleMcpSubcommand } from "./cli"
export { serializeError } from "./errors"
