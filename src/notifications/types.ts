export type NotificationPriority = "default" | "high" | "urgent"

export type NtfyTarget = {
  kind: "ntfy"
  server: string // e.g. "https://ntfy.sh" (always https)
  topic: string // e.g. "wopr-leo-1234"
  auth?: { user: string; pass: string }
}

export type NotificationTarget = NtfyTarget // only ntfy for now; union for future

export type NotificationEvent =
  | { type: "run_started"; runId: string; pipeline: string; targetDir: string; worktreePath?: string; estimatedCost?: number }
  | { type: "phase_done"; runId: string; phase: string; durationMs: number; model: string; tokens: number; cost: number }
  | { type: "phase_failed"; runId: string; phase: string; attempts: number; error: string }
  | { type: "verdict_received"; runId: string; phase: string; verdict: "pass" | "partial" | "reject"; summary: string }
  | { type: "budget_warning"; runId: string; spent: number; cap: number; percentUsed: number }
  | { type: "budget_exceeded"; runId: string; spent: number; cap: number; atPhase: string }
  | { type: "run_completed"; runId: string; totalCost: number; durationMs: number; worktreePath?: string }
  | { type: "run_failed"; runId: string; failedPhase: string; error: string }

export type NotificationPayload = {
  title: string // e.g. "wopr · implementer done"
  message: string // multi-line body
  priority: NotificationPriority
  tags: string[] // emoji shortcodes, e.g. ["white_check_mark", "wopr"]
  click?: string // URL — for ntfy, file:// or https://
}
