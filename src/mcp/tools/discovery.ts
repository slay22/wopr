import { listPipelines, describePipeline, listAgents, describeAgent, listModels, describeModel } from "../../core"
import { serializeError } from "../errors"
import type { ToolHandler } from "./index"

// ─── Tool handlers ──────────────────────────────────────────────────────────

export const discoveryHandlers: Record<string, ToolHandler> = {
  list_pipelines: async (args) => {
    const targetDir = args.targetDir as string | undefined
    return listPipelines(targetDir)
  },

  describe_pipeline: async (args) => {
    const name = args.name as string
    if (!name) throw new Error("name is required")
    const targetDir = args.targetDir as string | undefined
    return describePipeline(name, targetDir)
  },

  list_agents: async (args) => {
    const targetDir = args.targetDir as string | undefined
    return listAgents(targetDir)
  },

  describe_agent: async (args) => {
    const name = args.name as string
    if (!name) throw new Error("name is required")
    const targetDir = args.targetDir as string | undefined
    return describeAgent(name, targetDir)
  },

  list_models: async (args) => {
    const filter = args.filter as
      | { tag?: string; freeOnly?: boolean; reasoningOnly?: boolean }
      | undefined
    return listModels(filter)
  },

  describe_model: async (args) => {
    const modelID = args.modelID as string
    if (!modelID) throw new Error("modelID is required")
    return describeModel(modelID)
  },
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export const discoveryToolDefs = [
  {
    name: "list_pipelines",
    description: "List all available pipelines (built-in + project/global overrides).",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the server's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_pipeline",
    description: "Step-by-step detail for one pipeline, including agent names and models.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Pipeline name (e.g. 'implement', 'refine')." },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the server's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    description: "List all agents (built-in + project overrides).",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the server's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_agent",
    description: "Detail for one agent including its resolved model, prompt path, and temperature.",
    inputSchema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Agent name (e.g. 'implementer', 'security-auditor')." },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the server's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    description: "List models from pi's catalog, optionally filtered by tag/free/reasoning.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "object",
          description: "Optional filter criteria.",
          properties: {
            tag: { type: "string", description: "Filter by tag (e.g. 'free', 'cheap', 'frontier')." },
            freeOnly: { type: "boolean", description: "Only show free models." },
            reasoningOnly: { type: "boolean", description: "Only show reasoning models." },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_model",
    description: "Cost, context window, and tags for one model.",
    inputSchema: {
      type: "object" as const,
      required: ["modelID"],
      properties: {
        modelID: { type: "string", description: "Full model ID (e.g. 'opencode/deepseek-v4-flash')." },
      },
      additionalProperties: false,
    },
  },
]
