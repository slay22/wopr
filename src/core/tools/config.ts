/**
 * Shared tool definitions — config category.
 *
 * @module
 */

import type { ToolDef } from "./index"
import { getConfig, validateConfig, diffConfig, setConfig } from "../config"

export const configToolDefs: ToolDef[] = [
  {
    name: "get_config",
    description: "Load the merged, project, or global wopr config. Returns the full config object.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["global", "project", "merged"],
          description: "Config scope: 'global', 'project', or 'merged' (default).",
        },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the current working directory.",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const scope = args.scope as "global" | "project" | "merged" | undefined
      const targetDir = args.targetDir as string | undefined
      return getConfig(scope, targetDir)
    },
  },
  {
    name: "validate_config",
    description: "Validate a YAML string against the wopr config schema.",
    inputSchema: {
      type: "object",
      required: ["yaml"],
      properties: {
        yaml: { type: "string", description: "YAML config to validate." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const yaml = args.yaml as string
      if (yaml === undefined) throw new Error("yaml is required")
      return validateConfig(yaml)
    },
  },
  {
    name: "diff_config",
    description: "Show what would change in the config without writing.",
    inputSchema: {
      type: "object",
      required: ["scope", "yaml"],
      properties: {
        scope: {
          type: "string",
          enum: ["global", "project"],
          description: "Which config scope to diff.",
        },
        yaml: { type: "string", description: "Proposed YAML config." },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the current working directory.",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const scope = args.scope as "global" | "project"
      if (!scope) throw new Error("scope is required (global or project)")
      const yaml = args.yaml as string
      if (yaml === undefined) throw new Error("yaml is required")
      const targetDir = args.targetDir as string | undefined
      return diffConfig(scope, yaml, targetDir)
    },
  },
  {
    name: "set_config",
    description: "Write config to disk. With validateOnly: true, this is a dry-run 'plan' path.",
    inputSchema: {
      type: "object",
      required: ["scope", "yaml"],
      properties: {
        scope: {
          type: "string",
          enum: ["global", "project"],
          description: "Which config scope to write to.",
        },
        yaml: { type: "string", description: "YAML config to write." },
        targetDir: {
          type: "string",
          description: "Absolute path to the target project. Defaults to the current working directory.",
        },
        validateOnly: {
          type: "boolean",
          description: "When true, only validate without writing (dry-run).",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const scope = args.scope as "global" | "project"
      if (!scope) throw new Error("scope is required (global or project)")
      const yaml = args.yaml as string
      if (yaml === undefined) throw new Error("yaml is required")
      const targetDir = args.targetDir as string | undefined
      const validateOnly = args.validateOnly as boolean | undefined
      return setConfig(scope, yaml, { targetDir, validateOnly })
    },
  },
]
