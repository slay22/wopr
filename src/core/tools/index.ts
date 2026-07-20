/**
 * Shared tool definitions for the core API.
 *
 * Every tool is defined once here with its name, description, input schema,
 * and executor. Transports (MCP server, pi extension) wrap these with their
 * own wire format.
 *
 * @module
 */

import { discoveryToolDefs } from "./discovery"
import { configToolDefs } from "./config"
import { planningToolDefs } from "./planning"
import { runsToolDefs } from "./runs"

// ─── Shared tool definition type ───────────────────────────────────────────

/**
 * A single tool definition shared across transports.
 *
 * - `name` — the tool name (e.g. "list_pipelines").
 * - `description` — what the tool does, for the LLM.
 * - `inputSchema` — JSON Schema for the tool's parameters.
 * - `execute` — the core API call. Must return JSON-serializable data.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

// ─── Combine all tool definitions ──────────────────────────────────────────

export const allToolDefs: ToolDef[] = [
  ...discoveryToolDefs,
  ...configToolDefs,
  ...planningToolDefs,
  ...runsToolDefs,
]

// Re-export individual category arrays for transport-specific use.
export { discoveryToolDefs, configToolDefs, planningToolDefs, runsToolDefs }
