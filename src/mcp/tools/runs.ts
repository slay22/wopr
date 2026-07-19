import {
  startRun,
  getRunStatus,
  listRuns,
  getRunReport,
  getRunCost,
  getRunDiff,
  getRunCommits,
  cancelRun,
  resumeRun,
} from "../../core"
import type { RunInput } from "../../core/types"
import type { ToolHandler } from "./index"

// ─── Tool handlers ──────────────────────────────────────────────────────────

export const runsHandlers: Record<string, ToolHandler> = {
  start_run: async (args) => {
    const input = args as unknown as RunInput
    if (!input.prompt) throw new Error("prompt is required")
    if (!input.pipeline && !input.steps) throw new Error("pipeline or steps is required")
    if (!input.targetDir) throw new Error("targetDir is required")

    const handle = startRun(input)
    return {
      runId: handle.runId,
      status: "started",
      note: "Poll get_run_status for progress. The run executes in the background.",
    }
  },

  get_run_status: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    return getRunStatus(runId)
  },

  list_runs: async (args) => {
    const filter = args.filter as
      | { targetDir?: string; since?: number; pipeline?: string; limit?: number }
      | undefined
    return listRuns(filter)
  },

  get_run_report: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    const phase = args.phase as string
    if (!phase) throw new Error("phase is required")
    return getRunReport(runId, phase)
  },

  get_run_cost: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    return getRunCost(runId)
  },

  get_run_diff: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    const against = (args.against as "base" | "previous" | undefined) ?? "base"
    return getRunDiff(runId, against)
  },

  get_run_commits: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    return getRunCommits(runId)
  },

  cancel_run: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    const reason = args.reason as string | undefined
    return cancelRun(runId, reason)
  },

  resume_run: async (args) => {
    const runId = args.runId as string
    if (!runId) throw new Error("runId is required")
    const handle = await resumeRun(runId)
    return {
      runId: handle.runId,
      status: "resumed",
      note: "Poll get_run_status for progress.",
    }
  },
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export const runsToolDefs = [
  {
    name: "start_run",
    description:
      "Start a wopr run. Returns a runId immediately. Poll get_run_status for progress.",
    inputSchema: {
      type: "object" as const,
      required: ["prompt", "targetDir"],
      properties: {
        prompt: { type: "string", description: "The PRD or task description." },
        pipeline: { type: "string", description: "Pipeline name (e.g. 'implement', 'refine'). Ignored when steps is set." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent name (e.g. 'implementer', 'test-engineer')." },
              name: { type: "string", description: "Optional step name." },
              model: { type: "string", description: "Optional model override for this step." },
            },
            required: ["agent"],
            additionalProperties: true,
          },
          description: "Custom steps array for a dynamic pipeline. Takes precedence over pipeline.",
        },
        targetDir: { type: "string", description: "Absolute path to the target project." },
        baseRef: { type: "string", description: "Branch/ref for diff calculation. Defaults to auto-detected." },
        worktree: {
          type: "object",
          properties: {
            dir: { type: "string" },
            mainRepo: { type: "string" },
          },
          description: "Run in an isolated worktree on a new branch.",
        },
        keepWorktree: { type: "boolean", description: "Keep the worktree checkout after a successful run." },
        budget: {
          type: "object",
          properties: {
            perRun: { type: "number", description: "Hard cap in USD." },
            onExceed: { type: "string", enum: ["abort", "warn-and-continue"] },
          },
        },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to every step." },
        modelOverride: { type: "string", description: "Force a model for all steps." },
        onlySteps: { type: "array", items: { type: "string" }, description: "Run only these pipeline steps." },
        skipSteps: { type: "array", items: { type: "string" }, description: "Skip these pipeline steps." },
        keepRunDir: { type: "boolean", description: "Keep the run dir after completion." },
        maxAttempts: { type: "number", description: "Attempts per step (default: 2)." },
        yolo: { type: "boolean", description: "Auto-allow ask-level permissions." },
        smart: { type: "boolean", description: "Smart auto-accept via AI judge." },
        smartJudgeModel: { type: "string", description: "Model for the safety judge." },
        initRepo: { type: "boolean", description: "Create git repo + initial commit first." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_status",
    description:
      "Poll the status of an in-flight or finished run. Returns starting/running/completed/failed/aborted/budget_exceeded.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID returned by start_run." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_runs",
    description:
      "List past runs, optionally filtered by targetDir, since timestamp, pipeline, or limit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "object",
          properties: {
            targetDir: { type: "string" },
            since: { type: "number", description: "Unix timestamp (ms)." },
            pipeline: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_report",
    description:
      "Read a phase report (markdown + structured findings) for a given run and phase.",
    inputSchema: {
      type: "object" as const,
      required: ["runId", "phase"],
      properties: {
        runId: { type: "string", description: "Run ID." },
        phase: { type: "string", description: "Phase name (e.g. 'adversarial', 'implementer')." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_cost",
    description: "Cost breakdown by phase and model for a given run.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_diff",
    description: "File-level diff summary for a given run.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID." },
        against: {
          type: "string",
          enum: ["base", "previous"],
          description: "Diff against base branch or previous commit. Default: base.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_commits",
    description: "Commit list with phase annotations for a given run.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_run",
    description: "Abort an in-flight run by ID.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID to cancel." },
        reason: { type: "string", description: "Optional reason for the cancellation." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resume_run",
    description: "Resume an incomplete run by ID. Returns a new runId.",
    inputSchema: {
      type: "object" as const,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Run ID of an incomplete run to resume." },
      },
      additionalProperties: false,
    },
  },
]
