import type { Plan, ValidatorReport, Verdict } from "./plan-schema"

// Pure control helpers for the converging plan → implement → validate loop
// (adapted from council's src/core/loop.ts).

/** Stable signature of a plan's task set, so two iterations can be compared. */
export function planSignature(plan: Plan): string {
  return plan.tasks
    .map((task) => `${task.id}:${task.action}:${task.file}`)
    .sort()
    .join("|")
}

const VERDICT_RANK: Record<Verdict, number> = { REJECT: 0, PARTIAL: 1, PASS: 2 }

/** True if the current verdict is strictly better than the previous one. */
export function verdictImproved(prev: Verdict | undefined, curr: Verdict): boolean {
  if (prev === undefined) return true
  return VERDICT_RANK[curr] > VERDICT_RANK[prev]
}

/**
 * No progress = the same plan as last time AND the verdict did not improve.
 * Retrying then is pointless — stop instead of burning iterations.
 */
export function isStalled(args: {
  prevPlanSig: string | undefined
  currPlanSig: string
  prevVerdict: Verdict | undefined
  currVerdict: Verdict
}): boolean {
  const samePlan = args.prevPlanSig !== undefined && args.prevPlanSig === args.currPlanSig
  const noImprovement = !verdictImproved(args.prevVerdict, args.currVerdict)
  return samePlan && noImprovement
}

/** Render a validator report as feedback the planner can act on next iteration. */
export function formatValidatorFeedback(report: ValidatorReport): string {
  const perTask = report.taskResults.map((task) => `- ${task.taskId}: ${task.verdict} — ${task.notes}`).join("\n")
  const outOfScope = report.outOfScopeChanges.length
    ? `\n\nOut-of-scope changes flagged:\n${report.outOfScopeChanges.map((item) => `- ${item}`).join("\n")}`
    : ""
  return `Overall verdict: ${report.verdict}\n${report.notes}\n\nPer-task results:\n${perTask}${outOfScope}`
}
