// The typed hand-off between the converge loop's phases: the planner emits a
// Plan (adapted from council's JudgePlan), the validator emits a ValidatorReport
// (its Verdict). Both are parsed out of the agent's final report text — a JSON
// block if the agent fenced one, else the last balanced {...} object — and then
// structurally validated. A parse/validation failure is thrown, so the phase's
// existing maxAttempts re-asks the model. No zod (archer has no such dep); the
// validators are hand-rolled.

export type ActionType = "create" | "modify" | "delete" | "refactor" | "test"
export type Priority = "P0" | "P1" | "P2"

export type PlanTask = {
  id: string
  file: string
  action: ActionType
  instruction: string
  rationale: string
  priority: Priority
  /** Which reviewer(s)/step(s) flagged this task, for traceability. */
  source: string[]
}

export type Plan = {
  summary: string
  tasks: PlanTask[]
  riskFlags: string[]
  outOfScope: string[]
}

export type Verdict = "PASS" | "PARTIAL" | "REJECT"

export type TaskValidation = {
  taskId: string
  verdict: Verdict
  notes: string
}

export type ValidatorReport = {
  verdict: Verdict
  taskResults: TaskValidation[]
  outOfScopeChanges: string[]
  notes: string
}

const ACTIONS: ReadonlySet<string> = new Set(["create", "modify", "delete", "refactor", "test"])
const PRIORITIES: ReadonlySet<string> = new Set(["P0", "P1", "P2"])
const VERDICTS: ReadonlySet<string> = new Set(["PASS", "PARTIAL", "REJECT"])

/**
 * Pull the JSON object out of an agent's report. Prefers a ```json fenced block;
 * otherwise scans for the last balanced top-level {...} so trailing prose after
 * the object doesn't break parsing. Throws if neither yields valid JSON.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i)
  const candidates = fenced ? [fenced[1]!] : balancedObjects(text)
  let lastError: unknown
  // Try the richest candidate first (last balanced object is usually the answer).
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`no parseable JSON object found in report${lastError ? `: ${(lastError as Error).message}` : ""}`)
}

/** Every balanced top-level {...} substring, in source order. */
function balancedObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1))
    }
  }
  return out
}

export function parsePlan(text: string): Plan {
  const data = extractJson(text) as Record<string, unknown>
  const tasks = requireArray(data.tasks, "tasks").map((raw, i) => parseTask(raw, i))
  if (tasks.length === 0) throw new Error("plan must contain at least one task")
  return {
    summary: requireString(data.summary, "summary"),
    tasks,
    riskFlags: stringArray(data.riskFlags),
    outOfScope: stringArray(data.outOfScope),
  }
}

function parseTask(raw: unknown, index: number): PlanTask {
  const obj = requireObject(raw, `tasks[${index}]`)
  const action = requireString(obj.action, `tasks[${index}].action`)
  if (!ACTIONS.has(action)) throw new Error(`tasks[${index}].action "${action}" not one of ${[...ACTIONS].join("/")}`)
  const priority = requireString(obj.priority, `tasks[${index}].priority`)
  if (!PRIORITIES.has(priority)) throw new Error(`tasks[${index}].priority "${priority}" not one of ${[...PRIORITIES].join("/")}`)
  const source = stringArray(obj.source)
  if (source.length === 0) throw new Error(`tasks[${index}].source must cite at least one reviewer/step`)
  return {
    id: requireString(obj.id, `tasks[${index}].id`),
    file: requireString(obj.file, `tasks[${index}].file`),
    action: action as ActionType,
    instruction: requireString(obj.instruction, `tasks[${index}].instruction`),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    priority: priority as Priority,
    source,
  }
}

export function parseValidatorReport(text: string): ValidatorReport {
  const data = requireObject(extractJson(text), "report")
  const verdict = requireString(data.verdict, "verdict")
  if (!VERDICTS.has(verdict)) throw new Error(`verdict "${verdict}" not one of ${[...VERDICTS].join("/")}`)
  const taskResults = arrayOr(data.taskResults).map((raw, i) => {
    const obj = requireObject(raw, `taskResults[${i}]`)
    const v = requireString(obj.verdict, `taskResults[${i}].verdict`)
    if (!VERDICTS.has(v)) throw new Error(`taskResults[${i}].verdict "${v}" not one of ${[...VERDICTS].join("/")}`)
    return { taskId: requireString(obj.taskId, `taskResults[${i}].taskId`), verdict: v as Verdict, notes: typeof obj.notes === "string" ? obj.notes : "" }
  })
  return { verdict: verdict as Verdict, taskResults, outOfScopeChanges: stringArray(data.outOfScopeChanges), notes: typeof data.notes === "string" ? data.notes : "" }
}

// ── tiny validation helpers ────────────────────────────────────────────────

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`)
  return value
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}

function arrayOr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return arrayOr(value).filter((item): item is string => typeof item === "string")
}
