import { startMcpServer } from "./server"
import { allToolDefs } from "../core/tools"
import { readVersion } from "../version"

/**
 * Handle the `wopr mcp` CLI subcommand.
 *
 * Supports:
 *   wopr mcp            — start the MCP server (stdio)
 *   wopr mcp --version  — print version
 *   wopr mcp --list-tools — print all tool names + descriptions
 */
export async function handleMcpSubcommand(argv: string[]): Promise<void> {
  const rest = argv.slice(1) // skip "mcp"

  if (rest.includes("--version") || rest.includes("-v")) {
    process.stdout.write(`wopr ${readVersion()} (MCP server ready)\n`)
    return
  }

  if (rest.includes("--list-tools")) {
    for (const def of allToolDefs) {
      process.stdout.write(`${def.name}\n`)
      if (def.description) {
        process.stdout.write(`  ${def.description}\n`)
      }
      process.stdout.write("\n")
    }
    return
  }

  // Start the MCP server (runs until SIGINT/SIGTERM)
  await startMcpServer()
}
