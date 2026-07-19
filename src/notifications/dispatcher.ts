import { log } from "../log"
import { sendNotification } from "./ntfy"
import type { NotificationEvent, NotificationPayload, NotificationPriority, NotificationTarget, NtfyTarget } from "./types"

/**
 * Pure function: maps a NotificationEvent to a NotificationPayload
 * (title, message, priority, tags, optional click URL).
 */
export function formatEvent(event: NotificationEvent): NotificationPayload {
  switch (event.type) {
    case "run_started": {
      const lines = [`Pipeline: ${event.pipeline}`, `Target: ${event.targetDir}`]
      if (event.worktreePath) lines.push(`Worktree: ${event.worktreePath}`)
      if (event.estimatedCost !== undefined) lines.push(`Est. cost: $${event.estimatedCost.toFixed(2)}`)
      return {
        title: "wopr · run started",
        message: lines.join("\n"),
        priority: "default",
        tags: ["rocket", "wopr"],
      }
    }
    case "phase_done": {
      const mins = Math.round(event.durationMs / 60_000)
      return {
        title: `wopr · ${event.phase} done`,
        message: `${event.phase} complete in ${mins}m · $${event.cost.toFixed(4)} · ${event.tokens} tokens`,
        priority: "default",
        tags: ["white_check_mark", "wopr"],
      }
    }
    case "phase_failed": {
      return {
        title: `wopr · ${event.phase} failed`,
        message: `${event.phase} failed after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}: ${event.error}`,
        priority: "high",
        tags: ["x", "wopr"],
      }
    }
    case "verdict_received": {
      const icon = event.verdict === "pass" ? "white_check_mark" : event.verdict === "partial" ? "warning" : "x"
      const priority: NotificationPriority = event.verdict === "pass" ? "default" : "high"
      return {
        title: `wopr · validator: ${event.verdict.toUpperCase()}`,
        message: `Phase "${event.phase}" verdict: ${event.verdict.toUpperCase()}\n${event.summary}`,
        priority,
        tags: [icon, "wopr"],
      }
    }
    case "budget_warning": {
      return {
        title: "wopr · budget warning",
        message: `$${event.spent.toFixed(4)} of $${event.cap.toFixed(2)} cap used (${event.percentUsed.toFixed(0)}%)`,
        priority: "high",
        tags: ["warning", "wopr"],
      }
    }
    case "budget_exceeded": {
      return {
        title: "wopr · budget exceeded",
        message: `$${event.spent.toFixed(4)} of $${event.cap.toFixed(2)} cap exceeded at phase "${event.atPhase}"`,
        priority: "urgent",
        tags: ["bangbang", "wopr"],
      }
    }
    case "run_completed": {
      const mins = Math.round(event.durationMs / 60_000)
      const lines = [`Duration: ${mins}m`, `Total cost: $${event.totalCost.toFixed(4)}`]
      if (event.worktreePath) lines.push(`Worktree: ${event.worktreePath}`)
      return {
        title: "wopr · run complete",
        message: lines.join("\n"),
        priority: "high",
        tags: ["white_check_mark", "wopr"],
      }
    }
    case "run_failed": {
      return {
        title: "wopr · run failed",
        message: `Failed at phase "${event.failedPhase}": ${event.error}`,
        priority: "urgent",
        tags: ["bangbang", "wopr"],
      }
    }
  }
}

const testNotificationPayload: NotificationPayload = {
  title: "wopr · test notification",
  message: "This is a test notification from wopr.\nIf you can read this, notifications are working correctly.",
  priority: "default",
  tags: ["wopr", "test"],
}

export class NotificationDispatcher {
  private readonly targets: NotificationTarget[]

  constructor(targets: NotificationTarget[]) {
    this.targets = targets
  }

  /** True when there are no targets configured — the dispatcher is a no-op. */
  get empty(): boolean {
    return this.targets.length === 0
  }

  /** Fire-and-forget: never throws, never blocks the run. */
  fire(event: NotificationEvent): void {
    if (this.targets.length === 0) return
    const payload = formatEvent(event)
    for (const target of this.targets) {
      if (target.kind !== "ntfy") continue
      // Don't await; we don't want notification latency to block the run.
      sendNotification(target, payload).catch((err: Error) => {
        log.warn(`[notify] ${target.server}/${target.topic} failed for ${event.type}: ${err.message}; continuing`)
      })
    }
  }

  /** Send a test notification to all targets. Returns per-target results. */
  async test(): Promise<Array<{ target: NotificationTarget; ok: boolean; error?: string }>> {
    const results = await Promise.allSettled(
      this.targets.map(async (target) => {
        if (target.kind !== "ntfy") return { target, ok: false, error: "unsupported target kind" }
        try {
          await sendNotification(target, testNotificationPayload)
          return { target, ok: true }
        } catch (error) {
          return { target, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    return results.map((result) => {
      if (result.status === "fulfilled") return result.value
      return { target: { kind: "ntfy" as const, server: "unknown", topic: "unknown" }, ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
    })
  }
}
