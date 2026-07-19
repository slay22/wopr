import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { startMcpServer } from "./server"
import { discoveryToolDefs, configToolDefs, planningToolDefs, runsToolDefs } from "./tools/index"

/** All tool definitions. */
const allToolDefs = [...discoveryToolDefs, ...configToolDefs, ...planningToolDefs, ...runsToolDefs]

/** Version read from package.json. */
let _version: string | undefined

function readVersion(): string {
  if (_version) return _version
  try {
    // Try to read from the built package first (production binary), fall back
    // to the source package.json (development).
    const paths = [
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"),
    ]
    for (const p of paths) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string }
        if (pkg.version) {
          _version = pkg.version
          return _version
        }
      } catch {
        // try next path
      }
    }
  } catch {
    // ignore
  }
  _version = "0.1.0"
  return _version
}

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
