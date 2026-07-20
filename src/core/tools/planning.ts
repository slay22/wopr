/**
 * Shared tool definitions — planning category.
 *
 * @module
 */

import type { ToolDef } from "./index"
import { previewRun, estimateCost, suggestConfigForBudget } from "../planning"
import { recommendPipeline } from "../recommend"
import type { RunInput, RecommendPipelineInput } from "../types"

export const planningToolDefs: ToolDef[] = [
  {
    name: "recommend_pipeline",
    description:
      "Given a prompt and optional preferences, recommends a named pipeline or a custom steps array. Pure heuristic, no LLM cost.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "The PRD or task description (first 200-500 chars are enough)." },
        targetDir: { type: "string", description: "Absolute path to the target project (optional)." },
        preferences: {
          type: "object",
          properties: {
            changeExisting: { type: "boolean", description: "When true, prefer refine/review over implement." },
            rigor: { type: "string", enum: ["low", "standard", "high"], description: "Rigor level." },
            budget: { type: "string", enum: ["low", "medium", "any"], description: "Budget preference." },
            readOnly: { type: "boolean", description: "When true, prefer read-only review." },
          },
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = args as unknown as RecommendPipelineInput
      if (!input.prompt) throw new Error("prompt is required")
      return recommendPipeline(input)
    },
  },
  {
    name: "preview_run",
    description:
      "Complete run preview without creating a workspace. Returns the run ID, step details, cost estimate, and warnings.",
    inputSchema: {
      type: "object",
      required: ["prompt", "targetDir"],
      properties: {
        prompt: { type: "string", description: "The PRD or task description." },
        pipeline: { type: "string", description: "Pipeline name (e.g. 'implement', 'refine'). Ignored when steps is set." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              name: { type: "string" },
              model: { type: "string" },
            },
            required: ["agent"],
            additionalProperties: true,
          },
          description: "Custom steps array. Takes precedence over pipeline.",
        },
        targetDir: { type: "string", description: "Absolute path to the target project." },
        baseRef: { type: "string", description: "Branch/ref for diff calculation. Defaults to auto-detected." },
        budget: {
          type: "object",
          properties: {
            perRun: { type: "number", description: "Hard cap in USD." },
            onExceed: { type: "string", enum: ["abort", "warn-and-continue"] },
          },
          description: "Optional budget cap.",
        },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to every step." },
        modelOverride: { type: "string", description: "Force a model for all steps." },
        onlySteps: { type: "array", items: { type: "string" }, description: "Run only these pipeline steps." },
        skipSteps: { type: "array", items: { type: "string" }, description: "Skip these pipeline steps." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = args as unknown as RunInput
      if (!input.prompt) throw new Error("prompt is required")
      if (!input.pipeline && !input.steps) throw new Error("pipeline or steps is required")
      if (!input.targetDir) throw new Error("targetDir is required")
      return previewRun(input)
    },
  },
  {
    name: "estimate_cost",
    description: "Pure cost projection for a pipeline. Returns min/max/expected cost by phase and model.",
    inputSchema: {
      type: "object",
      required: ["prompt", "targetDir"],
      properties: {
        prompt: { type: "string", description: "The PRD or task description." },
        pipeline: { type: "string", description: "Pipeline name (e.g. 'implement', 'refine'). Ignored when steps is set." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              name: { type: "string" },
              model: { type: "string" },
            },
            required: ["agent"],
            additionalProperties: true,
          },
          description: "Custom steps array. Takes precedence over pipeline.",
        },
        targetDir: { type: "string", description: "Absolute path to the target project." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = args as unknown as RunInput
      if (!input.prompt) throw new Error("prompt is required")
      if (!input.pipeline && !input.steps) throw new Error("pipeline or steps is required")
      if (!input.targetDir) throw new Error("targetDir is required")
      return estimateCost(input)
    },
  },
  {
    name: "suggest_config_for_budget",
    description: "Proposes a wopr configuration (agents + pipeline steps) that fits a given budget.",
    inputSchema: {
      type: "object",
      required: ["budget", "pipeline"],
      properties: {
        budget: { type: "number", description: "Maximum budget in USD." },
        pipeline: { type: "string", description: "Pipeline name (e.g. 'implement')." },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the current working directory.",
        },
        preferences: {
          type: "object",
          description: "Optional preferences for model selection.",
          properties: {
            tier: { type: "string", enum: ["free-only", "cheap", "any"] },
            perAgent: {
              type: "object",
              description: "Per-agent model tier preferences (agent name → 'free' | 'cheap' | 'frontier' | 'reasoning').",
              additionalProperties: { type: "string", enum: ["free", "cheap", "frontier", "reasoning"] },
            },
          },
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const budget = args.budget as number
      if (typeof budget !== "number" || budget <= 0) throw new Error("budget must be a positive number")
      const pipeline = args.pipeline as string
      if (!pipeline) throw new Error("pipeline is required")
      const targetDir = args.targetDir as string | undefined
      const preferences = args.preferences as
        | { tier?: "free-only" | "cheap" | "any"; perAgent?: Record<string, "free" | "cheap" | "frontier" | "reasoning"> }
        | undefined
      return suggestConfigForBudget({ budget, pipeline, targetDir, preferences })
    },
  },
]
