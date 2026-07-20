/**
 * Pi tool wrappers for the 22 shared wopr tool definitions.
 *
 * Each tool is imported from the shared `src/core/tools` source and wrapped
 * in a pi `ToolDefinition` that pi's ExtensionAPI.registerTool() accepts.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { allToolDefs } from "../../src/core/tools"
import type { ToolDef } from "../../src/core/tools"

/**
 * Register all 22 wopr tools with a pi ExtensionAPI instance.
 *
 * Each shared ToolDef is wrapped in a pi ToolDefinition with:
 * - The same `name`, `description` from the shared source
 * - A JSON Schema `parameters` object
 * - An `execute` that calls the shared executor and returns an AgentToolResult
 */
export function registerAllWoprTools(pi: ExtensionAPI): void {
  for (const def of allToolDefs) {
    const piTool = toPiToolDef(def)
    pi.registerTool(piTool as any)
  }
}

/**
 * Convert a shared ToolDef to a pi-compatible tool registration object.
 *
 * pi's registerTool expects a ToolDefinition which requires a specific
 * parameter schema (TypeBox-based) and AgentToolResult return type. We cast
 * through `any` to bridge the gap between the shared JSON Schema approach
 * and pi's strongly-typed tool system, since wopr tools are always
 * request/response and don't need pi's full tool lifecycle.
 */
function toPiToolDef(def: ToolDef) {
  return {
    name: def.name,
    label: def.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: def.description,
    parameters: def.inputSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ) => {
      const result = await def.execute(params)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: undefined,
      }
    },
  }
}
